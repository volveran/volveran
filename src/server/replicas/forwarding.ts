// Forwarding (#92): any Replica serves a request that belongs to another by passing it on
// over that Replica's internal port, streamed both ways, with the signed-in Operator's
// identity under a shared secret. This module knows nothing of what a request is about: a
// route says how to find the Replica that must answer it (`toOwner`).
//
// The internal listener hands an accepted request to the same app that serves the web port,
// so it passes the same owner and Role checks, here as the forwarded Operator. Only that
// listener can make a request forwarded, through a map no header reaches: on the web port
// these headers mean nothing. A forwarded request is answered here, never forwarded again.
//
// Tokens never travel. A request names its session, and the receiving Replica reads the
// session's token from the store (auth.ts). The id alone signs nobody in: a session cookie
// must also be signed with the session secret.
//
// Every request says which forwarding protocol it speaks, because during a rolling update
// Replicas of two versions run side by side (ADR 0015). A Replica refuses another version before
// it reads anything else of the request, and the sender treats that as an Owner Replica it
// cannot reach now: the Operator is told to try again, nothing is acted on and nothing is lost.
import { createHash, timingSafeEqual } from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { HttpError } from '../http-error.js';
import { isRecord } from '../is-record.js';
import type { Operator } from '../operator.js';

const OPERATOR_HEADER = 'x-volveran-forwarded-operator';
const SESSION_HEADER = 'x-volveran-forwarded-session';
const PROTOCOL_HEADER = 'x-volveran-forwarding-protocol';
/**
 * Change this when what Replicas say to each other changes meaning: the identity headers, or
 * what a forwarded request may assume of the Replica answering it. The refusal of another version must stay
 * as it is through 1.x (a 400 with PROTOCOL_HEADER), so that every Replica can read it.
 */
const FORWARDING_PROTOCOL_VERSION = '1';
/** How long a forwarded request may wait for its answer to begin, unless its route says otherwise. */
const DEFAULT_ANSWER_WITHIN_MS = 10_000;
/** Between one hop and the next, or what this hop replaces. */
const NOT_PASSED_ON = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'authorization', OPERATOR_HEADER, SESSION_HEADER, PROTOCOL_HEADER]);

const forwardedRequests = new WeakMap<IncomingMessage, { operator: Operator; session: string | null }>();

/** The Operator a request was forwarded with; null for any request that arrived on the web port. */
export function forwardedOperator(raw: IncomingMessage): Operator | null {
  return forwardedRequests.get(raw)?.operator ?? null;
}

/** The id of the session a request was forwarded from; null when it named none, or arrived on the web port. */
export function forwardedSession(raw: IncomingMessage): string | null {
  return forwardedRequests.get(raw)?.session ?? null;
}

/** Another Replica must answer, and cannot now. Nothing is known to be lost. */
export function replicaUnreachable(): HttpError<'replica_unreachable'> {
  return new HttpError(503, 'replica_unreachable', 'The Replica that must answer this cannot be reached right now. Try again in a moment.', { tryAgain: true });
}

export interface ToOwnerOptions {
  /** How long to wait for the answer to begin, for a route that can take longer. */
  answerWithinMs?: number;
}

export interface Forwarder {
  /**
   * Route options that forward the request to the `host:port` `ownerOf` answers, or leave it
   * to the route when it answers null. They run after sign-in and before the body is read.
   */
  toOwner<R extends FastifyRequest>(ownerOf: (req: R) => Promise<string | null>, options?: ToOwnerOptions): { onRequest: onRequestAsyncHookHandler };
  /** Sends the Replica at `address` a POST of its own, with no body, on behalf of `operator`. Rejects unless it answers 2xx within `withinMs`. */
  tell(address: string, path: string, operator: Operator, withinMs: number): Promise<void>;
}

/**
 * Why a request between Replicas failed: the connection failed or dropped before an answer
 * began (`unreachable`), no answer began in time (`timed_out`), nobody is known to send it to
 * (`no_address`), the internal port refused it, told by the Replica refusing (`refused`), or
 * the other Replica speaks another forwarding protocol, told by the Replica sending (`protocol_mismatch`).
 */
export type ForwardingFailure = 'unreachable' | 'timed_out' | 'no_address' | 'refused' | 'protocol_mismatch';

/** The answer of a Replica that speaks another forwarding protocol. No route answers with this header. */
function isProtocolRefusal(answer: IncomingMessage): boolean {
  return answer.statusCode === 400 && answer.headers[PROTOCOL_HEADER] !== undefined;
}

function passedOn(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !NOT_PASSED_ON.has(name)));
}

