// HTTP JSON API and the built web app, served by one Fastify process.
// startServer is the in-process entry point of both main.ts and the
// integration test harness (test/integration/harness.ts).
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createTeamAuth, type TeamAuth } from './auth.js';
import { CheckoutManager, type CheckoutTestHooks } from './checkout/manager.js';
import { ConfigError } from './config-error.js';
import { HttpError } from './http-error.js';
import { ManagementClient } from './management.js';
import { loadProfilesFile, type BrokerProfile } from './profiles.js';
import { parseCheckoutLimits, type CheckoutLimits } from './triage/checkout-collection.js';
import { parseCheckoutTiming, type CheckoutTiming } from './triage/checkout-timing.js';
import { checkoutHolders, isLockQueue } from './triage/checkout-lock.js';
import { arrangeQueues, checkoutAvailability, deadLetterSetupWarning, deadLetterSources } from './triage/queue-list.js';
import { registerCheckoutRoutes } from './routes/checkouts.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { attachOperator, operatorOf } from './operator.js';
import { resolveRunMode, type RunMode } from './run-mode.js';

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
  logger?: boolean;
  /** Overrides the Checkout limits from VOLVERAN_CHECKOUT_MAX_MESSAGES / VOLVERAN_CHECKOUT_MAX_MB. */
  checkoutLimits?: Partial<CheckoutLimits>;
  /** Overrides the Checkout timing from VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES / VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS. */
  checkoutTiming?: Partial<CheckoutTiming>;
  /** How long an ended or lost Checkout stays readable (default 15 min). */
  endedCheckoutRetentionMs?: number;
  /** Test seams of the Checkout manager; unset in production. */
  checkoutTestHooks?: CheckoutTestHooks;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/** Checks the configuration (throwing a ConfigError), then listens. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const mode = resolveRunMode(options.env, options.host);
  if (!mode.ok) throw new ConfigError(mode.error);
  const limits = parseCheckoutLimits(options.env);
  if (!limits.ok) throw new ConfigError(limits.error);
  const timing = parseCheckoutTiming(options.env);
  if (!timing.ok) throw new ConfigError(timing.error);
  const profiles = await loadProfilesFile(options.profilesFile, options.env);
  const checkouts = new CheckoutManager({
    limits: { ...limits.limits, ...options.checkoutLimits },
    timing: { ...timing.timing, ...options.checkoutTiming },
    endedRetentionMs: options.endedCheckoutRetentionMs,
    testHooks: options.checkoutTestHooks,
  });
  const teamAuth = mode.mode.kind === 'team' ? await createTeamAuth(mode.mode.oidc, mode.mode.sessionSecret) : undefined;
  const app = await buildApp(profiles, mode.mode, teamAuth, checkouts, options);
  // Every held Message goes back to its queue before the process exits.
  app.addHook('onClose', () => checkouts.endAll());
  await app.listen({ host: options.host, port: options.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const host = options.host.includes(':') ? `[${options.host}]` : options.host;
  return {
    url: `http://${host}:${port}`,
    close: () => app.close(),
  };
}

async function buildApp(
  profiles: BrokerProfile[],
  mode: RunMode,
  teamAuth: TeamAuth | undefined,
  checkouts: CheckoutManager,
  options: ServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { ...err.details, code: err.code, message: err.message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal_error', message: (err as Error).message } });
  });

  // Every request carries its Operator (operator.ts); in Team Mode, /api/
  // routes refuse requests without a session before any handler runs.
  if (mode.kind === 'solo') {
    const operator = { id: mode.operator, displayName: mode.operator };
    attachOperator(app, () => operator);
  } else {
    await teamAuth!.register(app);
  }

  // Who is acting: in Solo Mode the configured name, in Team Mode the signed-in person.
  // `checkoutId` is the Operator's active Checkout, so the web app can return to it.
  app.get('/api/session', async (req) => {
    const operator = operatorOf(req);
    const checkoutId = checkouts.activeFor(operator.id)?.id ?? null;
    if (mode.kind === 'solo') return { mode: 'solo', operator: operator.displayName, checkoutId };
    return {
      mode: 'team',
      operator: operator.displayName,
      operatorId: operator.id,
      ...(operator.email !== undefined && { email: operator.email }),
      ...(operator.name !== undefined && { name: operator.name }),
      checkoutId,
    };
  });

  app.get('/api/profiles', async () => ({
    profiles: profiles.map((p) => ({
      name: p.name,
      username: p.username,
      managementUrl: p.managementUrl,
      amqpUrl: p.amqpUrl,
      passwordEnv: p.passwordEnv,
      passwordSet: p.password !== undefined,
      vhosts: p.vhosts,
      defaultQueueFilter: p.defaultQueueFilter ?? null,
      protected: p.protected,
    })),
  }));

  const findProfile = (name: string): BrokerProfile => {
    const profile = profiles.find((p) => p.name === name);
    if (!profile) throw new HttpError(404, 'profile_not_found', `No Broker Profile named "${name}".`);
    return profile;
  };

  const checkVhost = (profile: BrokerProfile, vhost: string) => {
    if (profile.vhosts !== 'all' && !profile.vhosts.includes(vhost)) {
      throw new HttpError(404, 'vhost_not_in_profile', `Vhost "${vhost}" is not configured for Broker Profile "${profile.name}".`);
    }
  };

  app.get<{ Params: { profile: string } }>('/api/profiles/:profile/vhosts', async (req) => {
    const profile = findProfile(req.params.profile);
    const names = profile.vhosts === 'all' ? await new ManagementClient(profile).listVhosts() : profile.vhosts;
    return { vhosts: names.map((name) => ({ name })) };
  });

  // Depth and consumer counts come from management statistics, which lag the
  // broker by a few seconds: the list calls the depth approximate.
  app.get<{
    Params: { profile: string; vhost: string };
    Querystring: { search?: string; onlyDeadLetterQueues?: string };
  }>('/api/profiles/:profile/vhosts/:vhost/queues', async (req) => {
    const profile = findProfile(req.params.profile);
    const { vhost } = req.params;
    checkVhost(profile, vhost);
    const client = new ManagementClient(profile);
    const [allQueues, bindings] = await Promise.all([client.listQueues(vhost), client.listBindings(vhost)]);
    // Checkout lock queues are Volverán's own: not listed, but they say who holds which queue.
    const holders = checkoutHolders(allQueues);
    const queues = allQueues.filter((q) => !isLockQueue(q.name));
    const rows = queues.map((q) => ({
      name: q.name,
      type: q.type,
      approximateMessages: q.messages,
      consumers: q.consumers,
      checkout: checkoutAvailability(q.type),
      checkedOutBy: holders.get(q.name) ?? null,
    }));
    const arranged = arrangeQueues(rows, {
      defaultQueueFilter: profile.defaultQueueFilter,
      deadLetterSources: deadLetterSources(queues, bindings),
      onlyDeadLetterQueues: req.query.onlyDeadLetterQueues === 'true',
      search: req.query.search,
    });
    const byName = new Map(queues.map((q) => [q.name, q]));
    return {
      defaultQueueFilter: profile.defaultQueueFilter ?? null,
      queues: arranged.map((row) => ({
        ...row,
        setupWarning: deadLetterSetupWarning({ ...byName.get(row.name)!, deadLetterQueue: row.deadLetterQueue }),
      })),
    };
  });

  registerCheckoutRoutes(app, {
    checkouts,
    queueRef: (profileName, vhost, queue) => {
      const profile = findProfile(profileName);
      checkVhost(profile, vhost);
      return { profile, vhost, queue };
    },
  });
  registerDecisionRoutes(app, checkouts);

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'not_found', message: `No route ${req.method} ${req.url}` } });
    }
    if (options.webRoot && existsSync(options.webRoot)) return reply.sendFile('index.html');
    return reply.status(404).send('Web app not built');
  });

  if (options.webRoot && existsSync(options.webRoot)) {
    app.register(fastifyStatic, { root: options.webRoot });
  }

  return app;
}
