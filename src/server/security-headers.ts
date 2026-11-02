// The headers that stop a browser treating what Volverán sends as anything but what it is:
// Message content comes from anyone who can publish to a queue (docs/threat-model.md).
//
// They go on the raw response as a request arrives, not in a Fastify hook, because Fastify
// answers some requests without running any hook (a URL it cannot decode, shutting down).
// A route or a static file can still replace them: static files set their own Cache-Control.
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/**
 * The web app bundles its scripts, styles and fonts and talks only to its own origin. React
 * sets `style` properties through the DOM, which style-src does not govern, and the swallow
 * of the wordmark is a CSS mask in a data: URL, which counts as an image.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** A year, without includeSubDomains: the rest of the domain is not Volverán's to decide. */
const STRICT_TRANSPORT_SECURITY = 'max-age=31536000';

/** Every listener a browser could open. API answers carry Message bodies, so nothing is cached unless it says so. */
export function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
}

/** TLS ends at the proxy in front. A browser ignores HSTS received over plain http, so a forged header gains nothing. */
function cameOverHttps(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0]?.trim().toLowerCase() === 'https';
}

/**
 * Sets the headers on every answer of the web port. A forwarded answer leaves here too, as the
 * Owner Replica's internal port sets none of them. `publicUrl` covers a proxy that does not say
 * how the request came.
 */
export function sendSecurityHeaders(server: Server, publicUrl: string | null): void {
  const reachedOverHttps = publicUrl?.startsWith('https:') ?? false;
  server.prependListener('request', (req: IncomingMessage, res: ServerResponse) => {
    setSecurityHeaders(res);
    if (reachedOverHttps || cameOverHttps(req)) res.setHeader('strict-transport-security', STRICT_TRANSPORT_SECURITY);
  });
}
