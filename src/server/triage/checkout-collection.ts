// Pure collection rules (no I/O): how many Messages a Checkout takes, and
// which deliveries it holds (ADR 0006).
//
// A Checkout takes the N oldest ready Messages, capped by a Message limit and
// a byte limit. The byte limit can only be estimated up front (management
// statistics), so it is enforced again while collecting: once it is reached,
// the rest of the N deliveries overflow. They are not shown, and go back to
// the queue right after the held ones when the Checkout ends, which keeps the
// queue's order on both classic and quorum queues. The consumer has a
// prefetch of N, so after a shortfall (another consumer took some, some
// expired) it could still receive Messages published after the start; once
// the Checkout stops waiting, every further delivery is late and goes back
// to the queue at once.

export interface CheckoutLimits {
  /** Most Messages one Checkout holds (default 1,000). */
  maxMessages: number;
  /** Most body bytes one Checkout holds (default 100 MB). */
  maxBytes: number;
}

const MB = 1024 * 1024;

export const DEFAULT_CHECKOUT_LIMITS: CheckoutLimits = { maxMessages: 1000, maxBytes: 100 * MB };

/** AMQP's prefetch count is 16 bits, and a Checkout takes all N with one prefetch. */
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

export type LimitedBy = 'messages' | 'bytes';

/**
 * How many Messages to take. `ready` is the exact ready count (passive
 * declare); `readyBytes` the management API's estimate of their total size,
 * null when unknown.
 */
export function checkoutSize(input: CheckoutLimits & { ready: number; readyBytes: number | null }): {
  take: number;
  limitedBy: LimitedBy | null;
} {
  const { ready, readyBytes, maxMessages, maxBytes } = input;
  let take = Math.min(ready, maxMessages);
  let limitedBy: LimitedBy | null = take < ready ? 'messages' : null;
  if (take > 0 && readyBytes !== null && readyBytes > 0) {
    const fit = Math.max(1, Math.floor(maxBytes / (readyBytes / ready)));
    if (fit < take) {
      take = fit;
      limitedBy = 'bytes';
    }
  }
  return { take, limitedBy };
}

export type Collected = 'held' | 'overflow' | 'late';

export class CheckoutCollection<M> {
  readonly held: M[] = [];
  /** Deliveries of the N past the byte limit; returned after the held ones when the Checkout ends. */
  readonly overflow: M[] = [];
  /** Deliveries the Checkout must not hold; the caller returns them to the queue at once. */
  readonly late: M[] = [];
  heldBytes = 0;
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

  /** Stops waiting (for fewer than N): anything delivered from now on is late. */
  close(): void {
    this.waiting = false;
  }
}
