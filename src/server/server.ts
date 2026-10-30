// HTTP JSON API and the built web app, served by one Fastify process.
// startServer is the in-process entry point of both main.ts and the
// integration test harness (test/integration/harness.ts).
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { bodyStoreUsage, type BodyRetention } from './audit/body-retention.js';
import { Notifier } from './alerts/notifier.js';
import { Alerting } from './alerts/alerting.js';
import type { AlertDestination } from './alerts/destinations.js';
import { RestoreService } from './audit/restore.js';
import type { AuditStore as AsyncAuditStore } from './audit/audit-store.js';
import { AuditStore } from './audit/store.js';
import { createTeamAuth, type TeamAuth } from './auth.js';
import { CheckoutManager, type CheckoutTestHooks } from './checkout/manager.js';
import { loadConfig } from './config.js';
import { AlertMetrics } from './metrics/alerts.js';
import { startMetricsListener, type MetricsListener } from './metrics/listener.js';
import { QueueMetrics } from './metrics/queues.js';
import { startRuntimeMetrics } from './metrics/runtime.js';
import { TriageMetrics } from './metrics/triage.js';
import { ConfigError } from './config-error.js';
import { QueueSampler, type SamplerTestHooks } from './history/sampler.js';
import { HttpError } from './http-error.js';
import { checkProfilesForRunMode, checkReplayRules, loadProfilesFile, type BrokerProfile } from './profiles.js';
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
  wrapAuditStore?(store: AsyncAuditStore): AsyncAuditStore;
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

