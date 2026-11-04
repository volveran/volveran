// The demo's contract check (scripts/demo-check.mjs): every route of a
// release's openapi.json has a demo handler or is listed as not in the demo.
import { describe, expect, it } from 'vitest';
import { contractProblems, routesOf } from '../../scripts/demo-contract.mjs';
import { describedRoutes, readOpenApi } from '../support/api-routes.js';

const openapi = {
  servers: [{ url: '/api/v1' }],
  paths: {
    '/session': { get: {} },
    '/checkouts/{id}/end': { post: {} },
    '/approvals': { get: {}, post: {} },
  },
};

describe('the demo contract check', () => {
  it("reads a release's routes as the API tests do", () => {
    expect(routesOf(openapi)).toEqual(['GET /api/v1/approvals', 'GET /api/v1/session', 'POST /api/v1/approvals', 'POST /api/v1/checkouts/{id}/end']);
    expect(routesOf(readOpenApi())).toEqual(describedRoutes(readOpenApi()));
  });

  it('passes when every route is handled or listed as not in the demo', () => {
    const demo = { handled: ['GET /api/v1/session', 'POST /api/v1/checkouts/{id}/end'], notInDemo: ['GET /api/v1/approvals', 'POST /api/v1/approvals'] };
    expect(contractProblems(openapi, demo)).toEqual([]);
  });

  it('names each route of the release the demo neither handles nor lists', () => {
    const demo = { handled: ['GET /api/v1/session'], notInDemo: ['GET /api/v1/approvals'] };
    expect(contractProblems(openapi, demo)).toEqual([
      'POST /api/v1/approvals has no demo handler and is not listed as not in the demo',
      'POST /api/v1/checkouts/{id}/end has no demo handler and is not listed as not in the demo',
    ]);
  });
});
