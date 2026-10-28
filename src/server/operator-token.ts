// The signed-in Operator's OAuth 2.0 access token (Team Mode, ADR 0008),
// kept server-side in their session: the browser never sees it. A Broker
// Profile with `credentials: operatorToken` connects with it
// (broker-credentials.ts), so the broker applies the Operator's own
// permissions.
//
// One object per sign-in, held by the session's Operator and by every
// Checkout that Operator starts: an approved Apply runs on the requester's
// Checkout, so with the requester's token. Refreshing it (and pushing the new
// token to live connections with `update-secret`) belongs here, on this
// object, so everything holding it sees the new token.

/** The claims of a JWT, unverified (the broker verifies it); {} for a token that is not a JWT. */
function claimsOf(token: string): Record<string, unknown> {
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return claims !== null && typeof claims === 'object' && !Array.isArray(claims) ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class OperatorToken {
  readonly claims: Record<string, unknown>;
  /** When the broker stops accepting it (ms since the epoch); undefined when nothing says. */
  readonly expiresAt: number | undefined;

  /**
   * `expiresInSeconds` is the token response's `expires_in`; the token's own
   * `exp` claim, which the broker enforces, wins when it has one.
   */
  constructor(
    private readonly accessToken: string,
    expiresInSeconds: number | undefined,
    now = Date.now(),
  ) {
    this.claims = claimsOf(accessToken);
    const exp = this.claims.exp;
    this.expiresAt =
      typeof exp === 'number' ? exp * 1000 : expiresInSeconds !== undefined ? now + expiresInSeconds * 1000 : undefined;
  }

  /** The access token, or null once it has expired. */
  valid(now = Date.now()): string | null {
    return this.expiresAt !== undefined && now >= this.expiresAt ? null : this.accessToken;
  }

  /** The value of `claim` when it is a non-empty string. */
  claim(claim: string): string | undefined {
    const value = this.claims[claim];
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  /** Never serialised: an Operator or Checkout logged or sent as JSON leaves the token out. */
  toJSON(): undefined {
    return undefined;
  }
}
