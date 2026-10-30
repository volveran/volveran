// Links into the web app's depth history, Dead-letter Map and Audit view, root-relative so a
// notification can put its public URL in front. Everything travels in the URL
// fragment, which the server never routes on and sign-in keeps (returnTo).

export interface HistoryTarget {
  profile: string;
  vhost: string;
  queue: string;
}

export type MapTarget = Omit<HistoryTarget, 'queue'>;

/** The fields of the Audit view's search that a link can fill in. */
export interface AuditLinkSearch {
  profile?: string;
  queue?: string;
  checkoutId?: string;
}

const HISTORY_PREFIX = '#/history/';
const MAP_PREFIX = '#/dead-letter-map/';
const AUDIT_PREFIX = '#/audit?';
const AUDIT_API_PREFIX = '/api/audit-entries?';
const AUDIT_FIELDS = ['profile', 'queue', 'checkoutId'] as const;

/** The link to a queue's history view. */
export function historyPath({ profile, vhost, queue }: HistoryTarget): string {
  return `/${HISTORY_PREFIX}${[profile, vhost, queue].map(encodeURIComponent).join('/')}`;
}

/** The queue a URL fragment (window.location.hash) links to the history of, or null. */
export function historyTargetIn(hash: string): HistoryTarget | null {
  if (!hash.startsWith(HISTORY_PREFIX)) return null;
  const parts = hash.slice(HISTORY_PREFIX.length).split('/');
  if (parts.length !== 3 || parts.some((p) => p === '')) return null;
  try {
    const [profile, vhost, queue] = parts.map(decodeURIComponent) as [string, string, string];
    return { profile, vhost, queue };
  } catch {
    return null;
  }
}

/** The link to a vhost's Dead-letter Map. */
export function deadLetterMapPath({ profile, vhost }: MapTarget): string {
  return `/${MAP_PREFIX}${[profile, vhost].map(encodeURIComponent).join('/')}`;
}

/** The vhost a URL fragment links to the Dead-letter Map of, or null. */
export function deadLetterMapTargetIn(hash: string): MapTarget | null {
  if (!hash.startsWith(MAP_PREFIX)) return null;
  const parts = hash.slice(MAP_PREFIX.length).split('/');
  if (parts.length !== 2 || parts.some((p) => p === '')) return null;
  try {
    const [profile, vhost] = parts.map(decodeURIComponent) as [string, string];
    return { profile, vhost };
  } catch {
    return null;
  }
}

/** The Audit view's link for a history mark's `auditUrl` (an API search). */
export function auditViewPath(auditUrl: string): string {
  return `/${AUDIT_PREFIX}${auditUrl.slice(AUDIT_API_PREFIX.length)}`;
}

/** The search a URL fragment opens the Audit view on, or null. */
export function auditSearchIn(hash: string): AuditLinkSearch | null {
  if (!hash.startsWith(AUDIT_PREFIX)) return null;
  const params = new URLSearchParams(hash.slice(AUDIT_PREFIX.length));
  const search: AuditLinkSearch = {};
  for (const field of AUDIT_FIELDS) {
    const value = params.get(field);
    if (value !== null) search[field] = value;
  }
  return search;
}
