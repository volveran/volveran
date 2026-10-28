// The Died Again chain (triage/died-again.ts) read from the audit store. A
// Replay or Move recorded the Message's original headers in its own entry; a
// Restore recorded none, so the headers are those its Discard recorded.
// Only the entries of the Broker Profiles in `profiles` are followed (the
// Operator's own audit scope), so the trail never shows an entry the
// Operator may not read.
import { replayIdOf, type ReplayTrail } from '../triage/died-again.js';
import type { DiedAgainSource } from '../../shared/checkout.js';
import type { AuditStore, ProfileScope } from './store.js';

export function replayTrail(audit: AuditStore, profiles?: ProfileScope): ReplayTrail {
  return (replayId) => {
    const [entry] = audit.list({ replayId, profiles, limit: 1 });
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
