// The Canary of an Apply in the demo, as src/server/checkout/canary.ts runs
// it. Which Message is the Canary comes from the request (canaryFor), checked
// against the Decisions and the profile's `canary.requiredAbove`. Its copy is
// watched on the dead-letter exchange of the queue it is Replayed to, as the
// server's watch queue bound to that exchange would see it, and recognised by
// its `x-volveran-replay-id`; the dead-letter queue is never read.
//
// After the Canary's step the Apply waits: `canary_watch` for the profile's
// Watch Window (cut short by a copy that died again), then `canary_done` until
// the Operator continues or the Apply is stopped. Continuing or stopping
// during the watch ends it at once: the Canary is then `watch_cut_short`,
// unless a copy died again first. The clock is the browser's: production's
// Watch Window is 15 real seconds (profile-settings.ts).
import { canaryNeedsReplay, canaryRequired } from '../../../../src/server/apply/errors.js';
import { InvalidRequestError } from '../../../../src/server/http-error.js';
import type { CanaryStatus } from '../../../../src/shared/checkout.js';
import type { CanaryHooks } from './apply.js';
import type { AuditLog } from './audit-log.js';
import type { BrokerMessage, DemoBroker } from './broker.js';
import type { DemoCheckout } from './checkouts.js';
import { REPLAY_ID_HEADER } from './filters.js';
import { messageIdOf, messageSummary, replayOrigin } from './message-view.js';

/**
 * The handle of the Apply's Canary from the request's `canary`: left out or
 * false for none, true for the first Message with the Decision Replay in
 * Checkout order, `{ handle }` for that Message, which must have the Decision
 * Replay. Throws 400 `canary_needs_replay`, `canary_required` and
 * `invalid_request` as the server does.
 */
export function canaryFor(checkout: DemoCheckout, requested: unknown): number | null {
  const replays = [...checkout.held.keys()].filter((h) => checkout.decisions.get(h)?.kind === 'replay');
  if (requested === undefined || requested === null || requested === false) {
    const { requiredAbove } = checkout.profile.canary;
    if (requiredAbove !== null && replays.length > requiredAbove) throw canaryRequired(checkout.profile.name, requiredAbove, replays.length);
    return null;
  }
  const picked = typeof requested === 'object' && !Array.isArray(requested) ? (requested as { handle?: unknown }).handle : undefined;
  if (requested !== true && !(typeof picked === 'number' && Number.isInteger(picked))) {
    throw new InvalidRequestError('"canary" must be true (the first Replay is the Canary), { "handle": <Message handle> }, or left out.');
  }
  if (replays.length === 0) throw canaryNeedsReplay();
  if (requested === true) return replays[0]!;
  if (!replays.includes(picked as number)) {
    throw new InvalidRequestError(`The Canary must be a held Message with the Decision Replay; Message ${String(picked)} is not.`);
  }
  return picked as number;
}

export interface CanaryOptions {
  handle: number;
  broker: DemoBroker;
  audit: AuditLog;
  /** Aborted when the Apply is stopped (the Operator, the time limit, the Checkout ending): the wait ends. */
  stopSignal: AbortSignal;
  /** The Apply waits after the Canary: `continueAfterCanary` lets it go on with the rest (Continue). */
  waitStarted(continueAfterCanary: () => void): void;
  /** The wait is over: the Apply goes on with the rest, or stops. */
  waitEnded(): void;
}

interface Watch {
  /** Resolves with the first copy carrying the Canary's replay id. */
  copy: Promise<BrokerMessage>;
  close(): void;
}

/** Hooks that watch and wait for the Canary of the Checkout's Apply, keeping `checkout.canary` up to date. */
export function canaryHooks(checkout: DemoCheckout, options: CanaryOptions): CanaryHooks {
  const { watchWindowMs } = checkout.profile.canary;
  let watch: Watch | null = null;
  let entry: number | null = null;
  // Resolved by Continue; the stop signal ends the same wait.
  let continueAfterCanary!: () => void;
  const continued = new Promise<void>((resolve) => (continueAfterCanary = resolve));
  const stopped = new Promise<void>((resolve) => {
    if (options.stopSignal.aborted) resolve();
    options.stopSignal.addEventListener('abort', () => resolve(), { once: true });
  });
  const goOn = Promise.race([continued, stopped]);
  // Registered first, so it is set before anything else awaiting goOn runs.
  let over = false;
  void goOn.then(() => (over = true));

  const settle = (status: Exclude<CanaryStatus, 'watching'>) => {
    checkout.canary!.status = status;
    if (entry !== null) options.audit.setCanaryOutcome(entry, status);
  };

  return {
    handle: options.handle,

    beforePublish(entryId, replayId) {
      entry = entryId;
      const message = checkout.held.get(options.handle);
      checkout.canary = {
        handle: options.handle,
        messageId: messageIdOf(message),
        auditEntryId: entryId,
        status: 'watching',
        watchEndsAt: null,
        deadLetterReason: null,
        failureDetails: null,
        watchProblem: null,
      };
      const origin = replayOrigin(message?.properties.headers);
      const dlx = origin.ok ? options.broker.queue({ vhost: checkout.vhost, queue: origin.queue })?.deadLetterExchange : undefined;
      if (!replayId || !dlx) checkout.canary.watchProblem = 'Where this Message dead-letters is not known.';
      else watch = openWatch(options.broker, checkout.vhost, dlx, replayId);
    },

    async afterStep(outcome) {
      const progress = checkout.applyProgress;
      const c = checkout.canary;
      if (!c) return;
      if (outcome.status !== 'done') {
        watch?.close();
        c.watchProblem = outcome.reason;
        settle('failed');
      } else if (!watch) {
        settle('unwatched');
      } else {
        c.watchEndsAt = new Date(Date.now() + watchWindowMs).toISOString();
        if (progress) progress.phase = 'canary_watch';
        if (!over) options.waitStarted(continueAfterCanary);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const windowOver = new Promise<'window'>((resolve) => (timer = setTimeout(() => resolve('window'), watchWindowMs)));
        const ended = await Promise.race([watch.copy, windowOver, goOn.then(() => 'cut' as const)]);
        clearTimeout(timer);
        watch.close();
        if (ended === 'window') {
          settle('not_dead_lettered');
        } else if (ended === 'cut') {
          // A copy that died again before the cut has already won the race above.
          c.watchEndsAt = new Date().toISOString();
          settle('watch_cut_short');
        } else {
          const summary = messageSummary(0, ended, checkout.info);
          c.deadLetterReason = summary.deadLetterReason;
          c.failureDetails = summary.failureDetails;
          settle('died_again');
        }
      }
      if (!over) {
        if (progress) progress.phase = 'canary_done';
        options.waitStarted(continueAfterCanary);
        await goOn;
      }
      if (progress) progress.phase = 'running';
      options.waitEnded();
    },
  };
}

/** Watches the dead-letter exchange for the copy carrying `replayId`. */
function openWatch(broker: DemoBroker, vhost: string, exchange: string, replayId: string): Watch {
  let found!: (m: BrokerMessage) => void;
  const copy = new Promise<BrokerMessage>((resolve) => (found = resolve));
  const close = broker.tap(vhost, exchange, (m) => {
    if (m.properties.headers?.[REPLAY_ID_HEADER] === replayId) found(m);
  });
  return { copy, close };
}
