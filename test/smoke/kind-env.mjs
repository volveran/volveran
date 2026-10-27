// Where the kind smoke test's pieces live: the cluster, namespaces, release,
// local port-forward ports and the Helm command that installs the chart from
// this checkout. Shared by scripts/kind-smoke.mjs (which builds the cluster)
// and test/smoke/operator.test.ts (which upgrades the release and restarts
// port-forwards), so both drive the same install.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
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
/** The kubectl flags that select the smoke cluster. */
export const kubectlFlags = ['--kubeconfig', kubeconfig, '--context', kubeContext];

/** Volverán's namespace, which enforces the restricted Pod Security Standard. */
export const appNamespace = 'volveran-smoke';
/** RabbitMQ and the mock OIDC provider (their images do not run under restricted). */
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
/** RabbitMQ's administrator from test/broker/definitions.json. */
export const brokerAdmin = { username: 'volveran-admin', password: 'volveran-admin-pass' };

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
 * kubectl against the smoke cluster; returns its stdout.
 * @param {string[]} args
 */
export function kubectl(...args) {
  return run('kubectl', [...kubectlFlags, ...args]);
}
