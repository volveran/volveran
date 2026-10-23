#!/usr/bin/env node
// Brings this checkout's docker-compose test broker up or down (see README
// "Development"). The compose project name and host ports come from
// scripts/test-broker-env.mjs: one broker per checkout, on random free ports
// unless VOLVERAN_TEST_AMQP_PORT / VOLVERAN_TEST_MGMT_PORT are set.
//
//   node scripts/test-broker.mjs up
//   node scripts/test-broker.mjs down
//   node scripts/test-broker.mjs run -- <command...>   # up, run, down
//
// `run` passes the broker's ports to the command as VOLVERAN_TEST_AMQP_PORT
// and VOLVERAN_TEST_MGMT_PORT, and tears the broker down afterwards (also on
// Ctrl-C) unless VOLVERAN_TEST_KEEP_BROKER=1.
import { spawn, spawnSync } from 'node:child_process';
import { composeFile, publishedPorts, repoRoot, testBrokerSettings } from './test-broker-env.mjs';

const settings = testBrokerSettings(repoRoot, process.env);

const composeEnv = {
  ...process.env,
  VOLVERAN_TEST_PROJECT: settings.project,
  VOLVERAN_TEST_AMQP_PORT: settings.amqpPort ?? '',
  VOLVERAN_TEST_MGMT_PORT: settings.mgmtPort ?? '',
};

function compose(...args) {
  const result = spawnSync('docker', ['compose', '-p', settings.project, '-f', composeFile, ...args], {
    stdio: 'inherit',
    env: composeEnv,
  });
  return result.status ?? 1;
}

function up() {
  const status = compose('up', '-d', '--wait', '--wait-timeout', '180');
  if (status !== 0) return { status };
  const ports = publishedPorts(settings.project);
  console.log(`[test-broker] up: project=${settings.project} amqp=${ports.amqpPort} mgmt=${ports.mgmtPort}`);
  return { status, ports };
}

function down() {
  return compose('down', '-v', '--remove-orphans');
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'up') {
  process.exit(up().status);
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
  const started = up();
  if (started.status !== 0 || !started.ports) finish(started.status || 1);
  const child = spawn(cmd[0], cmd.slice(1), {
    stdio: 'inherit',
    env: {
      ...process.env,
      VOLVERAN_TEST_PROJECT: settings.project,
      VOLVERAN_TEST_AMQP_PORT: started.ports.amqpPort,
      VOLVERAN_TEST_MGMT_PORT: started.ports.mgmtPort,
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
