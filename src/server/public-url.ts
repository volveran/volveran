// Pure startup setting: where Volverán is reached from outside, for the links
// in notifications. VOLVERAN_PUBLIC_URL, else in Team Mode the origin of the
// OIDC redirect URL, else nothing: notifications then carry no link.
import type { RunMode } from './run-mode.js';

export function resolvePublicUrl(
  env: Record<string, string | undefined>,
  mode: RunMode,
): { ok: true; url: string | null } | { ok: false; error: string } {
  const value = env.VOLVERAN_PUBLIC_URL?.trim();
  if (!value) return { ok: true, url: mode.kind === 'team' ? new URL(mode.oidc.redirectUrl).origin : null };
  const refused = {
    ok: false as const,
    error: `VOLVERAN_PUBLIC_URL must be an http or https URL without credentials, query or fragment, such as https://volveran.example.com, not "${value}".`,
  };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refused;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return refused;
  return { ok: true, url: (url.origin + url.pathname).replace(/\/+$/, '') };
}
