# RabbitMQ behaviour Volverán relies on

Observed on **RabbitMQ 4.4.0** (`rabbitmq:4-management`, October 2026) with AMQP 0-9-1 clients, and cross-checked with the [consumers](https://www.rabbitmq.com/docs/consumers) and [dead lettering](https://www.rabbitmq.com/docs/dlx) docs and the [4.3 release notes](https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release). Where the docs and the broker disagreed, the broker's behaviour is listed. The v0.1 test suite in `test/broker-facts/` will check these on each new RabbitMQ release.

## Consumer timeout

- Classic queues no longer time out consumers. `x-consumer-timeout` is rejected on them.
- Quorum queues send `basic.cancel` when a consumer's timeout passes. The channel stays open, the Messages become ready again, and later acks or nacks of their delivery tags are silently ignored.
- If the client has already cancelled its own consumer while still holding deliveries, the quorum timeout still fires, but as a channel close (`406 PRECONDITION_FAILED`), not `basic.cancel`. The Messages return in their original order with only `x-acquired-count` increased. Until then, a passive declare still counts the cancelled consumer. Classic queues never time out a cancelled consumer.
- On quorum queues the timeout can be set by consumer argument, queue argument or policy (`consumer-timeout`). The consumer argument wins.
- The management API's `/api/consumers` `consumer_timeout` field does not reflect the consumer argument, and is shown for classic consumers too.

## Exclusivity

- Exclusive consume is honoured on classic queues and silently ignored on quorum queues.
- Single-active-consumer works on both, but only as a queue argument at declaration; policies cannot set it.

## Delivery counting (quorum queues)

| How the Message is returned | `x-delivery-count` increases |
|---|---|
| `nack` with requeue | No |
| `reject` with requeue | Yes |
| Channel or connection closed with the Message unacknowledged | Yes |
| Consumer timeout | No |
| `basic.recover` | No |

- `x-acquired-count` increases on every return.
- The default `delivery-limit` is 20 and is shown as `delivery_limit` in the queue's management API details, not in its arguments.
- A Message past the limit is dead-lettered with reason `delivery_limit` if the queue has a dead-letter exchange, and dropped otherwise.
- Peeking with the management UI's "ack, requeue" increases only `x-acquired-count`.
- Classic queues only set the `redelivered` flag.

## Dead-lettering headers

- `BCC` is removed on publish. `CC` survives dead-lettering, even when `x-dead-letter-routing-key` is set.
- Republishing a dead-lettered Message with its `CC` header delivers copies to the `CC` queues again.
- A client-supplied `x-death` reaches consumers untouched. When the Message is dead-lettered again, the broker discards it and starts a new history (`count: 1`, new `x-first-death-*`).

## Dead-letter set-up

- A queue whose dead-letter exchange does not exist drops the Messages it dead-letters.
- A dead-letter queue with a message TTL and no dead-letter exchange of its own drops Messages once they expire.
- A dead-letter queue with a length limit and the default `drop-head` overflow drops its oldest Messages when full, unless it has a dead-letter exchange of its own.
- A queue that expires (`x-expires`) is deleted with its Messages, which are not dead-lettered even when it has a dead-letter exchange.
- The default quorum dead-letter strategy is `at-most-once`: a Message dead-lettered to an exchange that routes it to no queue is dropped. With `at-least-once` (which needs `reject-publish` overflow) the queue keeps it, not ready, and retries.
- A dead-letter exchange that routes the dead-letter routing key to no queue drops the Message, on classic and quorum queues alike. A binding added afterwards gets nothing.
- An alternate exchange on the dead-letter exchange saves the Message: it reaches the alternate exchange's queues.

## Re-dead-letter time

Replay rules measure a Message's back-off from its most recent dead-lettering, read from `x-death`.

- A Message republished with `x-death` removed (as Replay does, ADR 0005) and dead-lettered again carries a single fresh `x-death` entry (`count: 1`) whose `time` is the new dead-lettering, not the first one.
- `x-death` `time` is an AMQP timestamp: whole seconds since the epoch.

## Canary watch

Canary Replay watches for a Canary that dies again without consuming from the dead-letter queue, through a queue of its own bound to the dead-letter exchange.

- A queue bound to a dead-letter exchange with the same binding as the dead-letter queue receives a copy of a Message dead-lettered there, with `x-volveran-replay-id` intact, and the dead-letter queue still receives its own copy. This holds for direct, fanout and topic dead-letter exchanges, from classic and quorum source queues.

## Watch queue lifetime

- An exclusive, auto-delete queue declared on a connection disappears when that connection closes, whether the client closes it or the socket drops.

## Publishing

- Publishing to a missing exchange closes only that channel (`404 NOT_FOUND`). Other channels on the connection keep their unacknowledged deliveries.
- With publisher confirms and `mandatory`, an unroutable Message gets `basic.return` (`312 NO_ROUTE`) and then a confirm (`ack`), not a `nack`.

## Queue counts

- Management API counts lag a confirmed publish by roughly 4–9 seconds. The API can also show 0 consumers on a quorum queue that has one.
- A passive `queue.declare` returns exact counts at once. Its `message_count` counts ready Messages only, not unacknowledged ones.

## Publish counter

Depth history cannot read arrivals from a dead-letter queue's `message_stats.publish`, because the broker does not count dead-lettered Messages there. So Volverán reports **estimated arrivals**: the positive depth change between Samples plus the Messages Volverán itself took out in between, from Audit Entries. If a RabbitMQ release starts counting them, the first fact below fails in the weekly latest-broker run, and this choice can be revisited. "Broker restart" below means `rabbitmqctl stop_app` then `start_app`, with the broker's statistics at their default 5 s interval.

- Dead-lettering does not count in the receiving queue's `message_stats.publish`: on classic and quorum queues, for rejected and expired Messages, through the dead-letter exchange directly or through an exchange-to-exchange binding, the Message adds to the depth and the counter stays absent. Only a client's publish counts.
- A client's publish shows in `message_stats.publish` within about 5 seconds of its confirm, one statistics interval.
- A queue with no traffic yet reports no `message_stats` at all, rather than a zero count.
- Deleting and re-declaring a queue resets its `message_stats.publish`, so a reading can be lower than the previous one.
- A broker restart resets `message_stats.publish`, so a reading can be lower than the previous one. Durable Messages keep the queue's depth across it.

## Prefetch

- A new prefetch (`basic.qos`, global or not) does not apply to a consumer that already exists, on classic or quorum queues.
- A new consumer on the same channel, after one holding deliveries was cancelled, gets the next ready Messages in queue order.

## Order after a return

- Classic queues put a returned Message back in its original position.
- Quorum queues put returned Messages ahead of newer ones, in the order they were returned.

## Credentials

- `update-secret` is accepted even with a wrong password on the internal authentication backend. The OAuth 2.0 backend does re-check the new secret; see "OAuth 2.0 tokens".

## OAuth 2.0 tokens

Observed on a broker with the OAuth 2.0 backend only (`auth_backends.1 = rabbit_auth_backend_oauth2`), `resource_server_id` `rabbitmq` and the provider's signing key configured statically (`auth_oauth2.signing_keys`: RabbitMQ refuses to start with an `http` `jwks_url`). Tokens carry `aud: rabbitmq` and scopes such as `rabbitmq.read:*/*` and `rabbitmq.tag:management`. With no `auth_oauth2.issuer` configured, the broker does not check the token's `iss`. These facts are the gate for connecting with the Operator's own token (ADR 0008).

- A connection opened with a valid access token as its password works. The broker user is the token's `sub`, whatever user name the client sends. An invalid token is refused at connection open.
- `update-secret` with a refreshed access token for the same user is accepted, and the connection then outlives the old token's expiry.
- `update-secret` with an invalid token, an expired token or another user's token is refused: the broker closes the whole connection with `530 NOT_ALLOWED`.
- A connection whose token expires without a refresh is closed by the broker at the token's expiry, with `320 CONNECTION_FORCED` "credential expired".
- The management API accepts the access token as a bearer token, and refuses an expired one with 401.
- The management API refuses a token without a `tag:management` scope with 401 and the reason "Not management user", on every endpoint.
- A token without read permission on a queue is refused `403 ACCESS_REFUSED` on consume and get, and the broker closes the channel. A passive declare of the queue (`checkQueue`) still succeeds.
- A token without configure permission on a queue is refused `403 ACCESS_REFUSED` on declaring it, and the broker closes the channel.
- A token without write permission on an exchange is refused `403 ACCESS_REFUSED` on publishing to it (`amq.default` for the default exchange). The broker closes the channel: the publish confirm fails with only "channel closed", and the channel's error carries the refusal, naming the exchange and the permission.
