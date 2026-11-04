// The Pages workflow publishes the landing page and the demo: on main, and after
// a release, when the demo moves to the new release. The github-pages
// environment deploys from main only, so a release does not run Pages itself:
// release.yml dispatches pages.yml on main once the release is out.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}
const workflow = parse(readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8')) as {
  on: { push: { branches: string[]; tags?: string[]; paths: string[] }; workflow_dispatch?: unknown };
  jobs: { deploy: { steps: Step[] } };
};
const steps = workflow.jobs.deploy.steps;
const runs = steps.map((s) => s.run ?? '').join('\n');

describe('the Pages workflow', () => {
  it('runs on pushes to main that touch the site, the demo or its data, and when dispatched', () => {
    expect(workflow.on.push.branches).toEqual(['main']);
    // A tag push could not deploy: the github-pages environment allows main only.
    expect(workflow.on.push.tags).toBeUndefined();
    expect('workflow_dispatch' in workflow.on).toBe(true);
    expect(workflow.on.push.paths).toEqual(
      expect.arrayContaining(['site/**', 'docs/images/**', 'docs/demo/**', 'scripts/demo.mjs', 'scripts/release-tag.mjs', '.github/workflows/pages.yml']),
    );
  });

  it("builds the demo from main's code, whatever pushed", () => {
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('main');
    expect(runs).toMatch(/node scripts\/demo\.mjs build _site\/demo/);
  });

  it('runs on changes to the demo check too', () => {
    expect(workflow.on.push.paths).toEqual(expect.arrayContaining(['scripts/demo-*.mjs', 'package.json']));
  });

  it('checks the built demo, contract and smoke run in Firefox, before anything is uploaded or deployed', () => {
    const index = (find: (s: Step) => boolean) => steps.findIndex(find);
    const build = index((s) => /node scripts\/demo\.mjs build _site\/demo/.test(s.run ?? ''));
    const firefox = index((s) => s.uses?.startsWith('browser-actions/setup-firefox@') ?? false);
    const check = index((s) => /npm run demo:check -- _site\/demo/.test(s.run ?? ''));
    const upload = index((s) => s.uses?.startsWith('actions/upload-pages-artifact@') ?? false);
    const deploy = index((s) => s.uses?.startsWith('actions/deploy-pages@') ?? false);
    expect([build, firefox, check].every((i) => i >= 0)).toBe(true);
    expect(build < check && firefox < check && check < upload && upload < deploy).toBe(true);
    expect(steps[firefox]!.uses).toMatch(/@[0-9a-f]{40}$/);
    expect((steps[check] as Step & { env?: Record<string, string> }).env?.FIREFOX).toMatch(/steps\.firefox\.outputs\.firefox-path/);
    // A failed check must stop the job: nothing after it may run regardless.
    expect(steps.slice(check + 1).some((s) => /always\(\)|failure\(\)/.test(String((s as { if?: string }).if ?? '')))).toBe(false);
  });

  it('publishes the landing page as before, with its images, and the demo under /demo/', () => {
    expect(runs).toMatch(/cp -r site\/\. _site\//);
    expect(runs).toMatch(/cp -r docs\/images _site\/images/);
    expect(steps.find((s) => s.uses?.startsWith('actions/upload-pages-artifact@'))?.with?.path).toBe('_site');
  });
});

describe('the Release workflow', () => {
  interface Job {
    needs?: string | string[];
    permissions?: Record<string, string>;
    steps: Array<Step & { env?: Record<string, string> }>;
  }
  const release = parse(readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')) as {
    jobs: Record<string, Job>;
  };
  const dispatches = (s: Step) => /gh workflow run pages\.yml\b/.test(s.run ?? '');

  it('republishes the demo after the GitHub Release, by dispatching the Pages workflow on main', () => {
    const job = Object.values(release.jobs).find((j) => j.steps.some(dispatches));
    expect(job).toBeDefined();
    expect([job!.needs].flat()).toContain('github-release');
    expect(job!.permissions).toEqual({ actions: 'write' });
    const step = job!.steps.find(dispatches)!;
    expect(step.run).toMatch(/--ref main\b/);
    expect(step.env?.GH_TOKEN).toMatch(/github\.token|secrets\.GITHUB_TOKEN/);
  });
});
