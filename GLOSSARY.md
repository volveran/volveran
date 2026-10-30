# Volverán

A tool for inspecting the Messages in RabbitMQ dead-letter queues and deciding, Message by Message, which to Discard, which to Replay to where they came from and which to Move elsewhere.

## Brokers

**Broker Profile**:
A named set of connection details for one RabbitMQ broker (e.g. dev, staging, prod).
_Avoid_: Connection, environment, cluster

**Protected Profile**:
A Broker Profile on which every Apply that changes where a Message ends up, and every Restore, needs a typed confirmation. In Team Mode such an Apply also needs an Approval, unless the profile sets `requireApproval: false`.
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
Carrying out all the Decisions of a Checkout against the broker, confirmed once. It runs in the background, one Message at a time, and ends the Checkout. It can be stopped part way, and can start with a Canary; either way, every Message not yet attempted falls back to Keep.
_Avoid_: Commit, execute, submit

**Replay Rate**:
The most Messages per second an Apply (or a Rule Pass) publishes: its Replay and Move steps start at least 1/rate apart, while Discards are not slowed down. A Broker Profile can set a default and a maximum, and each Replay Rule has its own; without a rate an Apply runs as fast as the broker confirms.
_Avoid_: Throttle, speed, QPS

**Replay Rule**:
A declaration, in the profiles file, of which Messages in one dead-letter queue Volverán Replays automatically, how often and how many times: a filter, a back-off between attempts, an attempt limit counted from Died Again, and a required automatic stop. A rule that stops itself, or that an Operator pauses, stays paused until an `admin` resumes it. In prose, "Replay rules" (lower-case r) names the feature and the view.
_Avoid_: Policy (reserved for RabbitMQ policies), automation, job, retry rule

**Rule Pass**:
One run of a Replay Rule: a short Checkout taken as the rule, the Replays of the matching Messages that are due, at the rule's Replay Rate, and its end, which Keeps the rest (or Moves the Messages whose attempts are used up, when the rule says so). A pass is skipped while someone else holds the queue.
_Avoid_: Tick, cycle, run

**Canary**:
The one Replay an Apply carries out alone before the rest, watched for the Watch Window. The Operator then continues with the rest or stops, and everything left falls back to Keep.
_Avoid_: Test Message, probe, pilot

**Watch Window**:
How long Volverán watches for a Canary that dies again, through a queue of its own bound to the dead-letter exchange (it never reads the dead-letter queue). Set per Broker Profile.
_Avoid_: Timeout, grace period

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
Sending a Message back to the queue it was dead-lettered from (its most recent `x-death` entry, else the MassTransit input queue), so that only the consumer that failed sees it again.
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

**Failure Details**:
The exception and context a client framework (Spring AMQP, MassTransit) writes into a Message's headers when it gives up on it: the exception type and message, the stack trace, the consumer, the time and the original queue or exchange.
_Avoid_: Error info, fault (except in MassTransit's own header names)

## Accountability

**Operator**:
The person using the tool: the signed-in identity in Team Mode, or the name they configured in Solo Mode. Recorded alongside the Broker Profile's broker user, which is often a shared service account, or the Operator themself on a profile that connects with their own token (`credentials: operatorToken`). For the actions a Rule Pass takes, the Operator is the Replay Rule (`Replay rule <name>`); its Audit Entries name the rule.
_Avoid_: User, who, actor

**Role**:
What an Operator may do on one Broker Profile: `viewer` (look), `operator` (triage) or `admin` (also Restore). Each one includes the ones before it. In Team Mode it comes from the Operator's groups and the profile's `roles`; in Solo Mode the Operator is `admin` everywhere. The role `operator` is written in code format, so it reads apart from the Operator, the person.
_Avoid_: Permission, access level

**Approval**:
A second Operator's consent, after reviewing its Decisions, to an Apply on a Protected Profile. In Team Mode, an Apply with any Decision other than Keep on a Protected Profile waits for it (unless the profile sets `requireApproval: false`); approving runs the Apply, and its Audit Entries record both people. Rejecting, with a reason, returns the Checkout to staging; withdrawing it or the Checkout ending cancels the request.
_Avoid_: Sign-off, review, four-eyes (four-eyes may describe the feature in prose)

## Alerting

**Alert Destination**:
Where notifications go: a Slack incoming webhook, a Microsoft Teams workflow webhook or a generic webhook, declared once in the profiles file. Its URL and signing secret come from environment variables.
_Avoid_: Channel, receiver, sink, notifier

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
