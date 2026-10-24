// Brings this checkout's docker-compose test broker and mock OIDC provider up
// or down (see README "Development"). The compose project name and host ports
// come from scripts/test-broker-env.mjs: one broker per checkout, on random
// free ports unless VOLVERAN_TEST_AMQP_PORT / VOLVERAN_TEST_MGMT_PORT /
// VOLVERAN_TEST_OIDC_PORT are set.
//
//   node scripts/test-broker.mjs up
//   node scripts/test-broker.mjs down
//   node scripts/test-broker.mjs run -- <command...>   # up, run, down
//
// `run` passes the ports to the command as VOLVERAN_TEST_AMQP_PORT,
// VOLVERAN_TEST_MGMT_PORT and VOLVERAN_TEST_OIDC_PORT, and tears the broker down afterwards (also on
// Ctrl-C) unless VOLVERAN_TEST_KEEP_BROKER=1.
import { spawn, spawnSync } from 'node:child_process';
import { composeFile, publishedPorts, repoRoot, testBrokerSettings } from './test-broker-env.mjs';

const settings = testBrokerSettings(repoRoot, process.env);

const composeEnv = {
  ...process.env,
  VOLVERAN_TEST_PROJECT: settings.project,
  VOLVERAN_TEST_AMQP_PORT: settings.amqpPort ?? '',
  VOLVERAN_TEST_MGMT_PORT: settings.mgmtPort ?? '',
  VOLVERAN_TEST_OIDC_PORT: settings.oidcPort ?? '',
};

function compose(...args) {
  const result = spawnSync('docker', ['compose', '-p', settings.project, '-f', composeFile, ...args], {
    stdio: 'inherit',
    env: composeEnv,
  });
  return result.status ?? 1;
}

// The OIDC provider image has no shell for a compose healthcheck, so wait
// here until it serves its discovery document.
async function waitForOidc(port) {
  const url = `http://127.0.0.1:${port}/default/.well-known/openid-configuration`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error(`[test-broker] the mock OIDC provider did not answer at ${url}`);
  return false;
}

async function up() {
  const status = compose('up', '-d', '--wait', '--wait-timeout', '180');
  if (status !== 0) return { status };
  const ports = publishedPorts(settings.project);
  if (!(await waitForOidc(ports.oidcPort))) return { status: 1 };
  console.log(
    `[test-broker] up: project=${settings.project} amqp=${ports.amqpPort} mgmt=${ports.mgmtPort} oidc=${ports.oidcPort}`,
  );
  return { status, ports };
}

function down() {
  return compose('down', '-v', '--remove-orphans');
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'up') {
  process.exit((await up()).status);
} else if (command === 'down') {
  process.exit(down());
} else if (command === 'run') {
  const cmd = rest[0] === '--' ? rest.slice(1) : rest;
  if (cmd.length === 0) {
    console.error('usage: test-broker.mjs run -- <command...>');
    process.exit(2);
  }
  const keep = process.env.VOLVERAN_TEST_KEEP_BROKER === '1';
  const finish = (status) => {
    if (!keep) down();
    process.exit(status);
  };
  const started = await up();
  if (started.status !== 0 || !started.ports) finish(started.status || 1);
  const child = spawn(cmd[0], cmd.slice(1), {
    stdio: 'inherit',
    env: {
      ...process.env,
      VOLVERAN_TEST_PROJECT: settings.project,
      VOLVERAN_TEST_AMQP_PORT: started.ports.amqpPort,
      VOLVERAN_TEST_MGMT_PORT: started.ports.mgmtPort,
      VOLVERAN_TEST_OIDC_PORT: started.ports.oidcPort,
    },
    shell: process.platform === 'win32',
  });
  // The child gets Ctrl-C from the terminal too; wait for it, then tear down.
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {});
  child.on('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)));
} else {
  console.error('usage: test-broker.mjs up|down|run -- <command...>');
  process.exit(2);
}
