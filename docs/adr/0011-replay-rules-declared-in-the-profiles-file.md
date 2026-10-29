# Replay rules are declared in the profiles file

Replay rules are the first time Volverán acts on the broker with no person at the keyboard: a rule Replays the matching Messages of one dead-letter queue on its own, pass after pass. A rule is declared in the profiles file, under its Broker Profile (`replayRules`), and nowhere else: the web app and the API show rules and run a pass on demand, but cannot create or change one. The file is already where a team reviews and versions everything Volverán may do to a broker (credentials, Protected Profiles, roles, Replay Rates), and in a Kubernetes deployment it arrives through the chart and GitOps. A rule therefore gets the same review as any other change that lets Volverán touch a broker, and its history is the history of the file.

The safety of a rule rests on four things, each a decision of its own:

- **The review of the profiles file is the safety gate.** A Rule Pass bypasses Approval and typed confirmation by design: there is nobody to ask, and the reviewer of the rule already gave the second pair of eyes for every pass it will run. This is why rules are allowed on Protected Profiles too. Startup logs one line per rule on a Protected Profile, so the choice stays visible. A rule needs credentials of its own, so a profile that connects with the Operator's token (`credentials: operatorToken`, ADR 0008) cannot have one: startup refuses it.
- **Attempts are counted from Died Again.** A Message's attempts are its Died Again count, followed back through the Audit Entries by its replay id. Nothing is kept per Message on the side: the count survives a restart, includes Replays by people and by other rules, and cannot drift from what the Audit Entries say happened. The back-off before attempt n is `min(initial × multiplier^n, max)`, measured from the most recent `x-death` time, else the Failure Details' fault time.
- **An automatic stop is required.** `stopWhen: { diedAgain, within }` has no default and no way to turn it off: a rule pauses itself when too many of the Messages it Replayed come back, so a broken consumer is not fed the same Messages again and again. `maxAttempts` (at most 100) bounds what one poison Message can cost.
- **A pass is an ordinary Checkout.** Each pass takes a Checkout of the rule's queue through the same path as an Operator (ADR 0006): the same in-process lock and lock queue, the same collection limits (capped by the rule's `maxPerPass`), the same Keep that uses no Delivery Budget and keeps the order, and the same Apply executor (ADR 0001, ADR 0009) at the rule's Replay Rate. The pass acts as the Operator `Replay rule <name>` (id `rule:<profile>/<name>`) with the role `operator`, connecting as the profile's broker user, and its Replays are ordinary Audit Entries that also record the rule and the pass. A rule and a person never act on the same queue at once, and when a person holds the queue, a pass does not wait for them.

## Considered Options

- **Rules created and edited in the web app, stored in the audit store**: rejected for now; it needs its own review flow to be as safe as a reviewed file, and splits Volverán's configuration across two places.
- **Rules only on unprotected profiles, or an Approval per pass**: rejected; an Approval nobody is awake to give stops the rule, and on a Protected Profile the review of the file is the stronger check. If allowing rules on Protected Profiles proves too permissive, a per-profile `allowReplayRules` switch is a cheap later addition.
- **Counting attempts in rule state**: rejected; it would forget attempts on a reset, miss Replays made by people, and disagree with the Audit Entries.
- **A separate consumer for rules, outside the Checkout**: rejected; it would need its own exclusivity, its own return order and its own Delivery Budget handling, all of which the Checkout already gets right on RabbitMQ 4.

## Consequences

- Changing a rule needs a change to the profiles file and a restart; a rule removed from the file stops at the next restart, while its Audit Entries stay.
- A pass looks only at the Messages at the head of the queue, up to its limit; a long run of Messages it Keeps at the head can delay the ones behind them to a later pass.
- During a pass the queue list and the "held by" answer name the rule (`Replay rule <name>`), so an Operator knows why a Checkout is refused and that it will end soon.
- Audit Entries gain `rule` and `rule_pass_id`, and audit search gains `rule`.
