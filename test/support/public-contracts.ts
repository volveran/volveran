// The public contracts as this checkout has them, read from the code and the chart, in the form
// test/fixtures/public-contracts.json records them (docs/compatibility.md, ADR 0015).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { buildRequest, type Notification } from '../../src/server/alerts/payloads.js';
import { MIGRATIONS as POSTGRES_MIGRATIONS } from '../../src/server/audit/postgres-migrations.js';
import { MIGRATIONS as SQLITE_MIGRATIONS } from '../../src/server/audit/sqlite-audit-store.js';
import type { LatestSample } from '../../src/server/history/sampler.js';
import { AlertMetrics } from '../../src/server/metrics/alerts.js';
import type { MetricFamily } from '../../src/server/metrics/exposition.js';
import { QueueMetrics } from '../../src/server/metrics/queues.js';
import { ReplicaMetrics } from '../../src/server/metrics/replicas.js';
import { startRuntimeMetrics } from '../../src/server/metrics/runtime.js';
import { TriageMetrics } from '../../src/server/metrics/triage.js';
import type { BrokerProfile } from '../../src/server/profiles.js';
import { exportFilename, exportLine } from '../../src/server/triage/export-line.js';
import { registeredRoutes, versionedRoutes } from './api-routes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

function filesUnder(dir: string): string[] {
  return readdirSync(path.join(root, dir)).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(path.join(root, file)).isDirectory() ? filesUnder(file) : [file];
  });
}

const matchesIn = (files: readonly string[], pattern: RegExp) => [...new Set(files.flatMap((file) => [...read(file).matchAll(pattern)].map((m) => m[1]!)))].sort();

/** Every field of a value as a path; `[]` stands for an array's items. An empty object or array is a field with nothing under it. */
export function fieldPaths(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) return value.length === 0 ? [at] : [...new Set(value.flatMap((item) => fieldPaths(item, `${at}[]`)))];
  if (typeof value === 'object' && value !== null && !Buffer.isBuffer(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [at];
    return entries.flatMap(([key, item]) => fieldPaths(item, at === '' ? key : `${at}.${key}`));
  }
  return [at];
}

/** Every key a JSON Schema allows, as a path; `[]` an array's items, `*` the keys of a free-form object. */
export function schemaKeys(schema: any, root_: any = schema, at = '', following: readonly string[] = []): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  if (typeof schema.$ref === 'string') {
    if (following.includes(schema.$ref)) return [];
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((node: any, key: string) => node?.[key], root_);
    return schemaKeys(target, root_, at, [...following, schema.$ref]);
  }
  const nested = (next: any, where: string) => schemaKeys(next, root_, where, following);
  const keys = [
    ...Object.entries<any>(schema.properties ?? {}).flatMap(([key, value]) => {
      const where = at === '' ? key : `${at}.${key}`;
      const under = nested(value, where);
      return under.length === 0 ? [where] : under;
    }),
    ...(schema.items ? nested(schema.items, `${at}[]`) : []),
    ...(typeof schema.additionalProperties === 'object' ? [...nested(schema.additionalProperties, `${at}.*`)] : []),
    ...['oneOf', 'anyOf', 'allOf'].flatMap((word) => (schema[word] ?? []).flatMap((option: any) => nested(option, at))),
    ...['if', 'then', 'else'].flatMap((word) => (schema[word] ? nested(schema[word], at) : [])),
  ];
  return [...new Set(keys)];
}

