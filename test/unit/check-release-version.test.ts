// The release workflow's version check (scripts/check-release-version.mjs):
// a version tag publishes only when it equals the version in package.json and
// the chart's version and appVersion, so a mismatched image or chart is never
// pushed.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { releaseVersionErrors } from '../../scripts/check-release-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/check-release-version.mjs');

const matching = { packageVersion: '0.2.0', chartVersion: '0.2.0', chartAppVersion: '0.2.0' };

describe('release version check', () => {
  it('accepts a tag equal to package.json and the chart version and appVersion', () => {
    expect(releaseVersionErrors('v0.2.0', matching)).toEqual([]);
  });

  it('refuses a tag that differs from package.json', () => {
    expect(releaseVersionErrors('v0.2.1', matching)).toContainEqual(
      'Tag v0.2.1 does not match package.json version 0.2.0 (expected v0.2.0)',
    );
  });

  it('refuses a chart version that differs from the tag', () => {
    expect(releaseVersionErrors('v0.2.0', { ...matching, chartVersion: '0.1.0' })).toEqual([
      'charts/volveran/Chart.yaml version 0.1.0 does not match tag v0.2.0 (expected 0.2.0)',
    ]);
  });

  it('refuses a chart appVersion that differs from the tag', () => {
    expect(releaseVersionErrors('v0.2.0', { ...matching, chartAppVersion: '0.1.0' })).toEqual([
      'charts/volveran/Chart.yaml appVersion 0.1.0 does not match tag v0.2.0 (expected 0.2.0)',
    ]);
  });

  it('accepts a pre-release tag when package.json and the chart carry the same pre-release version', () => {
    const rc = { packageVersion: '0.2.0-rc.1', chartVersion: '0.2.0-rc.1', chartAppVersion: '0.2.0-rc.1' };
    expect(releaseVersionErrors('v0.2.0-rc.1', rc)).toEqual([]);
  });

  it('refuses a pre-release tag for a release version', () => {
    expect(releaseVersionErrors('v0.2.0-rc.1', matching)).toHaveLength(3);
  });

  // Helm turns `+` into `_` in the chart's OCI tag, so the chart tag would no
  // longer equal the version; release tags carry no build metadata.
  it.each(['v0.2', 'v0.2.0+build.1', '0.2.0', 'v0.2.0.1', 'v01.2.0', 'v0.2.0-', 'latest'])(
    'refuses %s, which is not v<major>.<minor>.<patch>[-<pre-release>]',
    (tag) => {
      const version = tag.replace(/^v/, '');
      const same = { packageVersion: version, chartVersion: version, chartAppVersion: version };
      expect(releaseVersionErrors(tag, same)).toContainEqual(
        `Tag ${tag} is not v<major>.<minor>.<patch>[-<pre-release>], e.g. v0.2.0 or v0.2.0-rc.1`,
      );
    },
  );

  it('reports every mismatch at once', () => {
    expect(
      releaseVersionErrors('v0.3.0', { packageVersion: '0.2.0', chartVersion: '0.1.0', chartAppVersion: '0.1.0' }),
    ).toHaveLength(3);
  });
});

describe('release version check, as the release workflow runs it', () => {
  // This checkout's package.json and Chart.yaml agree (test/chart/default-render.test.ts).
  const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;

  it('prints the version and succeeds for the tag v<package.json version>', () => {
    expect(execFileSync('node', [script, `v${version}`], { encoding: 'utf8' })).toBe(`${version}\n`);
  });

  it('prints a GitHub Actions error per mismatch and fails for another tag', () => {
    const result = spawnSync('node', [script, 'v99.0.0'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`::error::Tag v99.0.0 does not match package.json version ${version}`);
    expect(result.stderr).toContain(`::error::charts/volveran/Chart.yaml version ${version} does not match tag v99.0.0`);
    expect(result.stderr).toContain(`::error::charts/volveran/Chart.yaml appVersion ${version} does not match tag v99.0.0`);
  });

  it('fails without a tag', () => {
    expect(spawnSync('node', [script], { encoding: 'utf8' }).status).toBe(1);
  });
});

describe('release workflow wiring', () => {
  type Job = { needs?: string | string[]; steps: Array<{ run?: string }> };
  const workflow = parse(readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')) as {
    jobs: Record<string, Job>;
  };
  const runs = (job: string) => workflow.jobs[job]!.steps.map((step) => step.run ?? '').join('\n');

  it('runs the version check in the job every push waits for', () => {
    expect(runs('check')).toContain('node scripts/check-release-version.mjs "$GITHUB_REF_NAME"');
    expect(workflow.jobs['image']!.needs).toBe('check');
    expect(workflow.jobs['chart']!.needs).toEqual(['check', 'image']);
  });

  it('documents the Flux identity for the chart it pushes', () => {
    const text = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
    expect(text).toContain('url: oci://ghcr.io/volveran/charts/volveran');
    expect(text).toContain('provider: cosign');
    expect(text).toContain('matchOIDCIdentity:');
  });
});
