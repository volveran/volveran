// The Flux example (examples/flux/) installs this chart with the values in its
// HelmRelease. Those values must pass the chart's schema and guards and render
// the install the example promises: OIDC from an existing Secret, inline Broker
// Profiles with passwords from a Secret, a persistent audit store and an
// HTTPRoute on the redirect URL's host. scripts/validate-chart.sh validates
// the example's own manifests with kubeconform.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { container, env, podSpec, render, renderNotes, repoRoot, type Values } from './render.js';

const appDir = path.join(repoRoot, 'examples/flux/app');

/** Every object in one of the example's manifest files. */
function manifests(file: string): any[] {
  return parseAllDocuments(readFileSync(path.join(appDir, file), 'utf8')).map((doc) => doc.toJS());
}

const helmRelease = manifests('helmrelease.yaml').find((obj) => obj.kind === 'HelmRelease');
const values = helmRelease.spec.values as Values;
const secrets = manifests('secrets.yaml');

/** The example's values on chart defaults alone, without the test fixture. */
const chart = () => render(values, { fixture: null });

describe('Flux example HelmRelease values', () => {
  it('render with the schema and the chart guards', () => {
    expect(chart().kinds()).toEqual(['ConfigMap', 'Deployment', 'HTTPRoute', 'PersistentVolumeClaim', 'Service']);
  });

  it('read the OIDC secrets from the Secret the example template defines', () => {
    const oidcSecret = secrets.find((s) => s.metadata.name === 'volveran-oidc');
    expect(oidcSecret).toBeDefined();
    const ref = env(chart(), 'VOLVERAN_OIDC_CLIENT_SECRET').valueFrom.secretKeyRef;
    expect(ref.name).toBe('volveran-oidc');
    expect(Object.keys(oidcSecret.stringData)).toContain(ref.key);
    expect(Object.keys(oidcSecret.stringData)).toContain(env(chart(), 'VOLVERAN_SESSION_SECRET').valueFrom.secretKeyRef.key);
  });

  it('take each Broker Profile password from a key of the example passwords Secret', () => {
    const passwords = secrets.find((s) => s.metadata.name === 'volveran-broker-passwords');
    expect(container(chart()).envFrom).toEqual([{ secretRef: { name: 'volveran-broker-passwords' } }]);
    const profiles = (values.brokerProfiles as { profiles: Array<{ passwordEnv: string }> }).profiles;
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) expect(Object.keys(passwords.stringData)).toContain(profile.passwordEnv);
  });

  it('keep the audit store on a PersistentVolumeClaim', () => {
    const rendered = chart();
    const claim = rendered.one('PersistentVolumeClaim').metadata.name;
    const data = podSpec(rendered).volumes.find((v: any) => v.name === 'data');
    expect(data.persistentVolumeClaim.claimName).toBe(claim);
  });

  it('attach an HTTPRoute to the placeholder Gateway at the redirect URL host', () => {
    const route = chart().one('HTTPRoute');
    expect(route.spec.parentRefs[0].name).toBe('edge');
    expect(route.spec.hostnames).toEqual(['volveran.example.com']);
    expect(env(chart(), 'VOLVERAN_OIDC_REDIRECT_URL').value).toBe('https://volveran.example.com/auth/callback');
    expect(renderNotes(values, { fixture: null })).not.toContain('WARNING');
  });

  it('are installed in the restricted Namespace from the OCIRepository', () => {
    const namespace = manifests('namespace.yaml')[0];
    expect(namespace.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
    expect(helmRelease.metadata.namespace).toBe(namespace.metadata.name);
    expect(helmRelease.spec.chartRef).toEqual({ kind: 'OCIRepository', name: 'volveran' });
    for (const secret of secrets) expect(secret.metadata.namespace).toBe(namespace.metadata.name);
  });

  it('keep the Namespace, and the audit claim in it, when Flux prunes the example', () => {
    // The Flux Kustomization prunes what it applied. Deleting the Namespace
    // would delete the audit store's claim with it, whatever Helm's keep
    // policy says, so the Namespace opts out of pruning.
    const fluxKustomization = parseAllDocuments(
      readFileSync(path.join(repoRoot, 'examples/flux/cluster/volveran.yaml'), 'utf8'),
    )[0]!.toJS();
    expect(fluxKustomization.spec.prune).toBe(true);
    const namespace = manifests('namespace.yaml')[0];
    expect(namespace.metadata.annotations?.['kustomize.toolkit.fluxcd.io/prune']).toBe('disabled');
    const claim = chart().one('PersistentVolumeClaim');
    expect(claim.metadata.annotations?.['helm.sh/resource-policy']).toBe('keep');
  });
});
