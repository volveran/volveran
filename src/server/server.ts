// HTTP JSON API and the built web app, served by one Fastify process.
// startServer is the in-process entry point of both main.ts and the
// integration test harness (test/integration/harness.ts).
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ConfigError } from './config-error.js';
import { HttpError } from './http-error.js';
import { ManagementClient } from './management.js';
import { loadProfilesFile, type BrokerProfile } from './profiles.js';
import { arrangeQueues, checkoutAvailability, deadLetterSources } from './triage/queue-list.js';
import { resolveRunMode, type RunMode } from './run-mode.js';

export interface ServerOptions {
  /** The Broker Profiles YAML file. */
  profilesFile: string;
  /** Environment: password variables of the profiles, VOLVERAN_AUTH, VOLVERAN_OPERATOR, USER. */
  env: Record<string, string | undefined>;
  host: string;
  /** 0 picks a free port. */
  port: number;
  /** Directory with the built web app; omitted or missing means API only. */
  webRoot?: string;
  logger?: boolean;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/** Checks the configuration (throwing a ConfigError), then listens. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const mode = resolveRunMode(options.env, options.host);
  if (!mode.ok) throw new ConfigError(mode.error);
  const profiles = await loadProfilesFile(options.profilesFile, options.env);
  const app = buildApp(profiles, mode.mode, options);
  await app.listen({ host: options.host, port: options.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const host = options.host.includes(':') ? `[${options.host}]` : options.host;
  return {
    url: `http://${host}:${port}`,
    close: () => app.close(),
  };
}

function buildApp(profiles: BrokerProfile[], mode: RunMode, options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { ...err.details, code: err.code, message: err.message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal_error', message: (err as Error).message } });
  });

  // Who is acting: in Solo Mode the configured Operator name.
  app.get('/api/session', async () => ({ mode: mode.kind, operator: mode.operator }));

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
    const [queues, bindings] = await Promise.all([client.listQueues(vhost), client.listBindings(vhost)]);
    const rows = queues.map((q) => ({
      name: q.name,
      type: q.type,
      approximateMessages: q.messages,
      consumers: q.consumers,
      checkout: checkoutAvailability(q.type),
    }));
    return {
      defaultQueueFilter: profile.defaultQueueFilter ?? null,
      queues: arrangeQueues(rows, {
        defaultQueueFilter: profile.defaultQueueFilter,
        deadLetterSources: deadLetterSources(queues, bindings),
        onlyDeadLetterQueues: req.query.onlyDeadLetterQueues === 'true',
        search: req.query.search,
      }),
    };
  });

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
