// The image reference: a private mirror, a digest pin that overrides the tag,
// and pull Secrets for a registry that needs credentials.
import { describe, expect, it } from 'vitest';
import { container, podSpec, render, renderRefusal } from './render.js';

const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('image', () => {
  it('pins the image by digest, overriding the tag', () => {
    const chart = render({ image: { tag: '0.2.0', digest } });
    expect(container(chart).image).toBe(`ghcr.io/volveran/volveran@${digest}`);
  });

  it('pulls from an overridden repository, by tag or by digest', () => {
    expect(container(render({ image: { repository: 'registry.example.com/mirror/volveran', tag: '0.2.0' } })).image).toBe(
      'registry.example.com/mirror/volveran:0.2.0',
    );
    expect(container(render({ image: { repository: 'registry.example.com/mirror/volveran', digest } })).image).toBe(
      `registry.example.com/mirror/volveran@${digest}`,
    );
  });

  it('sets imagePullSecrets from the named Secrets', () => {
    const chart = render({ image: { pullSecrets: ['mirror-pull', 'backup-pull'] } });
    expect(podSpec(chart).imagePullSecrets).toEqual([{ name: 'mirror-pull' }, { name: 'backup-pull' }]);
  });

  it('sets no imagePullSecrets by default', () => {
    expect(podSpec(render()).imagePullSecrets).toBeUndefined();
  });

  it('refuses a digest that is not sha256:<64 hex>', () => {
    expect(renderRefusal({ image: { digest: '0123abcd' } }, { skipSchemaValidation: true })).toContain(
      'image.digest must look like sha256:',
    );
    expect(renderRefusal({ image: { digest: '0123abcd' } })).toContain('/image/digest');
  });
});
