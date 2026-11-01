// The authorization matrix: every route the server registers, and who may
// reach it. A new route fails the first test here until it has a row, which
// says what its role check must be.
//
// Each row is sent as each Persona over HTTP in Team Mode. A Persona that may
// reach the route gets the row's `reached` answer, exact, so a broken fixture
// cannot pass as allowed; several rows reach the handler with a request it
// then refuses, so that nothing changes. Any other Persona gets the refusal
// the row implies.
//
// All Personas are one person (one `sub`) in different groups, so each owns
// the same Checkout: the owner check (403 `not_checkout_owner`) would
// otherwise answer before the role check does.
//
// The metrics port is not here: it has its own listener, without sign-in, on
// purpose.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyAndWait, closedPort, eventually, makeTempDir, purgeQueues, readyCount, seedMessages, startApp, testProfile, withChannel, type TestApp } from './harness.js';
import { teamModeEnv, TestBrowser } from './oidc-provider.js';

const OWN_QUEUE = 'authorization-matrix.own';
const WAITING_QUEUE = 'authorization-matrix.waiting';
const OWN_MESSAGES = 2;
const DISCARD = { kind: 'discard', reason: 'bad payload' };
const VHOST_PATH = '/api/profiles/prod/vhosts/%2F';
const startPath = (profile: string, queue: string) => `/api/profiles/${profile}/vhosts/%2F/queues/${queue}/checkouts`;

const ROLE_GROUPS = { viewer: ['matrix-viewers'], operator: ['matrix-operators'], admin: ['matrix-admins'] };

/** Who sends each request, by their standing on the profile `prod`. */
const PERSONA_GROUPS = {
  /** No session at all. */
  'no session': null,
  /** Signed in, no Role on any Broker Profile. */
  'no role': ['matrix-nobody'],
  /** `admin` on another Broker Profile, no Role on `prod`. */
  'role elsewhere': ['matrix-elsewhere'],
  viewer: ROLE_GROUPS.viewer,
  operator: ROLE_GROUPS.operator,
  admin: ROLE_GROUPS.admin,
} as const;
type Persona = keyof typeof PERSONA_GROUPS;
const PERSONAS = Object.keys(PERSONA_GROUPS) as Persona[];

const EVERYONE: readonly Persona[] = PERSONAS;
const SIGNED_IN: readonly Persona[] = ['no role', 'role elsewhere', 'viewer', 'operator', 'admin'];
/** A Role on some Broker Profile (`assertSomeRole`). */
const SOME_ROLE: readonly Persona[] = ['role elsewhere', 'viewer', 'operator', 'admin'];
/** `admin` on some Broker Profile, for what belongs to none (`requireOnAnyProfile`). */
const ADMIN_ANYWHERE: readonly Persona[] = ['role elsewhere', 'admin'];
const VIEWER_UP: readonly Persona[] = ['viewer', 'operator', 'admin'];
const OPERATOR_UP: readonly Persona[] = ['operator', 'admin'];
const ADMIN: readonly Persona[] = ['admin'];

interface Row {
  method: 'GET' | 'POST' | 'DELETE';
  /** The route as registered. */
  route: string;
  reach: readonly Persona[];
  /** The answer of a Persona in `reach`. */
  reached: { status: number; code?: string };
  /** The request to send; may set up what it needs. Default: the route itself. */
  request?(): Promise<{ path: string; body?: unknown }> | { path: string; body?: unknown };
  /** Text in the answer that only these Personas may read. */
  shows?(): { text: string; to: readonly Persona[] };
  /** Reaching it signs the session out, so each Persona uses a session of its own. */
  endsSession?: boolean;
  /** Reaching it ends the Checkout it names. */
  endsCheckout?: boolean;
}

/** What the fixtures in beforeAll set up. */
let waiting: { id: string; handles: number[] };
let discardEntry: { id: string };
let discardedBody: string;
let startOwnCheckout: () => Promise<{ id: string; handles: number[] }>;
let ownCheckout: { id: string; handles: number[] } | null = null;

