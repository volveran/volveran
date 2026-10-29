// Which Replay Rate an Apply runs at, given the request and the Broker
// Profile's `replayRate`, and whether it would outlast its Checkout.
import { describe, expect, it } from 'vitest';
import { applyOutlastsCheckout, resolveReplayRate } from '../../src/server/triage/replay-rate.js';

const NONE = { default: null, max: null };
/** An Apply with Replay or Move steps. */
const PACED = { pacedSteps: 3 };

describe('resolveReplayRate', () => {
  it("is the request's rate, or the profile's default when it gives none, or none", () => {
    expect(resolveReplayRate(7, NONE, PACED)).toEqual({ ok: true, rate: 7 });
    expect(resolveReplayRate(undefined, NONE, PACED)).toEqual({ ok: true, rate: null });
    expect(resolveReplayRate(null, NONE, PACED)).toEqual({ ok: true, rate: null });
    expect(resolveReplayRate(undefined, { default: 10, max: 20 }, PACED)).toEqual({ ok: true, rate: 10 });
    expect(resolveReplayRate(2.5, { default: 10, max: 20 }, PACED)).toEqual({ ok: true, rate: 2.5 });
  });

  it('refuses a rate that is not a number from 0.1 to 1,000', () => {
    for (const rate of ['10', 0, 0.09, 1000.5, Number.NaN, true]) {
      expect(resolveReplayRate(rate, NONE, PACED)).toEqual({ ok: false, problem: 'invalid' });
    }
  });

  it('refuses a rate above the maximum, and no rate when there is a maximum but no default', () => {
    expect(resolveReplayRate(21, { default: 10, max: 20 }, PACED)).toEqual({ ok: false, problem: 'above_maximum', max: 20 });
    expect(resolveReplayRate(20, { default: 10, max: 20 }, PACED)).toEqual({ ok: true, rate: 20 });
    expect(resolveReplayRate(undefined, { default: null, max: 5 }, PACED)).toEqual({ ok: false, problem: 'above_maximum', max: 5 });
  });

  it('lets an Apply with no Replay or Move go without a rate when there is a maximum but no default', () => {
    expect(resolveReplayRate(undefined, { default: null, max: 5 }, { pacedSteps: 0 })).toEqual({ ok: true, rate: null });
    expect(resolveReplayRate(undefined, { default: null, max: 5 }, { pacedSteps: 1 })).toEqual({ ok: false, problem: 'above_maximum', max: 5 });
    expect(resolveReplayRate(6, { default: null, max: 5 }, { pacedSteps: 0 })).toEqual({ ok: false, problem: 'above_maximum', max: 5 });
  });
});

describe('applyOutlastsCheckout', () => {
  it('is null when unthrottled, or when the paced steps fit in the time left minus the margin', () => {
    expect(applyOutlastsCheckout({ pacedSteps: 1000, rate: null, remainingMs: 1_000 })).toBeNull();
    expect(applyOutlastsCheckout({ pacedSteps: 20, rate: 10, remainingMs: 12_000 })).toBeNull();
  });

  it('says how long the Apply needs and how long is left when it does not fit', () => {
    expect(applyOutlastsCheckout({ pacedSteps: 20, rate: 0.1, remainingMs: 120_000 })).toEqual({
      neededMs: 200_000,
      remainingMs: 120_000,
    });
    // Within 10 s of the time left is too close.
    expect(applyOutlastsCheckout({ pacedSteps: 20, rate: 1, remainingMs: 25_000 })).toEqual({
      neededMs: 20_000,
      remainingMs: 25_000,
    });
  });
});
