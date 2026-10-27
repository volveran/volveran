// The pod passes the restricted Pod Security Standard: non-root numeric user,
// read-only root filesystem, no privilege escalation, no capabilities,
// RuntimeDefault seccomp. Only the audit store and /tmp are writable.
import { describe, expect, it } from 'vitest';
import { container, podSpec, render, volumeAt } from './render.js';

describe('pod security', () => {
  it('runs the pod as the non-root user and group 1000, with fsGroup 1000 so the audit store is writable', () => {
    expect(podSpec(render()).securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
  });

  it('locks the container down', () => {
    expect(container(render()).securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    });
  });

  it('mounts a small emptyDir at /tmp', () => {
    const chart = render();
    const { mount, volume } = volumeAt(chart, '/tmp');
    expect(mount).toBeDefined();
    expect(volume.emptyDir).toEqual({ sizeLimit: '64Mi' });
  });

  it('uses only volume types the restricted standard allows', () => {
    const allowed = ['configMap', 'csi', 'downwardAPI', 'emptyDir', 'ephemeral', 'persistentVolumeClaim', 'projected', 'secret'];
    for (const volume of podSpec(render()).volumes as Record<string, unknown>[]) {
      const types = Object.keys(volume).filter((key) => key !== 'name');
      expect(types.every((type) => allowed.includes(type)), JSON.stringify(volume)).toBe(true);
    }
  });
});
