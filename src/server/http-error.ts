// The one shape every error the API reports takes: a stable `code`, its HTTP
// status and a message an operator can act on, plus optional extra fields for
// the error body (e.g. who holds a queue). Each domain error (BrokerError,
// and later CheckoutError, ApplyError, ...) is an HttpError with its own codes;
// server.ts turns any HttpError into `{ error: { ...details, code, message } }`.

export class HttpError<C extends string = string> extends Error {
  constructor(
    readonly status: number,
    readonly code: C,
    message: string,
    /** Extra fields for the API error body. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** A request the API can't read (malformed body or query). */
export class InvalidRequestError extends HttpError<'invalid_request'> {
  constructor(message: string) {
    super(400, 'invalid_request', message);
    this.name = 'InvalidRequestError';
  }
}
