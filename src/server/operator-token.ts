// The signed-in Operator's OAuth 2.0 access token (Team Mode, ADR 0008),
// kept server-side in their session with its refresh token: the browser never
// sees either. A Broker Profile with `credentials: operatorToken` connects
// with it (broker-credentials.ts), so the broker applies the Operator's own
// permissions.
//
// One object per sign-in, held by the session's Operator and by every
// Checkout that Operator starts: an approved Apply runs on the requester's
// Checkout, so with the requester's token. It refreshes itself a margin
// before it expires (`refreshMarginMs`) and tells its listeners the new
// token: every live AMQP connection opened with it sends the new token to the
// broker with `update-secret` (amqp-connection.ts), and management API calls
// read the current one. When the provider refuses a refresh, the token runs
// out at its expiry: routes answer 401 `broker_token_expired`, and the broker
// closes the connections opened with it (a live Checkout becomes a Lost
// Checkout).

/** The claims of a JWT, unverified (the broker verifies it); {} for a token that is not a JWT. */
function claimsOf(token: string): Record<string, unknown> {
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return claims !== null && typeof claims === 'object' && !Array.isArray(claims) ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A token response: from sign-in, or from a refresh. */
export interface TokenGrant {
  accessToken: string;
  /** The response's `expires_in`; the token's own `exp` claim, which the broker enforces, wins when it has one. */
  expiresIn: number | undefined;
  /** Absent when the provider issued none (then there is no refresh), or kept the old one on a refresh. */
  refreshToken: string | undefined;
}

/** The provider refused the refresh (e.g. `invalid_grant`: revoked or expired); trying again will not help. */
export class RefreshRefused extends Error {
  override name = 'RefreshRefused';
}

export interface RefreshOptions {
  /** The refresh grant at the provider; throws RefreshRefused when refused, anything else when it may pass. */
  refresh?: (refreshToken: string) => Promise<TokenGrant>;
  /** No refresh after this time (ms since the epoch): the session's end. */
  until?: number;
  /** Refresh even when the access token has already expired: one read back from a session store after a restart. */
  refreshPastExpiry?: boolean;
  /** Told why a refresh failed (never a token); `final` when it stops refreshing. */
  onFailure?: (reason: string, final: boolean) => void;
}

/** Refresh this long before expiry: 60 seconds, or half the lifetime of a token that lasts less than two minutes. */
export function refreshMarginMs(lifetimeMs: number): number {
  return Math.min(60_000, lifetimeMs / 2);
}

/** Try again this long after a refresh that failed but may pass, while the token is still valid. */
const retryMs = 10_000;

/** The expiry a grant gives (ms since the epoch). */
function expiryOf(claims: Record<string, unknown>, grant: TokenGrant, now: number): number | undefined {
  const exp = claims.exp;
  return typeof exp === 'number' ? exp * 1000 : grant.expiresIn !== undefined ? now + grant.expiresIn * 1000 : undefined;
}

export class OperatorToken {
  private accessToken!: string;
  private refreshToken: string | undefined;
  private _claims: Record<string, unknown> = {};
  private _expiresAt: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly listeners = new Set<(accessToken: string) => void>();

  constructor(
    grant: TokenGrant,
    private readonly options: RefreshOptions = {},
    now = Date.now(),
  ) {
    this.take(grant, now);
    this.schedule(now);
  }

  get claims(): Record<string, unknown> {
    return this._claims;
  }

  /** When the broker stops accepting it (ms since the epoch); undefined when nothing says. */
  get expiresAt(): number | undefined {
    return this._expiresAt;
  }

  /** The access token, or null once it has expired. */
  valid(now = Date.now()): string | null {
    return this._expiresAt !== undefined && now >= this._expiresAt ? null : this.accessToken;
  }

  /** The value of `claim` when it is a non-empty string. */
  claim(claim: string): string | undefined {
    const value = this._claims[claim];
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  /** Calls `listener` with each refreshed access token; returns the unsubscribe. */
  onRefresh(listener: (accessToken: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** No more refreshes: the session ended. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.listeners.clear();
  }

  /** Never serialised: an Operator or Checkout logged or sent as JSON leaves the tokens out. */
  toJSON(): undefined {
    return undefined;
  }

  private take(grant: TokenGrant, now: number): void {
    this.accessToken = grant.accessToken;
    if (grant.refreshToken !== undefined) this.refreshToken = grant.refreshToken;
    this._claims = claimsOf(grant.accessToken);
    this._expiresAt = expiryOf(this._claims, grant, now);
  }

  private schedule(now: number): void {
    if (this._expiresAt === undefined) return;
    this.refreshAt(now >= this._expiresAt ? now : this._expiresAt - refreshMarginMs(this._expiresAt - now), now);
  }

  /** Refreshes at `when`, if it can still refresh then. */
  private refreshAt(when: number, now: number): void {
    const { refresh, until, refreshPastExpiry } = this.options;
    if (this.stopped || !refresh || this.refreshToken === undefined || this._expiresAt === undefined) return;
    if ((when >= this._expiresAt && !refreshPastExpiry) || (until !== undefined && when >= until)) return;
    // refresh reports its failures through onFailure, and nothing waits for it.
    this.timer = setTimeout(() => void this.refresh(refresh), Math.max(0, when - now));
    this.timer.unref();
  }

  private async refresh(refresh: NonNullable<RefreshOptions['refresh']>): Promise<void> {
    let grant: TokenGrant;
    try {
      grant = await refresh(this.refreshToken!);
    } catch (err) {
      if (this.stopped) return;
      const final = err instanceof RefreshRefused;
      this.options.onFailure?.(err instanceof Error ? err.message : String(err), final);
      if (!final) this.refreshAt(Date.now() + retryMs, Date.now());
      return;
    }
    if (this.stopped) return;
    const now = Date.now();
    const next = expiryOf(claimsOf(grant.accessToken), grant, now);
    if (this._expiresAt !== undefined && (next === undefined || next <= this._expiresAt)) {
      // Pushing it would not keep a connection open any longer; refreshing again would loop.
      this.options.onFailure?.('the refreshed access token does not expire later than the current one', true);
      return;
    }
    this.take(grant, now);
    for (const listener of this.listeners) listener(this.accessToken);
    this.schedule(now);
  }
}
