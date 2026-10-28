// Pure (no I/O): whether a held Message is Died Again, and how many times.
// Every Message carrying `x-volveran-replay-id` is Died Again: Volverán
// Replayed, Moved or Restored it and it was dead-lettered again. The Audit
// Entry that published that replay id recorded the Message's headers as they
// were then, so the replay id it carried before (if any) leads to the entry
// that sent it out the time before, and so on back: the length of that chain
// is how many times the Message has died again.
import { REPLAY_ID_HEADER } from '../apply/republish.js';
import type { DiedAgain, DiedAgainSource } from '../../shared/checkout.js';

export type { DiedAgain, DiedAgainSource };

/** What the Audit Entry that published a replay id says. */
export interface ReplayRecord extends DiedAgainSource {
  /** The replay id the Message carried when this entry sent it out; null for its first trip. */
  earlierReplayId: string | null;
}

/** Finds the Audit Entry that published a replay id; null when there is none here. */
export type ReplayTrail = (replayId: string) => ReplayRecord | null;

/** Stops a forged or corrupt chain from looping or running away. */
const MAX_CHAIN = 1000;

/** The `x-volveran-replay-id` header's value, or null when the Message carries none. */
export function replayIdOf(headers: Record<string, unknown> | undefined): string | null {
  const value = headers?.[REPLAY_ID_HEADER];
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  return typeof text === 'string' && text !== '' ? text : null;
}

/** The Died Again facts of a Message with these headers; null when it is not Died Again. */
export function diedAgain(headers: Record<string, unknown> | undefined, trail: ReplayTrail): DiedAgain | null {
  const replayId = replayIdOf(headers);
  if (replayId === null) return null;
  const record = trail(replayId);
  const seen = new Set([replayId]);
  let earlier = record?.earlierReplayId ?? null;
  while (earlier !== null && !seen.has(earlier) && seen.size < MAX_CHAIN) {
    seen.add(earlier);
    earlier = trail(earlier)?.earlierReplayId ?? null;
  }
  let last: DiedAgainSource | null = null;
  if (record) {
    const { earlierReplayId: _, ...source } = record;
    last = source;
  }
  return { replayId, count: seen.size, last };
}
