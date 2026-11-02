// The images the kind smoke test loads into the cluster before the
// dependencies start, read from test/smoke/deps.yaml so they cannot drift.
import { describe, expect, it } from 'vitest';
import { containerImages, dependencyImages } from '../smoke/kind-env.mjs';

describe('smoke dependency images', () => {
  it('lists every container and init container image once, across documents', () => {
    const manifest = [
      'apiVersion: v1',
      'kind: Service',
      'metadata: { name: svc }',
      '---',
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec:',
      '  template:',
      '    spec:',
      '      initContainers: [{ name: init, image: busybox:1 }]',
      '      containers: [{ name: a, image: one:1 }, { name: b, image: busybox:1 }]',
      '---',
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec: { template: { spec: { containers: [{ name: c, image: two:2 }] } } }',
    ].join('\n');
    expect(containerImages(manifest)).toEqual(['busybox:1', 'one:1', 'two:2']);
  });

  it('are the RabbitMQ, PostgreSQL and mock OIDC provider images of deps.yaml', () => {
    const images = dependencyImages();
    expect(images).toHaveLength(3);
    expect(images.some((i) => i.startsWith('postgres:'))).toBe(true);
    expect(images.some((i) => i.startsWith('rabbitmq:'))).toBe(true);
    expect(images.some((i) => i.startsWith('ghcr.io/navikt/mock-oauth2-server:'))).toBe(true);
  });
});
