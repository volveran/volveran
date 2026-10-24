// Pure type guard (no I/O) for untrusted input: YAML mappings, JSON bodies, AMQP tables.
/** A plain object (an AMQP table, a YAML mapping): not null, an array or a byte buffer. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);
}
