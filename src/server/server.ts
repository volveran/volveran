// HTTP JSON API and the built web app, served by one Fastify process.
// startServer is the in-process entry point of both main.ts and the
// integration test harness (test/integration/harness.ts).
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import pg from 'pg';
import { bodyStoreUsage, type BodyRetention } from './audit/body-retention.js';
import { Notifier } from './alerts/notifier.js';
import { Alerting } from './alerts/alerting.js';
import type { AlertDestination } from './alerts/destinations.js';
import { RestoreService } from './audit/restore.js';
import type { AuditStore } from './audit/audit-store.js';
import { PostgresAuditStore } from './audit/postgres-audit-store.js';
import { asStartupError } from './audit/postgres-connection.js';
import { SqliteAuditStore } from './audit/sqlite-audit-store.js';
import { createTeamAuth, type TeamAuth } from './auth.js';
import { CheckoutManager, type CheckoutTestHooks } from './checkout/manager.js';
import { AlertMetrics } from './metrics/alerts.js';
import { startMetricsListener, type MetricsListener } from './metrics/listener.js';
import { QueueMetrics } from './metrics/queues.js';
import { startRuntimeMetrics } from './metrics/runtime.js';
import { StoreReadings } from './metrics/store-readings.js';
import { TriageMetrics } from './metrics/triage.js';
import { QueueSampler, type SamplerTestHooks } from './history/sampler.js';
import { HttpError } from './http-error.js';
import { NO_VERSION_WARNING, type BrokerProfile } from './profiles.js';
import { readStartupConfig, type StartupConfig } from './startup-config.js';
import { systemClock } from './replay-rules/rule-clock.js';
import { ReplayRules } from './replay-rules/rules.js';
import type { CheckoutLimits } from './triage/checkout-collection.js';
import type { CheckoutTiming } from './triage/checkout-timing.js';
import { registerCheckoutRoutes } from './routes/checkouts.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerApplyRoutes } from './routes/apply.js';
import { registerAlertDestinationRoutes } from './routes/alert-destinations.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerExportRoutes } from './routes/export.js';
import { registerAuditRoutes, type AuditRouteDeps } from './routes/audit.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerHistoryRoutes, type HistoryRouteDeps } from './routes/history.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerReplayRuleRoutes } from './routes/replay-rules.js';
import { registerSessionRoutes } from './routes/session.js';
import { attachOperator } from './operator.js';
import { ProfileAccessCheck } from './profile-access.js';

export interface ServerOptions {
  /** The Broker Profiles YAML file. */
  profilesFile: string;
  /** Environment: password variables of the profiles, VOLVERAN_AUTH, VOLVERAN_OPERATOR, USER, VOLVERAN_OIDC_*, VOLVERAN_SESSION_SECRET. */
  env: Record<string, string | undefined>;
  host: string;
  /** 0 picks a free port. */
  port: number;
  /** Directory with the built web app; omitted or missing means API only. */
  webRoot?: string;
  /** Directory of the audit store (VOLVERAN_DATA_DIR); omitted means in memory only (tests). */
  dataDir?: string;
  /** Logs as JSON lines: true to stdout, or into `stream` (tests). Default off. */
  logger?: boolean | { stream: { write(line: string): void } };
  /** Overrides the Checkout limits from VOLVERAN_CHECKOUT_MAX_MESSAGES / VOLVERAN_CHECKOUT_MAX_MB. */
  checkoutLimits?: Partial<CheckoutLimits>;
  /** Overrides the Checkout timing from VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES / VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS. */
  checkoutTiming?: Partial<CheckoutTiming>;
  /** How long an ended or lost Checkout stays readable (default 15 min). */
  endedCheckoutRetentionMs?: number;
  /** Overrides the body retention from VOLVERAN_BODY_RETENTION_DAYS / _MAX_BYTES / _INTERVAL_MINUTES. */
  bodyRetention?: Partial<BodyRetention>;
  /** Test seam: what the callers on the audit store interface talk to (a delayed store); unset in production. */
  wrapAuditStore?(store: AuditStore): AuditStore;
  /** Test seams of the Checkout manager; unset in production. */
  checkoutTestHooks?: CheckoutTestHooks;
  /** Test seams of the queue sampler; unset in production. */
  samplerTestHooks?: SamplerTestHooks;
}

export interface RunningServer {
  url: string;
  /** Where the metrics are scraped, when VOLVERAN_METRICS_PORT is set. */
  metricsUrl?: string;
  close(): Promise<void>;
}

/** How often the metrics read the audit store when nothing has told them to. */
const METRICS_READING_INTERVAL_MS = 15_000;

