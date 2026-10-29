// The Replay Rate's bounds and what it means for how long an Apply takes,
// shared by the server and the web app. Pure values (no Node or DOM APIs).

/** The slowest and fastest Replay Rate, in Messages per second. */
export const MIN_REPLAY_RATE = 0.1;
export const MAX_REPLAY_RATE = 1000;

/** Whether `value` is a Replay Rate: a number of Messages per second from 0.1 to 1,000. */
export function isReplayRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_REPLAY_RATE && value <= MAX_REPLAY_RATE;
}

/** How long `steps` paced steps (Replay, Move) take at `rate` (one interval each); null without a rate. */
export function pacedDurationMs(steps: number, rate: number | null): number | null {
  return rate === null ? null : Math.ceil((steps * 1000) / rate);
}

/** A rate as the pages show it, e.g. "10 Messages/s". */
export function rateText(rate: number | null): string {
  return rate === null ? 'unthrottled' : `${rate} Messages/s`;
}
