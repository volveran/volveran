// Canary Replay on a Checkout (docs/rabbitmq-behaviour.md, "Canary watch" and
// "Watch queue lifetime"). Before the Canary is published, a watch queue
// `volveran.canary.<checkout id>` (exclusive, auto-delete) is declared on a
// channel of the Checkout's own connection and bound to the dead-letter
// exchange the Canary's source queue uses, with the bindings that route to
// the dead-letter queue (triage/canary-watch.ts). A Canary that fails again
// is recognised there by its `x-volveran-replay-id`; nothing is consumed
// from the dead-letter queue. The queue goes with the channel when the watch
// ends, and with the connection when the Checkout does.
//
// After the Canary's step the Apply waits: `canary_watch` for the Watch
// Window (cut short by a copy that died again), then `canary_done` until the
// Operator continues or the Apply is stopped (an Operator, the time limit,
// the Checkout ending or being lost). Continuing or stopping during the watch
// ends it at once.
import type * as amqp from 'amqplib';
import type { AuditStore } from '../audit/store.js';
import { permissionRefused } from '../broker-credentials.js';
import type { MessageOutcome } from '../apply/types.js';
import type { CanaryWatchBindings } from '../triage/canary-watch.js';
import { messageSummary } from '../triage/message-view.js';
import type { CanaryStatus, CanaryView } from '../../shared/checkout.js';
import type { Checkout } from './state.js';
import { queueInfo } from './view.js';

/** The header a Replay is published with (republish.ts), by which the watch recognises the Canary. */
const REPLAY_ID_HEADER = 'x-volveran-replay-id';

export function canaryQueueName(checkoutId: string): string {
  return `volveran.canary.${checkoutId}`;
}

/** The Canary as the manager keeps it on the Checkout. */
export interface CanaryState extends Omit<CanaryView, 'watchEndsAt'> {
  watchEndsAt: Date | null;
}

export function canaryView(c: CanaryState): CanaryView {
  return { ...c, watchEndsAt: c.watchEndsAt?.toISOString() ?? null };
}

export interface CanaryOptions {
  handle: number;
  watchWindowMs: number;
  audit: AuditStore;
  /** Aborted when the Apply is stopped (an Operator, the time limit, the Checkout ending or lost): the wait ends. */
  stopSignal: AbortSignal;
  /** The Apply waits after the Canary: `resume` lets it go on (Continue). */
  waiting(resume: () => void): void;
  /** The wait is over: the Apply goes on with the rest, or stops. */
  resumed(): void;
}

/** The executor's hooks for the Canary step (apply/executor.ts `canary`). */
export interface CanaryHooks {
  handle: number;
  beforePublish(entryId: number, replayId: string | null): Promise<void>;
  afterStep(outcome: MessageOutcome): Promise<void>;
}

/** Hooks that watch and wait for the Canary of the Checkout's Apply, keeping `checkout.canary` up to date. */
export function canaryHooks(checkout: Checkout, options: CanaryOptions): CanaryHooks {
  let watch: Watch | null = null;
  let entry: number | null = null;
  // Resolved by Continue; the stop signal ends the same wait.
  let resume!: () => void;
  const resumed = new Promise<void>((resolve) => (resume = resolve));
  const stopped = new Promise<void>((resolve) => {
    if (options.stopSignal.aborted) resolve();
    options.stopSignal.addEventListener('abort', () => resolve(), { once: true });
  });
  const goOn = Promise.race([resumed, stopped]);
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
      const message = checkout.held.get(options.handle);
      const id = message?.properties.messageId;
      checkout.canary = {
        handle: options.handle,
        messageId: typeof id === 'string' ? id : id == null ? null : String(id),
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
        if (!over) options.waiting(resume);
        let timer: NodeJS.Timeout | undefined;
        const windowOver = new Promise<'window'>((resolve) => (timer = setTimeout(() => resolve('window'), options.watchWindowMs)));
        const ended = await Promise.race([watch.copy, windowOver, goOn.then(() => 'cut' as const)]);
        clearTimeout(timer);
        await watch.close();
        if (ended === 'window' || ended === 'cut') {
          if (ended === 'cut') c.watchEndsAt = new Date();
          settle('not_dead_lettered');
        } else {
          const summary = messageSummary(0, ended, queueInfo(checkout));
          c.deadLetterReason = summary.deadLetterReason;
          c.failureDetails = summary.failureDetails;
          settle('died_again');
        }
      }
      if (!over) {
        if (progress) progress.phase = 'canary_done';
        options.waiting(resume);
        await goOn;
      }
      if (progress) progress.phase = 'running';
      options.resumed();
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
