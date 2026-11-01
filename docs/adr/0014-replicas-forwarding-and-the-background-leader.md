# Several Replicas: forwarding and the Background Leader

This ADR supersedes [ADR 0003](0003-single-replica-on-kubernetes.md). What it means for someone running several Replicas is in the [guide](../replicas.md).

## Forwarding

A Checkout's held Messages live in one process's AMQP connection and cannot move, so a request reaching another Replica has to go to that one. A load balancer sends requests anywhere, so the Replica that takes one forwards it.

**Forwarding, not sticky sessions.** Stickiness cannot serve an approver who is not the requester, since their browser holds its own session to some other Replica, and it would lose everyone on a pod when that pod goes.

**Registration in the audit store.** Each process registers a new Replica id with its address and a lease, and each Checkout gets a Live Checkout record naming its owner. The record is routing information: held Messages and Decisions stay in the owner's memory. A route opts in with `toOwner`, so only Checkout routes forward; the Replica that takes a start becomes the owner, with the Operator's live token.

**A separate internal port at the pod's address.** It is plain HTTP and streams, so an export is not buffered. The same app serves it, through `app.routing`, so owner and Role checks run on the owner. It sends the shared secret and the Operator's identity with the session's id, and no token crosses. Only the internal listener can make a request count as forwarded, so those headers mean nothing on the web port. Without `VOLVERAN_FORWARDING_SECRET`, in Team Mode on PostgreSQL, nothing registers, so a single Replica needs no new secret.

**The chart gives each pod its address** from `status.podIP` through the downward API. The chart's headless Service only names the pods; nothing resolves it, since the store has the addresses, and a pod that has lost its DNS entry may still own Checkouts. An IPv6 pod address is not written as the `[host]:port` that the setting needs, so a Replica refuses to start there; nobody has needed it or tested it.

**The internal port is closed by default, by a policy that cannot be turned off.** It accepts any identity from whoever holds the secret ([threat model](../threat-model.md), N4), so it must not be left open to a cluster because someone did not set `networkPolicy.enabled`. Three ways were weighed:

- Refusing `replicaCount` above 1 without `networkPolicy.enabled`, or turning that value on with it. Rejected: the policy that value renders admits nothing to the web port unless `ingressFrom` is set, so scaling up would cut off the Gateway, and the engineer asked for neither.
- A value to opt out. Rejected: nothing needs it, since a policy of one's own adds to this one rather than fights it.
- With several Replicas, always rendering the one NetworkPolicy object, which only other pods of the release may pass on the internal port. Chosen. NetworkPolicy can only list what is allowed, so with `networkPolicy.enabled` false the same object lists the web and metrics ports as open to all, which is what they were with no policy. Scaling up changes who reaches the internal port and nothing else.

`extraEnv` may not set the forwarding variables, on one Replica either, so the port cannot be opened beside this. This relies on a CNI that enforces NetworkPolicy, which the chart cannot check, and it says so in the install notes and the guide. Egress does not need the same care unless the engineer restricts it, and then the chart adds the rule between Replicas, since otherwise forwarding would fail only once a Checkout is on another pod. That rule uses the port number, because not every CNI resolves a named port on egress.

**One Replica on any store renders as it did,** but for the profiles file's format version. Recreate, no internal port, no secret, no budget, and no policy unless asked for: an upgrade must not open anything unasked. The format version changes the ConfigMap's checksum, so the upgrade to 1.0 rolls the pod once and ends open Checkouts; the alternative was a warning at every start for as long as the set-up lasted.

**A rolling update with `maxUnavailable: 0`, and a budget of one.** The replacement is ready before a pod is told to stop, so one always serves. `ScheduleAnyway` spreads pods without leaving a Replica unscheduled on a small cluster.

## When an Owner Replica goes

**A live lease that cannot be reached is not a loss.** The request answers 503 `replica_unreachable` with `tryAgain`, and nothing is reported lost. A Replica's lease is renewed every 5 s and holds for 15 s.

**A lease that has run out is a Lost Checkout.** Any Replica asked about the Checkout then answers for it from its Live Checkout record, through the same routes and owner and Role checks as an owner answering for a Checkout that is over. So a route that forwards needs nothing more for this. A record saying the Checkout had ended stays ended.

**The lease and the Messages do not move together.** The socket of a killed process drops at once. A lost host's connection holds the lock queue and Messages for about three heartbeats ([RabbitMQ behaviour](../rabbitmq-behaviour.md#dead-connections)), so AMQP connections ask for a heartbeat of 5 s: about 15 s, against about three minutes at the broker's default. A Lost Checkout's reason says the queue can stay locked until then, rather than that the Messages are back. A profile's `amqpUrl` may name its own `heartbeat`, which then holds, and the wait with it.

