// What must hold of a store from any release once the current version runs on
// it, through the HTTP API alone. It takes the running app as a parameter, so
// test/integration/upgrade.test.ts runs it on the fixtures as they are and a
// copy into another audit store can run the same checks.
import { beforeEach, afterEach, expect, it } from 'vitest';
import { drain, fixtureQueues, purgeQueues, testBroker, withChannel } from '../broker/client.js';
import type { StartAppOptions, TestApp } from '../integration/harness.js';
import {
  FIXTURE_DESTINATION,
  FIXTURE_DISCARD_REASON,
  FIXTURE_HEADER,
  FIXTURE_MOVE_QUEUE,
  FIXTURE_OPERATOR,
  FIXTURE_PAUSED_RULE,
  FIXTURE_PAUSE_REASON,
  FIXTURE_PROFILE,
  FIXTURE_QUEUE,
  FIXTURE_RUNNING_RULE,
  fixtureEnv,
  fixtureMessages,
  fixtureProfilesYaml,
  type UpgradeFixture,
} from './upgrade-fixtures.js';

/**
 * Starting on a fixture: its own profiles file against the test broker, and body
 * retention that keeps what it holds, however long ago the fixture was made.
 */
export async function fixtureAppOptions(fixture: UpgradeFixture, dataDir: string): Promise<StartAppOptions> {
  return {
    rawYaml: await fixtureProfilesYaml(fixture.version, testBroker),
    env: fixtureEnv(),
    dataDir,
    bodyRetention: { maxAgeMs: Number.MAX_SAFE_INTEGER },
  };
}

