// Pure (no I/O): where Replay sends a Message (ADR 0005): through the
// default exchange to the queue named in its most recent x-death entry, the
// queue that dead-lettered it. A Message with no x-death history has nowhere
// to be Replayed to.
import { parseXDeath } from './message-view.js';

export type ReplayOrigin = { ok: true; queue: string } | { ok: false; reason: string };

export function replayOrigin(headers: Record<string, unknown> | undefined): ReplayOrigin {
  const latest = parseXDeath(headers)[0];
  if (!latest) {
    return {
      ok: false,
      reason: 'This Message has no x-death history, so there is no queue it was dead-lettered from to Replay it to. Move it instead.',
    };
  }
  if (latest.queue === null || latest.queue === '') {
    return {
      ok: false,
      reason: 'The most recent x-death entry of this Message names no queue, so there is nowhere to Replay it to. Move it instead.',
    };
  }
  return { ok: true, queue: latest.queue };
}
