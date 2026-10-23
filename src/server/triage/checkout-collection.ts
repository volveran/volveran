// Pure collection rules (no I/O): how many Messages a Checkout takes, and
// which deliveries it holds (ADR 0006).
//
// A Checkout takes the N oldest ready Messages, capped by a Message limit and
// a byte limit. N comes from the Message limit alone; the byte limit is
// enforced on the exact body sizes while collecting: once it is reached, the
// deliveries past it overflow. They are not shown, and go back to the queue
// right after the held ones when the Checkout ends, which keeps the queue's
// order on both classic and quorum queues. The broker is asked for the N in
// windows (collectionWindow), so only the window in flight when the limit is
// reached overflows; the rest of the N never leave the queue. The windows add
// up to N, so after a shortfall (another consumer took some, some expired)
// the Checkout could still receive Messages published after the start; once
// it stops waiting, every further delivery is late and goes back to the
// queue at once.
import type { CheckoutLimits, LimitedBy } from '../../shared/checkout.js';

export type { CheckoutLimits, LimitedBy };

const MB = 1024 * 1024;

export const DEFAULT_CHECKOUT_LIMITS: CheckoutLimits = { maxMessages: 1000, maxBytes: 100 * MB };

/** AMQP's prefetch count is 16 bits, and a Checkout's window can be all of N. */
const MAX_PREFETCH = 65_535;

/**
 * The Checkout limits from `VOLVERAN_CHECKOUT_MAX_MESSAGES` and
 * `VOLVERAN_CHECKOUT_MAX_MB`, each defaulting to DEFAULT_CHECKOUT_LIMITS.
 */
export function parseCheckoutLimits(
  env: Record<string, string | undefined>,
): { ok: true; limits: CheckoutLimits } | { ok: false; error: string } {
  const read = (name: string, fallback: number, max: number): number | string => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < 1 || n > max) return `${name} must be a whole number from 1 to ${max}, not "${raw}".`;
    return n;
  };
  const maxMessages = read('VOLVERAN_CHECKOUT_MAX_MESSAGES', DEFAULT_CHECKOUT_LIMITS.maxMessages, MAX_PREFETCH);
  if (typeof maxMessages === 'string') return { ok: false, error: maxMessages };
  const maxMb = read('VOLVERAN_CHECKOUT_MAX_MB', DEFAULT_CHECKOUT_LIMITS.maxBytes / MB, 1_000_000);
  if (typeof maxMb === 'string') return { ok: false, error: maxMb };
  return { ok: true, limits: { maxMessages, maxBytes: maxMb * MB } };
}

/**
 * How many Messages to take (N): every ready Message up to the Message
 * limit. `ready` is the exact ready count (passive declare). The byte limit
 * does not shrink N: the management API's size estimate is stale and, on
 * quorum queues, counts more than the bodies, so it would hold fewer than
 * the limit allows. The byte limit is applied to each body as it arrives
 * (CheckoutCollection): past it, the rest of the N overflow.
 */
export function checkoutSize(input: { ready: number; maxMessages: number }): {
  take: number;
  limitedBy: LimitedBy | null;
} {
  const take = Math.min(input.ready, input.maxMessages);
  return { take, limitedBy: take < input.ready ? 'messages' : null };
}

/**
 * How many more deliveries to ask the broker for (the next consumer's
 * prefetch): as many as the remaining bytes fit at the average body size
 * delivered so far, never more than double what was delivered (the first
 * bodies may be unusually small), nor more than the Messages still to take.
 * At least 1 while any remain: one delivery past the byte limit shows it is
 * reached. Bounds the deliveries in memory beyond the byte limit to one
 * window, rather than the whole N.
 */
export function collectionWindow(input: {
  remaining: number;
  remainingBytes: number;
  delivered: number;
  deliveredBytes: number;
}): number {
  const { remaining, remainingBytes, delivered, deliveredBytes } = input;
  if (remaining <= 0) return 0;
  if (delivered === 0) return 1;
  const average = deliveredBytes / delivered;
  const byBytes = average === 0 ? remaining : Math.floor(Math.max(0, remainingBytes) / average);
  return Math.max(1, Math.min(byBytes, delivered, remaining));
}

export type Collected = 'held' | 'overflow' | 'late';

export class CheckoutCollection<M> {
  readonly held: M[] = [];
  /** Deliveries of the N past the byte limit (at most one window); returned after the held ones when the Checkout ends. */
  readonly overflow: M[] = [];
  /** Deliveries the Checkout must not hold; the caller returns them to the queue at once. */
  readonly late: M[] = [];
  heldBytes = 0;
  private deliveredBytes = 0;
  private waiting = true;

  /** `expected`: how many Messages the Checkout takes (N). */
  constructor(
    readonly expected: number,
    readonly maxBytes: number,
  ) {}

  /** Whether the Checkout holds this delivery of `size` body bytes, keeps it hidden, or must return it. */
  offer(delivery: M, size: number): Collected {
    if (!this.waiting || this.held.length + this.overflow.length >= this.expected) {
      this.late.push(delivery);
      return 'late';
    }
    this.deliveredBytes += size;
    const fits = this.held.length === 0 || (this.overflow.length === 0 && this.heldBytes + size <= this.maxBytes);
    if (fits) {
      this.held.push(delivery);
      this.heldBytes += size;
    } else {
      this.overflow.push(delivery);
    }
    if (this.complete) this.waiting = false;
    return fits ? 'held' : 'overflow';
  }

  get complete(): boolean {
    return this.held.length + this.overflow.length >= this.expected;
  }

  /** Holds all N, or the byte limit is reached: ask the broker for no more. */
  get done(): boolean {
    return this.complete || this.overflow.length > 0;
  }

  /** How many more deliveries to ask for (collectionWindow); 0 once done. */
  nextWindow(): number {
    if (this.done) return 0;
    const delivered = this.held.length + this.overflow.length;
    return collectionWindow({
      remaining: this.expected - delivered,
      remainingBytes: this.maxBytes - this.heldBytes,
      delivered,
      deliveredBytes: this.deliveredBytes,
    });
  }

  /** Stops waiting (for fewer than N): anything delivered from now on is late. */
  close(): void {
    this.waiting = false;
  }
}
