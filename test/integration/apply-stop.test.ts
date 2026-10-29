// Stopping an Apply in progress (Team Mode, against the real broker): the
// owner, or the approver of an approved Apply, asks it to attempt no further
// step. The step in progress finishes; the rest is reported `not-attempted`
// with "stopped by <name>" and goes back to the queue in order. Stop races
// with the Apply's end, the time limit and a Lost Checkout are serialised
// per Checkout: the first one wins.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  appliedCheckout,
  checkoutConnectionNames,
  closeConnection,
  closedPort,
  deadLetter,
  deadLetterRoutes,
  eventually,
  fixtureQueues,
  purgeQueues,
  readyMessageIds,
  seedMessages,
  startApp,
  testOperator,
  testProfile,
  withChannel,
  type TestApp,
} from "./harness.js";
import {
  teamModeEnv,
  TestBrowser,
  type TestIdentity,
} from "./oidc-provider.js";

const QUEUE = "stop.dlq";
const checkoutPath = (profile: string) =>
  `/api/profiles/${profile}/vhosts/%2F/queues/${QUEUE}/checkouts`;
const DISCARD = { kind: "discard", reason: "bad payload" };
const ids = (...n: number[]) => n.map((i) => `${QUEUE}-${i}`);

const rita = { sub: "rita-sub", email: "rita@example.com", groups: ["oncall"] };
const alan = { sub: "alan-sub", email: "alan@example.com", groups: ["oncall"] };
const omar = { sub: "omar-sub", email: "omar@example.com", groups: ["oncall"] };

type Hook = ((entryId: number) => Promise<void>) | null;

