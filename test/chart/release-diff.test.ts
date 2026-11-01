// The check of the chart against the last release (scripts/chart-release-diff.mjs),
// on copies of the chart with one change each.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareCharts, latestRelease, parseAllowList, withoutVersions } from '../../scripts/chart-release-diff.mjs';
import { chartDir, repoRoot } from './render.js';

const team = path.join(repoRoot, 'test/chart/fixtures/team.yaml');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function chartCopy(change?: (chart: string) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'volveran-chart-copy-'));
  dirs.push(dir);
  const chart = path.join(dir, 'volveran');
  cpSync(chartDir, chart, { recursive: true });
  change?.(chart);
  return chart;
}

function edit(file: string, from: string | RegExp, to: string): void {
  const text = readFileSync(file, 'utf8');
  const edited = text.replace(from, to);
  expect(edited).not.toBe(text);
  writeFileSync(file, edited);
}

const compare = (after: string, allowed: Parameters<typeof compareCharts>[2]['allowed'] = []) =>
  compareCharts(chartCopy(), after, { fixtures: [team], releaseFixtures: ['team.yaml'], allowed });

describe('chart against the last release', () => {
  it('passes on the version strings alone', () => {
    const bumped = chartCopy((c) => {
      edit(path.join(c, 'Chart.yaml'), /^version: .*$/m, 'version: 99.1.0');
      edit(path.join(c, 'Chart.yaml'), /^appVersion: .*$/m, 'appVersion: "99.1.0"');
    });
    expect(compare(bumped).differences).toEqual([]);
  });

  it('fails on a change to what renders by default', () => {
    const after = chartCopy((c) => edit(path.join(c, 'templates/deployment.yaml'), /^(\s*)containers:$/m, '$1terminationGracePeriodSeconds: 77\n$1containers:'));
    expect(compare(after).differences).toContainEqual({ fixture: 'team.yaml', change: '+ terminationGracePeriodSeconds: 77' });
  });

  it('passes a new optional template that renders nothing by default', () => {
    const added = chartCopy((c) => writeFileSync(path.join(c, 'templates/extra.yaml'), '{{- if .Values.extra }}\nkind: Extra\n{{- end }}\n'));
    expect(compare(added).differences).toEqual([]);
  });

  it('passes a difference on the allow-list, and says when an entry is no longer needed', () => {
    const after = chartCopy((c) => edit(path.join(c, 'templates/deployment.yaml'), /^(\s*)containers:$/m, '$1terminationGracePeriodSeconds: 77\n$1containers:'));
    const entry = { change: '+ terminationGracePeriodSeconds: 77', reason: 'A longer stop.' };
    const stale = { change: '- gone', reason: 'Released already.' };
    const { differences, unused } = compare(after, [entry, stale]);
    expect(differences).toEqual([]);
    expect(unused).toEqual([stale]);
  });

  it('leaves out a fixture the release does not have', () => {
    const { differences, skipped } = compareCharts(chartCopy(), chartCopy(), { fixtures: [team], releaseFixtures: [], allowed: [] });
    expect(differences).toEqual([]);
    expect(skipped).toEqual(['team.yaml']);
  });

  it('refuses an allow-list entry with no reason', () => {
    expect(() => parseAllowList('allowed:\n  - change: "+ a: b"\n')).toThrow(/a change and a reason/);
    expect(parseAllowList(readFileSync(path.join(repoRoot, 'test/chart/release-diff-allow.yaml'), 'utf8'))).toEqual([]);
  });

  it('takes the highest final release as the latest', () => {
    expect(latestRelease(['v0.9.0', 'v0.10.0', 'v0.11.0-rc.1', 'nightly', ''])).toBe('v0.10.0');
    expect(latestRelease([''])).toBeUndefined();
  });

  it('replaces only the version strings of a release', () => {
    const rendered = 'app.kubernetes.io/version: "1.2.3"\nhelm.sh/chart: volveran-1.2.3\nimage: ghcr.io/volveran/volveran:1.2.3\nother: 1.2.3\n';
    expect(withoutVersions(rendered)).toBe('app.kubernetes.io/version: <version>\nhelm.sh/chart: volveran-<version>\nimage: ghcr.io/volveran/volveran:<version>\nother: 1.2.3\n');
  });
});
