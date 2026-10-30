// Canary Replay on a Checkout (docs/rabbitmq-behaviour.md, "Canary watch" and
// "Watch queue lifetime"). Which Message is the Canary comes from the
// request (canaryFor), checked against the Decisions and the profile's
// `canary.requiredAbove`. Before the Canary is published, a watch queue
// `volveran.canary.<checkout id>` (exclusive, auto-delete) is declared on a
// channel of the Checkout's own connection and bound to the dead-letter
// exchange the Canary's source queue uses (for a MassTransit Replay, the
// `_error` exchange MassTransit publishes faults to), with the bindings that
// route to the dead-letter queue (triage/canary-watch.ts). A Canary that fails again
// is recognised there by its `x-volveran-replay-id`; nothing is consumed
// from the dead-letter queue. The queue goes with the channel when the watch
// ends, and with the connection when the Checkout does.
//
// After the Canary's step the Apply waits: `canary_watch` for the Watch
// Window (cut short by a copy that died again), then `canary_done` until the
// Operator continues or the Apply is stopped (an Operator, the time limit,
// the Checkout ending or being lost). Continuing or stopping during the watch
// ends it at once: the Canary is then `watch_cut_short`, not
// `not_dead_lettered`, unless a copy died again first.
import type * as amqp from 'amqplib';
import type { AuditStore } from '../audit/store.js';
import { permissionRefused } from '../broker-credentials.js';
import { canaryNeedsReplay, canaryRequired } from '../apply/errors.js';
import type { CanaryHooks } from '../apply/types.js';
import { InvalidRequestError } from '../http-error.js';
import { isRecord } from '../is-record.js';
import { canaryQueueName, type CanaryWatchBindings } from '../triage/canary-watch.js';
import { messageIdOf, messageSummary } from '../triage/message-view.js';
import type { CanaryStatus, CanaryView } from '../../shared/checkout.js';
import type { Checkout } from './state.js';
import { queueInfo } from './view.js';

/** The header a Replay is published with (republish.ts), by which the watch recognises the Canary. */
const REPLAY_ID_HEADER = 'x-volveran-replay-id';

/** The Canary as the manager keeps it on the Checkout. */
export interface CanaryState extends Omit<CanaryView, 'watchEndsAt'> {
  watchEndsAt: Date | null;
}

export function canaryView(c: CanaryState): CanaryView {
  return { ...c, watchEndsAt: c.watchEndsAt?.toISOString() ?? null };
}

/**
 * The handle of the Apply's Canary from the request's `canary`: left out
 * or false for none, true for the first Message with the Decision Replay
 * in Checkout order, `{ handle }` for that Message, which must have the
 * Decision Replay. Throws 400 `canary_needs_replay` when a Canary is asked
 * for and no Message has the Decision Replay, 400 `canary_required` when
 * none is and the profile requires one for this many Replays, 400
 * `invalid_request` for anything else.
 */
export function canaryFor(checkout: Checkout, requested: unknown): number | null {
  const replays = [...checkout.held.keys()].filter((h) => checkout.decisions.get(h)?.kind === 'replay');
  if (requested === undefined || requested === null || requested === false) {
    const { requiredAbove } = checkout.profile.canary;
    if (requiredAbove !== null && replays.length > requiredAbove) {
      throw canaryRequired(checkout.profile.name, requiredAbove, replays.length);
    }
    return null;
  }
  const picked = isRecord(requested) ? requested.handle : undefined;
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
  watchWindowMs: number;
  audit: AuditStore;
  /** Aborted when the Apply is stopped (an Operator, the time limit, the Checkout ending or lost): the wait ends. */
  stopSignal: AbortSignal;
  /** The Apply waits after the Canary: `continueAfterCanary` lets it go on with the rest (Continue). */
  waitStarted(continueAfterCanary: () => void): void;
  /** The wait is over: the Apply goes on with the rest, or stops. */
  waitEnded(): void;
}

