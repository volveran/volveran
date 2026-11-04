// What the demo page changes in the browser for the release's web app, which
// it cannot change itself (no change under src/web). Each takes the window
// as a parameter, so it runs under Node with a stand-in.
import { isDemoApiPath, type DemoApi } from '../api/demo-api.js';

/**
 * Answers the web app's calls to /api/ (and Team Mode's /auth/) from `api`, so
 * they never reach the network. The web app writes them root-relative
 * (`/api/v1/session`), so on Pages they would go to the origin's root.
 */
export function interceptFetch(win: { fetch: typeof fetch; location: { href: string } }, api: DemoApi): void {
  const network = win.fetch;
  win.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), win.location.href);
    if (!isDemoApiPath(url.pathname)) return network(input, init);
    return api.handle(input instanceof Request ? new Request(input, init) : new Request(url, init));
  };
}

/**
 * The web app's links to its own views are root-relative (`/#/history/...`),
 * since it is served at `/`; under the demo they would leave it. Returns the
 * link under `pathname` (the demo page's), or undefined for any other link
 * and for one that is already there (the demo served at `/`).
 */
export function inDemoUrl(href: string, pathname: string): string | undefined {
  if (!href.startsWith('/#')) return undefined;
  const inDemo = `${pathname}${href.slice(1)}`;
  return inDemo === href ? undefined : inDemo;
}

/** Replaces localStorage and sessionStorage with storage in memory, gone with the page. */
export function installMemoryStorage(win: object): void {
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(win, name, { value: memoryStorage(), configurable: true, enumerable: true });
  }
}

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
    clear: () => items.clear(),
  };
}