**A Replica whose lease runs out ends its Checkouts through Keep.** It may be alive and only cut off from the store, or have stalled. The others no longer forward to it, so it must not go on holding the queue, and a renewal must not bring the Checkout back. Keep needs only the broker, so the Messages go back with no delivery counted and none dropped, in the same way as at shutdown; the Checkout ends with the reason `lease-ran-out`. An Apply attempts no further step. So a store outage longer than a lease costs the Checkouts of every Replica, but no Delivery Budget. While that record cannot be written, another Replica that can read the store but not this one reports a Lost Checkout from what it knows, including the warning about a delivery: it cannot tell a Replica cut off from one that died. A connection already gone, as after a long stall, has returned its Messages the abnormal way, and that Checkout is lost.

**The Background Leader clears up.** Audit Entries left `pending` by a gone Replica's Checkouts become `uncertain`, since the step may or may not have happened; `done` means settled, and a Message with no entry never left the queue. The lease and records are removed once they have been readable as long as a Checkout that is over (15 minutes).

**The token refresh lock is the one lock held across a call out of the store** ([ADR 0013](0013-audit-store-interface.md)). It is an advisory lock on the session's id, so signing out, the sweep and a move of the idle expiry do not wait for a provider, and a session removed meanwhile is not brought back. A provider that does not answer in 10 s counts as a failed refresh, tried again; if it did act on the request, a rotating refresh token may be spent, and the Operator signs in again.

**Sessions are shared only on PostgreSQL.** They live in its tables, with tokens sealed. On SQLite they are in memory (ADR 0013), as a single Replica needs no more.

**A Replica that shuts down leaves its records.** It ends its Checkouts, writes why (`shutdown`) and then ends its lease at once, without removing anything. The others find the lease over and the record `ended`, and so answer for it as above, saying why it ended, rather than `checkout_not_found`. The Background Leader removes the lease and records after the same 15 minutes. If the store could not be written, the record still says `active`, and it is reported as a Lost Checkout, which is as much as is known.

## The Background Leader

Some work must run once however many Replicas there are: retention, the sampler and Alerts now; Replay Rule scheduling after them. One Replica at a time, the Background Leader, runs all of it. One leader for everything was chosen over a lease per job because it is much simpler and the load is small.

**A lease row in the audit store, with no Kubernetes API access.** So the chart needs no RBAC, and the pod keeps `automountServiceAccountToken: false`, and it works outside Kubernetes too. Every Replica claims the lease every 5 s (`LEADER_RENEW_MS`); a claim lasts 15 s (`LEADER_LEASE_MS`). The leader's claims renew it, and the others take it once it has expired or been given up.

**The stated time.** After a leader goes silently, another holds the lease within 20 s (`LEADER_TAKEOVER_MS`, a lease plus a renewal). A leader that shuts down stops its jobs and gives the lease up first, and it moves within 5 s. Work is at-least-once across a change: a job in progress when the leader dies may run again, and a notification in flight may be sent twice.

**A holder is one process, not one Replica's name.** Each start gets a new random holder, so a restart is never taken for the process it replaces.

**Fencing, because a lease alone does not stop a stalled leader.** A process that stops for 30 s and wakes up does not know it lost the lease. So each change of hands raises a term, and a job's writes name the holder and term (`LeaseFence`). The store checks them as part of the write, in its transaction: on PostgreSQL the check keeps the lease row locked until the commit, so a claim taking the lease waits for that write to finish, and any later write of the former leader is refused with `LeaderLeaseLost`, having done nothing. The fence does not depend on anyone's clock. A fenced write delays a renewal by as long as it runs, so it must stay well short of the lease. A local timer also stops the jobs when a renewal has not succeeded by the time the lease runs out; that is only tidiness, since fencing is what is safe.

**Clocks.** Expiry compares the time of the Replica that claimed with the time of the one claiming now, so a clock running ahead by more than a lease can take the lease early. Fencing keeps that safe, and the cost is a needless change of leader: keep the Replicas' clocks in sync. The time comes from the Replica rather than the database so that tests can inject it, like the sampler's and the rule scheduler's.

**On SQLite the lease is in memory.** One Replica needs no more, and a row on disk would make a restart after a crash wait for its own old lease. So a single Replica on SQLite is simply its own leader, at once.

**Moving work onto the leader.** Add a `LeaderJob` to the list in `server.ts`. Its `start(fence)` may be called again after `stop()` in one process, so it must hold no state that assumes one start. `start` may do a first run before it answers: startup waits for it, while renewal does not. Writes that must not come from a former leader take a `fence` parameter on their store method, with a test in the contract suite ([ADR 0013](0013-audit-store-interface.md)); PostgreSQL's implementation runs in `fenced`, and SQLite's calls `check` right before writing. A job treats `LeaderLeaseLost` as no failure: it wrote nothing, and the leader will find out at its next claim.

**Alerts, at least once.** A leader stores an evaluation's result and its notifications in one fenced write, and only then sends them, so a stalled former leader sends nothing for a result the store refuses. A notification is forgotten when its delivery has ended, delivered or out of attempts. One still there when a new leader starts is sent again: that may be twice, and it is never lost to a change of leader. Storing them is why a firing Alert need not be sent again to be safe. On SQLite they are in memory, like the lease, so a single Replica keeps what it has always done: a crash between storing and sending loses that notification, and a restart sends nothing again.

