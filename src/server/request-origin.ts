// Whether a request may come from where it says (#123), for what a malicious page can send
// through an Operator's browser. A script sends no Origin, and needs none.
//
//   Team Mode  A state-changing request with an Origin must come from where the web app is
//              reached: the origin of VOLVERAN_OIDC_REDIRECT_URL or VOLVERAN_PUBLIC_URL. This
//              is on top of SameSite=Lax, which lets a sibling subdomain through. The Host is
//              not looked at: a proxy or forwarding Replica may change it, and a rebound name
//              carries no sign-in cookie.
//   Solo Mode  There is no credential but the loopback address, so every request, reads too,
//              needs a loopback Host or VOLVERAN_PUBLIC_URL's: a DNS-rebinding page sends its
//              own name. An Origin must be the Host's own (a page on another local port is
//              another site) or VOLVERAN_PUBLIC_URL's.
import type { IncomingHttpHeaders } from 'node:http';
import { HttpError } from './http-error.js';
import { isLoopback } from './is-loopback.js';
import type { RunMode } from './run-mode.js';

type Refusal = HttpError<'foreign_host' | 'foreign_origin'>;

/** Answers why a request is refused, or null when it may go on. */
export type RequestOriginCheck = (method: string | undefined, headers: IncomingHttpHeaders) => Refusal | null;

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const foreignOrigin = (): Refusal =>
  new HttpError(403, 'foreign_origin', 'This request comes from another site (its Origin header), so it was refused. If this is where you reach Volverán, set VOLVERAN_PUBLIC_URL to it.');

const foreignHost = (): Refusal =>
  new HttpError(403, 'foreign_host', 'Solo Mode answers only at a loopback address (its Host header), so this request was refused. If this is where you reach Volverán, set VOLVERAN_PUBLIC_URL to it.');

/** A Host header's `host[:port]` in the form a URL gives it, or null when it is anything more. */
function normalHost(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(`http://${value}`);
    return url.href === `${url.origin}/` ? url : null;
  } catch {
    return null;
  }
}

/** An Origin header's host, when it is one origin as a browser writes it. */
function originHost(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === value ? url.host : null;
  } catch {
    return null;
  }
}

export function requestOriginCheck(mode: RunMode, publicUrl: string | null): RequestOriginCheck {
  const publicOrigin = publicUrl === null ? null : new URL(publicUrl);
  if (mode.kind === 'team') {
    const allowed = new Set([new URL(mode.oidc.redirectUrl).origin, publicOrigin?.origin]);
    return (method, { origin }) => (origin !== undefined && !READ_METHODS.has(method ?? '') && !allowed.has(origin) ? foreignOrigin() : null);
  }
  return (_method, { host, origin }) => {
    const url = normalHost(host);
    if (!url || !(isLoopback(url.hostname.replace(/^\[|\]$/g, '')) || url.host === publicOrigin?.host)) return foreignHost();
    if (origin === undefined || origin === publicOrigin?.origin || originHost(origin) === url.host) return null;
    return foreignOrigin();
  };
}