export function createForwarder(secret: string, onFailure: (reason: ForwardingFailure) => void): Forwarder {
  const send = (req: FastifyRequest, reply: FastifyReply, address: string, answerWithinMs: number) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      let answered = false;
      let timedOut = false;
      let operatorLeft = false;
      const { hostname, port } = new URL(`http://${address}`);
      const outgoing = http.request({
        host: hostname.replace(/^\[|\]$/g, ''),
        port,
        method: req.raw.method,
        path: req.raw.url,
        // A kept connection can die between requests, which would read as an unreachable Replica.
        agent: false,
        headers: {
          ...passedOn(req.raw.headers),
          host: address,
          authorization: `Bearer ${secret}`,
          [PROTOCOL_HEADER]: FORWARDING_PROTOCOL_VERSION,
          [OPERATOR_HEADER]: encodeOperator(req.operator!),
          ...(req.operator!.brokerToken?.sessionId !== undefined && { [SESSION_HEADER]: req.operator!.brokerToken.sessionId }),
        },
      });
      const limit = setTimeout(() => {
        timedOut = true;
        outgoing.destroy();
      }, answerWithinMs);
      outgoing.once('response', (answer) => {
        answered = true;
        clearTimeout(limit);
        resolve(answer);
      });
      // Destroyed by the limit, or the connection failed. Once answered, this changes nothing.
      outgoing.once('close', () => {
        clearTimeout(limit);
        if (!answered && !operatorLeft) onFailure(timedOut ? 'timed_out' : 'unreachable');
        reject(replicaUnreachable());
      });
      outgoing.on('error', () => {});
      // The Operator went away, or the answer is complete.
      reply.raw.once('close', () => {
        operatorLeft = true;
        outgoing.destroy();
      });
      req.raw.pipe(outgoing);
    });

  return {
    tell: (address, path, operator, withinMs) =>
      new Promise<void>((resolve, reject) => {
        const { hostname, port } = new URL(`http://${address}`);
        const outgoing = http.request({
          host: hostname.replace(/^\[|\]$/g, ''),
          port,
          method: 'POST',
          path,
          agent: false,
          headers: { host: address, authorization: `Bearer ${secret}`, [PROTOCOL_HEADER]: FORWARDING_PROTOCOL_VERSION, [OPERATOR_HEADER]: encodeOperator(operator), 'content-length': 0 },
        });
        let answered = false;
        let timedOut = false;
        const limit = setTimeout(() => {
          timedOut = true;
          outgoing.destroy();
        }, withinMs);
        outgoing.on('error', () => {});
        outgoing.once('close', () => {
          clearTimeout(limit);
          if (!answered) onFailure(timedOut ? 'timed_out' : 'unreachable');
          reject(replicaUnreachable());
        });
        outgoing.once('response', (answer) => {
          answered = true;
          clearTimeout(limit);
          answer.resume();
          if (isProtocolRefusal(answer)) {
            onFailure('protocol_mismatch');
            reject(replicaUnreachable());
          } else if ((answer.statusCode ?? 500) < 300) resolve();
          else reject(new Error(`The Replica answered ${answer.statusCode}`));
        });
        outgoing.end();
      }),
    toOwner(ownerOf, { answerWithinMs = DEFAULT_ANSWER_WITHIN_MS } = {}) {
      return {
        onRequest: async (req, reply) => {
          if (forwardedRequests.has(req.raw)) return;
          const address = await ownerOf(req as never);
          if (address === null) return;
          const answer = await send(req, reply, address, answerWithinMs);
          if (isProtocolRefusal(answer)) {
            answer.resume();
            onFailure('protocol_mismatch');
            throw replicaUnreachable();
          }
          return reply
            .status(answer.statusCode ?? 502)
            .headers(passedOn(answer.headers))
            .send(answer);
        },
      };
    },
  };
}

function encodeOperator({ id, displayName, email, name, groups }: Operator): string {
  return Buffer.from(JSON.stringify({ id, displayName, email, name, groups })).toString('base64url');
}

function decodeOperator(raw: string | string[] | undefined): Operator | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString());
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.id !== 'string' || parsed.id === '' || typeof parsed.displayName !== 'string') return null;
  const { id, displayName, email, name, groups } = parsed;
  if (groups !== undefined && !(Array.isArray(groups) && groups.every((g) => typeof g === 'string'))) return null;
  return {
    id,
    displayName,
    ...(typeof email === 'string' && { email }),
    ...(typeof name === 'string' && { name }),
    ...(groups !== undefined && { groups: groups as string[] }),
  };
}

const digest = (value: string) => createHash('sha256').update(value).digest();

function carriesSecret(req: IncomingMessage, secret: string): boolean {
  return timingSafeEqual(digest(req.headers.authorization ?? ''), digest(`Bearer ${secret}`));
}

export interface ForwardingListenerOptions {
  host: string;
  port: number;
  secret: string;
  /** Serves an accepted request as the web port would. */
  serve(req: IncomingMessage, res: ServerResponse): void;
  /** A request without the secret or an Operator came: a Replica with another secret, or something that should not reach this port. */
  onRefused(): void;
}

export interface ForwardingListener {
  close(): Promise<void>;
}

/** The internal port. It answers only requests carrying the secret and an Operator; nothing here is for a browser. */
export async function startForwardingListener({ host, port, secret, serve, onRefused }: ForwardingListenerOptions): Promise<ForwardingListener> {
  const server = http.createServer((req, res) => {
    const secretHolds = carriesSecret(req, secret);
    // Only a Replica learns the version, and the rest of the request may mean something else in another one.
    if (secretHolds && req.headers[PROTOCOL_HEADER] !== FORWARDING_PROTOCOL_VERSION) {
      res.writeHead(400, { 'content-type': 'application/json', [PROTOCOL_HEADER]: FORWARDING_PROTOCOL_VERSION });
      res.end(JSON.stringify({ error: { code: 'forwarding_protocol_mismatch', message: `This Replica speaks forwarding protocol ${FORWARDING_PROTOCOL_VERSION}.` } }));
      return;
    }
    const operator = secretHolds ? decodeOperator(req.headers[OPERATOR_HEADER]) : null;
    if (!operator || !req.url?.startsWith('/api/')) {
      onRefused();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'forwarding_refused', message: 'This port takes only requests forwarded by another Replica.' } }));
      return;
    }
    const session = req.headers[SESSION_HEADER];
    forwardedRequests.set(req, { operator, session: typeof session === 'string' && session !== '' ? session : null });
    serve(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
