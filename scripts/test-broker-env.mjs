// Where the test broker (and mock OIDC provider) of this checkout lives: its
// docker compose project name and host ports. Shared by scripts/test-broker.mjs and the test helpers
// in test/broker/client.ts, so both find the same broker.
//
// Every checkout (worktree) gets its own compose project, named after its
// directory plus a hash of its path, so brokers of several worktrees run side
// by side. Host ports are left to Docker (random free ports, bound to
// 127.0.0.1) unless VOLVERAN_TEST_AMQP_PORT / VOLVERAN_TEST_MGMT_PORT /
// VOLVERAN_TEST_OIDC_PORT (and, for the OAuth 2.0 broker,
// VOLVERAN_TEST_OAUTH_AMQP_PORT / VOLVERAN_TEST_OAUTH_MGMT_PORT) are set.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of this checkout. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The compose file of the test broker. */
export const composeFile = path.join(repoRoot, 'test/broker/docker-compose.yml');

/**
 * @typedef {object} TestBrokerSettings
 * @property {string} project compose project name
 * @property {string | undefined} amqpPort host AMQP port, undefined for a random free port
 * @property {string | undefined} mgmtPort host management port, undefined for a random free port
 * @property {string | undefined} oidcPort host port of the mock OIDC provider, undefined for a random free port
 * @property {string | undefined} oauthAmqpPort host AMQP port of the OAuth 2.0 broker, undefined for a random free port
 * @property {string | undefined} oauthMgmtPort host management port of the OAuth 2.0 broker, undefined for a random free port
 */

/**
 * The compose project and host ports for the checkout at `root`, with
 * VOLVERAN_TEST_PROJECT, VOLVERAN_TEST_AMQP_PORT, VOLVERAN_TEST_MGMT_PORT,
 * VOLVERAN_TEST_OIDC_PORT, VOLVERAN_TEST_OAUTH_AMQP_PORT and
 * VOLVERAN_TEST_OAUTH_MGMT_PORT from `env` taking precedence.
 * @param {string} root
 * @param {Record<string, string | undefined>} env
 * @returns {TestBrokerSettings}
 */
export function testBrokerSettings(root, env) {
  return {
    project: env.VOLVERAN_TEST_PROJECT || defaultProject(root),
    amqpPort: env.VOLVERAN_TEST_AMQP_PORT || undefined,
    mgmtPort: env.VOLVERAN_TEST_MGMT_PORT || undefined,
    oidcPort: env.VOLVERAN_TEST_OIDC_PORT || undefined,
    oauthAmqpPort: env.VOLVERAN_TEST_OAUTH_AMQP_PORT || undefined,
    oauthMgmtPort: env.VOLVERAN_TEST_OAUTH_MGMT_PORT || undefined,
  };
}

/** @param {string} root */
function defaultProject(root) {
  const resolved = path.resolve(root);
  const slug = path
    .basename(resolved)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return `volveran-test-${slug ? `${slug}-` : ''}${hash}`;
}

/**
 * The host ports the running test broker, OAuth 2.0 broker and OIDC provider
 * of `project` were given, asked from docker compose. Throws when they are
 * not running.
 * @param {string} project
 * @returns {{ amqpPort: string, mgmtPort: string, oidcPort: string, oauthAmqpPort: string, oauthMgmtPort: string }}
 */
export function publishedPorts(project) {
  /** @param {number} containerPort @param {string} [service] */
  const port = (containerPort, service = 'rabbitmq') => {
    let out = '';
    try {
      out = execFileSync(
        'docker',
        ['compose', '-p', project, '-f', composeFile, 'port', service, String(containerPort)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
    } catch {
      // handled below
    }
    const match = /:(\d+)$/.exec(out);
    if (!match?.[1]) {
      throw new Error(
        `The test broker (compose project ${project}) is not running. Start it with npm run broker:up, or set VOLVERAN_TEST_AMQP_PORT and VOLVERAN_TEST_MGMT_PORT.`,
      );
    }
    return match[1];
  };
  return {
    amqpPort: port(5672),
    mgmtPort: port(15672),
    oidcPort: port(8080, 'oidc'),
    oauthAmqpPort: port(5672, 'rabbitmq-oauth'),
    oauthMgmtPort: port(15672, 'rabbitmq-oauth'),
  };
}
