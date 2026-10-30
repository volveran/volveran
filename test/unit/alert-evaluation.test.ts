// Alert evaluation: what each Sample does to the Alerts of a Broker Profile and
// which notifications it sends.
import { describe, expect, it } from 'vitest';
import { emptyAlertMemory, evaluateAlerts, type AlertMemory } from '../../src/server/alerts/evaluation.js';
import type { AlertRule } from '../../src/server/alerts/rules.js';
import type { FinishedRun, LatestSample } from '../../src/server/history/sampler.js';

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
    const result = evaluateAlerts({
      profile: 'prod', rules, memory, at: at(minutes), pausedReplayRules: [], lastSuccessAt: null,
      run: { run: { profile: 'prod', at: at(minutes), ok, errorCode: ok ? null : 'x' }, samples },
    });
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

describe('conditions on Volverán itself', () => {
  const paused = (name: string, reason: string | null, minutes = 0) => ({ name, reason, pausedAt: at(minutes).getTime() });
  const goodRun = (minutes: number, samples: LatestSample[] = []) => ({ run: { profile: 'prod', at: at(minutes), ok: true, errorCode: null }, samples });
  const failedRun = (minutes: number) => ({ run: { profile: 'prod', at: at(minutes), ok: false, errorCode: 'broker_unreachable' }, samples: [] });
  const warning = (severity: 'loses_messages' | 'may_lose_messages') =>
    severity === 'loses_messages'
      ? ({ severity, code: 'dead_letter_exchange_missing', deadLetterExchange: 'x', message: 'lost' } as const)
      : ({ severity, code: 'quorum_at_most_once_dead_lettering', message: 'may be lost' } as const);
  const warned = (minutes: number, warnings: ReadonlyArray<ReturnType<typeof warning>>, name = 'orders.dlq', vhost = '/'): LatestSample => ({
    ...sample(minutes, 0, 0, 0, name), vhost, setupWarnings: [...warnings],
  });

  function evaluation(rules: AlertRule[]) {
    let memory = emptyAlertMemory();
    return {
      step(minutes: number, over: { run?: FinishedRun | null; pausedReplayRules?: ReturnType<typeof paused>[]; lastSuccessAt?: Date | null } = {}) {
        const result = evaluateAlerts({ profile: 'prod', rules, memory, at: at(minutes), run: null, pausedReplayRules: [], lastSuccessAt: null, ...over });
        memory = result.memory;
        return result.notifications.map((n) => n.notification);
      },
      memory: () => memory,
    };
  }

  describe('replayRulePaused', () => {
    const anyRule = rule({ when: { kind: 'replayRulePaused', rule: null } });

    it('fires on the pause naming the Replay Rule and reason, and resolves on the resume with no second Sample', () => {
      const { step, memory } = evaluation([anyRule]);
      const [fired, ...others] = step(0, { pausedReplayRules: [paused('retry', 'died_again')] });
      expect(others).toEqual([]);
      expect(fired).toMatchObject({
        status: 'firing', rule: 'r', condition: 'replayRulePaused', replayRule: 'retry', reason: 'died_again', vhost: null, queue: null,
        startedAt: at(0).toISOString(), endedAt: null, path: '/',
      });
      expect(memory().alerts[0]).toMatchObject({ status: 'firing', vhost: null, queue: null, replayRule: 'retry', reason: 'died_again' });

      const [resolved] = step(1, { pausedReplayRules: [] });
      expect(resolved).toMatchObject({ status: 'resolved', alertId: fired!.alertId, replayRule: 'retry', reason: 'died_again', endedAt: at(1).toISOString() });
      expect(memory().alerts).toEqual([]);
    });

    it('makes each paused Replay Rule its own Alert', () => {
      const { step } = evaluation([anyRule]);
      const sent = step(0, { pausedReplayRules: [paused('one', 'a'), paused('two', 'b')] });
      expect(sent.map((n) => n.replayRule)).toEqual(['one', 'two']);
      expect(sent[0]!.alertId).not.toBe(sent[1]!.alertId);
      const resolved = step(1, { pausedReplayRules: [paused('two', 'b')] });
      expect(resolved.map((n) => [n.status, n.replayRule])).toEqual([['resolved', 'one']]);
    });

    it('watches only the named Replay Rule when `rule` is given', () => {
      const { step } = evaluation([rule({ when: { kind: 'replayRulePaused', rule: 'one' } })]);
      expect(step(0, { pausedReplayRules: [paused('two', 'b')] })).toEqual([]);
      expect(step(1, { pausedReplayRules: [paused('one', 'a'), paused('two', 'b')] }).map((n) => n.replayRule)).toEqual(['one']);
    });

    it('does not send a firing Alert again at a later evaluation, unless repeatEvery is due', () => {
      const pausedRules = [paused('retry', 'died_again')];
      const { step } = evaluation([rule({ when: { kind: 'replayRulePaused', rule: null }, repeatEveryMs: 10 * MINUTE })]);
      step(0, { pausedReplayRules: pausedRules });
      expect(step(5, { pausedReplayRules: pausedRules, run: goodRun(5) })).toEqual([]);
      expect(step(10, { pausedReplayRules: pausedRules, run: goodRun(10) }).map((n) => n.status)).toEqual(['firing']);
    });

    it('waits for `for`, counted from the pause, and forgets a pending Alert quietly on the resume', () => {
      const { step } = evaluation([rule({ when: { kind: 'replayRulePaused', rule: null }, forMs: 5 * MINUTE })]);
      const pausedRules = [paused('retry', 'x')];
      expect(step(0, { pausedReplayRules: pausedRules })).toEqual([]);
      expect(step(1, { pausedReplayRules: [] })).toEqual([]);
      expect(step(2, { pausedReplayRules: [paused('retry', 'x', 2)] })).toEqual([]);
      expect(step(7, { pausedReplayRules: [paused('retry', 'x', 2)] }).map((n) => n.startedAt)).toEqual([at(2).toISOString()]);
    });

    it('fires at once when the pause is timed later than the evaluation, as with two clocks', () => {
      const { step } = evaluation([anyRule]);
      expect(step(0, { pausedReplayRules: [paused('retry', 'x', 3)] })).toHaveLength(1);
    });

    it('caps a long reason, since a chat tool refuses a long field and the whole notification with it', () => {
      const { step } = evaluation([anyRule]);
      const [fired] = step(0, { pausedReplayRules: [paused('retry', 'y'.repeat(5000))] });
      expect(fired!.reason!.length).toBeLessThanOrEqual(500);
    });

    it('leaves queue Alerts, and what arrivals remember, alone when evaluating a pause', () => {
      const { step, memory } = evaluation([rule({ name: 'deep', when: depthAbove(1) }), rule({ name: 'any', when: anyArrival }), anyRule]);
      step(0, { run: goodRun(0, [sample(0, 5, 1, 2)]) });
      const before = memory();
      expect(step(1, { pausedReplayRules: [paused('retry', 'x')] }).map((n) => n.condition)).toEqual(['replayRulePaused']);
      expect(memory().alerts.filter((a) => a.condition !== 'replayRulePaused')).toEqual(before.alerts);
      expect(memory().arrivals).toEqual(before.arrivals);
    });
  });

  describe('setupWarning', () => {
    const atLeast = (severity: 'loses_messages' | 'may_lose_messages') => rule({ when: { kind: 'setupWarning', severity } });

    it('fires per queue that has a warning of that severity, in any vhost, and names the warning', () => {
      const { step } = evaluation([atLeast('loses_messages')]);
      const sent = step(0, {
        run: goodRun(0, [warned(0, [warning('loses_messages')], 'a.dlq'), warned(0, [], 'b.dlq'), warned(0, [warning('loses_messages')], 'a.dlq', 'other')]),
      });
      expect(sent.map((n) => [n.vhost, n.queue])).toEqual([['/', 'a.dlq'], ['other', 'a.dlq']]);
      expect(sent[0]).toMatchObject({
        condition: 'setupWarning', status: 'firing', value: 1, threshold: null, reason: 'dead_letter_exchange_missing', path: '/#/history/prod/%2F/a.dlq',
      });
    });

    it('takes a severity as at least that bad', () => {
      const may = [warning('may_lose_messages')];
      const loses = [warning('loses_messages')];
      expect(evaluation([atLeast('loses_messages')]).step(0, { run: goodRun(0, [warned(0, may)]) })).toEqual([]);
      expect(evaluation([atLeast('may_lose_messages')]).step(0, { run: goodRun(0, [warned(0, may)]) })).toHaveLength(1);
      expect(evaluation([atLeast('may_lose_messages')]).step(0, { run: goodRun(0, [warned(0, loses)]) })).toHaveLength(1);
    });

    it('resolves when the warning has gone for one full Sample, and when the queue has gone', () => {
      const { step } = evaluation([atLeast('loses_messages')]);
      const loses = [warning('loses_messages')];
      step(0, { run: goodRun(0, [warned(0, loses, 'a.dlq'), warned(0, loses, 'b.dlq')]) });
      expect(step(1, { run: goodRun(1, [warned(1, [], 'a.dlq')]) })).toEqual([]);
      const resolved = step(2, { run: goodRun(2, [warned(2, [], 'a.dlq')]) });
      expect(resolved.map((n) => [n.status, n.queue]).sort()).toEqual([['resolved', 'a.dlq'], ['resolved', 'b.dlq']]);
    });

    it('changes nothing on a failed run, which says nothing about any queue', () => {
      const { step, memory } = evaluation([atLeast('loses_messages')]);
      step(0, { run: goodRun(0, [warned(0, [warning('loses_messages')])]) });
      expect(step(1, { run: failedRun(1) })).toEqual([]);
      expect(step(2, { run: failedRun(2) })).toEqual([]);
      expect(memory().alerts).toHaveLength(1);
    });
  });

  describe('samplingFailing', () => {
    const failing = rule({ when: { kind: 'samplingFailing', forMs: 5 * MINUTE } });

    it('fires once the profile has not been sampled well for `for`, counted from its last good run', () => {
      const { step } = evaluation([failing]);
      const lastSuccessAt = at(0);
      expect(step(4, { run: failedRun(4), lastSuccessAt })).toEqual([]);
      const [fired] = step(5, { run: failedRun(5), lastSuccessAt });
      expect(fired).toMatchObject({
        status: 'firing', condition: 'samplingFailing', vhost: null, queue: null, value: 300, threshold: 300, reason: 'broker_unreachable',
        startedAt: at(0).toISOString(), path: '/',
      });
      expect(step(6, { run: failedRun(6), lastSuccessAt })).toEqual([]);
    });

    it('counts from the first failed run when the profile has never been sampled well', () => {
      const { step } = evaluation([failing]);
      expect(step(0, { run: failedRun(0) })).toEqual([]);
      expect(step(4, { run: failedRun(4) })).toEqual([]);
      expect(step(5, { run: failedRun(5) })).toHaveLength(1);
    });

    it('resolves at the next good run, with no second Sample', () => {
      const { step, memory } = evaluation([failing]);
      const [fired] = step(5, { run: failedRun(5), lastSuccessAt: at(0) });
      const [resolved] = step(6, { run: goodRun(6), lastSuccessAt: at(6) });
      expect(resolved).toMatchObject({ status: 'resolved', alertId: fired!.alertId, endedAt: at(6).toISOString() });
      expect(memory().alerts).toEqual([]);
    });

    it('forgets a pending Alert quietly at a good run', () => {
      const { step, memory } = evaluation([failing]);
      step(1, { run: failedRun(1), lastSuccessAt: at(0) });
      expect(step(2, { run: goodRun(2), lastSuccessAt: at(2) })).toEqual([]);
      expect(memory().alerts).toEqual([]);
    });

    it('changes nothing when evaluating a pause between runs', () => {
      const { step, memory } = evaluation([failing]);
      step(1, { run: failedRun(1), lastSuccessAt: at(0) });
      const before = memory().alerts;
      expect(step(9, { lastSuccessAt: at(0) })).toEqual([]);
      expect(memory().alerts).toEqual(before);
    });
  });
});