async function own(): Promise<{ id: string; handles: number[] }> {
  ownCheckout ??= await startOwnCheckout();
  return ownCheckout;
}

/** A route on the Checkout the Personas own. */
const onOwn = (route: string, reached: Row['reached'], body?: unknown, extra: Partial<Row> = {}, method: Row['method'] = 'POST'): Row => ({
  method,
  route,
  reach: OPERATOR_UP,
  reached,
  request: async () => {
    const { id, handles } = await own();
    const query = route.endsWith('/compare') ? `?a=${handles[0]}&b=${handles[1]}` : '';
    return { path: route.replace(':id', id).replace(':handle', String(handles[0])) + query, body };
  },
  ...extra,
});

/** A route on the Checkout waiting for Approval, which another person owns. */
const onWaiting = (method: Row['method'], route: string, reached: Row['reached'], body?: unknown): Row => ({
  method,
  route,
  reach: OPERATOR_UP,
  reached,
  request: () => {
    const query = route.endsWith('/compare') ? `?a=${waiting.handles[0]}&b=${waiting.handles[1]}` : '';
    return { path: route.replace(':checkoutId', waiting.id).replace(':handle', String(waiting.handles[0])) + query, body };
  },
});

const onEntry = (method: Row['method'], route: string, reach: readonly Persona[], reached: Row['reached'], extra: Partial<Row> = {}): Row => ({
  method,
  route,
  reach,
  reached,
  request: () => ({ path: route.replace(':id', discardEntry.id), body: method === 'POST' ? {} : undefined }),
  ...extra,
});

/** A route under one Broker Profile: `prod`, the vhost `/`, a queue and a Replay Rule that may not exist. */
const onProfile = (method: Row['method'], route: string, reach: readonly Persona[], reached: Row['reached']): Row => ({
  method,
  route,
  reach,
  reached,
  request: () => ({
    path: route.replace(':profile', 'prod').replace(':vhost', '%2F').replace(':queue', OWN_QUEUE).replace(':name', 'no-such-rule'),
    body: method === 'POST' ? {} : undefined,
  }),
});

