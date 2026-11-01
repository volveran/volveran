// What a release is built from cannot change under a moved tag: every GitHub
// Action is pinned by commit and every base image by digest, each still naming
// its version so that Dependabot can update it and a reader can tell what it is.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const workflowFiles = readdirSync(path.join(root, '.github/workflows')).map((f) => `.github/workflows/${f}`);

/** Every `uses:` in a workflow that is not `owner/repo@<commit> # <version>`. */
function unpinnedActions(workflow: string): string[] {
  return workflow
    .split('\n')
    .map((line) => /^\s*(?:-\s+)?uses:\s*(.+?)\s*$/.exec(line)?.[1])
    .filter((uses): uses is string => uses !== undefined)
    .filter((uses) => !uses.startsWith('./') && !/^[^\s@]+@[0-9a-f]{40} # v\d\S*$/.test(uses));
}

describe('the Dockerfile', () => {
  const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  it('pins its syntax image by digest', () => {
    expect(dockerfile.split('\n')[0]).toMatch(/^# syntax=docker\/dockerfile:1@sha256:[0-9a-f]{64}$/);
  });
  it('leaves no package manager in the image', () => {
    for (const tool of ['npm', 'npx', 'corepack', 'yarn', 'yarnpkg']) expect(dockerfile).toContain(`/usr/local/bin/${tool}`);
  });
});

/** Every `FROM` of an outside image that is not `image:tag@sha256:<digest>`. */
function unpinnedBaseImages(dockerfile: string): string[] {
  const stages = new Set<string>();
  const unpinned: string[] = [];
  for (const line of dockerfile.split('\n')) {
    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!from) continue;
    const image = from[1]!;
    if (!stages.has(image) && !/^[^\s@]+:[^\s@]+@sha256:[0-9a-f]{64}$/.test(image)) unpinned.push(image);
    if (from[2]) stages.add(from[2]);
  }
  return unpinned;
}

describe('pinning', () => {
  const commit = 'a'.repeat(40);
  const digest = 'b'.repeat(64);

  it('recognises an action not pinned by commit, or without its version', () => {
    const workflow = [
      'steps:',
      '  - uses: actions/checkout@v4',
      `  - uses: actions/setup-node@${commit}`,
      `  - uses: azure/setup-helm@${commit} # v4.3.1`,
      '    with:',
      '      version: v3',
      '  - uses: ./.github/actions/local',
    ].join('\n');
    expect(unpinnedActions(workflow)).toEqual(['actions/checkout@v4', `actions/setup-node@${commit}`]);
  });

  it('recognises a base image not pinned by digest, or without its tag', () => {
    const dockerfile = [
      'FROM node:24-slim AS build',
      `FROM node@sha256:${digest}`,
      `FROM node:24-slim@sha256:${digest} AS good`,
      'FROM good',
    ].join('\n');
    expect(unpinnedBaseImages(dockerfile)).toEqual(['node:24-slim', `node@sha256:${digest}`]);
  });

  it.each(workflowFiles)('%s pins every action by commit', (file) => {
    expect(unpinnedActions(read(file))).toEqual([]);
  });

  it('the Dockerfile pins its base image by digest', () => {
    expect(unpinnedBaseImages(read('Dockerfile'))).toEqual([]);
  });
});

describe('updates to what is pinned', () => {
  type Update = { 'package-ecosystem': string; directory: string; schedule: { interval: string } };
  const updates = () => (parse(read('.github/dependabot.yml')) as { updates: Update[] }).updates;

  it.each([
    ['github-actions', '/'],
    ['docker', '/'],
    ['npm', '/'],
    ['npm', '/tools/lint'],
  ])('Dependabot watches %s in %s', (ecosystem, directory) => {
    const update = updates().find((u) => u['package-ecosystem'] === ecosystem && u.directory === directory);
    expect(update?.schedule.interval).toBe('weekly');
  });
});

describe('scanning', () => {
  type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
  type Job = { steps: Step[] };
  type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };
  const load = (file: string) => parse(read(file)) as Workflow;
  const securityJob = (name: string) => load('.github/workflows/security.yml').jobs[name];
  const runs = (job: Job | undefined) => (job?.steps ?? []).map((step) => step.run ?? '').join('\n');
  const step = (job: Job | undefined, action: string) => job?.steps.find((s) => s.uses?.startsWith(`${action}@`));
  const imageScan = (job: Job | undefined) => step(job, 'anchore/scan-action');

  it('runs on pull requests, on main and every week', () => {
    expect(Object.keys(load('.github/workflows/security.yml').on)).toEqual(
      expect.arrayContaining(['pull_request', 'push', 'schedule']),
    );
  });

  it('runs CodeQL over the TypeScript', () => {
    const job = securityJob('codeql');
    expect(step(job, 'github/codeql-action/init')?.with?.['languages']).toBe('javascript-typescript');
    expect(step(job, 'github/codeql-action/analyze')).toBeDefined();
  });

  it('runs npm audit on both lockfiles', () => {
    expect(runs(securityJob('audit'))).toContain('npm audit --audit-level=high');
    expect(runs(securityJob('audit'))).toContain('npm audit --prefix tools/lint --audit-level=high');
  });

  it('fails on a high finding in an image built from the checkout', () => {
    const job = securityJob('image');
    expect(runs(job)).toContain('docker build');
    expect(imageScan(job)?.with).toMatchObject({ 'fail-build': true, 'severity-cutoff': 'high' });
  });

  it('scans the released image, so a finding after a release is seen', () => {
    expect(imageScan(securityJob('released-image'))?.with?.['image']).toBe('ghcr.io/volveran/volveran:latest');
  });

  it.each([
    ['the image from the checkout', () => securityJob('image')],
    ['the released image', () => securityJob('released-image')],
    ['a release', () => load('.github/workflows/release.yml').jobs['check']],
  ])('counts findings with no fix on %s, apart from the reviewed list', (_name, job) => {
    const scan = imageScan(job());
    expect(scan?.with?.['only-fixed']).toBeUndefined();
    expect(scan?.with?.['config']).toBe('.grype.yaml');
    expect(job()?.steps.some((s) => s.uses?.startsWith('actions/checkout@'))).toBe(true);
  });

  it('checks a release in the job every push waits for', () => {
    const check = load('.github/workflows/release.yml').jobs['check'];
    expect(runs(check)).toContain('npm audit --audit-level=high');
    expect(runs(check)).toContain('docker build');
    expect(imageScan(check)?.with).toMatchObject({ 'fail-build': true, 'severity-cutoff': 'high' });
  });
});