/** Checks the configuration (throwing a ConfigError), then listens. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const startup = await readStartupConfig(options);
  const { postgresUrl } = startup.config;
  const openedStore = postgresUrl ? await PostgresAuditStore.open(postgresUrl, startup.postgresTls) : new SqliteAuditStore(options.dataDir);
  try {
    return await serve(options, startup, openedStore);
  } catch (err) {
    // Nothing else closes the store when startup fails before the app is up.
    await openedStore.close().catch(() => {});
    // A permission missing on a table only shows when the table is first read.
    throw postgresUrl && err instanceof pg.DatabaseError ? asStartupError(err, postgresUrl) : err;
  }
}

async function serve(
  options: ServerOptions,
  { config, limits, file: { profiles, alertDestinations, versionDeclared } }: StartupConfig,
  openedStore: AuditStore,
): Promise<RunningServer> {
  const retention = { ...config.bodyRetention, ...options.bodyRetention };
  const auditStore = options.wrapAuditStore?.(openedStore) ?? openedStore;
  // A scrape takes the last of these readings and never waits on the store. Replay
  // Rules are created below; this reads only once it has started.
  const metricsReadings = new StoreReadings({
    read: async () => {
      const [ruleStates, storedBodyBytes, memories] = await Promise.all([
        replayRules.states(),
        auditStore.storedBodyBytes(),
        Promise.all(profiles.map((p) => auditStore.alerts.load(p.name))),
      ]);
      const firingRules = new Map(profiles.map((p, i) => [p.name, memories[i]!.alerts.filter((a) => a.status === 'firing').map((a) => a.rule)]));
      return { ruleStates, storedBodyBytes, firingRules };
    },
    intervalMs: METRICS_READING_INTERVAL_MS,
    // Called only once the app below is listening or starting up.
    onError: (err) => app.log.error({ err }, 'The metrics could not read the audit store; they keep their last values'),
  });
  // The Checkout manager and Replay Rules below tell it what happens; it reads them only at a scrape.
  const triageMetrics = new TriageMetrics({
    ruleStates: () => metricsReadings.current()?.ruleStates ?? [],
    checkoutCounts: () => checkouts.counts(),
    storedBodyBytes: () => metricsReadings.current()?.storedBodyBytes ?? null,
  });
  const checkouts = new CheckoutManager({
    audit: auditStore,
    limits,
    enforceApproval: config.mode.kind === 'team',
    timing: { ...config.checkoutTiming, ...options.checkoutTiming },
    endedRetentionMs: options.endedCheckoutRetentionMs,
    testHooks: options.checkoutTestHooks,
    // Replay Rules are created below, before any Checkout can start.
    ruleBadges: (c, held) => replayRules.badges(c.profile, c.vhost, c.queue, held),
    // Called only once the app below is listening.
    onRuleBadgesError: (err) => app.log.error({ err }, 'The rule badges of a Checkout could not be read'),
    // Called only once the app below is listening.
    onApplyError: (checkoutId, err) => app.log.error({ err, checkoutId }, 'An Apply failed unexpectedly; its Checkout ended'),
    onApplyEnded: (checkout, outcomes) => {
      triageMetrics.applyEnded(checkout.profile.name, outcomes);
      void metricsReadings.refresh();
    },
  });
  const access: Access =
    config.mode.kind === 'solo'
      ? { kind: 'solo', operator: config.mode.operator }
      : { kind: 'team', auth: await createTeamAuth(config.mode.oidc, config.mode.sessionSecret, {
          // Refreshing the access token is for profiles that connect with it.
          refreshBrokerTokens: profiles.some((p) => p.credentials.kind === 'operatorToken'),
        }),
      };
  const restore = new RestoreService(auditStore, (id) => checkouts.isRunning(id));
  const replayRules = new ReplayRules({
    checkouts,
    state: auditStore.ruleState,
    audit: auditStore,
    profiles,
    testHooks: options.checkoutTestHooks?.ruleScheduler,
    // Called only once the app below is listening.
    onError: (rule, err) => app.log.error({ err, rule }, 'A scheduled Replay rule pass failed unexpectedly'),
    onPassRecorded: (profile, rule, pass) => triageMetrics.passRecorded(profile, rule, pass.status),
    // Alerting is created below, before any rule starts.
    onPauseChanged: async (profile) => {
      await alerting.replayRuleChanged(profile);
      await metricsReadings.refresh();
    },
  });
  const samplerClock = options.samplerTestHooks?.clock ?? systemClock;
  const sampler = new QueueSampler({
    profiles,
    history: auditStore.history,
    intervalMs: config.historyIntervalMs,
    testHooks: options.samplerTestHooks,
    // Called only once the app below is listening.
    onError: (profile, err) => app.log.error({ err, profile }, 'A sampling run failed unexpectedly'),
  });
  const queueMetrics = new QueueMetrics(() => sampler.latest());
  sampler.onRun((finished) => queueMetrics.runFinished(finished));
  const alertMetrics = new AlertMetrics({ profiles, firingRules: (profile) => metricsReadings.current()?.firingRules.get(profile) ?? null });
  const notifier = new Notifier({
    onDelivered: (delivery) => alertMetrics.delivered(delivery),
    destinations: alertDestinations,
    store: auditStore.notifications,
    publicUrl: config.publicUrl,
    // Called only once the app below is listening.
    onError: (err) => app.log.error({ err }, 'The outcome of a notification could not be recorded'),
  });
  const alerting = new Alerting({
    profiles,
    store: auditStore.alerts,
    notifier,
    clock: samplerClock,
    pausedReplayRules: (profile) => replayRules.pausedRules(profile),
    lastSuccessAt: (profile) => sampler.latest().profiles.find((p) => p.profile === profile)?.lastSuccessAt ?? null,
    // Called only once the app below is listening.
    onError: (err) => app.log.error({ err }, 'An Alert notification could not be delivered'),
  });
  sampler.onRun(async (finished) => {
    await alerting.evaluate(finished);
    await metricsReadings.refresh();
  });
  const usage = async () => bodyStoreUsage(await auditStore.storedBodyBytes(), retention);
  const app = await buildApp({
    profiles,
    access,
    checkouts,
    replayRules,
    notifier,
    alertDestinations,
    audit: { audit: auditStore, restore, usage },
    history: { history: auditStore.history, clock: samplerClock, intervalMs: config.historyIntervalMs, retentionMs: config.historyRetentionMs },
    webRoot: options.webRoot,
    logger: options.logger ?? false,
  });

  // Roles (profile-access.ts): say which profiles anyone can act on, or that Solo Mode ignores them.
  if (access.kind === 'solo') {
    const mapped = profiles.filter((p) => p.roles).map((p) => p.name);
    if (mapped.length > 0) {
      app.log.info({ profiles: mapped }, 'Solo Mode ignores the roles of Broker Profiles: the Operator is admin on every profile');
    }
  } else {
    // Approval (v0.3): the one change for v0.2 users of Protected Profiles in Team Mode.
    for (const p of profiles.filter((p) => p.protected)) {
      if (p.requireApproval) {
        app.log.info(
          { profile: p.name },
          `Protected Profile "${p.name}" requires Approval: an Apply that changes where a Message ends up waits for a second Operator. Set requireApproval: false on it to Apply alone`,
        );
      } else {
        app.log.info({ profile: p.name }, `Protected Profile "${p.name}" has requireApproval: false: an Apply needs no Approval`);
      }
    }
    for (const p of profiles.filter((p) => !p.roles)) {
      app.log.warn(
        { profile: p.name },
        `Broker Profile "${p.name}" has no roles: every signed-in Operator is admin on it, and can Restore`,
      );
    }
  }

  if (!versionDeclared) app.log.warn(NO_VERSION_WARNING);

  // Replay Rules on a Protected Profile run without Approval (ADR 0011): say so once per rule.
  for (const p of profiles.filter((p) => p.protected)) {
    for (const rule of p.replayRules) {
      app.log.info(
        { profile: p.name, rule: rule.name },
        `Replay rule "${rule.name}" on Protected Profile "${p.name}" Replays without Approval: the review of the profiles file is its second pair of eyes`,
      );
    }
  }

  // Retention: evict Discarded bodies past the limits at startup, then on a schedule.
  const evict = async () => {
    try {
      const { evicted } = await auditStore.evictBodies({ now: new Date(), ...retention });
      if (evicted > 0) app.log.info({ evicted }, 'Retention evicted Discarded Message bodies');
    } catch (err) {
      app.log.error(err, 'Retention could not evict Discarded Message bodies');
    }
    try {
      await auditStore.notifications.removeOlderThan(new Date(Date.now() - config.historyRetentionMs));
    } catch (err) {
      app.log.error(err, 'Retention could not remove old notification outcomes');
    }
  };
  // The same job removes Samples and sampling runs past the history retention.
  const removeOldHistory = async () => {
    try {
      const { samples } = await auditStore.history.removeOlderThan(Date.now() - config.historyRetentionMs);
      if (samples > 0) app.log.info({ samples }, 'Retention removed old Samples');
    } catch (err) {
      app.log.error(err, 'Retention could not remove old Samples');
    }
  };
  // Never rejects. A run still going when the next is due is left to finish.
  let retentionRun: Promise<void> | null = null;
  const runRetention = () => {
    retentionRun ??= (async () => {
      await evict();
      await removeOldHistory();
      await metricsReadings.refresh();
    })().finally(() => {
      retentionRun = null;
    });
    return retentionRun;
  };
  await runRetention();
  const retentionTimer = setInterval(() => void runRetention(), retention.intervalMs);
  retentionTimer.unref();

  // No new Rule Pass starts and the ones in progress end (and are recorded);
  // then every held Message goes back to its queue (an Apply in progress
  // finishes first) before the audit store closes and the process exits.
  let metricsListener: MetricsListener | undefined;
  app.addHook('onClose', async () => {
    await metricsListener?.close();
    await metricsReadings.stop();
    clearInterval(retentionTimer);
    await retentionRun;
    await sampler.stop();
    // Before the notifier: a last pass can pause its rule, which sends a notification.
    await replayRules.stop();
    await alerting.stop();
    await notifier.close();
    await checkouts.endAll();
    await auditStore.close();
  });
  try {
    await alerting.start();
    // The sampler before the rules: a rule overdue from before a restart passes at once, and an automatic stop reads the sampler's snapshot.
    await sampler.start();
    // Replay Rules: give each its state and schedule the running ones.
    await replayRules.start();
  } catch (err) {
    await app.close();
    throw err;
  }

  // Metrics: on a port of their own, at the same address, so loopback in Solo Mode.
  if (config.metricsPort !== null) {
    const runtimeMetrics = startRuntimeMetrics();
    app.addHook('onClose', async () => runtimeMetrics.stop());
    try {
      await metricsReadings.start();
      metricsListener = await startMetricsListener({
        host: options.host,
        port: config.metricsPort,
        families: () => [...queueMetrics.families(), ...triageMetrics.families(), ...alertMetrics.families(), ...runtimeMetrics.families()],
        onError: (err) => app.log.error(err, 'A metrics scrape failed'),
      });
    } catch (err) {
      await app.close();
      throw err;
    }
  }

  // Listening comes last, so /readyz is only reachable once startup has finished.
  try {
    await app.listen({ host: options.host, port: options.port });
  } catch (err) {
    await app.close();
    throw err;
  }
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const host = options.host.includes(':') ? `[${options.host}]` : options.host;
  return {
    url: `http://${host}:${port}`,
    metricsUrl: metricsListener && `http://${host}:${metricsListener.port}/metrics`,
    close: () => app.close(),
  };
}

/** Who acts: Solo Mode's configured Operator, or Team Mode's sign-in. */
type Access = { kind: 'solo'; operator: string } | { kind: 'team'; auth: TeamAuth };

