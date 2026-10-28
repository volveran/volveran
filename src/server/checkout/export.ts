// NDJSON export of a Checkout's held Messages: all of them, or those
// matching a filter, one line each in queue order (triage/export-line.ts).
//
// Exporting only reads: it never acks, rejects or reorders a Message, and
// leaves the Decisions as they are. Which Messages, their Decisions and the
// count are taken when the export starts, so the download stays the same
// even if the Checkout ends while it is written. Lines are made one at a
// time as the response is read, so a Checkout near the byte limit is never
// copied whole into memory.
//
// Each export writes one Audit Entry (action `export`, no Message copy) with
// the filter and the count, before the first line: `pending` while the
// download is written, `done` once every line is, `failed` when it stopped
// part way (the browser went away).
import type { AuditStore } from '../audit/store.js';
import type { Role } from '../../shared/roles.js';
import { exportFilename, exportLine } from '../triage/export-line.js';
import { matchesFilter, type Filter } from '../triage/filters.js';
import { applyInProgress, checkoutNotActive } from './errors.js';
import type { Checkout } from './state.js';
import { queueInfo } from './view.js';

/** A started export: what the response streams. */
export interface CheckoutExport {
  /** The download's file name, naming the profile, queue and time. */
  filename: string;
  /** How many Messages (lines) it holds. */
  count: number;
  /** The NDJSON lines, each ending in a newline, made as they are read. */
  lines: AsyncIterable<string>;
}

export interface ExportOptions {
  audit: AuditStore;
  /** The exporting Operator's Role on the profile, recorded in the Audit Entry. */
  role: Role;
  /** Test seam: awaited before each line is made. */
  beforeLine?(position: number): Promise<void>;
}

/**
 * Starts exporting `checkout`'s held Messages matching `filter` (every one
 * when null) and records its Audit Entry. Throws `checkout_not_active` on a
 * Checkout that is over or lost, `apply_in_progress` while it is Applied.
 */
export function startExport(checkout: Checkout, filter: Filter | null, { audit, role, beforeLine }: ExportOptions): CheckoutExport {
  if (checkout.status !== 'active') throw checkoutNotActive(checkout, 'its Messages can no longer be exported');
  if (checkout.applying) throw applyInProgress(checkout);

  const info = queueInfo(checkout);
  const picked = [...checkout.held.entries()]
    .map(([handle, message], i) => ({ position: i + 1, message, decision: checkout.decisions.get(handle) ?? { kind: 'keep' as const } }))
    .filter(({ message }) => filter === null || matchesFilter(filter, message));
  const at = new Date();
  const entryId = audit.record({
    at,
    operator: checkout.operator,
    role,
    brokerUser: checkout.profile.username,
    profile: checkout.profile.name,
    vhost: checkout.vhost,
    queue: checkout.queue,
    messageId: null,
    action: 'export',
    reason: null,
    destination: null,
    checkoutId: checkout.id,
    message: null,
    filter,
    messageCount: picked.length,
  });

  async function* lines(): AsyncGenerator<string> {
    let written = 0;
    try {
      for (const { position, message, decision } of picked) {
        await beforeLine?.(position);
        written++;
        yield `${JSON.stringify(exportLine(position, message, info, decision))}\n`;
      }
    } finally {
      // Runs too when the response is destroyed part way.
      if (written === picked.length) audit.setOutcome(entryId, 'done');
      else audit.setOutcome(entryId, 'failed', `The download stopped after ${written} of ${picked.length} Messages.`);
    }
  }

  return { filename: exportFilename(checkout.profile.name, checkout.queue, at), count: picked.length, lines: lines() };
}
