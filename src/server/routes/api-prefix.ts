// The API is served under /api/v1. /api, where it lived before 1.0, is an alias through 1.x,
// so scripts from 0.x keep working. A route module registers a path once, under /api/, and this
// adds its twin under /api/v1/ with the same options: the same handler, and the same forwarding
// (`toOwner`). Hooks apply to both. One that looks at a route's URL must allow for both.
import type { FastifyInstance } from 'fastify';

const ALIAS = '/api/';
const VERSIONED = '/api/v1/';

/** Before the API's routes are registered. */
export function serveApiUnderVersionToo(app: FastifyInstance): void {
  app.addHook('onRoute', function (route) {
    // A HEAD route comes by itself with the GET route's twin.
    if (route.method === 'HEAD' || !route.url.startsWith(ALIAS) || route.url.startsWith(VERSIONED)) return;
    this.route({ ...route, url: VERSIONED + route.url.slice(ALIAS.length) });
  });
}

/** A route's URL as its module registered it, under whichever prefix it was reached. */
export function aliasOf(routeUrl: string | undefined): string | undefined {
  return routeUrl?.startsWith(VERSIONED) ? ALIAS + routeUrl.slice(VERSIONED.length) : routeUrl;
}
