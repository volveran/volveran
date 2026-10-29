// Replay Rule state in the audit store: the paused flag as first declared,
// then as stored; the bounded pass history; first-seen times by message id.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIRST_SEEN_LIMIT, PASS_HISTORY } from '../../src/server/audit/rule-state.js';
import { AuditStore } from '../../src/server/audit/store.js';
import type { RulePass } from '../../src/shared/replay-rules.js';

const KEY = 'local/transient-payments';

function pass(n: number): RulePass {
  return {
    id: `pass-${n}`,
    at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    status: 'ran',
    summary: { held: n, replayed: 1, moved: 0, usedUp: 0, notDue: 0, noMatch: 0, failed: 0 },
    reason: null,
  };
}

describe('Replay Rule state', () => {
  let store: AuditStore | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    store?.close();
    store = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('starts a rule paused as declared, and keeps the stored state after that, across a reopen', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rule-state-'));
    store = new AuditStore(dir);
    expect(store.ruleState.ensure(KEY, true)).toEqual({ paused: true, pausedReason: null, pausedBy: null, pausedAt: null });
    store.ruleState.setPaused(KEY, null);
    store.close();

    store = new AuditStore(dir);
    expect(store.ruleState.ensure(KEY, true).paused).toBe(false);
    expect(store.ruleState.state('local/never-started')).toBeNull();
  });

  it(`keeps the last ${PASS_HISTORY} passes of a rule, newest first, and a skipped pass without counts`, () => {
    store = new AuditStore();
    for (let n = 1; n <= PASS_HISTORY + 5; n++) store.ruleState.recordPass(KEY, pass(n));
    const skipped: RulePass = { id: 'skipped', at: pass(59).at, status: 'skipped', summary: null, reason: 'held by ana' };
    store.ruleState.recordPass(KEY, skipped);
    store.ruleState.recordPass('local/other', pass(1));

    const passes = store.ruleState.passes(KEY);
    expect(passes).toHaveLength(PASS_HISTORY);
    expect(passes[0]).toEqual(skipped);
    expect(passes[1]).toEqual(pass(PASS_HISTORY + 5));
    expect(passes.at(-1)).toEqual(pass(7));
    expect(store.ruleState.passes('local/other')).toEqual([pass(1)]);
  });

  it('remembers when a message id was first seen, and forgets the oldest beyond the limit', () => {
    store = new AuditStore();
    const t1 = new Date('2026-10-01T00:00:00Z');
    const t2 = new Date('2026-10-01T01:00:00Z');
    expect(store.ruleState.firstSeen(KEY, ['a'], t1)).toEqual(new Map([['a', t1]]));
    expect(store.ruleState.firstSeen(KEY, ['a', 'b'], t2)).toEqual(
      new Map([
        ['a', t1],
        ['b', t2],
      ]),
    );
    expect(store.ruleState.firstSeenAt(KEY, 'a')).toEqual(t1);
    expect(store.ruleState.firstSeenAt('local/other', 'a')).toBeNull();

    const many = Array.from({ length: FIRST_SEEN_LIMIT }, (_, i) => `m-${i}`);
    store.ruleState.firstSeen(KEY, many, new Date('2026-10-02T00:00:00Z'));
    expect(store.ruleState.firstSeenAt(KEY, 'a')).toBeNull();
    expect(store.ruleState.firstSeenAt(KEY, 'm-0')).not.toBeNull();
  });
});
