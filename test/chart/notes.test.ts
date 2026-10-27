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

describe('install notes with a route', () => {
  const route = { enabled: true, parentRefs: [{ name: 'edge' }], hostnames: ['volveran.example.com'] };

  it('print the external URL from the HTTPRoute host instead of the port-forward command', () => {
    const notes = renderNotes({ httpRoute: route });
    expect(notes).toContain('Open Volverán at https://volveran.example.com/');
    expect(notes).not.toContain('port-forward');
  });

  it('print the external URL from the Ingress host', () => {
    expect(renderNotes({ ingress: { enabled: true, hosts: ['volveran.example.com'] } })).toContain(
      'Open Volverán at https://volveran.example.com/',
    );
  });

  it('print the redirect URL and no warning when its host is a route host', () => {
    const notes = renderNotes({ httpRoute: route });
    expect(notes).toContain('https://volveran.example.com/auth/callback');
    expect(notes).not.toContain('WARNING');
  });

  it('warn when the redirect URL host matches no route host', () => {
    const notes = renderNotes({ httpRoute: { ...route, hostnames: ['triage.example.com'] } });
    expect(notes).toContain(
      'WARNING: the host of oidc.redirectUrl (volveran.example.com) is not a route host (triage.example.com)',
    );
  });

  it('accept a redirect URL host covered by a wildcard HTTPRoute host name', () => {
    expect(renderNotes({ httpRoute: { ...route, hostnames: ['*.example.com'] } })).not.toContain('WARNING');
  });

  it('match the redirect URL host against either route kind when both are enabled', () => {
    const notes = renderNotes({
      httpRoute: { ...route, hostnames: ['triage.example.com'] },
      ingress: { enabled: true, hosts: ['volveran.example.com'] },
    });
    expect(notes).toContain('Open Volverán at https://volveran.example.com/');
    expect(notes).not.toContain('WARNING');
  });
});

describe('install notes without a route', () => {
  it('explain how to port-forward', () => {
    const notes = renderNotes();
    expect(notes).toContain('No HTTPRoute or Ingress is enabled');
    expect(notes).toContain('port-forward');
  });
});
