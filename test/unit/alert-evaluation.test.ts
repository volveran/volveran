// Alert evaluation: what each Sample does to the Alerts of a Broker Profile and
// which notifications it sends.
import { describe, expect, it } from 'vitest';
import { emptyAlertMemory, evaluateAlerts, type AlertMemory } from '../../src/server/alerts/evaluation.js';
import type { AlertRule } from '../../src/server/alerts/rules.js';
import type { LatestSample } from '../../src/server/history/sampler.js';

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-30T10:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * MINUTE);

const rule = (over: Partial<AlertRule> & Pick<AlertRule, 'when'>): AlertRule => ({
  name: 'r',
  destinations: ['ops'],
  forMs: 0,
  repeatEveryMs: null,
  ...over,
});
const queue = { vhost: '/', queue: 'orders.dlq', queuePattern: null };
const depthAbove = (threshold: number) => ({ kind: 'depthAbove', ...queue, threshold }) as const;
const anyArrival = { kind: 'anyArrival', ...queue } as const;
const arrivalsAbove = (count: number, withinMs: number) => ({ kind: 'arrivalsAbove', ...queue, count, withinMs }) as const;

const sample = (minutes: number, depth: number, previousDepth: number | null, takenOut = 0, name = 'orders.dlq'): LatestSample => ({
  profile: 'prod',
  vhost: '/',
  queue: name,
  at: at(minutes),
  depth,
  previousDepth,
  takenOut,
  estimatedArrivals: previousDepth === null ? null : Math.max(0, depth - previousDepth + takenOut),
  setupWarnings: [],
});

/** Feeds Samples through in order; each step answers the notifications it sent. */
function run(rules: AlertRule[], memory: AlertMemory = emptyAlertMemory()) {
  const step = (samples: LatestSample[], minutes: number, ok = true) => {
    const result = evaluateAlerts({ profile: 'prod', rules, memory, run: { run: { profile: 'prod', at: at(minutes), ok, errorCode: ok ? null : 'x' }, samples } });
    memory = result.memory;
    return result.notifications;
  };
  return { step, memory: () => memory };
}

describe('depthAbove', () => {
  it('fires at once without `for`, naming the queue, value, threshold and since when', () => {
    const { step, memory } = run([rule({ when: depthAbove(100) })]);
    const [sent, ...rest] = step([sample(0, 101, 50)], 0);
    expect(rest).toEqual([]);
    expect(sent!.destinations).toEqual(['ops']);
    expect(sent!.notification).toMatchObject({
      status: 'firing', rule: 'r', profile: 'prod', vhost: '/', queue: 'orders.dlq',
      condition: 'depthAbove', value: 101, threshold: 100, startedAt: at(0).toISOString(), endedAt: null,
      path: '/#/history/prod/%2F/orders.dlq',
    });
    expect(memory().alerts).toHaveLength(1);
    expect(memory().alerts[0]).toMatchObject({ status: 'firing', vhost: '/', queue: 'orders.dlq' });
  });

  it('is not above a depth equal to the threshold', () => {
    expect(run([rule({ when: depthAbove(100) })]).step([sample(0, 100, 50)], 0)).toEqual([]);
  });

  it('stays pending under `for`, then fires with the time the condition began', () => {
    const { step, memory } = run([rule({ when: depthAbove(10), forMs: 5 * MINUTE })]);
    expect(step([sample(0, 20, 0)], 0)).toEqual([]);
    expect(memory().alerts[0]).toMatchObject({ status: 'pending' });
    expect(step([sample(4, 20, 20)], 4)).toEqual([]);
    const [sent] = step([sample(5, 20, 20)], 5);
    expect(sent!.notification).toMatchObject({ status: 'firing', startedAt: at(0).toISOString() });
  });

  it('forgets a pending Alert quietly when the condition goes false, and `for` starts again', () => {
    const { step, memory } = run([rule({ when: depthAbove(10), forMs: 5 * MINUTE })]);
    step([sample(0, 20, 0)], 0);
    expect(step([sample(1, 0, 20)], 1)).toEqual([]);
    expect(memory().alerts).toEqual([]);
    expect(step([sample(2, 20, 0)], 2)).toEqual([]);
    expect(step([sample(6, 20, 20)], 6)).toEqual([]);
  });

  it('resolves once the condition has been false for one full Sample, keeping the alert id', () => {
    const { step, memory } = run([rule({ when: depthAbove(10) })]);
    const [fired] = step([sample(0, 20, 0)], 0);
    expect(step([sample(1, 0, 20)], 1)).toEqual([]);
    const [resolved] = step([sample(2, 0, 0)], 2);
    expect(resolved!.notification).toMatchObject({
      status: 'resolved', alertId: fired!.notification.alertId, value: 0, startedAt: at(0).toISOString(), endedAt: at(2).toISOString(),
    });
    expect(memory().alerts).toEqual([]);
  });

  it('does not resolve when the condition comes back after one false Sample', () => {
    const { step } = run([rule({ when: depthAbove(10) })]);
    step([sample(0, 20, 0)], 0);
    step([sample(1, 0, 20)], 1);
    expect(step([sample(2, 20, 0)], 2)).toEqual([]);
    expect(step([sample(3, 0, 20)], 3)).toEqual([]);
  });

  it('gives a later firing of the same queue a new alert id', () => {
    const { step } = run([rule({ when: depthAbove(10) })]);
    const [first] = step([sample(0, 20, 0)], 0);
    step([sample(1, 0, 20)], 1);
    step([sample(2, 0, 0)], 2);
    const [second] = step([sample(3, 20, 0)], 3);
    expect(second!.notification.alertId).not.toBe(first!.notification.alertId);
  });

  it('repeats at repeatEvery while firing, with the current value and the same id', () => {
    const { step } = run([rule({ when: depthAbove(10), repeatEveryMs: 10 * MINUTE })]);
    const [fired] = step([sample(0, 20, 0)], 0);
    expect(step([sample(9, 25, 20)], 9)).toEqual([]);
    const [repeat] = step([sample(10, 30, 25)], 10);
    expect(repeat!.notification).toMatchObject({ status: 'firing', alertId: fired!.notification.alertId, value: 30 });
    expect(step([sample(19, 30, 30)], 19)).toEqual([]);
    expect(step([sample(20, 30, 30)], 20)).toHaveLength(1);
  });

  it('never repeats without repeatEvery', () => {
    const { step } = run([rule({ when: depthAbove(10) })]);
    step([sample(0, 20, 0)], 0);
    expect(step([sample(600, 20, 20)], 600)).toEqual([]);
  });

  it('resolves an Alert whose queue is gone from a good run', () => {
    const { step } = run([rule({ when: depthAbove(10) })]);
    step([sample(0, 20, 0)], 0);
    step([], 1);
    const [resolved] = step([], 2);
    expect(resolved!.notification).toMatchObject({ status: 'resolved', queue: 'orders.dlq', value: 20 });
  });

  it('changes nothing on a failed run: no data is not a false condition', () => {
    const { step, memory } = run([rule({ when: depthAbove(10), forMs: 5 * MINUTE }), rule({ name: 'now', when: depthAbove(10) })]);
    step([sample(0, 20, 0)], 0);
    const before = memory().alerts;
    expect(step([], 1, false)).toEqual([]);
    expect(step([], 2, false)).toEqual([]);
    expect(memory().alerts).toEqual(before);
  });
});