interface AppOptions {
  profiles: BrokerProfile[];
  access: Access;
  checkouts: CheckoutManager;
  replayRules: ReplayRules;
  notifier: Notifier;
  alertDestinations: AlertDestination[];
  audit: AuditRouteDeps;
  history: HistoryRouteDeps;
  /** Directory with the built web app; omitted or missing means API only. */
  webRoot: string | undefined;
  logger: boolean | { stream: { write(line: string): void } };
}

async function buildApp({ profiles, access, checkouts, replayRules, notifier, alertDestinations, audit, history, webRoot, logger }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { ...err.details, code: err.code, message: err.message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal_error', message: (err as Error).message } });
  });

  // Probes answer without a session in both modes (routes/health.ts).
  registerHealthRoutes(app, audit.audit);

  // Every request carries its Operator (operator.ts); in Team Mode, /api/
  // routes refuse requests without a session before any handler runs.
  if (access.kind === 'solo') {
    const operator = { id: access.operator, displayName: access.operator };
    attachOperator(app, () => operator);
  } else {
    await access.auth.register(app);
  }

  // Every route on a Broker Profile, a Checkout or an Audit Entry resolves
  // the profile through this one check (profile-access.ts).
  const profileAccess = new ProfileAccessCheck(profiles, access.kind);
  const checkoutDeps = { checkouts, access: profileAccess };
  registerSessionRoutes(app, { mode: access.kind, checkouts, access: profileAccess });
  const alertReadings = { alerts: audit.audit.alerts, notifications: audit.audit.notifications, destinations: alertDestinations };
  registerProfileRoutes(app, profileAccess, history, alertReadings);
  registerReplayRuleRoutes(app, replayRules, profileAccess);
  registerAlertDestinationRoutes(app, notifier, profileAccess);
  registerAlertRoutes(app, alertReadings, profileAccess);
  registerCheckoutRoutes(app, checkoutDeps);
  registerDecisionRoutes(app, checkoutDeps);
  registerApplyRoutes(app, checkoutDeps);
  registerApprovalRoutes(app, checkoutDeps);
  registerExportRoutes(app, checkoutDeps);
  registerAuditRoutes(app, audit, profileAccess);
  registerHistoryRoutes(app, history, profileAccess);

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'not_found', message: `No route ${req.method} ${req.url}` } });
    }
    if (webRoot && existsSync(webRoot)) return reply.sendFile('index.html');
    return reply
      .status(404)
      .send('Web app not built. In development the web app is served by Vite: npm run dev, then open http://localhost:5173');
  });

  if (webRoot && existsSync(webRoot)) {
    app.register(fastifyStatic, { root: webRoot });
  }

  return app;
}
