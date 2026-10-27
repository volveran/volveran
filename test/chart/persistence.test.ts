// The audit store (SQLite Audit Entries and Discarded Message bodies) lives on
// a PersistentVolumeClaim that outlives the release.
import { describe, expect, it } from 'vitest';
import { env, render, renderNotes, renderRefusal, volumeAt, type Rendered } from './render.js';

/** The volume mounted at the audit store directory. */
const dataVolume = (chart: Rendered) => volumeAt(chart, '/data').volume;

describe('persistence with an existing claim', () => {
  it('mounts the existing claim and creates no PersistentVolumeClaim', () => {
    const chart = render({ persistence: { existingClaim: 'volveran-restored' } });
    expect(chart.ofKind('PersistentVolumeClaim')).toEqual([]);
    expect(dataVolume(chart).persistentVolumeClaim).toEqual({ claimName: 'volveran-restored' });
  });
});

describe('persistence turned off', () => {
  const off = { persistence: { enabled: false } };

  it('uses an emptyDir for the audit store and creates no PersistentVolumeClaim', () => {
    const chart = render(off);
    expect(chart.ofKind('PersistentVolumeClaim')).toEqual([]);
    expect(dataVolume(chart)).toEqual({ name: dataVolume(chart).name, emptyDir: {} });
  });

  it('warns in the install notes that Audit Entries and Discarded Message bodies are lost on every restart', () => {
    const notes = renderNotes(off);
    expect(notes).toContain('WARNING');
    expect(notes).toContain('Audit Entries and Discarded Message bodies are lost on every restart');
    expect(notes).not.toContain('PersistentVolumeClaim');
  });

  it('does not warn when persistence is on', () => {
    expect(renderNotes()).not.toContain('WARNING');
    expect(renderNotes({ persistence: { existingClaim: 'volveran-restored' } })).toContain(
      'PersistentVolumeClaim volveran-restored',
    );
  });

  it.each([false, true])('refuses an existingClaim with persistence off (skip schema: %s)', (skipSchemaValidation) => {
    expect(
      renderRefusal({ persistence: { enabled: false, existingClaim: 'volveran-restored' } }, { skipSchemaValidation }),
    ).toContain('persistence.existingClaim is set but persistence.enabled is false');
  });
});

describe('persistence', () => {
  it('mounts a PersistentVolumeClaim at the audit store directory', () => {
    const chart = render();
    expect(env(chart, 'VOLVERAN_DATA_DIR').value).toBe('/data');
    expect(dataVolume(chart).persistentVolumeClaim.claimName).toBe(chart.one('PersistentVolumeClaim').metadata.name);
  });

  it('keeps the claim when the release is uninstalled', () => {
    expect(render().one('PersistentVolumeClaim').metadata.annotations).toMatchObject({
      'helm.sh/resource-policy': 'keep',
    });
  });

  it('asks for 1Gi ReadWriteOnce on the default StorageClass by default', () => {
    const spec = render().one('PersistentVolumeClaim').spec;
    expect(spec).toEqual({ accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } });
  });

  it('takes size, StorageClass and access mode from values', () => {
    const spec = render({
      persistence: { size: '10Gi', storageClass: 'fast-ssd', accessMode: 'ReadWriteOncePod' },
    }).one('PersistentVolumeClaim').spec;
    expect(spec).toEqual({
      accessModes: ['ReadWriteOncePod'],
      storageClassName: 'fast-ssd',
      resources: { requests: { storage: '10Gi' } },
    });
  });
});
