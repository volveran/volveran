// Pure startup check of forwarding between Replicas. VOLVERAN_FORWARDING_SECRET turns it on,
// and only Team Mode on PostgreSQL has anything to share: elsewhere nothing is read from
// these variables, as with VOLVERAN_SESSION_ENCRYPTION_KEY on SQLite.
export interface ForwardingSettings {
  /** Proves a forwarded request comes from another Replica; the same on every Replica. */
  secret: string;
  /** This Replica's internal port, at VOLVERAN_HOST's address. */
  port: number;
  /** `host:port` where the other Replicas reach that port. */
  address: string;
}

const MIN_SECRET_LENGTH = 32;

export function parseForwarding(
  env: Record<string, string | undefined>,
  applies: boolean,
): { ok: true; forwarding: ForwardingSettings | null } | { ok: false; error: string } {
  const read = (name: string) => env[name]?.trim() || undefined;
  const secret = read('VOLVERAN_FORWARDING_SECRET');
  if (!applies || !secret) return { ok: true, forwarding: null };
  if (secret.length < MIN_SECRET_LENGTH) {
    return { ok: false, error: `VOLVERAN_FORWARDING_SECRET must be at least ${MIN_SECRET_LENGTH} characters long (e.g. the output of \`openssl rand -hex 32\`), the same on every Replica.` };
  }
  const rawPort = read('VOLVERAN_FORWARDING_PORT');
  const port = rawPort && /^[0-9]+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `With VOLVERAN_FORWARDING_SECRET set, VOLVERAN_FORWARDING_PORT must be a port number from 1 to 65535, not "${rawPort ?? ''}".` };
  }
  const address = read('VOLVERAN_FORWARDING_ADDRESS');
  if (!address || !isHostAndPort(address)) {
    return { ok: false, error: `With VOLVERAN_FORWARDING_SECRET set, VOLVERAN_FORWARDING_ADDRESS must be the host:port where other Replicas reach this one, not "${address ?? ''}".` };
  }
  return { ok: true, forwarding: { secret, port, address } };
}

function isHostAndPort(value: string): boolean {
  try {
    const url = new URL(`http://${value}`);
    return url.port !== '' && url.host === value.toLowerCase();
  } catch {
    return false;
  }
}
