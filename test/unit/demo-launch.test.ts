// How an evaluator reaches the demo and finds their way in it: the demo
// banner's suggested path (site/demo/index.html), the landing page's hero
// (site/index.html) and the README. Each points on to the Docker command.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const demoPage = read('site/demo/index.html');
const banner = /<div id="demo-banner"[\s\S]*?\n {4}<\/div>/.exec(demoPage)?.[0] ?? '';

describe('the demo banner', () => {
  it('suggests the path the smoke run walks, in three steps', () => {
    const steps = [...(/<ol class="demo-path"[^>]*>([\s\S]*?)<\/ol>/.exec(banner)?.[1] ?? '').matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]!));
    expect(steps).toEqual([
      'Check out orders.dlq on production',
      'Replay the timeouts with a Canary',
      'See it die again, then Restore what you discarded',
    ]);
  });

  it('still names the version, says nothing touches a real broker, and resets', () => {
    expect(banner).toContain('class="demo-version"');
    expect(text(banner)).toContain('nothing here touches a real broker');
    expect(banner).toContain('class="demo-reset"');
  });

  it("points on to the landing page's Docker command, relative so it works under /volveran/demo/", () => {
    expect(banner).toMatch(/<a [^>]*href="\.\.\/#start"[^>]*>Run it in Docker<\/a>/);
  });

  it('sits in the page above the app, never over it', () => {
    // A guided tour or overlay is out of scope (#147): the path is text in the banner.
    const css = read('site/demo/browser/banner.css');
    expect(css).not.toMatch(/position:\s*(fixed|absolute|sticky)/);
    expect(css).not.toMatch(/z-index/);
  });
});

const landing = read('site/index.html');

describe("the landing page's hero", () => {
  it('offers "Try it in your browser" right next to "Run it in Docker", relative so it works under /volveran/', () => {
    const actions = /<p class="actions">([\s\S]*?)<\/p>/.exec(landing)?.[1] ?? '';
    const links = [...actions.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[2], m[1]]);
    expect(links.slice(0, 2)).toEqual([
      ['Run it in Docker', '#start'],
      ['Try it in your browser', 'demo/'],
    ]);
  });

  it('has the quick start send whoever tried the demo on to the docker run', () => {
    const start = /<section[^>]*id="start"[^>]*>([\s\S]*?)<\/section>/.exec(landing)?.[1] ?? '';
    expect(start).toMatch(/<a href="demo\/">/);
    expect(start.indexOf('href="demo/"')).toBeLessThan(start.indexOf('docker run'));
  });

  it('adds no analytics and no cookies: no third-party script and nothing that sets a cookie', () => {
    expect(landing).not.toMatch(/<script[^>]+src=/);
    expect(landing).not.toMatch(/cookie|analytics|gtag|plausible|umami/i);
  });
});

describe('the README', () => {
  it('links to the demo, and its quick start goes on from there to the docker run', () => {
    const demo = 'https://volveran.github.io/volveran/demo/';
    const readme = read('README.md');
    const quickStart = readme.slice(readme.indexOf('## Quick start'));
    expect(readme.indexOf(demo)).toBeLessThan(readme.indexOf('## Why'));
    expect(quickStart.indexOf(demo)).toBeGreaterThan(-1);
    expect(quickStart.indexOf(demo)).toBeLessThan(quickStart.indexOf('docker run'));
  });
});