const MATRIX: Row[] = [
  // Answer without a session in both modes.
  { method: 'GET', route: '/healthz', reach: EVERYONE, reached: { status: 200 } },
  { method: 'GET', route: '/readyz', reach: EVERYONE, reached: { status: 200 } },
  { method: 'GET', route: '/auth/login', reach: EVERYONE, reached: { status: 302 } },
  { method: 'GET', route: '/auth/callback', reach: EVERYONE, reached: { status: 400, code: 'sign_in_failed' } },
  { method: 'POST', route: '/auth/logout', reach: EVERYONE, reached: { status: 204 }, endsSession: true },
  // The built web app: holds no data, and has to load before anyone can sign in.
  { method: 'GET', route: '/*', reach: EVERYONE, reached: { status: 200 }, request: () => ({ path: '/assets/app.js' }) },

  // Any session: each answers with the Operator's own, or only what their Role shows.
  { method: 'GET', route: '/api/session', reach: SIGNED_IN, reached: { status: 200 }, shows: () => ({ text: '"prod"', to: VIEWER_UP }) },
  { method: 'GET', route: '/api/profiles', reach: SIGNED_IN, reached: { status: 200 }, shows: () => ({ text: '"prod"', to: VIEWER_UP }) },
  { method: 'GET', route: '/api/audit-entries', reach: SIGNED_IN, reached: { status: 200 }, shows: () => ({ text: '"prod"', to: VIEWER_UP }) },
  { method: 'GET', route: '/api/approvals', reach: SIGNED_IN, reached: { status: 200 }, shows: () => ({ text: '"guarded"', to: OPERATOR_UP }) },

  // A Role somewhere.
  { method: 'GET', route: '/api/alerts', reach: SOME_ROLE, reached: { status: 200 } },
  { method: 'GET', route: '/api/audit-store', reach: SOME_ROLE, reached: { status: 200 } },
  {
    method: 'POST',
    route: '/api/alert-destinations/:name/test',
    reach: ADMIN_ANYWHERE,
    reached: { status: 404, code: 'alert_destination_not_found' },
    request: () => ({ path: '/api/alert-destinations/no-such-destination/test', body: {} }),
  },

  // A Broker Profile.
  onProfile('GET', '/api/profiles/:profile/vhosts', VIEWER_UP, { status: 200 }),
  onProfile('GET', '/api/profiles/:profile/vhosts/:vhost/queues', VIEWER_UP, { status: 200 }),
  onProfile('GET', '/api/profiles/:profile/vhosts/:vhost/queues/:queue/history', VIEWER_UP, { status: 200 }),
  onProfile('GET', '/api/profiles/:profile/vhosts/:vhost/dead-letter-map', VIEWER_UP, { status: 200 }),
  onProfile('GET', '/api/profiles/:profile/vhosts/:vhost/move-destinations', OPERATOR_UP, { status: 200 }),
  onProfile('GET', '/api/profiles/:profile/alert-rules', VIEWER_UP, { status: 200 }),
  onProfile('GET', '/api/profiles/:profile/replay-rules', VIEWER_UP, { status: 200 }),
  onProfile('POST', '/api/profiles/:profile/replay-rules/:name/pause', OPERATOR_UP, { status: 404, code: 'replay_rule_not_found' }),
  onProfile('POST', '/api/profiles/:profile/replay-rules/:name/run', ADMIN, { status: 404, code: 'replay_rule_not_found' }),
  onProfile('POST', '/api/profiles/:profile/replay-rules/:name/resume', ADMIN, { status: 404, code: 'replay_rule_not_found' }),

  // An Audit Entry of `prod`.
  onEntry('GET', '/api/audit-entries/:id', VIEWER_UP, { status: 200 }, { shows: () => ({ text: discardedBody, to: OPERATOR_UP }) }),
  onEntry('POST', '/api/audit-entries/:id/restore', ADMIN, { status: 400, code: 'confirmation_required' }),

  // Starting a Checkout: these Personas already hold one.
  {
    method: 'POST',
    route: '/api/profiles/:profile/vhosts/:vhost/queues/:queue/checkouts',
    reach: OPERATOR_UP,
    reached: { status: 409, code: 'operator_has_checkout' },
    request: async () => {
      await own();
      return { path: startPath('prod', OWN_QUEUE), body: {} };
    },
  },

  // The Checkout's owner.
  onOwn('/api/checkouts/:id', { status: 200 }, undefined, {}, 'GET'),
  onOwn('/api/checkouts/:id/messages/:handle', { status: 200 }, undefined, {}, 'GET'),
  onOwn('/api/checkouts/:id/compare', { status: 200 }, undefined, {}, 'GET'),
  onOwn('/api/checkouts/:id/heartbeat', { status: 200 }),
  onOwn('/api/checkouts/:id/matching', { status: 400, code: 'invalid_request' }, {}),
  onOwn('/api/checkouts/:id/decisions', { status: 400, code: 'invalid_request' }, {}),
  onOwn('/api/checkouts/:id/export', { status: 200 }, {}),
  onOwn('/api/checkouts/:id/apply', { status: 400, code: 'confirmation_required' }, {}),
  onOwn('/api/checkouts/:id/apply/stop', { status: 409, code: 'apply_not_running' }),
  onOwn('/api/checkouts/:id/apply/continue', { status: 409, code: 'apply_not_waiting' }),
  onOwn('/api/checkouts/:id/approval-request', { status: 400, code: 'confirmation_required' }, {}),
  onOwn('/api/checkouts/:id/approval-request', { status: 409, code: 'not_awaiting_approval' }, undefined, {}, 'DELETE'),
  onOwn('/api/checkouts/:id/end', { status: 200 }, undefined, { endsCheckout: true }),
  onOwn('/api/checkouts/:id', { status: 200 }, undefined, { endsCheckout: true }, 'DELETE'),

  // Another Operator's Checkout waiting for Approval.
  onWaiting('GET', '/api/approvals/:checkoutId', { status: 200 }),
  onWaiting('GET', '/api/approvals/:checkoutId/messages/:handle', { status: 200 }),
  onWaiting('GET', '/api/approvals/:checkoutId/compare', { status: 200 }),
  onWaiting('POST', '/api/approvals/:checkoutId/approve', { status: 400, code: 'queue_name_confirmation_required' }, {}),
  onWaiting('POST', '/api/approvals/:checkoutId/reject', { status: 400, code: 'invalid_request' }, {}),
  onWaiting('POST', '/api/approvals/:checkoutId/apply/stop', { status: 403, code: 'not_checkout_owner' }),
  onWaiting('POST', '/api/approvals/:checkoutId/apply/continue', { status: 403, code: 'not_checkout_owner' }),
];

