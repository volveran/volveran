# Replay origin from framework headers

Amends [ADR 0005](0005-replay-targets-the-dead-lettering-queue.md). Spring AMQP and MassTransit do not dead-letter through the broker: when a consumer gives up, the framework republishes the Message to an error queue itself, with headers describing the failure (the Failure Details) and no `x-death`. Under ADR 0005 alone these Messages had no Replay origin, so the teams on the two most common client frameworks could only Move them. ADR 0005's reason still holds: Replay must reach only the consumer that failed, never every queue bound to a routing key. So the Replay origin is, in order:

1. The queue of the most recent `x-death` entry. The broker's own record wins when a Message carries both `x-death` and framework headers.
2. Otherwise, the MassTransit input queue: the queue named by `MT-Fault-InputAddress`, when `MT-Reason` is not `skip`. MassTransit writes the address of the receive endpoint whose consumer faulted, so this is exactly the queue ADR 0005 asks for, reached through the default exchange like any Replay.
3. Otherwise, no Replay, with the reason.

A skipped MassTransit Message (`MT-Reason: skip`) is not Replayable: no consumer handled its Message type, so Replaying it would only have it skipped again. A MassTransit Message whose input address is missing or names no queue is not Replayable either; Volverán never guesses a destination.

A Spring AMQP Message is never Replayed. `RepublishMessageRecoverer` records only the exchange and routing key the Message was first published with (`x-original-exchange`, `x-original-routingKey`), not the queue that failed it, and publishing there is the re-routing ADR 0005 rejects. The reason names that exchange and routing key, and the Move prompt is prefilled with them (or with the queue, when it was sent through the default exchange), so re-routing stays the explicit choice of the Operator.

Replay, Move and Restore also remove the Failure Details headers: `MT-Fault-*`, `MT-Reason`, `MT-Host-*`, `x-exception-*`, `x-original-exchange` and `x-original-routingKey`, as well as the headers ADR 0005 already removes. A consumer would otherwise see a stale exception, and Volverán would read the old Failure Details again if the Message comes back for another reason. The Audit Entry keeps the originals. Died Again chains are unaffected: `x-volveran-replay-id` is added as before, and MassTransit keeps it when it moves the Message to `_error` again.

A Canary Replayed to a MassTransit input queue cannot be watched on a dead-letter exchange, because a fault never goes through one. Its watch queue is bound instead to the `_error` exchange MassTransit publishes the faults of that input queue to (`<input queue>_error`), with that exchange's bindings to the Checkout's queue. When that exchange is missing or has no such binding, the Canary is `unwatched`.

## Considered Options

- **Replay Spring AMQP Messages to their original exchange and routing key**: rejected, it duplicates the Message to every queue bound to that key, which ADR 0005 rejects.
- **Guess the Spring AMQP queue from the routing key or the error queue's name**: rejected, a guessed destination is worse than an explicit Move.
- **Keep the framework headers on republish**: rejected, the consumer would see a stale exception and Volverán stale Failure Details.
- **Watch a MassTransit Canary on the input queue's dead-letter exchange**: rejected, MassTransit faults never reach it.

## Consequences

- MassTransit `_error` queues can be Replayed and their Canaries watched like broker dead-letter queues; Replay rules Replay their Messages too.
- Spring AMQP Messages still need an explicit Move, now prefilled; a Replay rule counts them as failed and Keeps them.
- Header names are pinned to `RepublishMessageRecoverer` (spring-amqp) and `MessageHeaders` (MassTransit.Abstractions); a framework that renames them falls back to no Replay.