/** A gate a test opens later: `wait` resolves once `open` is called. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

describe("Stopping an Apply", () => {
  let app: TestApp;
  let baseUrl: string;
  let beforeApplyStep: Hook = null;
  let beforeTimeLimitEnd: (() => Promise<void>) | null = null;
  /** Checkouts to end after each test: [owner's browser, id]. */
  const open: Array<[TestBrowser, string]> = [];

  async function signedIn(identity: TestIdentity) {
    const browser = new TestBrowser(baseUrl);
    await browser.signIn(identity);
    return browser;
  }

  /** Starts a Checkout of QUEUE on `profile` and Discards the Messages with these message ids. */
  async function checkoutWithDiscards(
    browser: TestBrowser,
    profile: string,
    discard: string[],
  ) {
    const started = await browser.post(checkoutPath(profile));
    expect(started.status).toBe(201);
    const { id, messages } = started.body.checkout;
    open.push([browser, id]);
    const handles = messages
      .filter((m: any) => discard.includes(m.messageId))
      .map((m: any) => m.handle);
    expect(
      (
        await browser.post(`/api/checkouts/${id}/decisions`, {
          handles,
          decision: DISCARD,
        })
      ).status,
    ).toBe(200);
    return id as string;
  }

  /** Holds the Apply's `n`th step (1-based) until the returned gate opens; `held` resolves once it is held. */
  function holdStep(n: number) {
    const release = gate();
    const held = gate();
    let steps = 0;
    beforeApplyStep = async () => {
      if (++steps !== n) return;
      held.open();
      await release.wait;
    };
    return { held: held.wait, release: release.open };
  }

  const stop = (browser: TestBrowser, id: string) =>
    browser.post(`/api/checkouts/${id}/apply/stop`);
  const outcomesOf = (checkout: any) =>
    checkout.lastApply.outcomes.map((o: any) => [
      o.messageId,
      o.status,
      o.reason,
    ]);

  beforeAll(async () => {
    await withChannel("/", (ch) => ch.assertQueue(QUEUE, { durable: true }));
    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = await startApp({
      profiles: [
        testProfile({
          name: "prod",
          protected: true,
          roles: { operator: ["oncall"] },
        }),
        testProfile({ name: "staging", roles: { operator: ["oncall"] } }),
      ],
      port,
      env: teamModeEnv(baseUrl),
      checkoutTestHooks: {
        beforeApplyStep: async (entryId) => beforeApplyStep?.(entryId),
        beforeTimeLimitEnd: async () => beforeTimeLimitEnd?.(),
      },
    });
  });
  afterEach(async () => {
    beforeApplyStep = null;
    beforeTimeLimitEnd = null;
    for (const [browser, id] of open.splice(0))
      await browser.request("DELETE", `/api/checkouts/${id}`);
    await purgeQueues("/", [QUEUE]);
  });
  afterAll(async () => {
    await app?.close();
    await withChannel("/", (ch) => ch.deleteQueue(QUEUE));
  });

  it("finishes the step in progress and returns the rest to the queue in order, not attempted", async () => {
    await seedMessages("/", QUEUE, 5);
    const owner = await signedIn(rita);
    const id = await checkoutWithDiscards(owner, "staging", ids(0, 1, 2, 3));
    const { held, release } = holdStep(2);
    expect(
      (await owner.post(`/api/checkouts/${id}/apply`, { confirm: true }))
        .status,
    ).toBe(202);
    await held;

    const stopped = await stop(owner, id);
    release();

    expect(stopped.status).toBe(200);
    expect(stopped.body.checkout).toMatchObject({
      status: "applying",
      applyProgress: { stoppedBy: "rita@example.com" },
    });
    const ended = await appliedCheckout(owner, id);
    const reason = expect.stringMatching(
      /^Stopped by rita@example\.com\b.*back in the queue/,
    );
    expect(outcomesOf(ended)).toEqual([
      [`${QUEUE}-0`, "done", null],
      [`${QUEUE}-1`, "done", null],
      [`${QUEUE}-2`, "not-attempted", reason],
      [`${QUEUE}-3`, "not-attempted", reason],
      [`${QUEUE}-4`, "kept", null],
    ]);
    expect(ended).toMatchObject({
      status: "ended",
      endReason: "applied",
      heldCount: 0,
    });
    expect(ended.applyProgress).toMatchObject({
      total: 4,
      done: 2,
      notAttempted: 2,
      remaining: 0,
      stoppedBy: "rita@example.com",
    });
    expect(await readyMessageIds("/", QUEUE)).toEqual(ids(2, 3, 4));
  });

  it("lets the approver of an approved Apply stop it, and no third Operator", async () => {
    await seedMessages("/", QUEUE, 3);
    const owner = await signedIn(rita);
    const approver = await signedIn(alan);
    const other = await signedIn(omar);
    const id = await checkoutWithDiscards(owner, "prod", ids(0, 1, 2));
    expect(
      (
        await owner.post(`/api/checkouts/${id}/approval-request`, {
          confirm: true,
          confirmQueueName: QUEUE,
        })
      ).status,
    ).toBe(200);
    const { held, release } = holdStep(1);
    expect(
      (
        await approver.post(`/api/approvals/${id}/approve`, {
          confirmQueueName: QUEUE,
        })
      ).status,
    ).toBe(202);
    await held;

    const refused = [
      await other.post(`/api/approvals/${id}/apply/stop`),
      await other.post(`/api/checkouts/${id}/apply/stop`),
      await approver.post(`/api/checkouts/${id}/apply/stop`),
    ];
    // The approver follows the Apply they approved.
    const followed = await approver.get(`/api/approvals/${id}`);
    const stopped = await approver.post(`/api/approvals/${id}/apply/stop`);
    release();

    expect(refused.map((r) => [r.status, r.body.error.code])).toEqual([
      [403, "not_checkout_owner"],
      [403, "not_checkout_owner"],
      [403, "not_checkout_owner"],
    ]);
    expect(followed.status).toBe(200);
    expect(followed.body.checkout).toMatchObject({
      id,
      status: "applying",
      applyProgress: { total: 3, stoppedBy: null },
    });
    expect(stopped.status).toBe(200);
    expect(stopped.body.checkout.applyProgress.stoppedBy).toBe(
      "alan@example.com",
    );
    const ended = await appliedCheckout(owner, id);
    const reason = expect.stringMatching(/^Stopped by alan@example\.com\b/);
    expect(outcomesOf(ended)).toEqual([
      [`${QUEUE}-0`, "done", null],
      [`${QUEUE}-1`, "not-attempted", reason],
      [`${QUEUE}-2`, "not-attempted", reason],
    ]);
    expect(await readyMessageIds("/", QUEUE)).toEqual(ids(1, 2));
    // Once it has ended, the approver sees the outcomes there too.
    expect(
      (await approver.get(`/api/approvals/${id}`)).body.checkout.lastApply
        .outcomes,
    ).toEqual(ended.lastApply.outcomes);
  });

  it("answers 409 apply_not_running when no Apply runs", async () => {
    await seedMessages("/", QUEUE, 1);
    const owner = await signedIn(rita);
    const id = await checkoutWithDiscards(owner, "staging", ids(0));

    const res = await stop(owner, id);

    expect([res.status, res.body.error.code]).toEqual([
      409,
      "apply_not_running",
    ]);
    expect((await owner.get(`/api/checkouts/${id}`)).body.checkout.status).toBe(
      "active",
    );
  });
});

