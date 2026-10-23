// Where the test broker of this checkout lives: its docker compose project
// name and host ports. Shared by scripts/test-broker.mjs and the test helpers
// in test/broker/client.ts, so both find the same broker.
//
// Every checkout (worktree) gets its own compose project, named after its
// directory plus a hash of its path, so brokers of several worktrees run side
// by side. Host ports are left to Docker (random free ports, bound to
// 127.0.0.1) unless VOLVERAN_TEST_AMQP_PORT / VOLVERAN_TEST_MGMT_PORT are set.
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
 */

/**
 * The compose project and host ports for the checkout at `root`, with
 * VOLVERAN_TEST_PROJECT, VOLVERAN_TEST_AMQP_PORT and VOLVERAN_TEST_MGMT_PORT
 * from `env` taking precedence.
 * @param {string} root
 * @param {Record<string, string | undefined>} env
 * @returns {TestBrokerSettings}
 */
export function testBrokerSettings(root, env) {
  return {
    project: env.VOLVERAN_TEST_PROJECT || defaultProject(root),
    amqpPort: env.VOLVERAN_TEST_AMQP_PORT || undefined,
    mgmtPort: env.VOLVERAN_TEST_MGMT_PORT || undefined,
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
 * The host ports the running test broker of `project` was given, asked from
 * docker compose. Throws when the broker is not running.
 * @param {string} project
 * @returns {{ amqpPort: string, mgmtPort: string }}
 */
export function publishedPorts(project) {
  /** @param {number} containerPort */
  const port = (containerPort) => {
    let out = '';
    try {
      out = execFileSync(
        'docker',
        ['compose', '-p', project, '-f', composeFile, 'port', 'rabbitmq', String(containerPort)],
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
  return { amqpPort: port(5672), mgmtPort: port(15672) };
}
