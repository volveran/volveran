// Pure (no I/O, no DOM): the line saying how much of the queue a Checkout
// holds, e.g. "1,000 of ~4,500 held (limit 1,000 Messages)". The ready count
// was exact only when the Checkout started, hence the "~".

export interface HeldCounts {
  heldCount: number;
  readyAtStart: number;
  limitedBy: 'messages' | 'bytes' | null;
  limits: { maxMessages: number; maxBytes: number };
}

const count = (n: number) => n.toLocaleString('en-US');

export function formatBytes(n: number): string {
  const MB = 1024 * 1024;
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Number((n / 1024).toFixed(1))} KB`;
  return `${Number((n / MB).toFixed(1))} MB`;
}

export function heldLine(c: HeldCounts): string {
  const held = `${count(c.heldCount)} of ~${count(c.readyAtStart)} held`;
  if (c.limitedBy === 'messages') return `${held} (limit ${count(c.limits.maxMessages)} Messages)`;
  if (c.limitedBy === 'bytes') return `${held} (limit ${formatBytes(c.limits.maxBytes)})`;
  return held;
}
