// Whether a held Message is Died Again, and how many times, as
// src/server/triage/died-again.ts and audit/replay-trail.ts tell it: every
// Message carrying `x-volveran-replay-id` is Died Again. The Audit Entry that
// published that replay id (a Replay, a Move or a Restore) recorded the
// Message's headers as they were then (a Restore through the Discard it
// restores), so the replay id they carried leads to the entry that sent it
// out the time before, and so on back: the length of that chain is how many
// times the Message has died again.
import type { DiedAgain, DiedAgainSource } from '../../../../src/shared/checkout.js';
import type { AuditLog } from './audit-log.js';
import { REPLAY_ID_HEADER } from './filters.js';

/** Stops a forged or corrupt chain from looping or running away. */
const MAX_CHAIN = 1000;

/** The `x-volveran-replay-id` header's value, or null when the Message carries none. */
export function replayIdOf(headers: Record<string, unknown> | undefined): string | null {
  const value = headers?.[REPLAY_ID_HEADER];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The Died Again facts of a Message with these headers, from the audit store; null when it is not Died Again. */
export function diedAgain(headers: Record<string, unknown> | undefined, audit: AuditLog): DiedAgain | null {
  const replayId = replayIdOf(headers);
  if (replayId === null) return null;
  const trail = (id: string) => {
    const entry = audit.byReplayId(id);
    if (!entry) return null;
    const sent = entry.restoreOf === null ? entry.message : audit.get(entry.restoreOf)?.message;
    const source: DiedAgainSource = {
      auditEntryId: entry.id,
      // Only Replay, Move and Restore record a replay id.
      action: entry.action as DiedAgainSource['action'],
      at: entry.at,
      operatorName: entry.operatorName,
      fromQueue: entry.queue,
    };
    return { source, earlierReplayId: replayIdOf(sent?.headers) };
  };
  const record = trail(replayId);
  const seen = new Set([replayId]);
  let earlier = record?.earlierReplayId ?? null;
  while (earlier !== null && !seen.has(earlier) && seen.size < MAX_CHAIN) {
    seen.add(earlier);
    earlier = trail(earlier)?.earlierReplayId ?? null;
  }
  return { replayId, count: seen.size, last: record?.source ?? null };
}
