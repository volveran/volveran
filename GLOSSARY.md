# Rmq Triage

A tool for inspecting the Messages in RabbitMQ dead-letter queues and deciding, Message by Message, which to Discard, which to Replay to where they came from and which to Move elsewhere.

## Brokers

**Broker Profile**:
A named set of connection details for one RabbitMQ broker (e.g. dev, staging, prod).
_Avoid_: Connection, environment, cluster

**Protected Profile**:
A Broker Profile on which every Apply that changes where a Message ends up, and every Restore, needs a typed confirmation.
_Avoid_: Prod mode, locked profile

## Triage

**Checkout**:
An exclusive hold on the Messages at the head of one queue when it started (all of them, up to the Checkout limit), so the user can act on each one. Messages that arrive later, or lie beyond the limit, wait for the next Checkout. Ending or losing a Checkout returns every Message that has no applied Decision to the queue.
_Avoid_: Session, lock, snapshot, browse

**Decision**:
The action the user has assigned to one Message in a Checkout: Discard, Replay, Move or Keep. Every Message is Keep until told otherwise, and a Decision that fails during Apply falls back to Keep.
_Avoid_: Action, mark, plan item, Undecided

**Apply**:
Carrying out all the Decisions of a Checkout against the broker in one step.
_Avoid_: Commit, execute, submit

**Message**:
A single RabbitMQ message, identified to the user by its `message_id`.
_Avoid_: Event, item, record

**Selection**:
The set of Messages within a Checkout that the user has picked to act on, chosen by hand or by a filter.
_Avoid_: Batch, filter result

**Discard**:
Removing a Message from its queue for good, keeping a full copy in its Audit Entry so it can be Restored. "Purge" is reserved for RabbitMQ emptying a whole queue, which this tool never does.
_Avoid_: Selective Purge, purge, delete, drop

**Replay**:
Sending a Message back to the exchange and routing key it was originally published to before it was dead-lettered.
_Avoid_: Retry, requeue, resend

**Move**:
Sending a Message to a queue the user names explicitly, then removing it from the source queue.
_Avoid_: Transfer, copy, shovel

**Keep**:
Returning a Message to its source queue unchanged at the end of a Checkout.
_Avoid_: Skip, requeue, ignore

## Accountability

**Operator**:
The person using the tool, as they named themselves in its configuration. Recorded alongside the Broker Profile's broker user, which is often a shared service account.
_Avoid_: User, who, actor

**Audit Entry**:
A record of one triage action: which Operator did it, as which broker user, when, on which Broker Profile and queue. For a Discard it includes a full copy of the Message.
_Avoid_: Log line, history

**Restore**:
Republishing a Discarded Message from its Audit Entry, by default back to the queue it was Discarded from.
_Avoid_: Undo, undelete