/** Registers the checks; `app` gives the app started on `fixture`'s store, fresh for each test. */
export function upgradeChecks(fixture: UpgradeFixture, app: () => TestApp): void {
  const search = async (query: string) => (await app().get(`/api/audit-entries?${query}`)).body.entries as any[];
  const entryOf = async (messageId: string, action = 'discard') => {
    const entries = await search(`messageId=${messageId}&action=${action}`);
    expect(entries).toHaveLength(1);
    return entries[0];
  };
  const clean = () => purgeQueues('/', fixtureQueues);
  beforeEach(clean);
  afterEach(clean);

  it('reads its profiles file', async () => {
    const { profiles } = (await app().get('/api/profiles')).body;
    expect(profiles.map((p: any) => p.name)).toEqual([FIXTURE_PROFILE]);
  });

  it('reads its Audit Entries', async () => {
    const m = fixtureMessages;
    const of = async (id: string) => (await search(`messageId=${id}`)).map((e) => [e.action, e.outcome]).sort();
    expect(await of(m.discarded.id)).toEqual([['discard', 'done']]);
    expect(await of(m.binary.id)).toEqual([['discard', 'done']]);
    expect(await of(m.restored.id)).toEqual([['discard', 'done'], ['restore', 'done']]);
    expect(await of(m.moved.id)).toEqual([['move', 'done']]);
    expect(await of(m.replayed.id)).toEqual([['replay', 'done']]);

    expect(await entryOf(m.discarded.id)).toMatchObject({
      operatorName: FIXTURE_OPERATOR,
      brokerUser: 'volveran-admin',
      profile: FIXTURE_PROFILE,
      vhost: '/',
      queue: FIXTURE_QUEUE,
      reason: FIXTURE_DISCARD_REASON,
    });
    expect((await entryOf(m.moved.id, 'move')).destination).toMatchObject({ queue: FIXTURE_MOVE_QUEUE });
  });

  it('finds a Replay by its replay id', async () => {
    const replay = await entryOf(fixtureMessages.replayed.id, 'replay');
    expect(replay.replayId).toEqual(expect.any(String));
    expect((await search(`replayId=${replay.replayId}`)).map((e) => e.id)).toEqual([replay.id]);
  });

  it('reads its Discarded bodies byte for byte, with their headers', async () => {
    for (const m of [fixtureMessages.discarded, fixtureMessages.binary]) {
      const { id } = await entryOf(m.id);
      const { entry } = (await app().get(`/api/audit-entries/${id}`)).body;
      expect(entry.message.body).toBe(m.body.toString('base64'));
      expect(entry.message.bodyBytes).toBe(m.body.length);
      expect(entry.message.properties).toMatchObject({ contentType: m.contentType });
      expect(entry.message.headers).toMatchObject(FIXTURE_HEADER);
    }
  });

  it('Restores a Discard the old release recorded', async () => {
    for (const m of [fixtureMessages.discarded, fixtureMessages.binary]) {
      const discard = await entryOf(m.id);
      const restored = await app().post(`/api/audit-entries/${discard.id}/restore`, { confirm: true });
      expect(restored.body.entry).toMatchObject({ action: 'restore', restoreOf: discard.id, outcome: 'done', operatorName: FIXTURE_OPERATOR });
      const back = await withChannel('/', (ch) => drain(ch, FIXTURE_QUEUE));
      expect(back.map((b) => [b.properties.messageId, b.content.toString('base64')])).toEqual([[m.id, m.body.toString('base64')]]);
    }
  });

  it('refuses to Restore again what the old release Restored', async () => {
    const discard = await entryOf(fixtureMessages.restored.id);
    expect((await entryOf(fixtureMessages.restored.id, 'restore')).restoreOf).toBe(discard.id);
    const again = await app().post(`/api/audit-entries/${discard.id}/restore`, { confirm: true });
    expect([again.status, again.body.error.code]).toEqual([409, 'already_restored']);
  });

  if (fixture.hasReplayRules) {
    const rules = async () => {
      const list = (await app().get(`/api/profiles/${FIXTURE_PROFILE}/replay-rules`)).body.rules as any[];
      return Object.fromEntries(list.map((r) => [r.rule.name, r]));
    };

    it('keeps a Replay rule paused, with who and why, and it can be resumed', async () => {
      const { [FIXTURE_PAUSED_RULE]: paused } = await rules();
      expect(paused.state).toMatchObject({ paused: true, pausedReason: FIXTURE_PAUSE_REASON, pausedBy: FIXTURE_OPERATOR });
      expect(paused.nextPassAt).toBeNull();
      expect(await search('action=rule_pause')).toEqual([expect.objectContaining({ rule: FIXTURE_PAUSED_RULE, reason: FIXTURE_PAUSE_REASON })]);

      const resumed = await app().post(`/api/profiles/${FIXTURE_PROFILE}/replay-rules/${FIXTURE_PAUSED_RULE}/resume`);
      expect(resumed.body.state).toMatchObject({ paused: false, pausedReason: null });
    });

    it('keeps a running Replay rule running, with its Rule Passes', async () => {
      const { [FIXTURE_RUNNING_RULE]: running } = await rules();
      expect(running.state.paused).toBe(false);
      expect(running.passes).toContainEqual(expect.objectContaining({ status: 'ran', summary: expect.objectContaining({ replayed: 1 }) }));
      expect(await search('messageId=fixture-rule-pass')).toEqual([expect.objectContaining({ action: 'replay', rule: FIXTURE_RUNNING_RULE })]);
    });
  }

  if (fixture.hasNotifications) {
    // Not the fixture's own test notification: startup removes notifications past
    // the history retention (90 days at most), so it would vanish as the fixture ages.
    it('records and lists notifications in its store', async () => {
      const { delivery } = (await app().post(`/api/alert-destinations/${FIXTURE_DESTINATION}/test`)).body;
      expect(delivery).toMatchObject({ test: true, destination: FIXTURE_DESTINATION });
      const { notifications } = (await app().get('/api/alerts')).body;
      expect(notifications).toContainEqual(expect.objectContaining({ id: delivery.id, replayRule: null }));
    });
  }
}