describe("Stop races (Solo Mode)", () => {
  let app: TestApp;
  let beforeApplyStep: Hook = null;
  let beforeTimeLimitEnd: (() => Promise<void>) | null = null;
  const hooks = {
    beforeApplyStep: async (entryId: number) => beforeApplyStep?.(entryId),
    beforeTimeLimitEnd: async () => beforeTimeLimitEnd?.(),
  };
  const STOPPED = expect.stringMatching(
    new RegExp(`^Stopped by ${testOperator}\\b`),
  );

  /** Starts a Checkout of QUEUE on `on`, Discards the first `discards` Messages and starts the Apply. */
  async function startApply(on: TestApp, discards: number) {
    const started = await on.post(
      "/api/profiles/local/vhosts/%2F/queues/stop.dlq/checkouts",
    );
    expect(started.status).toBe(201);
    const { id, messages } = started.body.checkout;
    const handles = messages.slice(0, discards).map((m: any) => m.handle);
    expect(
      (
        await on.post(`/api/checkouts/${id}/decisions`, {
          handles,
          decision: DISCARD,
        })
      ).status,
    ).toBe(200);
    expect(
      (await on.post(`/api/checkouts/${id}/apply`, { confirm: true })).status,
    ).toBe(202);
    return id as string;
  }
  const stop = (on: TestApp, id: string) =>
    on.post(`/api/checkouts/${id}/apply/stop`);
  async function dropCheckoutConnection() {
    const names = await eventually(async () => {
      const found = await checkoutConnectionNames(QUEUE);
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    for (const name of names) await closeConnection(name);
  }
  const statuses = (checkout: any) =>
    checkout.lastApply.outcomes.map((o: any) => [
      o.messageId,
      o.status,
      o.reason,
    ]);

  beforeAll(async () => {
    await withChannel("/", (ch) => ch.assertQueue(QUEUE, { durable: true }));
    app = await startApp({
      profiles: [testProfile({ name: "local" })],
      checkoutTestHooks: hooks,
    });
  });
  afterEach(async () => {
    beforeApplyStep = null;
    beforeTimeLimitEnd = null;
    await eventually(async () =>
      expect(await checkoutConnectionNames(QUEUE)).toEqual([]),
    );
    await purgeQueues("/", [QUEUE]);
  });
  afterAll(async () => {
    await app?.close();
    await withChannel("/", (ch) => ch.deleteQueue(QUEUE));
  });

  /** An app whose Checkouts reach their time limit after 1 s. */
  const quickApp = () =>
    startApp({
      profiles: [testProfile({ name: "local" })],
      checkoutTiming: { timeLimitMs: 1_000, heartbeatWindowMs: 5_000 },
      checkoutTestHooks: hooks,
    });

  it("stop, then the time limit: the stop wins", async () => {
    const quick = await quickApp();
    try {
      await seedMessages("/", QUEUE, 3);
      const release = gate();
      beforeApplyStep = () => release.wait; // the first step is in progress at the time limit
      let stopped: any;
      beforeTimeLimitEnd = async () => {
        stopped = await stop(quick, id);
        release.open();
      };
      const id = await startApply(quick, 3);

      const ended = await appliedCheckout(quick, id);

      expect(stopped.status).toBe(200);
      expect(statuses(ended)).toEqual([
        [`${QUEUE}-0`, "done", null],
        [`${QUEUE}-1`, "not-attempted", STOPPED],
        [`${QUEUE}-2`, "not-attempted", STOPPED],
      ]);
      expect(ended.applyProgress).toMatchObject({
        done: 1,
        notAttempted: 2,
        remaining: 0,
        stoppedBy: testOperator,
      });
      expect(await readyMessageIds("/", QUEUE)).toEqual(ids(1, 2));
    } finally {
      await quick.close();
    }
  });

  it("the time limit, then stop: the time limit wins and the stop answers apply_not_running", async () => {
    const quick = await quickApp();
    try {
      await seedMessages("/", QUEUE, 3);
      const release = gate();
      beforeApplyStep = () => release.wait;
      let stopped: Promise<any> | undefined;
      beforeTimeLimitEnd = async () => {
        // Sent as the time limit goes on to stop the Apply, so it arrives after.
        stopped = new Promise((resolve) =>
          setTimeout(() => resolve(stop(quick, id)), 0),
        );
        void stopped.then(release.open);
      };
      const id = await startApply(quick, 3);

      const ended = await appliedCheckout(quick, id);
      const late = await stopped!;

      expect([late.status, late.body.error.code]).toEqual([
        409,
        "apply_not_running",
      ]);
      expect(late.body.error.message).toMatch(/time limit/);
      const timeLimit = expect.stringMatching(/time limit/);
      expect(statuses(ended)).toEqual([
        [`${QUEUE}-0`, "done", null],
        [`${QUEUE}-1`, "not-attempted", timeLimit],
        [`${QUEUE}-2`, "not-attempted", timeLimit],
      ]);
      expect(ended).toMatchObject({
        endReason: "time-limit",
        applyProgress: { stoppedBy: null },
      });
      expect(await readyMessageIds("/", QUEUE)).toEqual(ids(1, 2));
    } finally {
      await quick.close();
    }
  });

  it("a Lost Checkout, then stop: the stop answers apply_not_running", async () => {
    await seedMessages("/", QUEUE, 3);
    let late: any;
    let id = "";
    const started = gate();
    beforeApplyStep = async () => {
      beforeApplyStep = null;
      await started.wait; // the test knows the Checkout's id
      await dropCheckoutConnection();
      await eventually(async () =>
        expect(
          (await app.get(`/api/checkouts/${id}`)).body.checkout.status,
        ).toBe("lost"),
      );
      late = await stop(app, id);
    };
    id = await startApply(app, 3);
    started.open();

    const ended = await appliedCheckout(app, id);

    expect([late.status, late.body.error.code]).toEqual([
      409,
      "apply_not_running",
    ]);
    expect(ended.lastApply.outcomes.map((o: any) => o.status)).toEqual([
      "failed",
      "not-attempted",
      "not-attempted",
    ]);
    expect(ended.lastApply.outcomes[1].reason).toMatch(/stopped being active/);
    expect(ended.applyProgress.stoppedBy).toBeNull();
    expect(await readyMessageIds("/", QUEUE)).toEqual(ids(0, 1, 2));
  });

  it("stop, then a Lost Checkout: the rest is reported stopped and is back in the queue", async () => {
    await seedMessages("/", QUEUE, 3);
    let stopped: any;
    let id = "";
    const started = gate();
    beforeApplyStep = async () => {
      beforeApplyStep = null;
      await started.wait; // the test knows the Checkout's id
      stopped = await stop(app, id);
      await dropCheckoutConnection();
      await eventually(async () =>
        expect(
          (await app.get(`/api/checkouts/${id}`)).body.checkout.status,
        ).toBe("lost"),
      );
    };
    id = await startApply(app, 3);
    started.open();

    const ended = await appliedCheckout(app, id);

    expect(stopped.status).toBe(200);
    expect(statuses(ended)).toEqual([
      [`${QUEUE}-0`, "failed", expect.any(String)],
      [`${QUEUE}-1`, "not-attempted", STOPPED],
      [`${QUEUE}-2`, "not-attempted", STOPPED],
    ]);
    expect(ended).toMatchObject({
      status: "lost",
      applyProgress: { stoppedBy: testOperator },
    });
    expect(await readyMessageIds("/", QUEUE)).toEqual(ids(0, 1, 2));
  });

  it("stop and the Apply's last step at once: exactly one consistent outcome list", async () => {
    await seedMessages("/", QUEUE, 3);
    const release = gate();
    const held = gate();
    let steps = 0;
    beforeApplyStep = async () => {
      if (++steps !== 2) return;
      held.open();
      await release.wait;
    };
    const id = await startApply(app, 2);
    await held.wait;

    const [stopped] = await Promise.all([
      stop(app, id),
      Promise.resolve().then(release.open),
    ]);
    const ended = await appliedCheckout(app, id);

    // Whichever came first, both steps were done (the second was in progress), each reported once.
    expect(statuses(ended)).toEqual([
      [`${QUEUE}-0`, "done", null],
      [`${QUEUE}-1`, "done", null],
      [`${QUEUE}-2`, "kept", null],
    ]);
    if (stopped.status === 200)
      expect(ended.applyProgress.stoppedBy).toBe(testOperator);
    else {
      expect([stopped.status, stopped.body.error.code]).toEqual([
        409,
        "apply_not_running",
      ]);
      expect(ended.applyProgress.stoppedBy).toBeNull();
    }
    expect(ended).toMatchObject({
      status: "ended",
      endReason: "applied",
      applyProgress: { done: 2, remaining: 0 },
    });
    expect(await readyMessageIds("/", QUEUE)).toEqual(ids(2));
  });
});

describe("Stopping a paced Apply", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startApp({
      profiles: [testProfile({ name: "local" })],
      checkoutTiming: { timeLimitMs: 120_000 },
    });
  });
  afterEach(async () => {
    await purgeQueues("/", fixtureQueues);
  });
  afterAll(async () => {
    await app?.close();
  });

  it("takes effect at once, not after the wait for the next paced step", async () => {
    const route = deadLetterRoutes.classic;
    await deadLetter(
      route,
      Array.from({ length: 4 }, (_, i) => ({
        body: `order ${i}`,
        options: { messageId: `paced-${i}` },
      })),
    );
    const started = await app.post(
      `/api/profiles/local/vhosts/%2F/queues/${route.dlq}/checkouts`,
    );
    expect(started.status).toBe(201);
    const { id, messages } = started.body.checkout;
    const handles = messages.map((m: any) => m.handle);
    expect(
      (
        await app.post(`/api/checkouts/${id}/decisions`, {
          handles,
          decision: { kind: "replay" },
        })
      ).status,
    ).toBe(200);
    // At 0.5/s the next Replay waits 2 s after the first.
    expect(
      (
        await app.post(`/api/checkouts/${id}/apply`, {
          confirm: true,
          rate: 0.5,
        })
      ).status,
    ).toBe(202);
    await eventually(
      async () => {
        expect(
          (await app.get(`/api/checkouts/${id}`)).body.checkout.applyProgress
            .done,
        ).toBe(1);
      },
      5_000,
      20,
    );

    const stoppedAt = Date.now();
    expect((await app.post(`/api/checkouts/${id}/apply/stop`)).status).toBe(
      200,
    );
    const ended = await appliedCheckout(app, id);

    expect(Date.now() - stoppedAt).toBeLessThan(1_000);
    expect(ended.lastApply.outcomes.map((o: any) => o.status)).toEqual([
      "done",
      "not-attempted",
      "not-attempted",
      "not-attempted",
    ]);
    expect(ended).toMatchObject({
      status: "ended",
      endReason: "applied",
      applyProgress: { stoppedBy: testOperator },
    });
  });
});
