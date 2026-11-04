// The demo's whole API: one instance per page load holds the demo's state in
// memory, so a reload starts the scenario over. Each area registers its routes
// on the Router from its own module in ./routes.
import { DemoApiError, errorResponse, Router } from './router.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerCheckoutRoutes } from './routes/checkouts.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerSessionRoutes } from './routes/session.js';
import { startingState, type DemoState } from './state.js';

export interface DemoApi {
  /** Answers a request the web app made to /api/v1 (or its /api alias). */
  handle(request: Request): Promise<Response>;
  /** The routes with a handler and those left out of the demo, as `METHOD /api/v1/path`. */
  routes(): { handled: string[]; notInDemo: string[] };
  readonly state: DemoState;
}

export function createDemoApi(state: DemoState = startingState(), now: () => number = Date.now): DemoApi {
  const router = new Router();
  registerSessionRoutes(router, state);
  registerProfileRoutes(router, state);
  registerHistoryRoutes(router, state, now);
  registerAlertRoutes(router, state);
  registerCheckoutRoutes(router, state);
  registerAuditRoutes(router, state);
  return {
    state,
    routes: () => router.routes(),
    handle: async (request) => {
      const { pathname } = new URL(request.url);
      if (isSignInPath(pathname)) return errorResponse(new DemoApiError(404, 'not_in_demo', 'Not in the demo: signing in needs Team Mode.'));
      return router.handle(request, apiPath(pathname));
    },
  };
}

/** Whether a request is one the demo answers in place of a server: the API, and Team Mode's sign-in. */
export function isDemoApiPath(pathname: string): boolean {
  return /^\/api\//.test(pathname) || isSignInPath(pathname);
}

function isSignInPath(pathname: string): boolean {
  return pathname.startsWith('/auth/');
}

/** The path under /api/v1 of an API path, which the server also takes under /api. */
function apiPath(pathname: string): string {
  return pathname.replace(/^\/api(\/v1)?(?=\/)/, '');
}
