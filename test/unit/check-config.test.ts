// `check-config`: the image's mode that tries a profiles file and environment
// in CI. These tests run it as CI does, as a process, and read its exit status
// and output; its parser is the one startup uses.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each test starts a process, which takes a while on a busy machine.
vi.setConfig({ testTimeout: 120_000 });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const profile = (extra: string[] = [], port = 1) =>
  [
    'profiles:',
    '  - name: prod',
    `    managementUrl: http://127.0.0.1:${port}`,
    `    amqpUrl: amqp://127.0.0.1:${port}`,
    '    username: volveran',
    '    passwordEnv: PROD_PW',
    ...extra,
  ].join('\n');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'volveran-check-config-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const baseEnv = { VOLVERAN_OPERATOR: 'ana', PROD_PW: 'secret-password' };

function checkConfig(
  file: string,
  env: Record<string, string> = baseEnv,
  args: string[] = [],
): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts', 'check-config', ...args], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        VOLVERAN_PROFILES_FILE: file,
        VOLVERAN_DATA_DIR: path.join(dir, 'data'),
        ...env,
      },
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, out }));
  });
}

async function write(text: string): Promise<string> {
  const file = path.join(dir, 'profiles.yaml');
  await writeFile(file, text);
  return file;
}

describe('check-config', () => {
  it('exits 0 on a good file, and starts nothing', async () => {
    const { status, out } = await checkConfig(await write(`version: 1\n${profile()}`));
    expect(out).toContain('OK');
    expect(status).toBe(0);
    expect(existsSync(path.join(dir, 'data'))).toBe(false);
    expect(out).not.toContain('listening');
  });

  it('contacts no broker named by the file', async () => {
    let connections = 0;
    const broker: Server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = broker.address() as AddressInfo;
      const { status } = await checkConfig(await write(`version: 1\n${profile([], port)}`));
      expect(status).toBe(0);
      expect(connections).toBe(0);
    } finally {
      await new Promise((resolve) => broker.close(resolve));
    }
  });

  it('exits 1 and names the problem when startup would refuse the file', async () => {
    const { status, out } = await checkConfig(await write(`version: 1\n${profile(['    protected: maybe'])}`));
    expect(status).toBe(1);
    expect(out).toContain('protected must be true or false');
  });

  it('exits 1 when the file cannot be read', async () => {
    const { status, out } = await checkConfig(path.join(dir, 'missing.yaml'));
    expect(status).toBe(1);
    expect(out).toContain('Cannot read the Broker Profiles file');
  });

  it('refuses an unsupported version', async () => {
    const { status, out } = await checkConfig(await write(`version: 2\n${profile()}`));
    expect(status).toBe(1);
    expect(out).toContain('version');
  });

  it('exits 1 when the environment is wrong, as startup would', async () => {
    const file = await write(`version: 1\n${profile()}`);
    const { status, out } = await checkConfig(file, { ...baseEnv, VOLVERAN_CHECKOUT_MAX_MESSAGES: 'lots' });
    expect(status).toBe(1);
    expect(out).toContain('VOLVERAN_CHECKOUT_MAX_MESSAGES');
  });

  it('applies the checks startup makes across the file and the environment', async () => {
    const file = await write(
      'version: 1\nprofiles:\n  - name: prod\n    managementUrl: http://127.0.0.1:1\n    amqpUrl: amqp://127.0.0.1:1\n    credentials: operatorToken\n',
    );
    const { status, out } = await checkConfig(file);
    expect(status).toBe(1);
    expect(out).toContain('needs Team Mode');
  });

  it('refuses a PostgreSQL CA file it cannot read, and contacts no database', async () => {
    const file = await write(`version: 1\n${profile()}`);
    const { status, out } = await checkConfig(file, {
      ...baseEnv,
      VOLVERAN_POSTGRES_URL: 'postgres://volveran:hunter2@127.0.0.1:1/volveran',
      VOLVERAN_POSTGRES_CA_FILE: path.join(dir, 'missing-ca.crt'),
    });
    expect(status).toBe(1);
    expect(out).toContain('VOLVERAN_POSTGRES_CA_FILE could not be read');
    expect(out).not.toContain('hunter2');
  });

  it('exits 1 on an unknown key, as startup would, naming its path', async () => {
    const { status, out } = await checkConfig(await write(`version: 1\n${profile(['    requireAproval: false'])}`));
    expect(status).toBe(1);
    expect(out).toContain('profiles[0] ("prod").requireAproval is not a key');
    expect(out).toContain('would refuse to start');
  });

  it('exits 1 on an unknown key deep in the file, naming its path', async () => {
    const rule = [
      '    replayRules:',
      '      - name: r',
      '        vhost: /',
      '        queue: q',
      '        every: 5m',
      '        backoff: { initial: 1m, max: 1h, multiplyer: 2 }',
      '        maxAttempts: 1',
      '        stopWhen: { diedAgain: 1, within: 1m }',
    ];
    const { status, out } = await checkConfig(await write(`version: 1\n${profile(rule)}`));
    expect(status).toBe(1);
    expect(out).toContain('replayRules[0] ("r").backoff.multiplyer is not a key');
  });

  it('warns about a file without a version, and still exits 0', async () => {
    const { status, out } = await checkConfig(await write(profile()));
    expect(status).toBe(0);
    expect(out).toMatch(/warning:.*version: 1/);
  });

  it('warns about a password variable that is not set, and still exits 0, as startup would start', async () => {
    const { status, out } = await checkConfig(await write(`version: 1\n${profile()}`), { VOLVERAN_OPERATOR: 'ana' });
    expect(status).toBe(0);
    expect(out).toMatch(/warning:.*PROD_PW/);
  });

  it('never prints a secret', async () => {
    const file = await write(`version: 1\nextra: leaked-value\n${profile()}`);
    const { status, out } = await checkConfig(file);
    expect(status).toBe(1);
    expect(out).toContain('extra is not a key');
    expect(out).not.toContain('secret-password');
    expect(out).not.toContain('leaked-value');
  });

  it('refuses an argument rather than checking some other file than the one named', async () => {
    const { status, out } = await checkConfig(await write(`version: 1\n${profile()}`), baseEnv, ['other.yaml']);
    expect(status).toBe(1);
    expect(out).toContain('VOLVERAN_PROFILES_FILE');
  });
});
