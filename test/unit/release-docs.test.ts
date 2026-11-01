// The README quick start, the Team Mode and Kubernetes guides, the Flux
// example and docker-compose.example.yml describe the image and chart the
// release workflow publishes (.github/workflows/release.yml), so they must name
// the version in package.json and the paths and defaults in the Dockerfile;
// the app reports
// the same version at startup and the CHANGELOG has an entry for it. Bumping
// the version without updating them fails here.
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

describe('the profiles file schema', () => {
  it('is attached to the GitHub Release', () => {
    const jobs = (parse(workflow) as { jobs: Record<string, { steps: Array<{ run?: string }> }> }).jobs;
    const create = jobs['github-release']!.steps.map((step) => step.run ?? '').find((run) => run.includes('gh release create'));
    expect(create).toMatch(/gh release create[^\n]*(\\\n[^\n]*)*profiles\.schema\.json/);
  });

  it('names the file the repository holds', () => {
    expect(JSON.parse(read('profiles.schema.json'))).toHaveProperty('$defs.brokerProfile');
  });
});

describe('The OpenAPI description', () => {
  it('is attached to the GitHub Release', () => {
    const jobs = (parse(workflow) as { jobs: Record<string, { steps: Array<{ run?: string }> }> }).jobs;
    const create = jobs['github-release']!.steps.map((step) => step.run ?? '').find((run) => run.includes('gh release create'));
    expect(create).toMatch(/gh release create[^\n]*(\\\n[^\n]*)*openapi\.json/);
  });

  it('names the file the repository holds', () => {
    expect(JSON.parse(read('openapi.json'))).toHaveProperty('paths');
  });
});

describe('release quick start', () => {
  it('publishes the image the docs name', () => {
    expect(workflow).toContain(image);
  });

  it.each(['README.md', 'docs/team-mode.md', 'site/index.html'])('%s pulls the version in package.json', (file) => {
    const refs = imageRefs(read(file));
    expect(refs).toContain(`${image}:${version}`);
    for (const ref of refs) expect([image, `${image}:${version}`, `${image}:latest`]).toContain(ref);
  });

  it('README and the Kubernetes guide install the chart version in package.json', () => {
    for (const text of [readme, read('docs/kubernetes.md')]) {
      const installs = [...text.matchAll(/oci:\/\/ghcr\.io\/volveran\/charts\/volveran[^\n]*?--version (\d\S*)/g)];
      expect(installs.length).toBeGreaterThan(0);
      for (const install of installs) expect(install[1]).toBe(version);
    }
  });

  it('the app reports the version in package.json', () => {
    expect(read('src/shared/product.ts')).toContain(`version: '${version}'`);
  });

  it('the CHANGELOG has an entry for the version in package.json', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
    expect(changelog).toContain(`[${version}]: https://github.com/volveran/volveran/releases/tag/v${version}`);
    expect(changelog).toContain(`[Unreleased]: https://github.com/volveran/volveran/compare/v${version}...HEAD`);
  });

  it("the Flux example follows the patch releases of the version in package.json", () => {
    const source = parse(read('examples/flux/app/ocirepository.yaml')) as { spec: { ref: { semver: string } } };
    const [major, minor] = version.split('.');
    expect(source.spec.ref.semver).toBe(`${major}.${minor}.x`);
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

  it('the compose example keeps the audit store on a volume where the image writes it', () => {
    const dataDir = imageEnv('VOLVERAN_DATA_DIR');
    expect(dataDir).toBe('/data');
    expect(dockerfile).toMatch(/^VOLUME \/data$/m);
    expect(solo?.volumes?.some((v) => v.split(':')[1] === dataDir)).toBe(true);
    expect(readme).toContain(`-v volveran-data:${dataDir}`);
    expect(readme).not.toContain('TODO(#6)');
  });

  it('the compose example passes the password variable profiles.example.yaml names for dev', () => {
    const profiles = parse(read('profiles.example.yaml')) as { profiles: Array<{ name: string; passwordEnv: string }> };
    const dev = profiles.profiles.find((p) => p.name === 'dev')!;
    expect(solo?.environment).toHaveProperty(dev.passwordEnv);
  });
});
