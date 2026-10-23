// Solo Mode (ADR 0002): no sign-in, so the app refuses to listen anywhere but
// loopback, and the Operator is the name configured for this machine.
import { spawnSync } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { repoRoot } from '../../scripts/test-broker-env.mjs';
import { makeTempDir, startApp, testOperator, testProfile, type TestApp } from './harness.js';

describe('Solo Mode', () => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each(['0.0.0.0', '::', '192.0.2.10'])('refuses to start listening on %s', async (host) => {
    await expect(startApp({ profiles: [testProfile({ name: 'dev' })], host })).rejects.toThrow(
      /Solo Mode.*loopback/s,
    );
  });

  it('listens on a loopback address', async () => {
    app = await startApp({ profiles: [testProfile({ name: 'dev' })], host: '127.0.0.1' });
    expect((await app.get('/api/profiles')).status).toBe(200);
  });

  it('names the Operator from VOLVERAN_OPERATOR', async () => {
    app = await startApp({ profiles: [testProfile({ name: 'dev' })], env: { USER: 'login-name' } });
    const res = await app.get('/api/session');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'solo', operator: testOperator, checkoutId: null });
  });

  it('falls back to $USER for the Operator', async () => {
    app = await startApp({
      profiles: [testProfile({ name: 'dev' })],
      env: { VOLVERAN_OPERATOR: undefined, USER: 'login-name' },
    });
    expect((await app.get('/api/session')).body.operator).toBe('login-name');
  });

  it('refuses to start without an Operator name', async () => {
    await expect(
      startApp({ profiles: [testProfile({ name: 'dev' })], env: { VOLVERAN_OPERATOR: undefined, USER: undefined } }),
    ).rejects.toThrow(/VOLVERAN_OPERATOR/);
  });

  it('refuses an auth setting it does not know', async () => {
    await expect(
      startApp({ profiles: [testProfile({ name: 'dev' })], env: { VOLVERAN_AUTH: 'ldap' } }),
    ).rejects.toThrow(/VOLVERAN_AUTH/);
  });
});

describe('the volveran process', () => {
  it('exits with an explanatory message when started in Solo Mode on 0.0.0.0', async () => {
    const dir = await makeTempDir('main');
    try {
      const profilesFile = path.join(dir, 'profiles.yaml');
      await writeFile(profilesFile, stringify({ profiles: [testProfile({ name: 'dev' })] }));
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
        cwd: repoRoot,
        env: { PATH: process.env.PATH, VOLVERAN_PROFILES_FILE: profilesFile, VOLVERAN_HOST: '0.0.0.0', VOLVERAN_PORT: '0', VOLVERAN_OPERATOR: 'me' },
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/^Configuration error: Solo Mode .*only listens on a loopback address.*not on "0\.0\.0\.0"/m);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
