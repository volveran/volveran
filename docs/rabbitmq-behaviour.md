# RabbitMQ behaviour Volverán relies on

Observed on **RabbitMQ 4.4.0** (`rabbitmq:4-management`, October 2026) with AMQP 0-9-1 clients, and cross-checked with the [consumers](https://www.rabbitmq.com/docs/consumers) and [dead lettering](https://www.rabbitmq.com/docs/dlx) docs and the [4.3 release notes](https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release). Where the docs and the broker disagreed, the broker's behaviour is listed. The v0.1 test suite in `test/broker-facts/` will check these on each new RabbitMQ release.

## Consumer timeout

- Classic queues no longer time out consumers. `x-consumer-timeout` is rejected on them.
- Quorum queues send `basic.cancel` when a consumer's timeout passes. The channel stays open, the Messages become ready again, and later acks or nacks of their delivery tags are silently ignored.
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

## Publishing

- Publishing to a missing exchange closes only that channel (`404 NOT_FOUND`). Other channels on the connection keep their unacknowledged deliveries.
- With publisher confirms and `mandatory`, an unroutable Message gets `basic.return` (`312 NO_ROUTE`) and then a confirm (`ack`), not a `nack`.

## Queue counts

- Management API counts lag a confirmed publish by roughly 4–9 seconds. The API can also show 0 consumers on a quorum queue that has one.
- A passive `queue.declare` returns exact counts at once. Its `message_count` counts ready Messages only, not unacknowledged ones.

## Order after a return

- Classic queues put a returned Message back in its original position.
- Quorum queues put returned Messages ahead of newer ones, in the order they were returned.

## Credentials

- `update-secret` is accepted even with a wrong password on the internal authentication backend. Its behaviour with the OAuth 2.0 backend is not yet verified.
