// A real `helm upgrade` between two published charts, following docs/upgrading-to-1.0.md and,
// for the move to PostgreSQL, the Job in docs/postgresql.md as it is written there. Only
// `VOLVERAN_SMOKE_RUN=chart-upgrade VOLVERAN_SMOKE_PUBLISHED=<version> node scripts/kind-smoke.mjs` runs it,
// with VOLVERAN_SMOKE_UPGRADE_FROM (by default 0.5.1); no suite does, as it needs what is published.
// Each chart runs the image of its own appVersion: the values name no tag.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { TestBrowser } from '../integration/oidc-provider.js';
import { deadLetterOrder, eventually, management, portForward, readyPod, replacementOf, type PortForward, type VolveranPod } from './cluster.js';
import { appNamespace, depsNamespace, kubeconfig, kubeContext, kubectl, oidc, ports, publishedVersion, releaseName, repoRoot, run, smokeDir, upgradeFromVersion } from './kind-env.mjs';

const chart = 'oci://ghcr.io/volveran/charts/volveran';
const appUrl = `http://127.0.0.1:${ports.app}`;
const operator = { sub: 'smoke-operator', email: 'operator@example.com', name: 'Smoke Operator', groups: ['smoke-admins'] };
const stamp = Date.now();
const ids = {
  kept: `upgrade-kept-${stamp}`,
  restoredByOld: `upgrade-restored-${stamp}`,
  restoredOnSqlite: `upgrade-sqlite-${stamp}`,
  restoredOnPostgres: `upgrade-postgres-${stamp}`,
};
const payloadOf = (id: string) => JSON.stringify({ order: id, total: 42 });
const pauseReason = 'paused before the upgrade';
const rulePath = '/api/profiles/smoke/replay-rules/orders-transient';
const copyDatabase = `upgrade_${stamp}`;
const copySecret = 'volveran-postgres-copy';

let app: PortForward | undefined;
const forwards: PortForward[] = [];
const work = mkdtempSync(path.join(tmpdir(), 'volveran-chart-upgrade-'));

const valuesArgs = ['-f', path.join(smokeDir, 'values.yaml'), '-f', path.join(smokeDir, 'values-chart-upgrade.yaml')];
const helmFlags = ['--kubeconfig', kubeconfig, '--kube-context', kubeContext, '--namespace', appNamespace];
const oidcSet = `oidc.issuer=${oidc.issuer},oidc.redirectUrl=http://127.0.0.1:${ports.app}/auth/callback`;

