// The Pages workflow publishes the landing page and the demo: on main, and on a
// release tag, when the demo moves to the new release. The demo's own code
// always comes from main, even on a tag push, whose run checks out the tag.
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
  on: { push: { branches: string[]; tags: string[]; paths: string[] } };
  jobs: { deploy: { steps: Step[] } };
};
const steps = workflow.jobs.deploy.steps;
const runs = steps.map((s) => s.run ?? '').join('\n');

describe('the Pages workflow', () => {
  it('runs on pushes to main that touch the site, the demo or its data, and on every release tag', () => {
    expect(workflow.on.push.branches).toEqual(['main']);
    expect(workflow.on.push.tags).toEqual(['v*']);
    expect(workflow.on.push.paths).toEqual(
      expect.arrayContaining(['site/**', 'docs/images/**', 'docs/demo/**', 'scripts/demo.mjs', 'scripts/release-tag.mjs', '.github/workflows/pages.yml']),
    );
  });

  it("builds the demo from main's code, whatever pushed", () => {
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('main');
    expect(runs).toMatch(/node scripts\/demo\.mjs build _site\/demo/);
  });

  it('publishes the landing page as before, with its images, and the demo under /demo/', () => {
    expect(runs).toMatch(/cp -r site\/\. _site\//);
    expect(runs).toMatch(/cp -r docs\/images _site\/images/);
    expect(steps.find((s) => s.uses?.startsWith('actions/upload-pages-artifact@'))?.with?.path).toBe('_site');
  });
});
