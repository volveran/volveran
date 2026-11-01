// Where the kind smoke test's pieces live: the cluster, namespaces, release,
// local port-forward ports and the Helm command that installs the chart from
// this checkout. Shared by scripts/kind-smoke.mjs (which builds the cluster)
// and test/smoke/operator.test.ts (which upgrades the release and restarts
// port-forwards), so both drive the same install.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { repoRoot } from '../../scripts/test-broker-env.mjs';

export { repoRoot };

const env = process.env;

/** The kind cluster; VOLVERAN_SMOKE_CLUSTER overrides it. */
export const clusterName = env.VOLVERAN_SMOKE_CLUSTER || 'volveran-smoke';
/** The kubectl context kind creates for it. */
export const kubeContext = `kind-${clusterName}`;
/**
 * The cluster's own kubeconfig under .test-tmp/, so a run never touches
 * ~/.kube/config; VOLVERAN_SMOKE_KUBECONFIG overrides it.
 */
export const kubeconfig = env.VOLVERAN_SMOKE_KUBECONFIG || path.join(repoRoot, '.test-tmp', `${clusterName}.kubeconfig`);
/** The Kubernetes versions CI runs the smoke test on, each by digest. kind's own default would move with kind. docs/compatibility.md supports those that pass. */
/** @type {Record<string, string>} */
export const kubernetesNodeDigests = {
  'v1.33.12': 'sha256:3f5c8443c620245e4d355cfe09e96a91ead32ceaa569d3f1ca9edf0cb2fe2ff4',
  'v1.34.11': 'sha256:44e222ee2132dab25ff87301682f89eb82c7880ea3a1bf543bfe9708fd08d67d',
  'v1.35.8': 'sha256:07b2536e30b803ed61d1677a79df6115f798ce64c80f9e22f6ed45afd09323c0',
  'v1.36.4': 'sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed',
  'v1.37.0': 'sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5',
};
/** The version of this run: VOLVERAN_SMOKE_KUBERNETES, else the newest. */
export const kubernetesVersion = env.VOLVERAN_SMOKE_KUBERNETES || 'v1.37.0';
if (!(kubernetesVersion in kubernetesNodeDigests)) throw new Error(`No kind node image is pinned for Kubernetes ${kubernetesVersion}`);
export const kubernetesNodeImage = `kindest/node:${kubernetesVersion}@${kubernetesNodeDigests[kubernetesVersion]}`;
/** The kubectl flags that select the smoke cluster. */
export const kubectlFlags = ['--kubeconfig', kubeconfig, '--context', kubeContext];

/** Volverán's namespace, which enforces the restricted Pod Security Standard. */
export const appNamespace = 'volveran-smoke';
/** RabbitMQ, PostgreSQL and the mock OIDC provider (their images do not run under restricted). */
export const depsNamespace = 'volveran-smoke-deps';
export const releaseName = 'volveran';
/** The image built from this checkout and loaded into kind. */
export const image = { repository: 'volveran', tag: 'smoke' };

/**
 * Local ports of the port-forwards. The app port is part of the OIDC redirect
 * URL (plain http is allowed on loopback), so it is fixed per run.
 */
export const ports = {
  app: Number(env.VOLVERAN_SMOKE_APP_PORT || 18080),
  oidc: Number(env.VOLVERAN_SMOKE_OIDC_PORT || 18443),
  management: Number(env.VOLVERAN_SMOKE_MGMT_PORT || 18672),
};

export const smokeDir = path.join(repoRoot, 'test/smoke');
/** The private CA of the mock OIDC provider's certificate (see tls/generate.sh). */
export const caFile = path.join(smokeDir, 'tls/ca.pem');

export const oidc = {
  /** As Volverán reaches it, inside the cluster. */
  issuer: `https://oidc.${depsNamespace}.svc.cluster.local:8080/default`,
  clientId: 'volveran-test',
  clientSecret: 'volveran-test-secret',
};
export const sessionSecret = 'smoke-session-secret-0123456789abcdef';
/** The run with several Replicas: its database, and the two secrets that run adds. */
export const postgresUrl = `postgres://volveran:volveran-smoke-pass@postgres.${depsNamespace}.svc.cluster.local:5432/volveran`;
export const sessionEncryptionKey = 'smoke-session-encryption-key-0123456789';
export const forwardingSecret = 'smoke-forwarding-secret-0123456789abcdef';
export const forwardingPort = 8081;
/** The file that makes a release several Replicas on PostgreSQL. */
export const replicasValues = path.join(smokeDir, 'values-replicas.yaml');
/** RabbitMQ's administrator from test/broker/definitions.json. */
export const brokerAdmin = { username: 'volveran-admin', password: 'volveran-admin-pass' };

/**
 * Every container image a manifest names, once each, in order.
 * @param {string} manifest YAML, possibly several documents
 * @returns {string[]}
 */
export function containerImages(manifest) {
  const images = new Set();
  for (const doc of parseAllDocuments(manifest)) {
    const spec = doc.toJS()?.spec?.template?.spec;
    for (const c of [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])]) {
      if (c.image) images.add(c.image);
    }
  }
  return [...images];
}

/** The images of RabbitMQ, PostgreSQL and the mock OIDC provider (test/smoke/deps.yaml), loaded into kind before they start. */
export function dependencyImages() {
  return containerImages(readFileSync(path.join(smokeDir, 'deps.yaml'), 'utf8'));
}

/**
 * The arguments of `helm upgrade --install` for the chart in this checkout, plus `valuesFiles`.
 * @param {string[]} [valuesFiles]
 * @returns {string[]}
 */
export function helmInstallArgs(valuesFiles = []) {
  return [
    'upgrade',
    '--install',
    releaseName,
    path.join(repoRoot, 'charts/volveran'),
    '--kubeconfig',
    kubeconfig,
    '--kube-context',
    kubeContext,
    '--namespace',
    appNamespace,
    '-f',
    path.join(smokeDir, 'values.yaml'),
    ...valuesFiles.flatMap((f) => ['-f', f]),
    '--set-string',
    `image.repository=${image.repository},image.tag=${image.tag}`,
    '--set-string',
    `oidc.issuer=${oidc.issuer},oidc.redirectUrl=http://127.0.0.1:${ports.app}/auth/callback`,
    '--wait',
    '--timeout',
    '5m',
  ];
}

/**
 * Runs a command and returns its stdout; throws with its stderr on failure.
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
export function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * kubectl against the smoke cluster; throws when it fails. By default returns
 * its stdout (and puts its stderr in the error); with `stdio: 'inherit'` its
 * output goes to this process's instead and it returns ''. `input` is piped to
 * its stdin.
 * @param {string[]} args
 * @param {{ stdio?: 'pipe' | 'inherit', input?: string }} [options]
 * @returns {string}
 */
export function kubectl(args, { stdio = 'pipe', input } = {}) {
  const stdin = input === undefined ? 'ignore' : 'pipe';
  const output = execFileSync('kubectl', [...kubectlFlags, ...args], {
    encoding: 'utf8',
    input,
    stdio: [stdin, stdio, stdio],
  });
  return output ?? '';
}
