# Replay rules

A Replay rule tells Volverán to Replay some of the Messages of one dead-letter queue on its own, pass after pass, without a person at the keyboard. Rules are declared in the profiles file under their Broker Profile (`replayRules`), so a change to a rule goes through the same review as any other configuration change ([ADR 0011](adr/0011-replay-rules-declared-in-the-profiles-file.md)). This page explains how a rule decides what to Replay, how it stops itself, and walks through three examples.

## How a rule runs

Every `every`, plus a few seconds of jitter, a running rule makes a **Rule Pass**:

1. It takes an ordinary Checkout of its queue as the Operator `Replay rule <name>`, connecting as the profile's broker user. If someone holds the queue, the pass is skipped (and recorded as skipped); it never waits.
2. For each Message it holds, it decides:
   - **replay**: the rule's `filter` selects it, it has attempts left, and its back-off delay has passed;
   - **used up**: the filter selects it, but its attempts are used up;
   - **not due**: the filter selects it, but its back-off delay has not passed yet (or the pass already has `maxPerPass` Messages to Replay);
   - **no match**: the filter does not select it.
3. It Replays up to `maxPerPass` due Messages at the rule's `rate`, Moves the used-up ones to the parking queue when `whenAttemptsUsedUp` says so, and Keeps every other Message in order.
4. It ends the Checkout.

Every Replay and Move is an Audit Entry naming the rule and the pass; search them with the **Rule** filter of the Audit view (`GET /api/audit-entries?rule=<name>`). The Replay rules view shows each rule's state, its next pass and its last 20 passes with their counts.

### Attempts and back-off

A Message's attempts are its **Died Again count**: how many times Volverán has sent it out (Replayed, Moved or Restored it, by any person or rule) and it came back to a dead-letter queue. The back-off before attempt n is `min(initial × multiplier^n, max)`, measured from:

1. the time of its most recent `x-death` entry (when the broker last dead-lettered it), else
2. the failure time in its Failure Details (Spring AMQP, MassTransit; see [Spring AMQP and MassTransit](spring-amqp-and-masstransit.md)), else
3. the time a pass of the rule first saw it (kept in the audit store by message id, at most 10,000 per rule).

**Attempts depend on the audit store.** Volverán recognises a Message that died again by its `x-volveran-replay-id` header, followed back through the Audit Entries. If the audit store is reset, or another Volverán instance with its own store sent the Message out, the attempts it cannot follow back count as one. Keep the audit store on a persistent volume when you use rules.

A Message with nowhere to Replay to (no Replay origin, for example a Spring AMQP Message) is Kept and counted as **Cannot Replay** in the pass. It does not pause the rule.

### Head-of-line limits

A pass looks only at the Messages at the head of the queue: it holds at most `maxPerPass` × 3 of them. If the head of the queue is a long run of Messages the rule Keeps (not matching, not due, used up and kept), the Messages behind them wait for a later pass, or for a person. Use a parking queue (`whenAttemptsUsedUp: { moveTo: … }`) so used-up Messages do not pile up at the head, and keep rules on queues that mostly hold the Messages they are for.

## Automatic stop, pause and resume

`stopWhen: { diedAgain, within }` is required. After each pass, the rule counts the Died Again Messages its passes saw within `within` whose last Audit Entry is one of this rule's Replays (each such Replay counts once, even when several passes see it). When the count reaches `diedAgain`, the rule pauses itself. It also pauses itself for problems that do not go away on their own:

| Reason | When |
| --- | --- |
| `died_again` | Too many of its Replays died again within `within`. |
| `queue_not_found` | Its queue does not exist. |
| `broker_permission_denied` | The broker refused its broker user a permission: reading the queue, or writing to the exchange a Replay or Move publishes to. |
| `lock_not_permitted` | Its broker user may not declare the Checkout lock queue (`^volveran\.`). |
| `publish_failed` | A Replay or Move of the pass failed to publish (for example, unroutable). |

A paused rule runs no scheduled passes and stays paused across restarts. The Replay rules view shows why it paused, who paused it (a person, or the rule itself) and when.