describe('queuePattern', () => {
  const when = { kind: 'depthAbove', vhost: '/', queue: null, queuePattern: '*.dlq', threshold: 0 } as const;

  it('makes each matching queue its own Alert, with its own id', () => {
    const { step } = run([rule({ when })]);
    const sent = step([sample(0, 1, 0, 0, 'a.dlq'), sample(0, 2, 0, 0, 'b.dlq'), sample(0, 3, 0, 0, 'other')], 0);
    expect(sent.map((s) => s.notification.queue)).toEqual(['a.dlq', 'b.dlq']);
    expect(new Set(sent.map((s) => s.notification.alertId)).size).toBe(2);
  });

  it('resolves one queue while another keeps firing', () => {
    const { step } = run([rule({ when })]);
    step([sample(0, 1, 0, 0, 'a.dlq'), sample(0, 2, 0, 0, 'b.dlq')], 0);
    step([sample(1, 0, 1, 0, 'a.dlq'), sample(1, 2, 2, 0, 'b.dlq')], 1);
    const sent = step([sample(2, 0, 0, 0, 'a.dlq'), sample(2, 2, 2, 0, 'b.dlq')], 2);
    expect(sent.map((s) => [s.notification.queue, s.notification.status])).toEqual([['a.dlq', 'resolved']]);
  });

  it('leaves other vhosts out', () => {
    const { step } = run([rule({ when: { ...when, vhost: 'other' } })]);
    expect(step([sample(0, 1, 0, 0, 'a.dlq')], 0)).toEqual([]);
  });
});