/**
 * What is wrong with the image scan's reviewed list: anything but a rule for
 * one vulnerability with its stated reason. A rule on a package, a fix state or
 * a whole class would hide findings nobody reviewed.
 */
function unreviewedIgnores(config: { ignore?: unknown[] | null } & Record<string, unknown>): string[] {
  const problems = ['only-fixed', 'only-notfixed', 'ignore-wontfix'].filter((key) => key in config);
  for (const rule of config.ignore ?? []) {
    const { vulnerability, reason, ...rest } = rule as Record<string, unknown>;
    if (typeof vulnerability !== 'string' || !/^(CVE|GHSA)-/.test(vulnerability)) problems.push(JSON.stringify(rule));
    else if (typeof reason !== 'string' || reason.trim() === '') problems.push(`${vulnerability}: no reason`);
    else if (Object.keys(rest).length > 0) problems.push(`${vulnerability}: wider than one vulnerability`);
  }
  return problems;
}

describe('the reviewed list of the image scan', () => {
  it('recognises a rule without a reason, or wider than one vulnerability', () => {
    const config = {
      ignore: [
        { vulnerability: 'CVE-2026-1', reason: 'Checked: not loaded by the process' },
        { vulnerability: 'CVE-2026-2' },
        { vulnerability: 'CVE-2026-3', reason: 'Checked', package: { name: 'musl' } },
        { 'fix-state': 'wont-fix', reason: 'Nothing to do' },
      ],
    };
    expect(unreviewedIgnores(config)).toEqual([
      'CVE-2026-2: no reason',
      'CVE-2026-3: wider than one vulnerability',
      '{"fix-state":"wont-fix","reason":"Nothing to do"}',
    ]);
  });

  it('recognises settings that hide findings by their fix state', () => {
    expect(unreviewedIgnores({ 'only-fixed': true, 'ignore-wontfix': 'high' })).toEqual(['only-fixed', 'ignore-wontfix']);
  });

  it('names one reviewed vulnerability per rule, and nothing else', () => {
    expect(unreviewedIgnores(parse(read('.grype.yaml')) as Record<string, unknown>)).toEqual([]);
  });
});

describe('SECURITY.md', () => {
  it('gives a private route, a response time and supported versions', () => {
    const policy = read('SECURITY.md');
    expect(policy).toContain('https://github.com/volveran/volveran/security/advisories/new');
    expect(policy).toMatch(/within \d+ days/);
    expect(policy).toMatch(/^## Supported versions$/m);
  });
});
