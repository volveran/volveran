// HTTP JSON API and the built web app, served by one Fastify process.
// startServer is the in-process entry point of both main.ts and the
// integration test harness (test/integration/harness.ts).
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { bodyStoreUsage, type BodyRetention } from './audit/body-retention.js';
import { Notifier } from './alerts/notifier.js';
import { Alerting } from './alerts/alerting.js';
import type { AlertDestination } from './alerts/destinations.js';
import { RestoreService } from './audit/restore.js';
import { LeaderLeaseLost, type AuditStore } from './audit/audit-store.js';
import { PostgresAuditStore } from './audit/postgres-audit-store.js';
import { SqliteAuditStore } from './audit/sqlite-audit-store.js';
import { createTeamAuth, DEFAULT_MAX_SIGN_INS_IN_PROGRESS, type TeamAuth } from './auth.js';
import { CheckoutManager, DEFAULT_ENDED_RETENTION_MS, type CheckoutTestHooks } from './checkout/manager.js';
import { AlertMetrics } from './metrics/alerts.js';
import { startMetricsListener, type MetricsListener } from './metrics/listener.js';
import { QueueMetrics } from './metrics/queues.js';
import { ReplicaMetrics } from './metrics/replicas.js';
import { startRuntimeMetrics } from './metrics/runtime.js';
import { reportingStoreErrors } from './metrics/store-errors.js';
import { StoreReadings } from './metrics/store-readings.js';
import { TriageMetrics } from './metrics/triage.js';
import { QueueSampler, type SamplerTestHooks } from './history/sampler.js';
import { HttpError } from './http-error.js';
import { BackgroundLeader, type LeaderTestHooks } from './leader/background-leader.js';
import { retentionJob } from './leader/retention-job.js';
import { NO_VERSION_WARNING, type BrokerProfile } from './profiles.js';
import { readStartupConfig, type StartupConfig } from './startup-config.js';
import { createForwarder, replicaUnreachable, startForwardingListener, type Forwarder, type ForwardingListener } from './replicas/forwarding.js';
import { goneReplicasJob } from './replicas/gone-replicas-job.js';
import { LiveCheckouts } from './replicas/live-checkouts.js';
import { DEFAULT_REPLICA_LEASE_TIMING, ReplicaLease, type ReplicaLeaseTiming } from './replicas/replica-lease.js';
import { keySeal, noSeal } from './token-seal.js';
import { systemClock } from './replay-rules/rule-clock.js';
import { ReplayRules } from './replay-rules/rules.js';
import type { CheckoutLimits } from './triage/checkout-collection.js';
import { endAnswersWithinMs, type CheckoutTiming } from './triage/checkout-timing.js';
import { registerCheckoutRoutes } from './routes/checkouts.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerApplyRoutes } from './routes/apply.js';
import { serveApiUnderVersionToo } from './routes/api-prefix.js';
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
import { sendSecurityHeaders } from './security-headers.js';
import { attachOperator, type Operator } from './operator.js';
import { ProfileAccessCheck } from './profile-access.js';
import { requestOriginCheck, type RequestOriginCheck } from './request-origin.js';

export interface ServerOptions {
  /** The Broker Profiles YAML file. */
  profilesFile: string;
  /** Environment: password variables of the profiles, VOLVERAN_AUTH, VOLVERAN_OPERATOR, USER, VOLVERAN_OIDC_*, VOLVERAN_SESSION_SECRET, VOLVERAN_SESSION_ENCRYPTION_KEY, VOLVERAN_SESSION_IDLE_MINUTES. */
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
  /** Test seams of the Background Leader; unset in production. */
  leaderTestHooks?: LeaderTestHooks;
  /** Test seam: how often a Replica renews its lease and how long that holds; unset in production. */
  replicaLeaseTiming?: Partial<ReplicaLeaseTiming>;
  /** Test seam: told of each route as it is registered (the authorization matrix); unset in production. */
  onRouteRegistered?(route: { method: string; url: string }): void;
  /** Test seam: overrides the session idle timeout from VOLVERAN_SESSION_IDLE_MINUTES; unset in production. */
  sessionIdleMs?: number;
  /** Test seam: how many sign-ins in progress the store keeps; unset in production. */
  maxSignInsInProgress?: number;
}

