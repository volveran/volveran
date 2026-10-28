// The Operator (GLOSSARY): the person acting through Volverán, recorded in
// every Audit Entry together with the broker user. Every request carries one,
// set before any route handler runs:
//   Solo Mode  the configured name (VOLVERAN_OPERATOR, else $USER)
//   Team Mode  the signed-in identity (auth.ts); requests without a session
//              never reach a handler
// Route handlers call `operatorOf(req)`; anything keyed by person (one active
// Checkout per Operator, Audit Entries) uses `operator.id`.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from './http-error.js';
import type { OperatorToken } from './operator-token.js';

export interface Operator {
  /**
   * Stable identity, the key for anything per person: the provider's `sub`
   * in Team Mode, the configured name in Solo Mode.
   */
  id: string;
  /** What people see: email, else name, else `sub` in Team Mode; the configured name in Solo Mode. */
  displayName: string;
  /** Team Mode: the `email` claim, when the provider gives one. */
  email?: string;
  /** Team Mode: the `name` claim, when the provider gives one. */
  name?: string;
  /**
   * Team Mode: the groups read from the groups claim at sign-in, which give
   * the Operator a Role on each Broker Profile (profile-access.ts). Fixed for
   * the session: a change at the provider applies at the next sign-in.
   */
  groups?: string[];
  /**
   * Team Mode: the access token from sign-in, kept server-side. Profiles
   * with `credentials: operatorToken` connect with it (broker-credentials.ts).
   */
  brokerToken?: OperatorToken;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by an onRequest hook; read it through `operatorOf`. */
    operator: Operator | null;
  }
}

/** The signed-in identity as an Operator, with the groups read from its claims. */
export function teamOperator(claims: { sub: string; email?: unknown; name?: unknown }, groups: string[]): Operator {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const email = text(claims.email);
  const name = text(claims.name);
  return {
    id: claims.sub,
    displayName: email ?? name ?? claims.sub,
    ...(email !== undefined && { email }),
    ...(name !== undefined && { name }),
    groups,
  };
}

/** Adds `req.operator` to every request; `resolve` returns null for a request without one. */
export function attachOperator(app: FastifyInstance, resolve: (req: FastifyRequest) => Operator | null): void {
  app.decorateRequest('operator', null);
  app.addHook('onRequest', async (req) => {
    req.operator = resolve(req);
  });
}

/** The Operator making this request. Throws 401 `not_signed_in` when there is none (Team Mode, no session). */
export function operatorOf(req: FastifyRequest): Operator {
  if (!req.operator) throw notSignedIn();
  return req.operator;
}

export function notSignedIn(): HttpError<'not_signed_in'> {
  return new HttpError(401, 'not_signed_in', 'Sign in to use Volverán.', { signInUrl: '/auth/login' });
}
