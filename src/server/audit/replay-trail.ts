// The Died Again chain (triage/died-again.ts) read from the audit store. A
// Replay or Move recorded the Message's original headers in its own entry; a
// Restore recorded none, so the headers are those its Discard recorded.
import { replayIdOf, type ReplayTrail } from '../triage/died-again.js';
import type { DiedAgainSource } from '../../shared/checkout.js';
import type { AuditStore } from './store.js';

export function replayTrail(audit: AuditStore): ReplayTrail {
  return (replayId) => {
    const [entry] = audit.list({ replayId, limit: 1 });
    if (!entry) return null;
    const sent = entry.restoreOf === null ? entry.message : audit.get(entry.restoreOf)?.message;
    return {
      auditEntryId: entry.id,
      // Only Replay, Move and Restore record a replay id.
      action: entry.action as DiedAgainSource['action'],
      at: entry.at.toISOString(),
      operatorName: entry.operatorName,
      fromQueue: entry.queue,
      earlierReplayId: replayIdOf(sent?.headers),
    };
  };
}
