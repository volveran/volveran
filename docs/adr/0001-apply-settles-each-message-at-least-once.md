# Apply settles each Message at-least-once, with no rollback

RabbitMQ cannot make "publish here + ack there" atomic, so Apply settles each Message on its own and always makes the destination durable before acking the held Message: Replay and Move publish with publisher confirms and `mandatory`, then ack; Discard writes the full Message to the audit store (fsync), then acks. A crash between the two steps leaves a duplicate (in the destination queue, or as an extra stored copy), never a loss. A Message whose settlement fails stays held, and Apply reports a per-Message outcome instead of rolling back the ones that succeeded.

## Considered Options

- **Ack first, then publish/store** (at-most-once): rejected, a crash loses Messages and Discard would not be recoverable.
- **Rollback on partial failure**: rejected, "un-publishing" a Replayed Message is impossible once a consumer has seen it.

## Consequences

- Downstream consumers may see a Replayed or Moved Message twice and should dedupe on `message_id`.
- Restore needs the stored copy to exist before the ack, which is why the audit store sits on the Apply path, not beside it.
