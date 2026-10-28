// The web app the server serves. Run from source (as `npm run dev` does) it
// must not serve src/web, the Vite source no browser can run; an explicit
// VOLVERAN_WEB_ROOT is still served.
import type { ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { brokerUsers, makeTempDir, spawnServer, testProfile } from './harness.js';

describe('the web root of a server run from source', () => {
  let dir: string | undefined;
  let child: ChildProcess | undefined;
  afterEach(async () => {
    child?.kill('SIGKILL');
    child = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const spawn = async (env: Record<string, string> = {}) => {
    dir = await makeTempDir('web-root');
    const spawned = await spawnServer({
      script: 'src/server/main.ts',
      dir,
      profiles: [testProfile({ name: 'dev', passwordEnv: 'DEV_PW' })],
      env: { VOLVERAN_OPERATOR: 'web-operator', DEV_PW: brokerUsers.admin.password, ...env },
    });
    child = spawned.child;
    return spawned.url;
  };

  it('serves no web app and points at the Vite dev server', async () => {
    const url = await spawn();
    for (const urlPath of ['/', '/main.tsx', '/api.ts', '/index.html']) {
      const res = await fetch(url + urlPath);
      expect(res.status, urlPath).toBe(404);
      expect(await res.text(), urlPath).toContain('http://localhost:5173');
    }
    expect((await fetch(url + '/api/session')).status).toBe(200);
  });

  it('serves the web root named in VOLVERAN_WEB_ROOT', async () => {
    const webRoot = path.join(await makeTempDir('web-root-built'), 'web');
    await mkdir(path.join(webRoot, 'assets'), { recursive: true });
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>built</title>');
    await writeFile(path.join(webRoot, 'assets', 'index.js'), 'export {};');
    try {
      const url = await spawn({ VOLVERAN_WEB_ROOT: webRoot });
      const page = await fetch(url + '/');
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<title>built</title>');
      const script = await fetch(url + '/assets/index.js');
      expect(script.status).toBe(200);
      expect(script.headers.get('content-type')).toMatch(/javascript/);
    } finally {
      await rm(path.dirname(webRoot), { recursive: true, force: true });
    }
  });
});
