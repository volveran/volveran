// HTTP JSON API and the built web app, served by one Fastify process.
// startServer is the in-process entry point of both main.ts and the
// integration test harness (test/integration/harness.ts).
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { bodyStoreUsage, type BodyRetention } from './audit/body-retention.js';
import { RestoreService } from './audit/restore.js';
import { AuditStore } from './audit/store.js';
import { createTeamAuth, type TeamAuth } from './auth.js';
import { CheckoutManager, type CheckoutTestHooks } from './checkout/manager.js';
import { loadConfig } from './config.js';
import { ConfigError } from './config-error.js';
import { HttpError } from './http-error.js';
import { loadProfilesFile, type BrokerProfile } from './profiles.js';
import type { CheckoutLimits } from './triage/checkout-collection.js';
import type { CheckoutTiming } from './triage/checkout-timing.js';
import { registerCheckoutRoutes } from './routes/checkouts.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerApplyRoutes } from './routes/apply.js';
import { registerExportRoutes } from './routes/export.js';
import { registerAuditRoutes, type AuditRouteDeps } from './routes/audit.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerProfileRoutes } from './routes/profiles.js';
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
  logger?: boolean;
  /** Overrides the Checkout limits from VOLVERAN_CHECKOUT_MAX_MESSAGES / VOLVERAN_CHECKOUT_MAX_MB. */
  checkoutLimits?: Partial<CheckoutLimits>;
  /** Overrides the Checkout timing from VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES / VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS. */
  checkoutTiming?: Partial<CheckoutTiming>;
  /** How long an ended or lost Checkout stays readable (default 15 min). */
  endedCheckoutRetentionMs?: number;
  /** Overrides the body retention from VOLVERAN_BODY_RETENTION_DAYS / _MAX_BYTES / _INTERVAL_MINUTES. */
  bodyRetention?: Partial<BodyRetention>;
  /** Test seams of the Checkout manager; unset in production. */
  checkoutTestHooks?: CheckoutTestHooks;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/** Checks the configuration (throwing a ConfigError), then listens. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const loaded = loadConfig(options.env, options.host);
  if (!loaded.ok) throw new ConfigError(loaded.error);
  const { config } = loaded;
  const retention = { ...config.bodyRetention, ...options.bodyRetention };
  const profiles = await loadProfilesFile(options.profilesFile, options.env);
  const audit = new AuditStore(options.dataDir);
  const checkouts = new CheckoutManager({
    audit,
    limits: { ...config.checkoutLimits, ...options.checkoutLimits },
    timing: { ...config.checkoutTiming, ...options.checkoutTiming },
    endedRetentionMs: options.endedCheckoutRetentionMs,
    testHooks: options.checkoutTestHooks,
  });
  const access: Access =
    config.mode.kind === 'solo'
      ? { kind: 'solo', operator: config.mode.operator }
      : { kind: 'team', auth: await createTeamAuth(config.mode.oidc, config.mode.sessionSecret) };
  const restore = new RestoreService(audit, (id) => checkouts.isRunning(id));
  const usage = () => bodyStoreUsage(audit.storedBodyBytes(), retention);
  // /readyz answers 200 only between the end of startup and the start of shutdown.
  let ready = false;
  const app = await buildApp({
    profiles,
    access,
    checkouts,
    audit: { audit, restore, usage },
    webRoot: options.webRoot,
    logger: options.logger ?? false,
    isReady: () => ready,
  });

  // Retention: evict Discarded bodies past the limits at startup, then on a schedule.
  const evict = () => {
    try {
      const { evicted } = audit.evictBodies({ now: new Date(), ...retention });
      if (evicted > 0) app.log.info({ evicted }, 'Retention evicted Discarded Message bodies');
    } catch (err) {
      app.log.error(err, 'Retention could not evict Discarded Message bodies');
    }
  };
  evict();
  const retentionTimer = setInterval(evict, retention.intervalMs);
  retentionTimer.unref();

  app.addHook('preClose', async () => {
    ready = false;
  });
  // Every held Message goes back to its queue (an Apply in progress finishes
  // first) before the audit store closes and the process exits.
  app.addHook('onClose', async () => {
    clearInterval(retentionTimer);
    await checkouts.endAll();
    audit.close();
  });
  ready = true;
  await app.listen({ host: options.host, port: options.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const host = options.host.includes(':') ? `[${options.host}]` : options.host;
  return {
    url: `http://${host}:${port}`,
    close: () => app.close(),
  };
}

/** Who acts: Solo Mode's configured Operator, or Team Mode's sign-in. */
type Access = { kind: 'solo'; operator: string } | { kind: 'team'; auth: TeamAuth };

interface AppOptions {
  profiles: BrokerProfile[];
  access: Access;
  checkouts: CheckoutManager;
  audit: AuditRouteDeps;
  /** Directory with the built web app; omitted or missing means API only. */
  webRoot: string | undefined;
  logger: boolean;
  /** Whether startup has finished, for /readyz. */
  isReady: () => boolean;
}

async function buildApp({ profiles, access, checkouts, audit, webRoot, logger, isReady }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { ...err.details, code: err.code, message: err.message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal_error', message: (err as Error).message } });
  });

  // Probes answer without a session in both modes (routes/health.ts).
  registerHealthRoutes(app, { isReady });

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
  const profileAccess = new ProfileAccessCheck(profiles);
  const checkoutDeps = { checkouts, access: profileAccess };
  registerSessionRoutes(app, { mode: access.kind, checkouts });
  registerProfileRoutes(app, profileAccess);
  registerCheckoutRoutes(app, checkoutDeps);
  registerDecisionRoutes(app, checkoutDeps);
  registerApplyRoutes(app, checkoutDeps);
  registerExportRoutes(app, checkoutDeps);
  registerAuditRoutes(app, audit, profileAccess);

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
