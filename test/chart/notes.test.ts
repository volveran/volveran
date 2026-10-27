// The install notes tell the platform engineer how to finish the set-up: the
// Service, how to port-forward to it, and the redirect URL the OIDC client
// must register.
import { describe, expect, it } from 'vitest';
import { release, render, renderNotes } from './render.js';

describe('install notes', () => {
  it('name the Service and show how to port-forward to it', () => {
    const service = render({ service: { port: 80 } }).one('Service').metadata.name;
    const notes = renderNotes({ service: { port: 80 } });
    expect(notes).toContain(`Service: ${service}`);
    expect(notes).toContain(`kubectl --namespace ${release.namespace} port-forward service/${service} 8080:80`);
  });

  it('print the redirect URL the OIDC client must register', () => {
    expect(renderNotes()).toContain('https://volveran.example.com/auth/callback');
  });
});