## Replay Rules on the leader

Measured first (#118): a pass the lock queue refuses is recorded `skipped`, touches nothing, does not pause the rule, and its next pass counts from the skip. A refusal by permissions, 403, is another thing: the rule pauses with `lock_not_permitted`. Across Replicas a second pass of a rule is refused sooner, by the Operator claim on the Live Checkout records, and is also `skipped`. A pause used not to reach a pass in progress at all, which Replayed every due Message, and a resume through another Replica left the first with no next pass.

**A pass is not moved or fenced once begun.** It is a Checkout, owned by the Replica that started it, so it finishes there and is recorded there even if the lease moves. Stopping the job does not wait for it, so with several Replicas a shutting-down leader gives up the lease before the pass's Messages come back. Its writes (the pass, first-seen times, the count of the automatic stop, an automatic pause) state what happened, so they are not refused from a former leader. What is fenced is starting one: a scheduled pass first clears the rule's next pass under the fence. A new leader's pass, meanwhile, meets the Operator claim or the lock queue, and is skipped.

**A pause is written where it arrives, and the leader is told.** So it works with the leader gone. The store settles it (`pause` and `resume` answer whether they changed anything), so two at once on two Replicas are one Audit Entry and one 409. A pause stops a pass that began before it, at the next step, as an Operator's stop does. The notice over the internal port is only for speed: it can be lost, and the pass may be a former leader's. So whatever runs the job or a pass also reads the store every 5 s (`RULE_STATE_CHECK_MS`).

**A last pass's automatic pause alerts from the next leader.** With several Replicas, a pass that pauses its rule after its leader has stopped finds Alerting stopped too, because a former leader must not write Alert state. The pause is in the store, so the new leader's next Sample fires the Alert. A single Replica (no `VOLVERAN_FORWARDING_SECRET`) has no next leader, so at shutdown it waits for its passes before it stops the leader, and its last pause notifies if the delivery finishes in time.

**A stopping Replica gives deliveries a bounded wait.** On every Replica, `notifier.close()` waits up to 5 s (`CLOSE_WAIT_MS`) for deliveries in progress, then ends them and logs a warning: without it a delivery just begun was cut short, and a destination that never answers must not hold shutdown. On PostgreSQL one cut short stays unsent and the next leader sends it, which may be a restart of a single Replica. On SQLite it is lost, since what is unsent is in memory and the Alert is stored as firing. The wait comes before Checkouts end, so it can delay their Messages' return by up to 5 s.

**Others read the next pass from the store,** since the timer is on the leader alone. To find the leader, its lease's holder is its Replica id, whose lease has the address. Run now is forwarded there, and answers 503 `replica_unreachable` when it cannot be reached: nothing has run.

## Restore

A Message must not be republished twice by two clicks on two Replicas, so the guard is one store method, `claimRestore`: it writes the Restore's `pending` Audit Entry unless an earlier Restore of that Discard is anything but `failed`. PostgreSQL holds the Discard's row for the transaction. That needs no migration, where a unique index could refuse a store that already holds two Restores of one Discard. A Restore that crashed before reporting back keeps the body, as it does on one Replica: republishing again could duplicate the Message. Its `pending` entry names no Checkout, so nothing can tell its Replica went: once it is over two minutes old, the next try settles it to `uncertain` and answers 409 `restore_interrupted`. There is no republish and no override.

"Is this Discard still running" asks the Live Checkout records as well as this process: a record that is `active` or `applying` under a live lease refuses the Restore. A Replica that has lost its lease cannot finish the step, so its record no longer counts.

## Consequences

- Gauges of shared state are exported by the leader alone, so that a sum across Replicas is right, and a Replica that does not lead does not read them from the store. A former leader's sampler keeps its snapshot, which is not shown. During a takeover they are absent, and a stalled leader can briefly export alongside its successor: both are visible in `volveran_background_leader`.
- Shutdown (#119) stops background work and ends Checkouts side by side, with every port still serving, so the lease moves without waiting for Messages to return.
- A job failing to start is logged and the leader stays leader without it, trying it again at each claim until it starts. A job that should not run without another must say so itself. A job marked `mustStart`, such as the sampler, instead fails startup if it fails on the process's first claim, as it always has on a single Replica; a Replica that takes over later is already serving, so it only retries.
- Alerting does not sit out a term over a failed start, because it is what tells people about problems: it runs anyway, and first retries what the start could not do. It is `mustStart`, so a Replica that fails it while starting up fails its startup, as one always has, and the lease moves.
- Only the leader reads the broker for Samples. The Messages taken out in estimated arrivals come from Audit Entries in the store, so they count every Replica. A failover leaves no runs for a while, which the history view shows as a gap once runs are more than 1.5 intervals apart, and the next Sample compares with the last stored one, counting what was taken out in between. At the default interval a quick takeover (a minute and 20 s at most, if the leader had just run) stays inside 1.5 intervals and shows no gap, because none was missed.