/** `helm upgrade --install` of a published chart with the smoke values; returns what helm said. */
function helm(version: string, extra: string[] = []) {
  const result = spawnSync('helm', ['upgrade', '--install', releaseName, chart, '--version', version, ...helmFlags, ...valuesArgs, '--set-string', oidcSet, ...extra, '--wait', '--timeout', '5m'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`helm upgrade to ${version} failed: ${result.stderr}`);
  expect(result.stderr).not.toMatch(/PodSecurity|would violate/i);
  return result.stdout;
}

async function forwardApp() {
  await app?.close();
  app = await portForward(appNamespace, `service/${releaseName}`, ports.app, 8080);
  await eventually(async () => {
    const res = await fetch(`${appUrl}/readyz`);
    if (res.status !== 200) throw new Error(`/readyz answered ${res.status}`);
  }, 60_000);
}

async function signIn(): Promise<TestBrowser> {
  const browser = new TestBrowser(appUrl);
  const authorize = new URL(await browser.startSignIn());
  authorize.protocol = 'https:';
  authorize.host = `127.0.0.1:${ports.oidc}`;
  const back = await browser.get(await browser.approveAtProvider(authorize.href, operator));
  expect(back.status).toBe(302);
  return browser;
}

const discardOf = async (browser: TestBrowser, id: string) => {
  const { entries } = (await browser.get(`/api/audit-entries?messageId=${id}&action=discard`)).body;
  expect(entries).toHaveLength(1);
  return entries[0];
};

/** What an Operator must find on the store, wherever it now is. */
async function checkStore(browser: TestBrowser, restoreId: string) {
  const entry = await discardOf(browser, ids.kept);
  expect(entry).toMatchObject({ operatorName: operator.email, outcome: 'done', reason: 'upgrade', queue: 'orders.dlq' });
  const { entry: full } = (await browser.get(`/api/audit-entries/${entry.id}`)).body;
  expect(Buffer.from(full.message.body, 'base64').toString()).toBe(payloadOf(ids.kept));

  const { rules } = (await browser.get('/api/profiles/smoke/replay-rules')).body;
  expect(rules[0].state).toMatchObject({ paused: true, pausedReason: pauseReason, pausedBy: operator.email });

  const old = await discardOf(browser, ids.restoredByOld);
  const again = await browser.post(`/api/audit-entries/${old.id}/restore`, { confirm: true });
  expect([again.status, again.body.error.code]).toEqual([409, 'already_restored']);

  const discard = await discardOf(browser, restoreId);
  const restored = await browser.post(`/api/audit-entries/${discard.id}/restore`, { confirm: true });
  expect(restored.status).toBeLessThan(300);
  expect(restored.body.entry).toMatchObject({ action: 'restore', restoreOf: discard.id, outcome: 'done' });
  const back = await management('POST', '/queues/%2F/orders.dlq/get', { count: 10, ackmode: 'ack_requeue_false', encoding: 'auto' });
  expect(back.map((m: any) => [m.properties.message_id, m.payload])).toEqual([[restoreId, payloadOf(restoreId)]]);
}

beforeAll(async () => {
  if (!publishedVersion) throw new Error('Set VOLVERAN_SMOKE_PUBLISHED');
  spawnSync('helm', ['uninstall', releaseName, ...helmFlags, '--wait', '--timeout', '5m'], { encoding: 'utf8' });
  kubectl(['-n', appNamespace, 'delete', 'pvc', '--all', '--wait=true']);
  forwards.push(await portForward(depsNamespace, 'service/oidc', ports.oidc, 8080));
  forwards.push(await portForward(depsNamespace, 'service/rabbitmq', ports.management, 15672));
}, 360_000);

afterAll(async () => {
  await app?.close();
  await Promise.all(forwards.map((f) => f.close()));
  rmSync(work, { recursive: true, force: true });
});

describe(`helm upgrade from ${upgradeFromVersion} to ${publishedVersion}`, () => {
  let old: VolveranPod;

  it(`installs the chart at ${upgradeFromVersion} and plays an Operator on it`, async () => {
    helm(upgradeFromVersion);
    old = readyPod();
    await forwardApp();
    await management('DELETE', '/queues/%2F/orders.dlq/contents');
    for (const id of Object.values(ids)) await deadLetterOrder(id, payloadOf(id));
    const browser = await signIn();
    const { checkout } = await eventually(async () => {
      const res = await browser.post('/api/profiles/smoke/vhosts/%2F/queues/orders.dlq/checkouts');
      expect(res.status).toBe(201);
      if (res.body.checkout.messages.length !== 4) {
        await browser.post(`/api/checkouts/${res.body.checkout.id}/end`);
        throw new Error('Not all four are in the Checkout yet');
      }
      return res.body;
    }, 30_000);
    const decided = await browser.post(`/api/checkouts/${checkout.id}/decisions`, {
      handles: checkout.messages.map((m: any) => m.handle),
      decision: { kind: 'discard', reason: 'upgrade' },
    });
    expect(decided.status).toBe(200);
    expect((await browser.post(`/api/checkouts/${checkout.id}/apply`, { confirm: true })).status).toBe(202);
    await eventually(async () => {
      const view = (await browser.get(`/api/checkouts/${checkout.id}`)).body.checkout;
      if (view.status !== 'ended') throw new Error(`Checkout is ${view.status}`);
    }, 60_000);

    const discard = await discardOf(browser, ids.restoredByOld);
    const restored = await browser.post(`/api/audit-entries/${discard.id}/restore`, { confirm: true });
    expect(restored.body.entry.outcome).toBe('done');
    await management('DELETE', '/queues/%2F/orders.dlq/contents');

    // Paused by startPaused in the values: a pause with a reason needs it running first.
    const resumed = await browser.post(`${rulePath}/resume`);
    expect(resumed.status).toBe(200);
    const paused = await browser.post(`${rulePath}/pause`, { reason: pauseReason });
    expect(paused.status).toBe(200);
  });

  it('passes check-config of the new image on the file the new chart renders, as the guide gives it', () => {
    const rendered = run('helm', ['template', releaseName, chart, '--version', publishedVersion!, ...valuesArgs, '--set-string', oidcSet, '--show-only', 'templates/configmap.yaml']);
    const configMap = parseAllDocuments(rendered).map((d) => d.toJS()).find((d) => d?.data?.['profiles.yaml']);
    const file = path.join(work, 'profiles.yaml');
    writeFileSync(file, configMap.data['profiles.yaml'], { mode: 0o644 });
    spawnSync('chmod', ['755', work]);
    const result = spawnSync('docker', [
      'run', '--rm', '--read-only', '-v', `${file}:/config/profiles.yaml:ro`,
      '-e', 'VOLVERAN_SMOKE_PASSWORD=x', '-e', 'VOLVERAN_AUTH=oidc',
      '-e', `VOLVERAN_OIDC_ISSUER=${oidc.issuer}`, '-e', `VOLVERAN_OIDC_CLIENT_ID=${oidc.clientId}`, '-e', 'VOLVERAN_OIDC_CLIENT_SECRET=x',
      '-e', `VOLVERAN_OIDC_REDIRECT_URL=http://127.0.0.1:${ports.app}/auth/callback`, '-e', 'VOLVERAN_SESSION_SECRET=check-config-session-secret-0123456789',
      `ghcr.io/volveran/volveran:${publishedVersion}`, 'node', 'dist/server/main.js', 'check-config',
    ], { encoding: 'utf8' });
    expect([result.status, result.stdout + result.stderr]).toEqual([0, expect.any(String)]);
  });

  it('takes the online backup of docs/kubernetes.md from the old pod', () => {
    kubectl(['-n', appNamespace, 'exec', 'deployment/volveran', '--', 'node', '-e', "const s = require('node:sqlite'); s.backup(new s.DatabaseSync('/data/audit.sqlite'), '/data/audit-backup.sqlite')"]);
    const backup = path.join(work, 'audit-backup.sqlite');
    kubectl(['-n', appNamespace, 'cp', `${old.name}:/data/audit-backup.sqlite`, backup]);
    kubectl(['-n', appNamespace, 'exec', 'deployment/volveran', '--', 'rm', '/data/audit-backup.sqlite']);
    expect(statSync(backup).size).toBeGreaterThan(0);
    const db = new DatabaseSync(backup, { readOnly: true });
    const tables = db.prepare("select name from sqlite_master where type = 'table'").all().map((r: any) => r.name);
    expect(tables).toContain('audit_entries');
    db.close();
  });

  it(`upgrades to the chart at ${publishedVersion} and runs its image`, async () => {
    const out = helm(publishedVersion!);
    expect(out).toMatch(/STATUS: deployed/);
    const pod = await replacementOf(old);
    const status = JSON.parse(kubectl(['-n', appNamespace, 'get', 'pod', pod.name, '-o', 'json']));
    expect(status.spec.containers[0].image).toBe(`ghcr.io/volveran/volveran:${publishedVersion}`);
    console.log(`upgraded pod runs ${status.status.containerStatuses[0].imageID}`);
    expect(status.spec.terminationGracePeriodSeconds).toBe(90);
    await forwardApp();
  });

  it('finds the store as it was on SQLite, and Restores', async () => {
    await checkStore(await signIn(), ids.restoredOnSqlite);
  });

  it('logs no version warning', () => {
    const logs = kubectl(['-n', appNamespace, 'logs', 'deployment/volveran']);
    expect(logs).not.toContain('The profiles file has no version');
  });

  it('moves to PostgreSQL with the Job of docs/postgresql.md, as it is written there', async () => {
    const postgres = kubectl(['-n', depsNamespace, 'get', 'pod', '-l', 'app=postgres', '-o', 'jsonpath={.items[0].metadata.name}']).trim();
    kubectl(['-n', depsNamespace, 'exec', postgres, '--', 'psql', '-U', 'volveran', '-d', 'volveran', '-c', `CREATE DATABASE ${copyDatabase} OWNER volveran ENCODING 'UTF8' TEMPLATE template0`]);
    const url = `postgres://volveran:volveran-smoke-pass@postgres.${depsNamespace}.svc.cluster.local:5432/${copyDatabase}`;
    kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: copySecret, namespace: appNamespace }, stringData: { url } }) });

    kubectl(['-n', appNamespace, 'scale', 'deployment/volveran', '--replicas=0']);
    await eventually(() => {
      const list = JSON.parse(kubectl(['-n', appNamespace, 'get', 'pods', '-l', `app.kubernetes.io/instance=${releaseName}`, '-o', 'json']));
      if (list.items.length) throw new Error('The pod has not gone yet');
    });

    // The guide's own text, with this namespace, this version and this database, which has no TLS.
    const guide = readFileSync(path.join(repoRoot, 'docs/postgresql.md'), 'utf8');
    const block = /```yaml\n((?:\s*)apiVersion: batch\/v1[\s\S]*?)```/.exec(guide)?.[1];
    if (!block) throw new Error('The Job is not in docs/postgresql.md');
    const job = parseAllDocuments(block)[0]!.toJS();
    job.metadata.namespace = appNamespace;
    const container = job.spec.template.spec.containers[0];
    container.image = container.image.replace('<version>', publishedVersion);
    container.imagePullPolicy = 'Never';
    const env = (name: string) => container.env.find((e: any) => e.name === name);
    env('VOLVERAN_POSTGRES_URL').valueFrom.secretKeyRef.name = copySecret;
    env('VOLVERAN_POSTGRES_REQUIRE_TLS').value = 'false';
    kubectl(['apply', '-f', '-'], { input: JSON.stringify(job) });
    kubectl(['-n', appNamespace, 'wait', '--for=condition=complete', '--timeout=5m', `job/${job.metadata.name}`]);
    const logs = kubectl(['-n', appNamespace, 'logs', `job/${job.metadata.name}`]);
    console.log(logs);
    expect(logs).toMatch(/\bOK\b/);
    kubectl(['-n', appNamespace, 'delete', 'job', job.metadata.name]);

    // The guide's refusal 3 and docs/postgresql.md: the key goes in the Secret first. The run's Secret has one.
    helm(publishedVersion!, ['--set-string', `postgres.existingSecret=${copySecret}`, '--set', 'postgres.requireTls=false']);
    const volumes = JSON.parse(kubectl(['-n', appNamespace, 'get', 'deployment/volveran', '-o', 'json'])).spec.template.spec.volumes.map((v: any) => v.name);
    expect(volumes).not.toContain('data');
    await eventually(() => readyPod());
    await forwardApp();
  });

  it('finds the store as it was on PostgreSQL, and Restores', async () => {
    await checkStore(await signIn(), ids.restoredOnPostgres);
  });
});
