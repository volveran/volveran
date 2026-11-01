// docs/compatibility.md supports only what is run, so its table must name what CI pins. Moving a
// pin without the guide, or the guide without a pin, fails here. `kubectl version` in
// test/smoke/replicas.test.ts checks that the pinned node image is what really ran.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { kubernetesNodeDigests, kubernetesNodeImage, kubernetesVersion } from '../smoke/kind-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/** The "Supported" cell of a row of the guide's table. */
function supported(software: string): string | undefined {
  const section = read('docs/compatibility.md').split('## Supported versions')[1] ?? '';
  return section.split('\n').map((line) => line.split('|').map((cell) => cell.trim())).find((cells) => cells[1] === software)?.[2];
}

const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1]!);

describe('The supported versions', () => {
  const compose = read('test/broker/docker-compose.yml');
  const deps = read('test/smoke/deps.yaml');

  it('of RabbitMQ are what the test broker and the smoke test run', () => {
    const pins = [...all(compose, /-rabbitmq:([0-9.]+)-management/g), ...all(deps, /image: rabbitmq:([0-9.]+)-management/g)];
    expect(pins.length).toBeGreaterThanOrEqual(3);
    expect(new Set(pins)).toEqual(new Set(['4.4.0']));
    expect(supported('RabbitMQ')).toBe('4.4');
  });

  it('of PostgreSQL are what the test database and the smoke test run', () => {
    const pins = [...all(compose, /-postgres:([0-9.]+)-alpine/g), ...all(deps, /image: postgres:([0-9.]+)-alpine/g)];
    expect(pins).toHaveLength(2);
    expect(new Set(pins)).toEqual(new Set(['17.6']));
    expect(supported('PostgreSQL')).toBe('17');
  });

  it('of Kubernetes are what the smoke test pins, by digest', () => {
    expect(kubernetesVersion).toBe('v1.37.0');
    expect(kubernetesNodeImage).toMatch(/^kindest\/node:v1\.37\.0@sha256:[0-9a-f]{64}$/);
    expect(supported('Kubernetes')).toBe('1.37');
    expect(read('scripts/kind-smoke.mjs')).toContain("'--image', kubernetesNodeImage");
  });

  it('that CI runs the smoke test on are each pinned by digest', () => {
    const matrix = /kubernetes: \[([^\]]+)\]/.exec(read('.github/workflows/ci.yml'))?.[1]?.split(', ');
    expect(matrix).toEqual(Object.keys(kubernetesNodeDigests));
    for (const digest of Object.values(kubernetesNodeDigests)) expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('of Node are what the image is built on and CI runs', () => {
    expect(new Set(all(read('Dockerfile'), /^FROM node:([0-9]+)-alpine@sha256:/gm))).toEqual(new Set(['24']));
    const ci = all(read('.github/workflows/ci.yml'), /node-version: (\S+)/g);
    expect(ci.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ci)).toEqual(new Set(['24']));
    expect((JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node).toBe('^24');
    expect(supported('Node')).toBe('24');
  });
});
