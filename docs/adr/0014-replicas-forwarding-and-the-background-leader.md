# Several Replicas: forwarding and the Background Leader

This ADR will supersede [ADR 0003](0003-single-replica-on-kubernetes.md) once the chart lets several Replicas run (#121). Until then, run exactly one.

## Forwarding

To be written with Replica registration and forwarding (#108, #121): a Checkout's held Messages live in one process's AMQP connection, so a request reaching another Replica has to go to that one.

## The Background Leader

Some work must run once however many Replicas there are: retention now; the sampler, Alerts and Replay Rule scheduling after it. One Replica at a time, the Background Leader, runs all of it. One leader for everything was chosen over a lease per job because it is much simpler and the load is small.

**A lease row in the audit store, with no Kubernetes API access.** So the chart needs no RBAC, and the pod keeps `automountServiceAccountToken: false`, and it works outside Kubernetes too. Every Replica claims the lease every 5 s (`LEADER_RENEW_MS`); a claim lasts 15 s (`LEADER_LEASE_MS`). The leader's claims renew it, and the others take it once it has expired or been given up.

**The stated time.** After a leader goes silently, another holds the lease within 20 s (`LEADER_TAKEOVER_MS`, a lease plus a renewal). A leader that shuts down stops its jobs and gives the lease up first, and it moves within 5 s. Work is at-least-once across a change: a job in progress when the leader dies may run again, and a notification in flight may be sent twice.

**A holder is one process, not one Replica's name.** Each start gets a new random holder, so a restart is never taken for the process it replaces.

**Fencing, because a lease alone does not stop a stalled leader.** A process that stops for 30 s and wakes up does not know it lost the lease. So each change of hands raises a term, and a job's writes name the holder and term (`LeaseFence`). The store checks them as part of the write, in its transaction: on PostgreSQL the check keeps the lease row locked until the commit, so a claim taking the lease waits for that write to finish, and any later write of the former leader is refused with `LeaderLeaseLost`, having done nothing. The fence does not depend on anyone's clock. A fenced write delays a renewal by as long as it runs, so it must stay well short of the lease. A local timer also stops the jobs when a renewal has not succeeded by the time the lease runs out; that is only tidiness, since fencing is what is safe.

**Clocks.** Expiry compares the time of the Replica that claimed with the time of the one claiming now, so a clock running ahead by more than a lease can take the lease early. Fencing keeps that safe, and the cost is a needless change of leader: keep the Replicas' clocks in sync. The time comes from the Replica rather than the database so that tests can inject it, like the sampler's and the rule scheduler's.

**On SQLite the lease is in memory.** One Replica needs no more, and a row on disk would make a restart after a crash wait for its own old lease. So a single Replica on SQLite is simply its own leader, at once.

**Moving work onto the leader.** Add a `LeaderJob` to the list in `server.ts`. Its `start(fence)` may be called again after `stop()` in one process, so it must hold no state that assumes one start. `start` may do a first run before it answers: startup waits for it, while renewal does not. Writes that must not come from a former leader take a `fence` parameter on their store method, with a test in the contract suite ([ADR 0013](0013-audit-store-interface.md)); PostgreSQL's implementation runs in `fenced`, and SQLite's calls `check` right before writing. A job treats `LeaderLeaseLost` as no failure: it wrote nothing, and the leader will find out at its next claim.

## Consequences

- Shutdown (#119) stops the leader before ending Checkouts, so the lease moves without waiting for Messages to return. Today's `onClose` already does this, as `leader.stop()` comes before `checkouts.endAll()`.
- A job failing to start is logged and the leader stays leader without it. A job that should not run without another must say so itself.
