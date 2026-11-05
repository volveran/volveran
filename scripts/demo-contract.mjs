// The demo's contract with a release: every route of the release's
// openapi.json has a demo handler, or is listed as not in the demo
// (createDemoApi().routes()). Routes are compared as `METHOD /api/v1/path`
// with `{param}` placeholders, the form of test/support/api-routes.ts.

/**
 * The routes `openapi` describes, sorted.
 * @param {{ servers: Array<{ url: string }>, paths: Record<string, Record<string, unknown>> }} openapi
 * @returns {string[]}
 */
export function routesOf(openapi) {
  const base = openapi.servers[0]?.url ?? '';
  return Object.entries(openapi.paths)
    .flatMap(([url, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${base}${url}`))
    .sort();
}

/**
 * What breaks the contract: one line per route of the release the demo neither handles nor lists.
 * @param {Parameters<typeof routesOf>[0]} openapi
 * @param {{ handled: string[], notInDemo: string[] }} demo
 * @returns {string[]}
 */
export function contractProblems(openapi, demo) {
  const covered = new Set([...demo.handled, ...demo.notInDemo]);
  return routesOf(openapi)
    .filter((route) => !covered.has(route))
    .map((route) => `${route} has no demo handler and is not listed as not in the demo`);
}
