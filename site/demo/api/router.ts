// Routes a Request for /api/v1 to the handler registered for its method and
// path, as the server does. Paths are written as in openapi.json, relative to
// /api/v1 and with `{param}` placeholders, so the contract check can compare
// them with the release's openapi.json. DOM-free: it runs in the browser and
// under Node.
import { HttpError } from '../../../src/server/http-error.js';

/** What a handler gets: the path parameters, decoded, the query and the JSON body. */
export interface DemoRequest {
  method: string;
  /** The path under /api/v1, as requested. */
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  /** The parsed JSON body; undefined when there is none. */
  body: unknown;
  headers: Headers;
}

export type Handler = (req: DemoRequest) => Response | Promise<Response>;

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** An error answered as the server answers one: `{ error: { code, message, ...details } }`. */
export class DemoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

/** Also answers the server's own HttpErrors, for the pure checks the demo shares with it (src/server/apply/errors.ts, protected-profile.ts). */
export function errorResponse(err: DemoApiError | HttpError): Response {
  return json({ error: { code: err.code, message: err.message, ...err.details } }, err.status);
}

/** How a route the demo leaves out is answered, and why. */
const NOT_IN_DEMO = 'not_in_demo';

interface Route {
  method: Method;
  template: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  readonly #routes: Route[] = [];
  readonly #left = new Map<string, string>();

  /** Registers the handler of `method` `template` (e.g. `GET`, `/profiles/{profile}/vhosts`). */
  on(method: Method, template: string, handler: Handler): this {
    this.#routes.push({ method, template, segments: template.split('/'), handler });
    return this;
  }

  /** Answers `method` `template` with 404 `not_in_demo` and `message`, saying why it is left out. */
  notInDemo(method: Method, template: string, message: string): this {
    this.#left.set(`${method} ${template}`, message);
    return this.on(method, template, () => {
      throw new DemoApiError(404, NOT_IN_DEMO, message);
    });
  }

  /** Every route with a handler, as `METHOD /api/v1/path`, sorted; those left out of the demo separately. */
  routes(): { handled: string[]; notInDemo: string[] } {
    const all = this.#routes.map((r) => `${r.method} ${r.template}`);
    const full = (route: string) => route.replace(' ', ' /api/v1');
    return {
      handled: all.filter((r) => !this.#left.has(r)).map(full).sort(),
      notInDemo: [...this.#left.keys()].map(full).sort(),
    };
  }

  /** Answers a request for `path` (under /api/v1); anything without a route is a clear "not in the demo yet". */
  async handle(request: Request, path: string): Promise<Response> {
    const method = request.method.toUpperCase();
    try {
      const segments = path.split('/');
      for (const route of this.#routes) {
        if (route.method !== method) continue;
        const params = match(route.segments, segments);
        if (!params) continue;
        const text = await request.text();
        return await route.handler({
          method,
          path,
          params,
          query: new URL(request.url).searchParams,
          body: text === '' ? undefined : (JSON.parse(text) as unknown),
          headers: request.headers,
        });
      }
      throw new DemoApiError(404, NOT_IN_DEMO, `Not in the demo yet: ${method} /api/v1${path}.`);
    } catch (err) {
      if (err instanceof DemoApiError || err instanceof HttpError) return errorResponse(err);
      throw err;
    }
  }
}

function match(template: string[], segments: string[]): Record<string, string> | undefined {
  if (template.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, part] of template.entries()) {
    const segment = segments[i]!;
    const name = /^\{(.+)\}$/.exec(part)?.[1];
    if (name === undefined) {
      if (part !== segment) return undefined;
    } else {
      if (segment === '') return undefined;
      params[name] = decodeURIComponent(segment);
    }
  }
  return params;
}