- **Pause** (`operator` or `admin`): from the Replay rules view, with a reason, or `POST /api/profiles/:profile/replay-rules/:name/pause` with `{ "reason": "…" }`. Use it during an incident to stop automatic Replay without a configuration change.
- **Resume** (`admin`): from the view, or `POST /api/profiles/:profile/replay-rules/:name/resume`. Resuming clears the automatic stop's count, so the rule starts with a fresh window.
- Pausing a paused rule, or resuming a running one, answers `409` (`replay_rule_paused`, `replay_rule_running`).
- **Run now** (`admin`) still runs one pass of a paused rule, so you can check a fix before resuming. A pass run that way can pause a running rule like any other.

Every pause and resume is an Audit Entry (`rule_pause`, `rule_resume`) with the rule, the Operator (the person, or `Replay rule <name>` for an automatic pause) and the reason. The Audit view's action filter selects them.

A rule declared with `startPaused: true` starts paused the first time Volverán sees it; after that the stored state wins, so a restart neither resumes a paused rule nor pauses a running one.

## Example: a transient database error, with back-off

The orders service dead-letters Messages when its database times out. Once the database recovers, a plain Replay works. Replay those Messages, and only those, with a growing delay:

```yaml
replayRules:
  - name: db-timeouts
    vhost: /
    queue: orders.dlq
    filter: { kind: failure, value: SQLTimeoutException }
    every: 5m
    rate: 5
    backoff: { initial: 2m, multiplier: 2, max: 1h }
    maxAttempts: 5
    stopWhen: { diedAgain: 20, within: 30m }
```

For a Message dead-lettered at 10:00 (with no Died Again yet), the rule waits 2 minutes, so the 10:05 pass Replays it. If it dies again at 10:05, attempt 1 waits 4 minutes from then, and so on: 8, 16 and 32 minutes. After 5 attempts the rule Keeps it, and the Message row shows that the rule has given up on it. Messages that failed for any other reason are never touched. For a queue whose consumer dead-letters through the broker rather than through a framework, select with `{ kind: x-death-reason, value: rejected }`, a header or a JSON path instead.

## Example: a parking queue

Used-up Messages that stay at the head of the queue slow down every pass (see Head-of-line limits). Move them to a parking queue a person looks at:

```yaml
replayRules:
  - name: payment-retries
    vhost: /
    queue: payments.dlq
    every: 1m
    backoff: { initial: 30s, max: 10m }
    maxAttempts: 3
    whenAttemptsUsedUp: { moveTo: { queue: payments.parked } }
    stopWhen: { diedAgain: 30, within: 15m }
```

Create `payments.parked` first: a Move to a queue that does not exist cannot be routed, and the rule pauses with `publish_failed`. Each Move is an Audit Entry naming the rule, with the original headers. Its broker user needs write permission on the exchange it publishes to (the default exchange for a queue).

## Example: an automatic stop

The payments consumer was redeployed with a bug, so every Message it gets is dead-lettered again. The rule from the previous example has `stopWhen: { diedAgain: 30, within: 15m }`:

- 12:00: a pass Replays 25 Messages. They all die again within seconds.
- 12:01: the next pass sees those 25 Died Again Messages, whose last Audit Entry is this rule's: 25 in the last 15 minutes, below 30, so it Replays the ones that are due again (their back-off has passed).
- 12:02: it sees 25 more from the 12:01 pass: 50 in the window. The rule pauses with reason `died_again`, records a `rule_pause` Audit Entry with `Replay rule payment-retries` as the Operator, and runs no more passes.

Messages someone Replayed by hand, or another rule Replayed, do not count towards this rule's stop. Once the consumer is fixed, an `admin` can Run now once to check, then Resume, which starts the count again from zero. Pick `diedAgain` below what one or two passes can Replay (`maxPerPass`), so a broken consumer stops the rule within a pass or two.

## Being told when a rule pauses

An Alert Rule with `replayRulePaused: true` sends a notification, with the reason, when a Replay Rule pauses, and another when it resumes, and the metric `volveran_replay_rule_paused` shows the same to Prometheus. See [Observability](observability.md#alert-rules).
