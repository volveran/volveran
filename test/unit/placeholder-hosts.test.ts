// The repository is public and generic: the docs, the chart and the Flux
// example name no real organisation's hosts, issuers or brokers. Every host
// they mention is an example.com name, a documentation or private address, a
// cluster-local name, or a public service Volverán's set-up really uses (the
// registry, the signing identity, identity provider vendors, references).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The files users copy from or read for set-up. */
const scanned = ['README.md', 'GLOSSARY.md', 'profiles.example.yaml', 'docker-compose.example.yml', 'docs', 'charts', 'examples'];

/** Public hosts the docs may name, and any of their subdomains. */
const publicHosts = [
  // Volverán's own registry, source, signing identity and Sigstore.
  'ghcr.io', 'github.com', 'githubusercontent.com', 'sigstore.dev',
  // Identity provider vendors named in the Team Mode guide.
  'jumpcloud.com', 'okta.com', 'microsoftonline.com',
  // References.
  'kubernetes.io', 'k8s.io', 'fluxcd.io', 'helm.sh', 'rabbitmq.com', 'getsops.io', 'age-encryption.org',
  'keepachangelog.com', 'semver.org', 'nodejs.org', 'openid.net', 'datatracker.ietf.org', 'json-schema.org',
  // Tools compared in docs/comparison.md.
  'warrenops.io', 'rabbitgui.com',
];

function files(entry: string): string[] {
  const full = path.join(root, entry);
  if (!statSync(full).isDirectory()) return [entry];
  return readdirSync(full).flatMap((child) => files(path.join(entry, child)));
}

/** Host names in a text: URL hosts, and bare names under a common public suffix. */
function hosts(raw: string): string[] {
  // Regular expressions (a Flux matchOIDCIdentity) escape their dots.
  const text = raw.replaceAll('\\.', '.');
  const urlHosts = [...text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([a-z0-9.-]+)/gi)].map((m) => m[1]!);
  const bareHosts = [...text.matchAll(/\b((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|cloud|corp|internal|lan|co|app))\b/gi)].map((m) => m[1]!);
  return [...urlHosts, ...bareHosts].map((h) => h.toLowerCase().replace(/\.$/, ''));
}

function isPlaceholder(host: string): boolean {
  const under = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  return (
    ['example.com', 'example.org', 'example.net', 'example'].some(under) ||
    ['localhost', 'svc', 'cluster.local'].some(under) ||
    // Loopback, private (RFC 1918) and documentation (RFC 5737) addresses.
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|0\.0\.0\.0$)/.test(host) ||
    publicHosts.some(under)
  );
}

describe('hosts named in the docs, the chart and the examples', () => {
  it.each(scanned.flatMap(files))('%s names only placeholder or public hosts', (file) => {
    const text = readFileSync(path.join(root, file), 'utf8');
    expect(hosts(text).filter((host) => !isPlaceholder(host))).toEqual([]);
  });

  it('finds the hosts it checks', () => {
    expect(hosts('url: https://rabbit.corp.acme.io:15671 and amqps://u@mq.acme.net, see acme.dev')).toEqual([
      'rabbit.corp.acme.io', 'mq.acme.net', 'rabbit.corp.acme.io', 'mq.acme.net', 'acme.dev',
    ]);
    expect(hosts(String.raw`'^https://login\.acme\.io$'`)).toEqual(['login.acme.io', 'login.acme.io']);
    expect(isPlaceholder('rabbit.corp.acme.io')).toBe(false);
    expect(isPlaceholder('volveran.example.com')).toBe(true);
  });
});
