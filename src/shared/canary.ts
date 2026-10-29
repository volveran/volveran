// The Watch Window of a Canary Replay, shared by the server (profiles.ts) and
// the web app. Pure values (no Node or DOM APIs).

/** How long a Canary is watched when the Broker Profile sets no `canary.watchWindow`, in seconds. */
export const DEFAULT_WATCH_WINDOW_SECONDS = 30;
export const MIN_WATCH_WINDOW_SECONDS = 5;
export const MAX_WATCH_WINDOW_SECONDS = 600;

/** Whether `value` is a Watch Window the profiles file may set: a number of seconds in range. */
export function isWatchWindow(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_WATCH_WINDOW_SECONDS &&
    value <= MAX_WATCH_WINDOW_SECONDS
  );
}
