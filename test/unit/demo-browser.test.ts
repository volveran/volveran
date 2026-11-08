// What the demo page installs in the browser before the release's web app
// loads (site/demo/browser): its API calls never reach the network, its links
// stay under /demo/, and it stores nothing.
import { describe, expect, it, vi } from 'vitest';
import { createDemoApi } from '../../site/demo/api/demo-api.js';
import { startingState } from '../../site/demo/api/state.js';
import { fetchRecording, installMemoryStorage, interceptFetch, inDemoUrl } from '../../site/demo/browser/adapters.js';
import { committedRecording } from '../support/demo-recording.js';

const demoPage = 'https://volveran.github.io/volveran/demo/';

function fakeWindow() {
  const network = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('from the network'));
  return { network, win: { fetch: network as typeof fetch, location: { href: demoPage } } };
}

describe('the demo fetch', () => {
  it("answers the web app's API calls from the demo, never from the network", async () => {
    const { network, win } = fakeWindow();
    interceptFetch(win, createDemoApi(startingState(committedRecording)));
    const session = await win.fetch('/api/v1/session', { headers: { accept: 'application/json' } });
    expect(await session.json()).toMatchObject({ mode: 'solo', operator: 'demo' });
    const end = await win.fetch(new Request(new URL('/api/v1/checkouts/c1/end', demoPage), { method: 'POST', keepalive: true }));
    expect(end.status).toBe(404);
    expect(await win.fetch(new URL('/auth/logout', demoPage), { method: 'POST' })).toHaveProperty('status', 404);
    expect(network).not.toHaveBeenCalled();
  });

  it('leaves every other request to the network', async () => {
    const { network, win } = fakeWindow();
    interceptFetch(win, createDemoApi(startingState(committedRecording)));
    expect(await (await win.fetch('assets/font.woff2')).text()).toBe('from the network');
    expect(network).toHaveBeenCalledWith('assets/font.woff2', undefined);
  });
});

describe('the recording', () => {
  const url = 'assets/recording-abc123.json';

  it('loads with one request to the network, before the demo answers anything', async () => {
    const network = vi.fn(async () => new Response(JSON.stringify(committedRecording)));
    const recorded = await fetchRecording(network as unknown as typeof fetch, url);
    expect(recorded.recordedAt).toBe(committedRecording.recordedAt);
    expect(network).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledWith(url);
  });

  it('says what went wrong when it cannot be loaded', async () => {
    const answering = (res: Response) => (async () => res) as unknown as typeof fetch;
    await expect(fetchRecording(answering(new Response('', { status: 404 })), url)).rejects.toThrow(`${url} answered 404.`);
    // A static host answering its index page for a missing file.
    await expect(fetchRecording(answering(new Response('<!doctype html><html></html>')), url)).rejects.toThrow(SyntaxError);
    await expect(fetchRecording(answering(new Response('{"profiles": []}')), url)).rejects.toThrow(/Not a demo recording/);
    const offline = (async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.');
    }) as unknown as typeof fetch;
    await expect(fetchRecording(offline, url)).rejects.toThrow(/NetworkError/);
  });
});

describe('links in the demo', () => {
  it("keeps the web app's root-relative links to its views under the demo's path", () => {
    expect(inDemoUrl('/#/history/staging/%2F/orders.dlq', '/volveran/demo/')).toBe('/volveran/demo/#/history/staging/%2F/orders.dlq');
    expect(inDemoUrl('/#/dead-letter-map/staging/%2F', '/volveran/demo/index.html')).toBe('/volveran/demo/index.html#/dead-letter-map/staging/%2F');
  });

  it('leaves any other link as it is', () => {
    expect(inDemoUrl('#/audit', '/volveran/demo/')).toBeUndefined();
    expect(inDemoUrl('https://github.com/volveran/volveran', '/volveran/demo/')).toBeUndefined();
    expect(inDemoUrl('/volveran/', '/volveran/demo/')).toBeUndefined();
  });

  it('leaves a link alone when the demo is served at the root, as `npm run demo` does', () => {
    // Rewriting it to itself would set the href again, and the page's link watcher would never stop.
    expect(inDemoUrl('/#/history/staging/%2F/orders.dlq', '/')).toBeUndefined();
  });
});

describe('storage in the demo', () => {
  it('keeps what the web app stores in memory, for this page only', () => {
    const stored = new Map<string, string>();
    const win: { localStorage: Storage; sessionStorage: Storage } = {
      localStorage: { setItem: (k: string, v: string) => stored.set(k, v) } as unknown as Storage,
      sessionStorage: { setItem: (k: string, v: string) => stored.set(k, v) } as unknown as Storage,
    };
    installMemoryStorage(win);
    win.localStorage.setItem('volveran.location', '{"profile":"production"}');
    win.sessionStorage.setItem('x', 'y');
    expect(win.localStorage.getItem('volveran.location')).toBe('{"profile":"production"}');
    expect(win.localStorage.length).toBe(1);
    expect(win.localStorage.key(0)).toBe('volveran.location');
    win.localStorage.removeItem('volveran.location');
    expect(win.localStorage.getItem('volveran.location')).toBeNull();
    expect(stored.size).toBe(0);
  });

  it("opens the web app on production, as the banner's suggested path starts there", () => {
    const win = {} as { localStorage: Storage };
    installMemoryStorage(win);
    // The release's App.tsx remembers the Broker Profile under this key and opens on it.
    expect(JSON.parse(win.localStorage.getItem('volveran.location') ?? '{}')).toEqual({ profile: 'production' });
  });
});