/** The refusal of a Persona outside `row.reach`. */
function refusal(row: Row, persona: Persona): { status: number; code: string } {
  if (persona === 'no session') return { status: 401, code: 'not_signed_in' };
  if (row.reach === SOME_ROLE) return { status: 403, code: 'no_role' };
  if (row.reach === ADMIN_ANYWHERE) return { status: 403, code: 'role_required' };
  if (persona === 'no role' || persona === 'role elsewhere') return { status: 403, code: 'no_role_on_profile' };
  return { status: 403, code: 'role_required' };
}

const routeKey = (method: string, route: string) => `${method} ${route}`;

describe('The authorization matrix', () => {
  let app: TestApp;
  let baseUrl: string;
  let webRoot: string;
  const registered = new Set<string>();
  const browsers = new Map<Persona, TestBrowser>();

  async function signedIn(sub: string, groups: readonly string[]): Promise<TestBrowser> {
    const browser = new TestBrowser(baseUrl);
    await browser.signIn({ sub, email: `${sub}@example.com`, groups: [...groups] });
    return browser;
  }

  async function browserOf(persona: Persona, row: Row): Promise<TestBrowser> {
    const groups = PERSONA_GROUPS[persona];
    if (groups && row.endsSession) return signedIn('matrix-person', groups);
    return browsers.get(persona)!;
  }

  /** A Checkout of `queue` on `profile` with these Messages, by `browser`. */
  async function startCheckout(browser: TestBrowser, profile: string, queue: string) {
    const started = await browser.post(startPath(profile, queue));
    expect(started.status).toBe(201);
    return { id: started.body.checkout.id as string, handles: started.body.checkout.messages.map((m: any) => m.handle) as number[] };
  }

  beforeAll(async () => {
    webRoot = await makeTempDir('authorization-matrix-web');
    await mkdir(path.join(webRoot, 'assets'), { recursive: true });
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>built</title>');
    await writeFile(path.join(webRoot, 'assets', 'app.js'), 'export {};');
    await withChannel('/', async (ch) => {
      await ch.assertQueue(OWN_QUEUE, { durable: true });
      await ch.assertQueue(WAITING_QUEUE, { durable: true });
    });

    const port = await closedPort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = await startApp({
      profiles: [
        testProfile({ name: 'prod', roles: ROLE_GROUPS }),
        testProfile({ name: 'guarded', protected: true, roles: ROLE_GROUPS }),
        testProfile({ name: 'elsewhere', roles: { admin: PERSONA_GROUPS['role elsewhere'] } }),
      ],
      port,
      env: teamModeEnv(baseUrl),
      webRoot,
      onRouteRegistered: ({ method, url }) => registered.add(routeKey(method, url)),
    });

    for (const persona of PERSONAS) {
      const groups = PERSONA_GROUPS[persona];
      browsers.set(persona, groups ? await signedIn('matrix-person', groups) : new TestBrowser(baseUrl));
    }

    // An Audit Entry on `prod` with a Discarded body, by someone else.
    await seedMessages('/', OWN_QUEUE, 1);
    const auditor = await signedIn('matrix-auditor', ROLE_GROUPS.operator);
    const discarded = await startCheckout(auditor, 'prod', OWN_QUEUE);
    await auditor.post(`/api/checkouts/${discarded.id}/decisions`, { handles: discarded.handles, decision: DISCARD });
    expect((await applyAndWait(auditor, `/api/checkouts/${discarded.id}/apply`, { confirm: true })).status).toBe(202);
    [discardEntry] = (await auditor.get(`/api/audit-entries?checkoutId=${discarded.id}`)).body.entries;
    discardedBody = Buffer.from('{"n":0}').toString('base64');

    // The Checkout the Personas own, started again whenever a row ends it.
    await seedMessages('/', OWN_QUEUE, OWN_MESSAGES);
    const owner = browsers.get('admin')!;
    startOwnCheckout = async () => {
      await eventually(async () => expect(await readyCount('/', OWN_QUEUE)).toBe(OWN_MESSAGES));
      return startCheckout(owner, 'prod', OWN_QUEUE);
    };

    // A Checkout waiting for Approval, of another person.
    await seedMessages('/', WAITING_QUEUE, 2);
    const requester = await signedIn('matrix-requester', ROLE_GROUPS.operator);
    waiting = await startCheckout(requester, 'guarded', WAITING_QUEUE);
    await requester.post(`/api/checkouts/${waiting.id}/decisions`, { handles: waiting.handles, decision: DISCARD });
    const requested = await requester.post(`/api/checkouts/${waiting.id}/approval-request`, { confirm: true, confirmQueueName: WAITING_QUEUE });
    expect(requested.status).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await purgeQueues('/', [OWN_QUEUE, WAITING_QUEUE]).catch(() => {});
    await withChannel('/', async (ch) => {
      await ch.deleteQueue(OWN_QUEUE);
      await ch.deleteQueue(WAITING_QUEUE);
    });
    await rm(webRoot, { recursive: true, force: true });
  });

  it('has a row for every registered route, and none for a route that is gone', () => {
    // Fastify registers a HEAD route for each GET route, running the same handler.
    const inMatrix = MATRIX.flatMap((row) => [routeKey(row.method, row.route), ...(row.method === 'GET' ? [routeKey('HEAD', row.route)] : [])]);
    expect([...registered].filter((route) => !inMatrix.includes(route)), 'registered routes missing from the matrix').toEqual([]);
    expect(inMatrix.filter((route) => !registered.has(route)), 'matrix rows for routes not registered').toEqual([]);
  });

  describe.each(MATRIX.map((row) => [routeKey(row.method, row.route), row] as const))('%s', (_key, row) => {
    it.each(PERSONAS)('as %s', async (persona) => {
      const browser = await browserOf(persona, row);
      const { path: urlPath, body } = (await row.request?.()) ?? { path: row.route };
      const res = await browser.request(row.method, urlPath, body === undefined ? {} : { body });

      const mayReach = row.reach.includes(persona);
      if (mayReach && row.endsCheckout) ownCheckout = null;
      const expected = mayReach ? row.reached : refusal(row, persona);
      expect(res.status).toBe(expected.status);
      if (expected.code) expect(res.body.error.code).toBe(expected.code);
      const shows = row.shows?.();
      if (shows && mayReach) expect(JSON.stringify(res.body).includes(shows.text)).toBe(shows.to.includes(persona));

      if (row.method === 'GET') {
        const head = await browser.request('HEAD', urlPath);
        expect(head.status, 'its HEAD route').toBe(expected.status);
      }
    });
  });

  // The session guard looks at the raw URL; the router decodes it first.
  describe('without a session, under a percent-encoded path', () => {
    const apiRows = MATRIX.filter((row) => row.route.startsWith('/api/'));
    it.each(apiRows.map((row) => [routeKey(row.method, row.route), row] as const))('%s', async (_key, row) => {
      const { path: urlPath, body } = (await row.request?.()) ?? { path: row.route };
      const res = await browsers.get('no session')!.request(row.method, urlPath.replace('/api/', '/%61pi/'), body === undefined ? {} : { body });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('not_signed_in');
    });
  });
});