/** The names of metrics written in the metrics modules, so that a new module cannot go unseen. */
export const metricNamesInSource = () => matchesIn(filesUnder('src/server/metrics'), /['"`]((?:volveran|process|nodejs)_[a-z0-9_]+)['"`]/g);

/** Every metric with a series of each kind, so that its labels show. */
function allFamilies(): MetricFamily[] {
  const sample: LatestSample = {
    profile: 'p',
    vhost: '/',
    queue: 'q',
    at: new Date(0),
    depth: 3,
    previousDepth: 1,
    takenOut: 0,
    estimatedArrivals: 2,
    setupWarnings: [{ code: 'code', severity: 'loses_messages' }] as unknown as LatestSample['setupWarnings'],
  };
  const queues = new QueueMetrics(() => ({ profiles: [{ profile: 'p', queues: [sample], lastRun: { ok: true }, lastSuccessAt: new Date(0) }] }) as never);
  queues.runFinished({ samplingRun: { profile: 'p', at: new Date(0), ok: true, errorCode: null }, samples: [sample], unknownDepth: [] });

  const triage = new TriageMetrics({
    ruleStates: () => [{ profile: 'p', rule: 'r', state: { paused: true, pausedReason: 'why' } as never }],
    checkoutCounts: () => ({ active: 0, waitingApproval: 0 }),
    storedBodyBytes: () => 0,
  });
  triage.passRecorded('p', 'r', 'completed' as never);
  triage.applyEnded('p', [{ decision: { kind: 'discard' }, status: 'discarded' } as never]);

  const alerts = new AlertMetrics({ profiles: [{ name: 'p', alerts: [{ name: 'r' }] } as unknown as BrokerProfile], firingRules: () => ['r'] });
  alerts.delivered({ test: false, destination: 'd', outcome: 'delivered' } as never);

  const replicas = new ReplicaMetrics(() => true);
  replicas.forwardingFailed('unreachable');
  replicas.storeFailed();

  const runtime = startRuntimeMetrics();
  const families = [...queues.families(), ...triage.families(), ...alerts.families(), ...replicas.families(), ...runtime.families()];
  runtime.stop();
  return families;
}

function metrics() {
  return Object.fromEntries(
    allFamilies()
      .map(({ name, type, series }) => [name, { type, labels: [...new Set(series.flatMap((s) => Object.keys(s.labels ?? {})))].sort() }] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

// Written like an environment variable in the source, and not one.
const NOT_ENV_VARS = new Set(['VOLVERAN_CONDITIONS']);
const ENV_VAR = /\b(VOLVERAN_[A-Z0-9_]*[A-Z0-9])\b(?!_)/g;

function environmentVariables() {
  const server = matchesIn(filesUnder('src/server').concat(filesUnder('src/shared')), ENV_VAR).filter((name) => !NOT_ENV_VARS.has(name));
  const chart = matchesIn(filesUnder('charts/volveran/templates'), ENV_VAR).filter((name) => !server.includes(name));
  return { server, setByTheChartForItself: chart };
}

function webhook() {
  const notification: Notification = {
    alertId: 'a',
    status: 'firing',
    rule: 'r',
    profile: 'p',
    vhost: '/',
    queue: 'q',
    condition: 'depthAbove',
    value: 1,
    threshold: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    path: '/',
  };
  const { headers, body } = buildRequest({ type: 'webhook', signingSecret: 'secret' }, notification, 'https://example.com', new Date(0));
  const parsed = JSON.parse(body) as { version: number };
  return { version: parsed.version, bodyFields: fieldPaths(parsed).sort(), signatureHeaders: Object.keys(headers).filter((h) => h.startsWith('x-volveran-')).sort() };
}

function ndjsonExport() {
  const lineWith = (decision: unknown) => exportLine(
    1,
    {
      fields: { exchange: 'x', routingKey: 'k', redelivered: false },
      properties: {
        headers: {
          bytes: Buffer.from('a'),
          bigint: 2n ** 63n - 1n,
          table: { $x: 1 },
          'x-volveran-replay-id': 'r',
          'x-death': [{ queue: 'q', reason: 'rejected', count: 1, time: { '!': 'timestamp', value: 1 }, exchange: 'x', 'routing-keys': ['k'], 'original-expiration': '1' }],
          'x-delivery-count': 1,
          'MT-Reason': 'fault',
          'MT-Fault-ExceptionType': 'E',
          'MT-Host-MachineName': 'm',
        },
      },
      content: Buffer.from('{}'),
    },
    { type: 'quorum', deliveryLimit: 5, deadLetterExchange: true },
    decision as never,
  );
  const decisions = [{ kind: 'keep' }, { kind: 'discard', reason: 'r' }, { kind: 'replay' }, { kind: 'move', destination: { queue: 'q' } }, { kind: 'move', destination: { exchange: 'x', routingKey: 'k' } }];
  const fields = decisions.flatMap((decision) => fieldPaths(lineWith(decision)));
  return {
    version: lineWith({ kind: 'keep' }).v,
    fields: [
      ...new Set(
        fields
          // The Message's own headers and host names are whatever it has; only how a value is written is the format's.
          .map((field) => field.replace(/^headers\.[^.$]+\.(\$[a-z]+).*$/, 'headers.*.$1').replace(/^failureDetails\.host\..*$/, 'failureDetails.host.*'))
          .filter((field) => !/^headers\.[^*]/.test(field)),
      ),
    ].sort(),
    fileName: exportFilename('profile', 'queue', new Date('2026-01-02T03:04:05Z')),
  };
}

function chartValues() {
  const values = parse(read('charts/volveran/values.yaml'));
  const schema = JSON.parse(read('charts/volveran/values.schema.json'));
  return [...new Set([...fieldPaths(values), ...schemaKeys(schema)])].sort();
}

const digestOf = (migrations: readonly string[]) => createHash('sha256').update(JSON.stringify(migrations)).digest('hex');

/** Each store's migrations, as the 1.0 baseline records them. */
export const storeMigrations = { sqlite: SQLITE_MIGRATIONS, postgres: POSTGRES_MIGRATIONS } as const;

function auditSchemaBaseline(recorded: Record<keyof typeof storeMigrations, { version: number }>) {
  return Object.fromEntries(
    Object.entries(storeMigrations).map(([store, migrations]) => {
      const { version } = recorded[store as keyof typeof storeMigrations];
      return [store, { version, sha256: digestOf(migrations.slice(0, version)) }];
    }),
  );
}

export interface PublicContracts {
  metrics: unknown;
  environmentVariables: unknown;
  chartValues: unknown;
  httpApi: unknown;
  profilesFile: unknown;
  webhook: unknown;
  xVolveranHeaders: unknown;
  ndjsonExport: unknown;
  auditSchemaBaseline: Record<keyof typeof storeMigrations, { version: number; sha256: string }>;
}

export const readRecordedContracts = (): PublicContracts => JSON.parse(read('test/fixtures/public-contracts.json'));

/** The `x-volveran-*` headers written anywhere in the product. */
export const xVolveranHeadersInSource = () => matchesIn(filesUnder('src'), /\b(x-volveran-[a-z0-9-]+)\b/g);

export async function currentContracts(recorded: PublicContracts): Promise<Omit<PublicContracts, 'xVolveranHeaders'>> {
  return {
    metrics: metrics(),
    environmentVariables: environmentVariables(),
    chartValues: chartValues(),
    httpApi: versionedRoutes(await registeredRoutes()),
    profilesFile: schemaKeys(JSON.parse(read('profiles.schema.json'))).sort(),
    webhook: webhook(),
    ndjsonExport: ndjsonExport(),
    auditSchemaBaseline: auditSchemaBaseline(recorded.auditSchemaBaseline) as PublicContracts['auditSchemaBaseline'],
  };
}
