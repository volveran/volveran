// The API's routes as the server registers them and as `openapi.json` describes them, in one
// form to compare: `GET /api/v1/session`, with path parameters as `{name}`.
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { startServer } from '../../src/server/server.js';

export interface RegisteredRoute {
  method: string;
  url: string;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const readOpenApi = (): any => JSON.parse(readFileSync(path.join(root, 'openapi.json'), 'utf8'));

/** The routes `openapi` describes. */
export function describedRoutes(openapi: any): string[] {
  const base: string = openapi.servers[0].url;
  return Object.entries<Record<string, unknown>>(openapi.paths)
    .flatMap(([url, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${base}${url}`))
    .sort();
}

/** The routes under `/api/v1/`. A HEAD route only follows from its GET route, so it is left out. */
export function versionedRoutes(registered: readonly RegisteredRoute[]): string[] {
  return registered
    .filter(({ method, url }) => url.startsWith('/api/v1/') && method !== 'HEAD')
    .map(({ method, url }) => `${method} ${url.replace(/:([^/]+)/g, '{$1}')}`)
    .sort();
}

/** Every route a single Replica in Solo Mode registers, from a server that needs no broker. */
export async function registeredRoutes(): Promise<RegisteredRoute[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'volveran-routes-'));
  const profilesFile = path.join(dir, 'profiles.yaml');
  await writeFile(profilesFile, stringify({ profiles: [{ name: 'closed', amqpUrl: 'amqp://127.0.0.1:1', managementUrl: 'http://127.0.0.1:1', username: 'nobody', passwordEnv: 'CLOSED_PASSWORD' }] }));
  const routes: RegisteredRoute[] = [];
  const server = await startServer({
    profilesFile,
    env: { VOLVERAN_OPERATOR: 'routes', CLOSED_PASSWORD: 'unused' },
    host: '127.0.0.1',
    port: 0,
    onRouteRegistered: (route) => routes.push(route),
  });
  await server.close();
  await rm(dir, { recursive: true, force: true });
  return routes;
}
