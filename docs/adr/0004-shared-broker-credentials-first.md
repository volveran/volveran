# Connect to brokers with each Broker Profile's shared credentials, not the Operator's token

Superseded for Broker Profiles with `credentials: operatorToken` by [ADR 0008](0008-operator-token-pass-through-per-profile.md). Shared credentials remain the default.

Brokers that authenticate with OAuth2 could accept the signed-in Operator's access token as the AMQP and management password, which would apply RabbitMQ's own permissions per person. We start with shared credentials per Broker Profile instead, and record the Operator in every Audit Entry ourselves. Token pass-through means refreshing the token on a live AMQP connection (`update-secret`) while a Checkout holds Messages, which is the riskiest place to add a failure mode. It also only works on brokers configured for OAuth2. Pass-through is planned as a per-profile option alongside roles and permissions.

## Consequences

- The broker's own logs show the shared service user, not the person; the tool's audit trail is the authority on who did what.
- Anyone who can sign in can act with the Broker Profile's full broker permissions until roles arrive, so Protected Profiles and typed confirmation carry the safety load in the meantime.
