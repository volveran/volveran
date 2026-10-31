// Chart rendering helpers: run `helm template` on charts/volveran with a values
// fixture plus per-test values, and parse the multi-document output into
// Kubernetes objects that tests find by kind.
//
//   const chart = render({ service: { port: 80 } });
//   chart.one('Service').spec.ports
//   renderRefusal({ replicaCount: 2 })   // Helm's error message
//   renderNotes()                        // the install notes text (no cluster needed)
//   volumeAt(chart, '/data').volume      // the pod volume mounted at a path
//
// Values are layered: chart defaults, then test/chart/fixtures/<fixture>.yaml
// (default "team", the smallest working install), then the test's values. To
// leave a fixture value out, edit fixtureValues() and render with fixture: null.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments, stringify } from 'yaml';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const chartDir = path.join(repoRoot, 'charts/volveran');
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** The release name and namespace every render uses. */
export const release = { name: 'volveran', namespace: 'triage' };

export type Values = Record<string, unknown>;

export interface RenderOptions {
  /** A file name in test/chart/fixtures without `.yaml`, or null for chart defaults only. */
  fixture?: string | null;
  /** Pass --skip-schema-validation, to check the template guards behind the schema. */
  skipSchemaValidation?: boolean;
}

/** A rendered Kubernetes object. Fields are loosely typed: tests assert on shapes. */
export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: any;
  data?: Record<string, string>;
}

export interface Rendered {
  /** What Helm printed, byte for byte. */
  output: string;
  objects: K8sObject[];
  /** Every rendered kind, sorted. */
  kinds(): string[];
  ofKind(kind: string): K8sObject[];
  /** The only object of a kind; throws when there are none or several. */
  one(kind: string): K8sObject;
}

/** A fresh copy of a values fixture, for tests that remove or rewrite part of it. */
export function fixtureValues(name = 'team'): Values {
  return parse(readFileSync(path.join(fixturesDir, `${name}.yaml`), 'utf8')) as Values;
}

/** Renders the chart and parses its manifests. Throws Helm's error if it refuses. */
export function render(values: Values = {}, options: RenderOptions = {}): Rendered {
  const output = helm(['template', release.name, chartDir], values, options);
  const objects = parseAllDocuments(output)
    .map((doc) => doc.toJS() as K8sObject | null)
    .filter((obj): obj is K8sObject => obj !== null);
  const ofKind = (kind: string) => objects.filter((obj) => obj.kind === kind);
  return {
    output,
    objects,
    kinds: () => [...new Set(objects.map((obj) => obj.kind))].sort(),
    ofKind,
    one(kind) {
      const found = ofKind(kind);
      if (found.length !== 1) throw new Error(`expected one ${kind}, rendered ${found.length}`);
      return found[0]!;
    },
  };
}

/** Renders the chart expecting Helm to refuse; returns its error message. */
export function renderRefusal(values: Values = {}, options: RenderOptions = {}): string {
  try {
    helm(['template', release.name, chartDir], values, options);
  } catch (error) {
    return (error as { stderr?: string }).stderr ?? String(error);
  }
  throw new Error('expected the chart to refuse these values, but it rendered');
}

/**
 * The install notes `helm install` would print. `helm template` never renders
 * NOTES.txt and `helm install --dry-run` needs a cluster, so this renders a
 * copy of the chart with one extra template that evaluates NOTES.txt (copied
 * outside templates/, where .Files can read it) into a ConfigMap.
 */
export function renderNotes(values: Values = {}, options: RenderOptions = {}): string {
  const copy = mkdtempSync(path.join(tmpdir(), 'volveran-notes-'));
  try {
    cpSync(chartDir, copy, { recursive: true });
    cpSync(path.join(copy, 'templates/NOTES.txt'), path.join(copy, 'notes-under-test.txt'));
    writeFileSync(
      path.join(copy, 'templates/notes-under-test.yaml'),
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: notes-under-test\ndata:\n' +
        '  notes: {{ tpl (.Files.Get "notes-under-test.txt") . | quote }}\n',
    );
    const output = helm(
      ['template', release.name, copy, '--show-only', 'templates/notes-under-test.yaml'],
      values,
      options,
    );
    return (parse(output) as { data: { notes: string } }).data.notes;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/** The pod template of the chart's Deployment. */
export function podSpec(chart: Rendered): any {
  return chart.one('Deployment').spec.template.spec;
}

/** The Volverán container of the chart's Deployment. */
export function container(chart: Rendered): any {
  const found = podSpec(chart).containers.find((c: any) => c.name === 'volveran');
  if (!found) throw new Error('no container named volveran');
  return found;
}

/**
 * The container's volume mount at a path and the pod volume behind it; both
 * undefined when nothing is mounted there.
 */
export function volumeAt(chart: Rendered, mountPath: string): { mount: any; volume: any } {
  const mount = container(chart).volumeMounts?.find((m: { mountPath: string }) => m.mountPath === mountPath);
  const volume = mount && podSpec(chart).volumes.find((v: { name: string }) => v.name === mount.name);
  return { mount, volume };
}

/** The container's env entry for a variable, or undefined. */
export function env(chart: Rendered, name: string): any {
  return (container(chart).env ?? []).find((e: any) => e.name === name);
}

function helm(args: string[], values: Values, { fixture = 'team', skipSchemaValidation }: RenderOptions): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'volveran-chart-'));
  try {
    const valuesFile = path.join(dir, 'values.yaml');
    writeFileSync(valuesFile, stringify(values));
    const files = fixture === null ? [] : ['-f', path.join(fixturesDir, `${fixture}.yaml`)];
    const flags = skipSchemaValidation ? ['--skip-schema-validation'] : [];
    return execFileSync(
      'helm',
      [...args, '--namespace', release.namespace, ...files, '-f', valuesFile, ...flags],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