describe('anyArrival', () => {
  it('fires on a rise in depth, with the number that arrived', () => {
    const [sent] = run([rule({ when: anyArrival })]).step([sample(0, 3, 0)], 0);
    expect(sent!.notification).toMatchObject({ condition: 'anyArrival', value: 3, threshold: null });
  });

  it('does not fire while arrivals are unknown, and leaves a firing Alert alone', () => {
    const { step } = run([rule({ when: anyArrival })]);
    expect(step([sample(0, 5, null)], 0)).toEqual([]);
    step([sample(1, 6, 5)], 1);
    expect(step([sample(2, 6, null)], 2)).toEqual([]);
    expect(step([sample(3, 6, null)], 3)).toEqual([]);
    expect(step([sample(4, 6, 6)], 4)).toEqual([]);
    expect(step([sample(5, 6, 6)], 5)).toHaveLength(1);
  });

  it('does not fire on the false spike of a take-out whose depth drop lags into the next Sample', () => {
    const { step, memory } = run([rule({ when: anyArrival })]);
    // Depth 10 -> 10 with 10 taken out reports 10 estimated arrivals; the drop shows next.
    expect(sample(0, 10, 10, 10).estimatedArrivals).toBe(10);
    expect(step([sample(0, 10, 10, 10)], 0)).toEqual([]);
    expect(step([sample(1, 0, 10)], 1)).toEqual([]);
    expect(step([sample(2, 0, 0)], 2)).toEqual([]);
    expect(memory().alerts).toEqual([]);
  });

  it('still fires, one Sample later, on arrivals a take-out really hid', () => {
    const { step } = run([rule({ when: anyArrival })]);
    // 10 taken out and 10 arrived: the depth never drops.
    expect(step([sample(0, 10, 10, 10)], 0)).toEqual([]);
    const [sent] = step([sample(1, 10, 10)], 1);
    expect(sent!.notification).toMatchObject({ status: 'firing', value: 10 });
  });

  it('counts only the part of a lagging take-out that the next drop does not explain', () => {
    const { step } = run([rule({ when: anyArrival })]);
    step([sample(0, 10, 10, 10)], 0);
    const [sent] = step([sample(1, 4, 10)], 1);
    expect(sent!.notification.value).toBe(4);
  });

  it('settles take-outs in a row: each drop answers the oldest one first', () => {
    const { step } = run([rule({ when: anyArrival })]);
    // Each take-out's drop shows one Sample later: nothing arrived.
    expect(step([sample(0, 20, 20, 10)], 0)).toEqual([]);
    expect(step([sample(1, 10, 20, 10)], 1)).toEqual([]);
    expect(step([sample(2, 0, 10)], 2)).toEqual([]);
    expect(step([sample(3, 0, 0)], 3)).toEqual([]);
  });

  it('counts a plain rise at once even while a take-out is unsettled', () => {
    const { step } = run([rule({ when: anyArrival })]);
    const [sent] = step([sample(0, 15, 10, 10)], 0);
    expect(sent!.notification.value).toBe(5);
  });

  it('keeps an unsettled take-out across a failed run', () => {
    const { step } = run([rule({ when: anyArrival })]);
    step([sample(0, 10, 10, 10)], 0);
    step([], 1, false);
    expect(step([sample(2, 0, 10)], 2)).toEqual([]);
  });
});

describe('arrivalsAbove', () => {
  const when = arrivalsAbove(5, 10 * MINUTE);

  it('fires when the arrivals within the window add up to more than the count', () => {
    const { step } = run([rule({ when })]);
    expect(step([sample(0, 3, 0)], 0)).toEqual([]);
    expect(step([sample(1, 5, 3)], 1)).toEqual([]);
    const [sent] = step([sample(2, 6, 5)], 2);
    expect(sent!.notification).toMatchObject({ condition: 'arrivalsAbove', value: 6, threshold: 5 });
  });

  it('forgets arrivals older than the window, and resolves', () => {
    const { step } = run([rule({ when })]);
    step([sample(0, 6, 0)], 0);
    expect(step([sample(9, 6, 6)], 9)).toEqual([]);
    expect(step([sample(10, 6, 6)], 10)).toEqual([]);
    const [resolved] = step([sample(11, 6, 6)], 11);
    expect(resolved!.notification).toMatchObject({ status: 'resolved', value: 0 });
  });

  it('does not add a false spike to the window', () => {
    const { step } = run([rule({ when })]);
    expect(step([sample(0, 10, 10, 10)], 0)).toEqual([]);
    expect(step([sample(1, 0, 10)], 1)).toEqual([]);
    expect(step([sample(2, 3, 0)], 2)).toEqual([]);
  });

  it('does not fire on unknown arrivals', () => {
    expect(run([rule({ when: arrivalsAbove(0, MINUTE) })]).step([sample(0, 100, null)], 0)).toEqual([]);
  });
});

describe('memory', () => {
  it('drops an Alert of a rule no longer given, with no resolved notification', () => {
    const first = run([rule({ when: depthAbove(10) })]);
    first.step([sample(0, 20, 0)], 0);
    const after = run([rule({ name: 'other', when: depthAbove(1000) })], first.memory());
    expect(after.step([sample(1, 20, 20)], 1)).toEqual([]);
    expect(after.memory().alerts).toEqual([]);
  });

  it('survives being handed back in, so a firing Alert is not sent again', () => {
    const rules = [rule({ when: depthAbove(10) })];
    const first = run(rules);
    first.step([sample(0, 20, 0)], 0);
    const after = run(rules, JSON.parse(JSON.stringify(first.memory())));
    expect(after.step([sample(1, 20, 20)], 1)).toEqual([]);
  });

  it('remembers nothing about queues no arrival rule watches', () => {
    const { step, memory } = run([rule({ when: depthAbove(10) })]);
    step([sample(0, 5, 0)], 0);
    expect(memory().arrivals).toEqual([]);
  });
});