/** Checks the configuration (throwing a ConfigError), then listens. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const loaded = loadConfig(options.env, options.host);
  if (!loaded.ok) throw new ConfigError(loaded.error);
  const { config } = loaded;
  const retention = { ...config.bodyRetention, ...options.bodyRetention };
  const { profiles, alertDestinations } = await loadProfilesFile(options.profilesFile, options.env);
  checkProfilesForRunMode(profiles, config.mode.kind);
  const limits = { ...config.checkoutLimits, ...options.checkoutLimits };
  checkReplayRules(profiles, limits);
  if (config.metricsPort !== null && config.metricsPort === options.port) {
    throw new ConfigError(`VOLVERAN_METRICS_PORT must differ from the web app's port (${options.port}): metrics are never served on it.`);
  }
  const audit = new AuditStore(options.dataDir);
  const asyncAudit = options.wrapAuditStore?.(audit.async) ?? audit.async;
  // The Checkout manager and Replay Rules below tell it what happens; it reads them only at a scrape.
  const triageMetrics = new TriageMetrics({
    ruleStates: () => replayRules.states(),
    checkoutCounts: () => checkouts.counts(),
    storedBodyBytes: () => audit.storedBodyBytes(),
  });
  const checkouts = new CheckoutManager({
    audit: asyncAudit,
    syncAudit: audit,
    limits,
    enforceApproval: config.mode.kind === 'team',
    timing: { ...config.checkoutTiming, ...options.checkoutTiming },
    endedRetentionMs: options.endedCheckoutRetentionMs,
    testHooks: options.checkoutTestHooks,
    // Replay Rules are created below, before any Checkout can start.
    ruleBadge: (c, delivery, diedAgainCount) => replayRules.badge(c.profile, c.vhost, c.queue, delivery, diedAgainCount),
    // Called only once the app below is listening.
    onApplyError: (checkoutId, err) => app.log.error({ err, checkoutId }, 'An Apply failed unexpectedly; its Checkout ended'),
    onApplyEnded: (checkout, outcomes) => triageMetrics.applyEnded(checkout.profile.name, outcomes),
  });
  const access: Access =
    config.mode.kind === 'solo'
      ? { kind: 'solo', operator: config.mode.operator }
      : { kind: 'team', auth: await createTeamAuth(config.mode.oidc, config.mode.sessionSecret, {
          // Refreshing the access token is for profiles that connect with it.
          refreshBrokerTokens: profiles.some((p) => p.credentials.kind === 'operatorToken'),
        }),
      };
  const restore = new RestoreService(audit, (id) => checkouts.isRunning(id));
  const replayRules = new ReplayRules({
    checkouts,
    state: audit.ruleState,
    audit,
    profiles,
    testHooks: options.checkoutTestHooks?.ruleScheduler,
    // Called only once the app below is listening.
    onError: (rule, err) => app.log.error({ err, rule }, 'A scheduled Replay rule pass failed unexpectedly'),
    onPassRecorded: (profile, rule, pass) => triageMetrics.passRecorded(profile, rule, pass.status),
    // Alerting is created below, before any rule starts.
    onPauseChanged: (profile) => alerting.replayRuleChanged(profile),
  });
  const samplerClock = options.samplerTestHooks?.clock ?? systemClock;
  const sampler = new QueueSampler({
    profiles,
    history: audit.history,
    intervalMs: config.historyIntervalMs,
    testHooks: options.samplerTestHooks,
    // Called only once the app below is listening.
    onError: (profile, err) => app.log.error({ err, profile }, 'A sampling run failed unexpectedly'),
  });
  const queueMetrics = new QueueMetrics(() => sampler.latest());
  sampler.onRun((finished) => queueMetrics.runFinished(finished));
  const alertMetrics = new AlertMetrics({ profiles, store: audit.alerts });
  const notifier = new Notifier({
    onDelivered: (delivery) => alertMetrics.delivered(delivery),
    destinations: alertDestinations,
    store: audit.notifications,
    publicUrl: config.publicUrl,
    // Called only once the app below is listening.
    onError: (err) => app.log.error({ err }, 'The outcome of a notification could not be recorded'),
  });
  const alerting = new Alerting({
    profiles,
    store: audit.alerts,
    notifier,
    clock: samplerClock,
    pausedReplayRules: (profile) => replayRules.pausedRules(profile),
    lastSuccessAt: (profile) => sampler.latest().profiles.find((p) => p.profile === profile)?.lastSuccessAt ?? null,
    // Called only once the app below is listening.
    onError: (err) => app.log.error({ err }, 'An Alert notification could not be delivered'),
  });
  sampler.onRun((finished) => alerting.evaluate(finished));
  const usage = () => bodyStoreUsage(audit.storedBodyBytes(), retention);
  const app = await buildApp({
    profiles,
    access,
    checkouts,
    replayRules,
    notifier,
    alertDestinations,
    audit: { audit, restore, usage },
    history: { history: audit.history, clock: samplerClock, intervalMs: config.historyIntervalMs, retentionMs: config.historyRetentionMs },
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
  const evict = () => {
    try {
      const { evicted } = audit.evictBodies({ now: new Date(), ...retention });
      if (evicted > 0) app.log.info({ evicted }, 'Retention evicted Discarded Message bodies');
    } catch (err) {
      app.log.error(err, 'Retention could not evict Discarded Message bodies');
    }
    try {
      audit.notifications.removeOlderThan(new Date(Date.now() - config.historyRetentionMs));
    } catch (err) {
      app.log.error(err, 'Retention could not remove old notification outcomes');
    }
  };
  // The same job removes Samples and sampling runs past the history retention.
  const removeOldHistory = () => {
    try {
      const { samples } = audit.history.removeOlderThan(Date.now() - config.historyRetentionMs);
      if (samples > 0) app.log.info({ samples }, 'Retention removed old Samples');
    } catch (err) {
      app.log.error(err, 'Retention could not remove old Samples');
    }
  };
  const runRetention = () => {
    evict();
    removeOldHistory();
  };
  runRetention();
  const retentionTimer = setInterval(runRetention, retention.intervalMs);
  retentionTimer.unref();

  // No new Rule Pass starts and the ones in progress end (and are recorded);
  // then every held Message goes back to its queue (an Apply in progress
  // finishes first) before the audit store closes and the process exits.
  let metricsListener: MetricsListener | undefined;
  app.addHook('onClose', async () => {
    // First: a scrape reads the audit store.
    await metricsListener?.close();
    clearInterval(retentionTimer);
    await sampler.stop();
    // Before the notifier: a last pass can pause its rule, which sends a notification.
    await replayRules.stop();
    await notifier.close();
    await checkouts.endAll();
    audit.close();
  });
  // Replay Rules: give each its state and schedule the running ones.
  replayRules.start();
  sampler.start();

  // Metrics: on a port of their own, at the same address, so loopback in Solo Mode.
  if (config.metricsPort !== null) {
    const runtimeMetrics = startRuntimeMetrics();
    app.addHook('onClose', async () => runtimeMetrics.stop());
    try {
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
  await app.listen({ host: options.host, port: options.port });
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
  registerHealthRoutes(app);

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
