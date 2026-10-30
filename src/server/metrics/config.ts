// Pure startup check of VOLVERAN_METRICS_PORT: unset, the metrics listener stays off.
export function parseMetricsPort(
  env: Record<string, string | undefined>,
): { ok: true; port: number | null } | { ok: false; error: string } {
  const raw = env.VOLVERAN_METRICS_PORT;
  if (raw === undefined || raw === '') return { ok: true, port: null };
  const port = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `VOLVERAN_METRICS_PORT must be a port number from 1 to 65535, not "${raw}".` };
  }
  return { ok: true, port };
}
