# Volverán

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
An exclusive hold on the Messages at the head of one queue when it started (all of them, up to the Checkout limit), so the user can act on each one. Messages that arrive later, or lie beyond the limit, wait for the next Checkout. A Checkout has a time limit. Ending or losing a Checkout returns every Message that has no applied Decision to the queue.
_Avoid_: Session, lock, snapshot, browse

**Lost Checkout**:
A Checkout that ended without Volverán ending it, for example because the broker cancelled it. Its Messages are back in the queue and it can no longer be Applied.
_Avoid_: Expired, timed out, dead Checkout

**Delivery Budget**:
How many more times a Message on a quorum queue can be returned abnormally (a crash, a lost connection, a rejection) before the broker drops it or dead-letters it again.
_Avoid_: Retries left, delivery limit, attempts

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
Sending a Message back to the queue it was dead-lettered from, so that only the consumer that failed sees it again.
_Avoid_: Retry, requeue, resend, re-route

**Move**:
Sending a Message to a queue the user names, or to an exchange with a routing key the user names, then removing it from the source queue.
_Avoid_: Transfer, copy, shovel

**Keep**:
Returning a Message to its source queue unchanged at the end of a Checkout, without using up any of its Delivery Budget.
_Avoid_: Skip, requeue, ignore

**Died Again**:
Said of a Message that Volverán Replayed, Moved or Restored and that has been dead-lettered again, recognised by the replay id (`x-volveran-replay-id`) it carries. How many times it has died again comes from following the replay ids back through the Audit Entries.
_Avoid_: Repeat offender, recurring, boomerang

## Accountability

**Operator**:
The person using the tool: the signed-in identity in Team Mode, or the name they configured in Solo Mode. Recorded alongside the Broker Profile's broker user, which is often a shared service account.
_Avoid_: User, who, actor

**Role**:
What an Operator may do on one Broker Profile: `viewer` (look), `operator` (triage) or `admin` (also Restore). Each one includes the ones before it. In Team Mode it comes from the Operator's groups and the profile's `roles`; in Solo Mode the Operator is `admin` everywhere. The role `operator` is written in code format, so it reads apart from the Operator, the person.
_Avoid_: Permission, access level

## Running

**Solo Mode**:
The tool running for one Operator on their own machine, reachable only from that machine, with no sign-in.
_Avoid_: Local mode, dev mode, no-auth mode

**Team Mode**:
The tool running as a shared service that Operators reach over the network after signing in through single sign-on.
_Avoid_: Server mode, hosted mode, SSO mode

**Audit Entry**:
A record of one triage action: which Operator did it, as which broker user, when, on which Broker Profile and queue. For a Discard it includes a full copy of the Message.
_Avoid_: Log line, history

**Restore**:
Republishing a Discarded Message from its Audit Entry, by default back to the queue it was Discarded from.
_Avoid_: Undo, undelete