export interface RunningServer {
  url: string;
  /** Where the metrics are scraped, when VOLVERAN_METRICS_PORT is set. */
  metricsUrl?: string;
  close(): Promise<void>;
}

/** How often the metrics read the audit store when nothing has told them to. */
const METRICS_READING_INTERVAL_MS = 15_000;

/** How long requests in progress get to finish once shutdown has ended every Checkout. */
const IN_FLIGHT_REQUESTS_MS = 5_000;

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
    throw postgresUrl ? PostgresAuditStore.startupFailure(err, postgresUrl) : err;
  }
}

async function serve(
  options: ServerOptions,
  { config, limits, file: { profiles, alertDestinations, versionDeclared } }: StartupConfig,
  openedStore: AuditStore,
): Promise<RunningServer> {
  const retention = { ...config.bodyRetention, ...options.bodyRetention };
  // The leader below exists before anything scrapes.
  const replicaMetrics = new ReplicaMetrics(() => leader.isLeader);
  const auditStore = reportingStoreErrors(options.wrapAuditStore?.(openedStore) ?? openedStore, () => replicaMetrics.storeFailed());
  // A scrape takes the last of these readings and never waits on the store. They describe
  // shared state, so only the Background Leader shows them, and only it reads them: a
  // Replica that stops leading forgets them, and takes new ones as soon as it leads again.
  // Replay Rules and the leader are created below; this reads only once it has started.
  const metricsReadings = new StoreReadings({
    read: async () => {
      if (!leader.isLeader) return null;
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
  const sharedReadings = () => (leader.isLeader ? metricsReadings.current() : null);
  const triageMetrics = new TriageMetrics({
    ruleStates: () => sharedReadings()?.ruleStates ?? [],
    checkoutCounts: () => checkouts.counts(),
    storedBodyBytes: () => sharedReadings()?.storedBodyBytes ?? null,
  });
  // Each start of the process is a new Replica: a Checkout does not survive a restart.
  const replicaId = randomUUID();
  const replicaLeaseTiming = { ...DEFAULT_REPLICA_LEASE_TIMING, ...options.replicaLeaseTiming };
  // Called only once the app below is listening or starting up.
  const liveCheckouts = config.forwarding ? new LiveCheckouts(auditStore.replicas, replicaId, (err) => app.log.error({ err }, 'A Live Checkout record could not be written; trying again')) : null;
  const checkouts = new CheckoutManager({
    ...(liveCheckouts && { liveCheckouts }),
    audit: auditStore,
    limits,
    enforceApproval: config.mode.kind === 'team',
    timing: { ...config.checkoutTiming, ...options.checkoutTiming },
    endedRetentionMs: options.endedCheckoutRetentionMs,
    testHooks: options.checkoutTestHooks,
    // Replay Rules are created below, before any Checkout can start.
    ruleBadges: (c, held) => replayRules.badges(c, held),
    // Called only once the app below is listening.
    onRuleBadgesError: (err) => app.log.error({ err }, 'The rule badges of a Checkout could not be read'),
    // Called only once the app below is listening.
    onApplyError: (checkoutId, err) => app.log.error({ err, checkoutId }, 'An Apply failed unexpectedly; its Checkout ended'),
    // Called only once the app below is listening.
    onReturnWaitRanOut: (checkout, waited) =>
      app.log.warn(
        { checkoutId: checkout.id, queue: checkout.queue, ...waited },
        'A Checkout stopped waiting for its quorum queue to take its Messages back, so some may have used up Delivery Budget',
      ),
    onApplyEnded: (checkout, outcomes) => {
      triageMetrics.applyEnded(checkout.profile.name, outcomes);
      // Never rejects, and an Apply's end should not wait for a reading.
      void metricsReadings.refresh();
    },
  });
  const access: Access =
    config.mode.kind === 'solo'
      ? { kind: 'solo', operator: config.mode.operator }
      : { kind: 'team', auth: await createTeamAuth(config.mode.oidc, config.mode.sessionSecret, {
          // Refreshing the access token is for profiles that connect with it.
          refreshBrokerTokens: profiles.some((p) => p.credentials.kind === 'operatorToken'),
          sessions: auditStore.sessions,
          seal: config.mode.sessionEncryptionKey ? keySeal(config.mode.sessionEncryptionKey) : noSeal,
          sessionIdleMs: options.sessionIdleMs ?? config.mode.sessionIdleMs,
          maxSignInsInProgress: options.maxSignInsInProgress ?? DEFAULT_MAX_SIGN_INS_IN_PROGRESS,
        }),
      };
  const forwarder = config.forwarding && createForwarder(config.forwarding.secret, (reason) => replicaMetrics.forwardingFailed(reason));
  /** Where the Background Leader can be reached: null when nobody holds the lease or its holder's own lease is over. */
  const leaderAddress = async (): Promise<string | null> => {
    const holder = await auditStore.leaderLease.currentHolder();
    return holder === null ? null : auditStore.replicas.liveAddress(holder, Date.now());
  };
  const restore = new RestoreService(auditStore, async (id) => checkouts.isRunning(id) || ((await liveCheckouts?.runningElsewhere(id)) ?? false));
  const replayRules = new ReplayRules({
    checkouts,
    state: auditStore.ruleState,
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
    ...(forwarder && {
      // The pause or resume is in the store: a leader that cannot be told finds it there by itself.
      tellLeader: async (profile: string, rule: string, by: Operator) => {
        try {
          const address = await leaderAddress();
          if (address) await forwarder.tell(address, `/api/v1/profiles/${encodeURIComponent(profile)}/replay-rules/${encodeURIComponent(rule)}/changed`, by, TELL_LEADER_WITHIN_MS);
        } catch (err) {
          app.log.info({ err, profile, rule }, 'The Background Leader could not be told of a Replay rule pause or resume; it will read it from the store');
        }
      },
    }),
    onLeaseLost: () => app.log.info('A Replay rule pass or schedule wrote nothing: this Replica is no longer the Background Leader'),
  });
  const samplerClock = options.samplerTestHooks?.clock ?? systemClock;
  const sampler = new QueueSampler({
    profiles,
    history: auditStore.history,
    intervalMs: config.historyIntervalMs,
    testHooks: options.samplerTestHooks,
    // Called only once the app below is listening.
    onError: (profile, err) => {
      if (err instanceof LeaderLeaseLost) app.log.info({ profile }, 'A sampling run wrote nothing: this Replica is no longer the Background Leader');
      else app.log.error({ err, profile }, 'A sampling run failed unexpectedly');
    },
  });
  // A former leader's snapshot stays for its next term, but it no longer says what is true now.
  const queueMetrics = new QueueMetrics(() => (leader.isLeader ? sampler.latest() : { profiles: [] }));
  sampler.onRun((finished) => queueMetrics.runFinished(finished));
  const alertMetrics = new AlertMetrics({ profiles, firingRules: (profile) => sharedReadings()?.firingRules.get(profile) ?? null });
  const notifier = new Notifier({
    onDelivered: (delivery) => alertMetrics.delivered(delivery),
    destinations: alertDestinations,
    store: auditStore.notifications,
    publicUrl: config.publicUrl,
    // Called only once the app below is listening.
    onError: (err) => app.log.error({ err }, 'The outcome of a notification could not be recorded'),
    onCloseWaitRanOut: (inProgress) => app.log.warn({ inProgress }, 'Stopping: notifications still being delivered at the limit were cut short'),
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
    onLeaseLost: () => app.log.info('Alerting wrote nothing: this Replica is no longer the Background Leader'),
  });
  sampler.onRun(async (finished) => {
    await alerting.evaluate(finished);
    await metricsReadings.refresh();
  });
  const usage = async () => bodyStoreUsage(await auditStore.storedBodyBytes(), retention);
  const originCheck = requestOriginCheck(config.mode, config.publicUrl);
  const app = await buildApp({
    forwarder,
    // Called only once the app is listening, when the leader below exists.
    leaderAddressForRoute: async () => {
      if (leader.isLeader) return null;
      const address = await leaderAddress();
      if (!address) {
        replicaMetrics.forwardingFailed('no_address');
        throw replicaUnreachable();
      }
      return address;
    },
    originCheck,
    liveCheckouts,
    endWithinMs: endAnswersWithinMs({ ...config.checkoutTiming, ...options.checkoutTiming }, limits.maxMessages),
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
    onRouteRegistered: options.onRouteRegistered,
    publicUrl: config.publicUrl,
  });

  // Roles (profile-access.ts): say which profiles anyone can act on, or that Solo Mode ignores them.
  if (access.kind === 'solo') {
    const mapped = profiles.filter((p) => p.roles).map((p) => p.name);
    if (mapped.length > 0) {
      app.log.info({ profiles: mapped }, 'Solo Mode ignores the roles of Broker Profiles: the Operator is admin on every profile');
    }
  } else {
    // Approval (v0.3): the one change for Operators of v0.2 Protected Profiles in Team Mode.
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

  // One Replica at a time runs what must run once. It claims the lease below, once Alerting has started.
  const leaderClock = options.leaderTestHooks?.clock ?? systemClock;
  const leader = new BackgroundLeader({
    holder: replicaId,
    lease: auditStore.leaderLease,
    clock: leaderClock,
    timing: options.leaderTestHooks?.timing,
    jobs: [
      alerting,
      retentionJob({
        store: auditStore,
        retention,
        historyRetentionMs: config.historyRetentionMs,
        clock: leaderClock,
        log: app.log,
        afterRun: () => metricsReadings.refresh(),
      }),
      sampler,
      ...(config.forwarding
        ? [
            goneReplicasJob({
              store: auditStore,
              everyMs: replicaLeaseTiming.renewEveryMs,
              keepMs: options.endedCheckoutRetentionMs ?? DEFAULT_ENDED_RETENTION_MS,
              log: app.log,
            }),
          ]
        : []),
      // Last, so that it starts after the sampler and stops first.
      replayRules,
    ],
    onError: (err, job) => app.log.error({ err, job }, job ? `The Background Leader's job "${job}" failed` : 'The leader lease could not be claimed or given up'),
    onChange: (isLeader) => {
      app.log.info(isLeader ? 'This Replica is now the Background Leader' : 'This Replica is no longer the Background Leader');
      // Never rejects.
      void metricsReadings.refresh();
    },
  });
  options.leaderTestHooks?.leader?.(leader);

  let metricsListener: MetricsListener | undefined;
  let forwardingListener: ForwardingListener | undefined;
  let replicaLease: ReplicaLease | undefined;
  // Shutdown, with the ports still serving, so Operators can read their Checkouts to the end, and
  // /readyz says not ready at once. Its two halves run side by side, so neither's wait adds to the
  // other's, and `pod.terminationGracePeriodSeconds` needs to cover only the longer (docs/kubernetes.md).
  const stopBackgroundWork = async () => {
    await metricsListener?.close();
    await metricsReadings.stop();
    // A single Replica has no next leader to tell of a last pass's pause, so it stays the leader until its passes end.
    if (!config.forwarding) {
      await replayRules.stop();
      await replayRules.drained();
    }
    // With several, the lease moves without waiting for a Rule Pass to give its Messages back.
    await leader.stop();
    // Before the notifier and the store. A former leader writes no Alert state: the next leader's next Sample tells of a last pass's pause.
    await replayRules.drained();
    // Up to CLOSE_WAIT_MS, so that what a last pass paused can still be told.
    await notifier.close();
    await alerting.drained();
  };
  let stopped: Promise<void> | undefined;
  const stopWork = () =>
    (stopped ??= (async () => {
      app.log.info('Shutting down: no new Checkouts, and every Checkout on this Replica ends');
      // endAll first: before its first await it refuses starts and stops every Apply.
      await Promise.all([checkouts.endAll(), stopBackgroundWork()]);
      await liveCheckouts?.settled();
      // Their records stay, saying why they ended, for the others to answer from.
      await replicaLease?.giveUp().catch((err: unknown) => app.log.error({ err }, 'This Replica could not end its lease; it runs out by itself'));
    })());
  app.addHook('onClose', async () => {
    await stopWork();
    await forwardingListener?.close();
    await auditStore.close();
  });
  try {
    // The leader's jobs. Alerting and the sampler come before the rules: a rule overdue from before a restart passes at once, and an automatic stop reads the sampler's snapshot.
    await leader.start();
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
        families: () => [...queueMetrics.families(), ...triageMetrics.families(), ...alertMetrics.families(), ...replicaMetrics.families(), ...runtimeMetrics.families()],
        // A scraper in Team Mode comes from the network by any address; Solo Mode has only loopback to protect it.
        ...(config.mode.kind === 'solo' && { refuses: (headers) => originCheck('GET', headers) !== null }),
        onError: (err) => app.log.error(err, 'A metrics scrape failed'),
      });
    } catch (err) {
      await app.close();
      throw err;
    }
  }

  // The internal port before the lease says where it is, and the lease before the web port takes a Checkout.
  if (config.forwarding && liveCheckouts) {
    const { forwarding } = config;
    try {
      await app.ready();
      forwardingListener = await startForwardingListener({
        host: options.host,
        port: forwarding.port,
        secret: forwarding.secret,
        serve: (req, res) => app.routing(req, res),
        onRefused: () => replicaMetrics.forwardingFailed('refused'),
      });
      const lease = new ReplicaLease({
        store: auditStore.replicas,
        replicaId,
        forwardingAddress: forwarding.address,
        timing: replicaLeaseTiming,
        afterRenewal: () => liveCheckouts.writeAgain(),
        onRanOut: () => checkouts.endAllOnLeaseRanOut(),
        onError: (err) => app.log.error({ err }, "This Replica's lease could not be renewed; trying again"),
      });
      await lease.start();
      replicaLease = lease;
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
    close: async () => {
      await stopWork();
      // Everything of value is done: a client still reading must not hold the store open until SIGKILL.
      const cutOff = setTimeout(() => app.server.closeAllConnections(), IN_FLIGHT_REQUESTS_MS);
      try {
        await app.close();
      } finally {
        clearTimeout(cutOff);
      }
    },
  };
}

/** A pause or resume answers no later than this for a leader that does not. It reads the store soon anyway. */
const TELL_LEADER_WITHIN_MS = 2_000;

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
  onRouteRegistered: ServerOptions['onRouteRegistered'];
  /** With other Replicas: how requests reach them. */
  forwarder: Forwarder | null;
  liveCheckouts: LiveCheckouts | null;
  /** Where to forward what must run on the Background Leader; null when this Replica is it. */
  leaderAddressForRoute(): Promise<string | null>;
  /** Refuses what a malicious page sends through an Operator's browser. */
  originCheck: RequestOriginCheck;
  /** Where Volverán is reached from outside, if known. */
  publicUrl: string | null;
  /** How long a forwarded end of a Checkout may take to answer. */
  endWithinMs: number;
}

/** What the log says of a request: what Fastify's default says, without the query, which carries the OIDC code and state of /auth/callback. */
function requestLogLine(req: FastifyRequest) {
  return {
    method: req.method,
    url: req.url.split('?', 1)[0],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/** What a client is told of a request the framework or a plugin refused. */
function refusal(statusCode: number): { code: string; message: string } {
  switch (statusCode) {
    case 403:
      return { code: 'forbidden', message: 'This request is not allowed.' };
    case 404:
      return { code: 'not_found', message: 'Nothing is here.' };
    case 413:
      return { code: 'body_too_large', message: 'The request body is too large.' };
    case 415:
      return { code: 'unsupported_media_type', message: "The request body's content type is not supported." };
    default:
      return { code: 'invalid_request', message: 'The request could not be read.' };
  }
}

async function buildApp({ originCheck, profiles, access, checkouts, replayRules, notifier, alertDestinations, audit, history, webRoot, logger, onRouteRegistered, forwarder, leaderAddressForRoute, liveCheckouts, publicUrl, endWithinMs }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: logger && { ...(logger === true ? {} : logger), serializers: { req: requestLogLine } } });
  sendSecurityHeaders(app.server, publicUrl);

  // Before any route, so none is missed.
  if (onRouteRegistered) {
    app.addHook('onRoute', ({ method, url }) => {
      for (const m of [method].flat()) onRouteRegistered({ method: m, url });
    });
  }
  serveApiUnderVersionToo(app);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { ...err.details, code: err.code, message: err.message } });
    }
    const { statusCode, code } = err as { statusCode?: number; code?: string };
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      // Its message can quote the request's body, so neither the answer nor the log carries it.
      req.log.info({ statusCode, code }, 'A request was refused');
      return reply.status(statusCode).send({ error: refusal(statusCode) });
    }
    req.log.error({ err }, 'A request failed unexpectedly');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong on the server. The details are in its log.' } });
  });

  // Before anything reads a session or forwards.
  app.addHook('onRequest', async (req) => {
    const refused = originCheck(req.method, req.headers);
    if (refused) throw refused;
  });

  // Probes answer without a session in both modes (routes/health.ts).
  registerHealthRoutes(app, audit.audit, () => checkouts.shuttingDown);

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
  const ownerOfCheckout = async (id: string) => {
    if (!liveCheckouts || checkouts.owns(id)) return null;
    const owner = await liveCheckouts.ownerOf(id);
    if (!owner) return null;
    if ('address' in owner) return owner.address;
    // Answered here from now on. A profile no longer configured leaves it unknown here.
    const profile = profiles.find((p) => p.name === owner.gone.profile);
    if (profile) checkouts.answerForGoneOwner(owner.gone, profile);
    return null;
  };
  const ownerOf = (req: FastifyRequest<{ Params: { id: string } }>) => ownerOfCheckout(req.params.id);
  const checkoutDeps = {
    checkouts,
    access: profileAccess,
    toOwner: forwarder ? forwarder.toOwner(ownerOf) : {},
    toOwnerToEnd: forwarder ? forwarder.toOwner(ownerOf, { answerWithinMs: endWithinMs }) : {},
  };
  registerSessionRoutes(app, {
    mode: access.kind,
    checkouts,
    access: profileAccess,
    ...(liveCheckouts && { activeElsewhere: (operatorId: string) => liveCheckouts.activeCheckoutOf(operatorId) }),
  });
  const alertReadings = { alerts: audit.audit.alerts, notifications: audit.audit.notifications, destinations: alertDestinations };
  registerProfileRoutes(app, profileAccess, history, alertReadings);
  // A Run now takes as long as a Checkout can.
  registerReplayRuleRoutes(app, replayRules, profileAccess, forwarder ? forwarder.toOwner(leaderAddressForRoute, { answerWithinMs: endWithinMs }) : {});
  registerAlertDestinationRoutes(app, notifier, profileAccess);
  registerAlertRoutes(app, alertReadings, profileAccess);
  registerCheckoutRoutes(app, checkoutDeps);
  registerDecisionRoutes(app, checkoutDeps);
  registerApplyRoutes(app, checkoutDeps);
  registerApprovalRoutes(app, {
    ...checkoutDeps,
    toOwnerOfApproval: forwarder ? forwarder.toOwner((req: FastifyRequest<{ Params: { checkoutId: string } }>) => ownerOfCheckout(req.params.checkoutId)) : {},
    ...(liveCheckouts && { waitingElsewhere: (approver: Operator) => liveCheckouts.waitingElsewhere(approver.id) }),
  });
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
