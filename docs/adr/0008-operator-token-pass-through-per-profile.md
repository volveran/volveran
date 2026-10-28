# A Broker Profile can connect with the Operator's own access token

[ADR 0004](0004-shared-broker-credentials-first.md) connected every Broker Profile with one shared service account, so the broker could not apply per-person permissions and its logs showed the account, not the person. v0.3 adds `credentials: operatorToken` as a per-profile option, in Team Mode only: Volverán keeps the access token the Operator got at sign-in in their server-side session, and every AMQP connection it opens for them on that profile (Checkout, Restore) uses it as the password, while every management API call sends it as a bearer token. RabbitMQ's OAuth 2.0 backend then checks the Operator's own scopes, and its connection list shows them. This supersedes ADR 0004 only for profiles that opt in: `shared` stays the default, and Solo Mode refuses `operatorToken` (it has no sign-in, so no token).

The option was gated on broker facts ([RabbitMQ behaviour](../rabbitmq-behaviour.md#oauth-20-tokens)), checked against a broker with the OAuth 2.0 backend only before any server work. The gate passed: a token works as the AMQP password (the broker user is taken from the token, whatever user name the client sends); `update-secret` accepts a refreshed token for the same user and refuses an invalid, expired or other user's token by closing the connection; a connection whose token expires without a refresh is closed at expiry with `320 CONNECTION_FORCED`; and the management API accepts the token as a bearer token.

## Decisions

- **One token per Operator, shared by every such profile.** Volverán has one OIDC client, so the one access token from sign-in serves every `operatorToken` profile. Each such broker must accept that token's audience and scopes (its `resource_server_id`, or `additional_scopes_key` / `scope_aliases`); per-profile clients, audiences and token exchange are out of scope.
- **The broker user in Audit Entries** is the token's `tokenUsernameClaim` (default `sub`, falling back to `sub` like RabbitMQ when the claim is missing). The profile's setting should match the broker's `auth_oauth2.preferred_username_claims`, so the Audit Entry names the user the broker's logs show.
- **A Checkout keeps its connection, and its owner.** The token is resolved when a connection opens and stays with that connection. An approved Apply runs on the requester's Checkout and connection ([Approval](../team-mode.md#approval)), so it acts with the requester's token and is recorded with the requester's broker user; the approver's broker permissions play no part.
- **Credentials are resolved per call, never cached** (`src/server/broker-credentials.ts`): the access check hands each route a management client and a credentials function, so an expired token is noticed when the broker is next used, not at sign-in.

## Failure modes

- **Expired token, new work:** Volverán knows the token's expiry (`exp`), and any route that would reach the broker answers `401 broker_token_expired` with `signInUrl`. Reading Volverán's own data (a Checkout already held, Audit Entries) still works.
- **Expired token, live Checkout:** the broker closes the connection at the token's expiry. That is a Lost Checkout through the existing path: the broker returns every Message to the queue (on quorum queues at the cost of one delivery), and the Checkout says why.
- **Missing broker permission:** a refused read of the queue when a Checkout starts, the configure permission for the lock queue, and the management tag answer `403 broker_permission_denied`, naming the profile, the broker user, the resource and the permission. A refused publish during an Apply or Restore fails that step, with the broker's reason, as any other failed step does.
- **Token the broker does not accept** (audience, signing key): `authentication_failed`, as for wrong shared credentials, naming the Operator's token.

## Consequences

- RabbitMQ's permissions, not only Volverán's roles, limit what each Operator can do on such a profile; the two are independent, and the narrower one wins.
- Refresh is not part of this decision's first step: a Checkout cannot outlive the sign-in token. Refreshing before expiry and pushing the new token to live connections with `update-secret` is the follow-up (#50); the token object held by the session and every Checkout is where it goes.
- Real deployments need an `https` JWKS endpoint (RabbitMQ refuses `http`) or a statically configured signing key; the Team Mode guide covers the set-up.
