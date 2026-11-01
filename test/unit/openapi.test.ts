// The published OpenAPI description against the routes the server registers. A new route fails
// here until it is described, and a route that goes fails here until its description does.
// With forwarding on, test/integration/api-v1-two-replicas.test.ts makes the same comparison.
import { Ajv2020 } from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { describedRoutes, readOpenApi, registeredRoutes, versionedRoutes, type RegisteredRoute } from '../support/api-routes.js';

describe('The API routes', () => {
  let registered: RegisteredRoute[];

  beforeAll(async () => {
    registered = await registeredRoutes();
  });

  it('are registered under /api/v1 and under /api alike', () => {
    const under = (prefix: string, without?: string) =>
      registered
        .filter(({ url }) => url.startsWith(prefix) && !(without && url.startsWith(without)))
        .map(({ method, url }) => `${method} /${url.slice(prefix.length)}`)
        .sort();
    const alias = under('/api/', '/api/v1/');
    expect(alias).toContain('GET /session');
    expect(alias).toContain('HEAD /session');
    expect(under('/api/v1/')).toEqual(alias);
  });

  it('are the ones the OpenAPI description has', () => {
    expect(describedRoutes(readOpenApi())).toEqual(versionedRoutes(registered));
  });
});

describe('The OpenAPI description', () => {
  const openapi = readOpenApi();
  const resolve = (ref: string): any => ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], openapi);

  it('is OpenAPI 3.1, at /api/v1, with /api named as its alias', () => {
    expect(openapi.openapi).toMatch(/^3\.1\./);
    expect(openapi.servers.map((s: { url: string }) => s.url)).toEqual(['/api/v1', '/api']);
  });

  it('declares each path parameter of each operation, and no other', () => {
    for (const [url, item] of Object.entries<any>(openapi.paths)) {
      const inPath = [...url.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      for (const [method, operation] of Object.entries<any>(item)) {
        const parameters = (operation.parameters ?? []).map((p: any) => (p.$ref ? resolve(p.$ref) : p));
        const declared = parameters.filter((p: any) => p.in === 'path').map((p: any) => p.name);
        expect(declared.sort(), `${method} ${url}`).toEqual([...inPath].sort());
      }
    }
  });

  it('has an operation id used once for each operation, and an answer on success and on refusal', () => {
    const operations = Object.values<any>(openapi.paths).flatMap((item) => Object.values<any>(item));
    const ids = operations.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const operation of operations) {
      expect(operation.summary, operation.operationId).toBeTruthy();
      expect(Object.keys(operation.responses).some((status) => status.startsWith('2')), operation.operationId).toBe(true);
      expect(operation.responses.default, operation.operationId).toBeDefined();
    }
  });

  it('refers only to what it has', () => {
    const refs = [...JSON.stringify(openapi).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(resolve(ref), ref).toBeDefined();
  });

  it('has schemas that are JSON Schema', () => {
    const ajv = new Ajv2020({ strict: false });
    ajv.addSchema({ $id: 'openapi', components: openapi.components });
    for (const name of Object.keys(openapi.components.schemas)) {
      expect(() => ajv.compile({ $ref: `openapi#/components/schemas/${name}` }), name).not.toThrow();
    }
  });
});
