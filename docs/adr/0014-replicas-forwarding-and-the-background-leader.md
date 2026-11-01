# Several Replicas: forwarding and the Background Leader

This ADR will supersede [ADR 0003](0003-single-replica-on-kubernetes.md) once the chart lets several Replicas run (#121). Until then, run exactly one.

## Forwarding

To be written with Replica registration and forwarding (#108, #121): a Checkout's held Messages live in one process's AMQP connection, so a request reaching another Replica has to go to that one.

## When an Owner Replica goes

**A live lease that cannot be reached is not a loss.** The request answers 503 `replica_unreachable` with `tryAgain`, and nothing is reported lost. A Replica's lease is renewed every 5 s and holds for 15 s.

**A lease that has run out is a Lost Checkout.** Any Replica asked about the Checkout then answers for it from its Live Checkout record, through the same routes and owner and Role checks as an owner answering for a Checkout that is over. So a route that forwards needs nothing more for this. A record saying the Checkout had ended stays ended.

**The lease and the Messages do not move together.** The socket of a killed process drops at once. A lost host's connection holds the lock queue and Messages for about three heartbeats ([RabbitMQ behaviour](../rabbitmq-behaviour.md#dead-connections)), so AMQP connections ask for a heartbeat of 5 s: about 15 s, against about three minutes at the broker's default. A Lost Checkout's reason says the queue can stay locked until then, rather than that the Messages are back. A profile's `amqpUrl` may name its own `heartbeat`, which then holds, and the wait with it.

**A Replica whose lease runs out gives its Checkouts up.** It may be alive and only cut off from the store, or have stalled. The others already report its Checkouts lost, so it closes their connections and marks them lost itself: otherwise the report would be false, the queue would stay locked, and a renewal could bring a lost Checkout back. So a store outage longer than a lease costs the Checkouts of every Replica, at one delivery each on quorum queues.

**The Background Leader clears up.** Audit Entries left `pending` by a gone Replica's Checkouts become `uncertain`, since the step may or may not have happened; `done` means settled, and a Message with no entry never left the queue. The lease and records are removed once they have been readable as long as a Checkout that is over (15 minutes).

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

A Message must not be republished twice by two clicks on two Replicas, so the guard is one store method, `claimRestore`: it writes the Restore's `pending` Audit Entry unless an earlier Restore of that Discard is anything but `failed`. PostgreSQL holds the Discard's row for the transaction. That needs no migration, where a unique index could refuse a store that already holds two Restores of one Discard. A Restore that crashed before reporting back keeps the body, as it does on one Replica: republishing again could duplicate the Message.

"Is this Discard still running" asks the Live Checkout records as well as this process: a record that is `active` or `applying` under a live lease refuses the Restore. A Replica that has lost its lease cannot finish the step, so its record no longer counts.

## Consequences

- Gauges of shared state are exported by the leader alone, so that a sum across Replicas is right, and a Replica that does not lead does not read them from the store. A former leader's sampler keeps its snapshot, which is not shown. During a takeover they are absent, and a stalled leader can briefly export alongside its successor: both are visible in `volveran_background_leader`.
- Shutdown (#119) stops the leader before ending Checkouts, so the lease moves without waiting for Messages to return. Today's `onClose` already does this, as `leader.stop()` comes before `checkouts.endAll()`. Until Replay Rules are a job (#118) they stop before the leader, so that a last Rule Pass's pause still reaches Alerting; a running pass delays the lease that long.
- A job failing to start is logged and the leader stays leader without it, trying it again at each claim until it starts. A job that should not run without another must say so itself. A job marked `mustStart`, such as the sampler, instead fails startup if it fails on the process's first claim, as it always has on a single Replica; a Replica that takes over later is already serving, so it only retries.
- Alerting does not sit out a term over a failed start, because it is what tells people about problems: it runs anyway, and first retries what the start could not do. It is `mustStart`, so a Replica that fails it while starting up fails its startup, as one always has, and the lease moves.
- Only the leader reads the broker for Samples. The Messages taken out in estimated arrivals come from Audit Entries in the store, so they count every Replica. A failover leaves no runs for a while, which the history view shows as a gap once runs are more than 1.5 intervals apart, and the next Sample compares with the last stored one, counting what was taken out in between. At the default interval a quick takeover (a minute and 20 s at most, if the leader had just run) stays inside 1.5 intervals and shows no gap, because none was missed.
