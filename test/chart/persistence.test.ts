// The audit store (SQLite Audit Entries and Discarded Message bodies) lives on
// a PersistentVolumeClaim that outlives the release.
import { describe, expect, it } from 'vitest';
import { container, env, podSpec, render } from './render.js';

describe('persistence', () => {
  it('mounts a PersistentVolumeClaim at the audit store directory', () => {
    const chart = render();
    expect(env(chart, 'VOLVERAN_DATA_DIR').value).toBe('/data');
    const mount = container(chart).volumeMounts.find((m: { mountPath: string }) => m.mountPath === '/data');
    const volume = podSpec(chart).volumes.find((v: { name: string }) => v.name === mount.name);
    expect(volume.persistentVolumeClaim.claimName).toBe(chart.one('PersistentVolumeClaim').metadata.name);
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
