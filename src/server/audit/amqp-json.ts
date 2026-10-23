// Pure (no I/O). Lossless JSON for AMQP field values as amqplib decodes them, so a stored
// Message's properties and headers can be published again unchanged (Restore).
//   Buffer (byte array)  → { "$bytes": "<base64>" }
//   bigint               → { "$bigint": "<decimal>" }
//   table with a "$" key → { "$table": { ... } }   (so it can't be mistaken for the two above)
// Typed values such as { "!": "timestamp", value } are plain tables and stay as they are.

export function toAmqpJson(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(toAmqpJson);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    const table = Object.fromEntries(entries.map(([k, v]) => [k, toAmqpJson(v)]));
    return entries.some(([k]) => k.startsWith('$')) ? { $table: table } : table;
  }
  return value;
}

export function fromAmqpJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromAmqpJson);
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    const keys = Object.keys(v);
    if (keys.length === 1 && typeof v.$bytes === 'string') return Buffer.from(v.$bytes, 'base64');
    if (keys.length === 1 && typeof v.$bigint === 'string') return BigInt(v.$bigint);
    const table = keys.length === 1 && typeof v.$table === 'object' && v.$table !== null ? v.$table : v;
    return Object.fromEntries(Object.entries(table).map(([k, x]) => [k, fromAmqpJson(x)]));
  }
  return value;
}