/** Hooks that watch and wait for the Canary of the Checkout's Apply, keeping `checkout.canary` up to date. */
export function canaryHooks(checkout: Checkout, options: CanaryOptions): CanaryHooks {
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
    const c = checkout.canary!;
    c.status = status;
    if (entry !== null) {
      try {
        options.audit.setCanaryOutcome(entry, status);
      } catch {
        // The entry keeps no outcome; the Checkout view still shows it.
      }
    }
  };

  return {
    handle: options.handle,

    async beforePublish(entryId, replayId) {
      entry = entryId;
      checkout.canary = {
        handle: options.handle,
        messageId: messageIdOf(checkout.held.get(options.handle)),
        auditEntryId: entryId,
        status: 'watching',
        watchEndsAt: null,
        deadLetterReason: null,
        failureDetails: null,
        watchProblem: null,
      };
      const bindings = checkout.canaryWatch.get(options.handle) ?? { watchable: false, reason: 'Volverán did not look up where this Message dead-letters.' };
      const opened = replayId && checkout.connection ? await openWatch(checkout, checkout.connection, bindings, replayId) : { problem: 'The Canary has no connection to watch on.' };
      if ('problem' in opened) checkout.canary.watchProblem = opened.problem;
      else watch = opened;
    },

    async afterStep(outcome) {
      const progress = checkout.applyProgress;
      const c = checkout.canary;
      if (!c) return;
      if (outcome.status !== 'done') {
        await watch?.close();
        c.watchProblem = outcome.reason;
        settle('failed');
      } else if (!watch) {
        settle('unwatched');
      } else {
        c.watchEndsAt = new Date(Date.now() + options.watchWindowMs);
        if (progress) progress.phase = 'canary_watch';
        if (!over) options.waitStarted(continueAfterCanary);
        let timer: NodeJS.Timeout | undefined;
        const windowOver = new Promise<'window'>((resolve) => (timer = setTimeout(() => resolve('window'), options.watchWindowMs)));
        const ended = await Promise.race([watch.copy, windowOver, goOn.then(() => 'cut' as const)]);
        clearTimeout(timer);
        await watch.close();
        if (ended === 'window') {
          settle('not_dead_lettered');
        } else if (ended === 'cut') {
          // A copy that died again before the cut has already won the race above.
          c.watchEndsAt = new Date();
          settle('watch_cut_short');
        } else {
          const summary = messageSummary(0, ended, queueInfo(checkout));
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

interface Watch {
  /** Resolves with the first copy carrying the Canary's replay id. */
  copy: Promise<amqp.ConsumeMessage>;
  close(): Promise<void>;
}

/**
 * Declares and binds the watch queue on a channel of its own (a refusal
 * closes only that channel) and starts consuming it; or says why the Canary
 * cannot be watched.
 */
async function openWatch(
  checkout: Checkout,
  connection: amqp.ChannelModel,
  bindings: CanaryWatchBindings,
  replayId: string,
): Promise<Watch | { problem: string }> {
  if (!bindings.watchable) return { problem: bindings.reason };
  const queue = canaryQueueName(checkout.id);
  let channel: amqp.Channel | undefined;
  let step: 'declare' | 'bind' | 'consume' = 'declare';
  try {
    channel = await connection.createChannel();
    channel.on('error', () => {});
    await channel.assertQueue(queue, { exclusive: true, autoDelete: true, durable: false });
    step = 'bind';
    for (const key of bindings.routingKeys) await channel.bindQueue(queue, bindings.exchange, key);
    step = 'consume';
    let found!: (m: amqp.ConsumeMessage) => void;
    const copy = new Promise<amqp.ConsumeMessage>((resolve) => (found = resolve));
    const ch = channel;
    await ch.consume(
      queue,
      (m) => {
        if (m && String(m.properties.headers?.[REPLAY_ID_HEADER] ?? '') === replayId) found(m);
      },
      { noAck: true, exclusive: true },
    );
    return {
      copy,
      async close() {
        await ch.deleteQueue(queue).catch(() => {});
        await ch.close().catch(() => {});
      },
    };
  } catch (err) {
    await channel?.close().catch(() => {});
    if ((err as { code?: number }).code === 403) return { problem: refusal(checkout, step, queue, bindings.exchange) };
    return { problem: `Could not set up the Canary's watch queue "${queue}": ${(err as Error).message}` };
  }
}

function refusal(checkout: Checkout, step: 'declare' | 'bind' | 'consume', queue: string, exchange: string): string {
  const { profile, brokerUser, vhost } = checkout;
  const hint =
    'The Canary watch declares a queue matching volveran.* (configure), binds it to the dead-letter exchange (read on the exchange, write on the queue) and consumes it (read on the queue).';
  const [resource, permission] =
    step === 'declare'
      ? [{ type: 'queue' as const, name: queue, vhost }, 'configure' as const]
      : step === 'bind'
        ? [{ type: 'exchange' as const, name: exchange, vhost }, 'read' as const]
        : [{ type: 'queue' as const, name: queue, vhost }, 'read' as const];
  return `${permissionRefused(profile, brokerUser, resource, permission, hint).message} The Canary is unwatched.`;
}
