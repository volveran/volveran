# Replay targets the queue that dead-lettered the Message, with dead-letter headers removed

"Send it back where it came from" sounds like publishing to the original exchange and routing key, but that re-routes the Message to every queue bound to that key, including queues whose consumers already processed it successfully. A `CC` header that survives dead-lettering adds more copies. So Replay publishes through the default exchange to the queue named in the most recent `x-death` entry, and only the consumer that failed sees the Message again. Re-routing through an exchange is still possible as a Move target the Operator names explicitly.

Replay, Move and Restore also remove `CC`, `BCC`, `x-death`, `x-first-death-*`, `x-last-death-*`, `x-delivery-count` and `x-acquired-count`, and add `x-volveran-replay-id` and `x-volveran-from`. RabbitMQ 4.4 passes a client-supplied `x-death` to consumers untouched, which misleads consumers that count retries from it, and discards it the next time the Message is dead-lettered, so the history would be lost anyway. Each Audit Entry keeps the original headers instead, and the replay id links a Message that dies again to its earlier history.

## Considered Options

- **Original exchange and routing key**: rejected, it duplicates the Message to queues that already handled it.
- **Republish with all headers**: rejected, `CC` copies the Message to extra queues and consumers see stale `x-death` counts.
