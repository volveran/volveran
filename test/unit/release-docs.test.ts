// The README quick start and docker-compose.example.yml describe the image the
// release workflow publishes (.github/workflows/release.yml), so they must
// name the version in package.json and the paths and defaults in the
// Dockerfile. Bumping the version without updating them fails here.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const version = (JSON.parse(read('package.json')) as { version: string }).version;
const image = 'ghcr.io/volveran/volveran';
const readme = read('README.md');
const dockerfile = read('Dockerfile');
const workflow = read('.github/workflows/release.yml');

type Service = {
  image?: string;
  network_mode?: string;
  read_only?: boolean;
  environment?: Record<string, string | null>;
  volumes?: string[];
};
const compose = parse(read('docker-compose.example.yml')) as { services: Record<string, Service> };
const solo = compose.services['volveran'];

/** `ENV A=1 B=2` in the Dockerfile's final stage. */
function imageEnv(name: string): string | undefined {
  const finalStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  return new RegExp(`\\b${name}=(\\S+)`).exec(finalStage)?.[1];
}

/** Every `image:tag` reference to the published image in a text. */
function imageRefs(text: string): string[] {
  return [...text.matchAll(/ghcr\.io\/volveran\/volveran(?::[\w.-]+)?/g)].map((m) => m[0]);
}

describe('release quick start', () => {
  it('publishes the image the docs name', () => {
    expect(workflow).toContain(image);
  });

  it('README pulls the version in package.json', () => {
    const refs = imageRefs(readme);
    expect(refs).toContain(`${image}:${version}`);
    for (const ref of refs) expect([image, `${image}:${version}`, `${image}:latest`]).toContain(ref);
  });

  it('the compose example runs the version in package.json', () => {
    expect(solo?.image).toBe(`${image}:${version}`);
  });

  it('the compose example runs Solo Mode on the host network, read-only', () => {
    expect(solo?.network_mode).toBe('host');
    expect(solo?.read_only).toBe(true);
    expect(solo?.environment?.['VOLVERAN_HOST'] ?? imageEnv('VOLVERAN_HOST')).toBe('127.0.0.1');
    expect(solo?.environment).toHaveProperty('VOLVERAN_OPERATOR');
  });

  it('the compose example mounts the profiles file where the image reads it', () => {
    const profilesFile = imageEnv('VOLVERAN_PROFILES_FILE');
    expect(profilesFile).toBe('/config/profiles.yaml');
    expect(solo?.volumes?.some((v) => v.split(':')[1] === profilesFile)).toBe(true);
  });

  it('the compose example passes the password variable profiles.example.yaml names for dev', () => {
    const profiles = parse(read('profiles.example.yaml')) as { profiles: Array<{ name: string; passwordEnv: string }> };
    const dev = profiles.profiles.find((p) => p.name === 'dev')!;
    expect(solo?.environment).toHaveProperty(dev.passwordEnv);
  });
});
