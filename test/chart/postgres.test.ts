// The audit store on PostgreSQL: the URL comes from a Secret, TLS is required by
// default and can trust a mounted CA, and one replica on SQLite stays exactly as it was.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { container, env, podSpec, render, renderNotes, renderRefusal, repoRoot, volumeAt } from './render.js';

const version = (JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;
const onPostgres = { postgres: { existingSecret: 'volveran-postgres' } };
const bundles = [{ name: 'postgres-ca', secret: 'postgres-internal-ca' }];

describe('one replica on SQLite', () => {
  // The golden file is 0.5.1's chart rendered with the same values, with its version replaced
  // and the profiles file's format version added: any other change to the ConfigMap or the pod
  // template would be a further reason to roll the pod on upgrade.
  it('writes the format version, so Volverán does not warn of it', () => {
    expect(parse(render().one('ConfigMap').data!['profiles.yaml']!).version).toBe(1);
  });

  it("renders 0.5.1's output but for the version and the profiles file's format version", () => {
    const golden = readFileSync(path.join(repoRoot, 'test/chart/golden/single-replica-sqlite.yaml'), 'utf8').replaceAll('<version>', version);
    expect(render().output).toBe(golden);
  });
});

describe('postgres', () => {
  it('writes the format version into the profiles file it renders', () => {
    expect(parse(render(onPostgres).one('ConfigMap').data!['profiles.yaml']!).version).toBe(1);
  });

  it('reads the URL from the named Secret, under the key url by default', () => {
    expect(env(render(onPostgres), 'VOLVERAN_POSTGRES_URL')).toEqual({
      name: 'VOLVERAN_POSTGRES_URL',
      valueFrom: { secretKeyRef: { name: 'volveran-postgres', key: 'url' } },
    });
  });

  it('takes another key of the Secret', () => {
    const chart = render({ postgres: { existingSecret: 'db', urlKey: 'connection' } });
    expect(env(chart, 'VOLVERAN_POSTGRES_URL').valueFrom.secretKeyRef).toEqual({ name: 'db', key: 'connection' });
  });

  it('reads the session encryption key from the OIDC Secret, since sessions are kept in the database', () => {
    expect(env(render(onPostgres), 'VOLVERAN_SESSION_ENCRYPTION_KEY')).toEqual({
      name: 'VOLVERAN_SESSION_ENCRYPTION_KEY',
      valueFrom: { secretKeyRef: { name: 'volveran-oidc', key: 'session-encryption-key' } },
    });
  });

  it('takes another key for it', () => {
    const chart = render({ ...onPostgres, oidc: { sessionEncryptionKeyKey: 'tokens' } });
    expect(env(chart, 'VOLVERAN_SESSION_ENCRYPTION_KEY').valueFrom.secretKeyRef.key).toBe('tokens');
  });

  it('asks for no session encryption key on SQLite, where sessions stay in memory', () => {
    expect(env(render(), 'VOLVERAN_SESSION_ENCRYPTION_KEY')).toBeUndefined();
  });

  it('refuses the session encryption key in extraEnv', () => {
    expect(renderRefusal({ ...onPostgres, extraEnv: [{ name: 'VOLVERAN_SESSION_ENCRYPTION_KEY', value: 'x' }] })).toContain('VOLVERAN_SESSION_ENCRYPTION_KEY');
  });

  it('never renders a Secret holding the URL', () => {
    expect(render(onPostgres).kinds()).not.toContain('Secret');
  });

  it('requires TLS by default', () => {
    expect(env(render(onPostgres), 'VOLVERAN_POSTGRES_REQUIRE_TLS')).toEqual({ name: 'VOLVERAN_POSTGRES_REQUIRE_TLS', value: 'true' });
  });

  it('can leave TLS to the URL', () => {
    const chart = render({ postgres: { existingSecret: 'db', requireTls: false } });
    expect(env(chart, 'VOLVERAN_POSTGRES_REQUIRE_TLS')).toBeUndefined();
  });

  it('points the CA file at a mounted bundle, ca.crt by default', () => {
    const chart = render({ caBundles: { bundles }, postgres: { existingSecret: 'db', ca: { bundle: 'postgres-ca' } } });
    expect(env(chart, 'VOLVERAN_POSTGRES_CA_FILE').value).toBe('/etc/volveran/ca/postgres-ca/ca.crt');
    expect(volumeAt(chart, '/etc/volveran/ca/postgres-ca').volume.secret).toEqual({ secretName: 'postgres-internal-ca' });
  });

  it('reads another key of the bundle', () => {
    const chart = render({ caBundles: { bundles }, postgres: { existingSecret: 'db', ca: { bundle: 'postgres-ca', key: 'root.pem' } } });
    expect(env(chart, 'VOLVERAN_POSTGRES_CA_FILE').value).toBe('/etc/volveran/ca/postgres-ca/root.pem');
  });

  it('renders no claim and no data volume, as nothing is kept on the pod', () => {
    const chart = render(onPostgres);
    expect(chart.ofKind('PersistentVolumeClaim')).toEqual([]);
    expect(volumeAt(chart, '/data').mount).toBeUndefined();
    expect(podSpec(chart).volumes.map((v: { name: string }) => v.name)).not.toContain('data');
    expect(env(chart, 'VOLVERAN_DATA_DIR')).toBeUndefined();
  });

  it('keeps one replica with Recreate', () => {
    const { spec } = render(onPostgres).one('Deployment');
    expect(spec.replicas).toBe(1);
    expect(spec.strategy).toEqual({ type: 'Recreate' });
  });

  it('keeps the root filesystem read-only', () => {
    expect(container(render(onPostgres)).securityContext.readOnlyRootFilesystem).toBe(true);
  });

  it('says in the install notes where the audit store is', () => {
    const notes = renderNotes(onPostgres);
    expect(notes).toContain('Audit store: PostgreSQL');
    expect(notes).not.toContain('PersistentVolumeClaim');
  });

  it('does not warn about persistence being off, which does not matter here', () => {
    expect(renderNotes({ ...onPostgres, persistence: { enabled: false } })).not.toContain('WARNING');
  });

  describe.each([false, true])('refusals (skip schema: %s)', (skipSchemaValidation) => {
    const refusal = (values: Record<string, unknown>) => renderRefusal(values, { skipSchemaValidation });

    it('refuses a CA bundle that is not listed', () => {
      expect(refusal({ postgres: { existingSecret: 'db', ca: { bundle: 'nope' } } })).toContain('postgres.ca.bundle names "nope"');
    });

    it('refuses a CA bundle without a Secret to connect with', () => {
      expect(refusal({ caBundles: { bundles }, postgres: { ca: { bundle: 'postgres-ca' } } })).toContain('postgres.ca.bundle needs postgres.existingSecret');
    });

    it('refuses a CA with TLS turned off', () => {
      expect(refusal({ caBundles: { bundles }, postgres: { existingSecret: 'db', requireTls: false, ca: { bundle: 'postgres-ca' } } })).toContain(
        'postgres.requireTls is false but postgres.ca.bundle is set',
      );
    });

    it('refuses an existing claim, which nothing would use', () => {
      expect(refusal({ ...onPostgres, persistence: { existingClaim: 'old' } })).toContain('persistence.existingClaim is set but postgres.existingSecret');
    });

    it.each(['VOLVERAN_POSTGRES_URL', 'VOLVERAN_POSTGRES_REQUIRE_TLS', 'VOLVERAN_POSTGRES_CA_FILE'])('refuses %s in extraEnv', (name) => {
      expect(refusal({ extraEnv: [{ name, value: 'x' }] })).toContain(`extraEnv sets ${name}: use the postgres values instead`);
    });
  });
});
