# Running several Replicas

Several Replicas are for availability, not for load: a node drain, an upgrade or a crash no longer takes the web app, the Replay Rules, the sampler and the Alerts down together. This guide says how to run them with the chart, what failover protects and what it does not, and what has been tested. The reasons are in [ADR 0014](adr/0014-replicas-forwarding-and-the-background-leader.md).

## Set it up

You need PostgreSQL for the audit store ([PostgreSQL guide](postgresql.md)). The chart refuses `replicaCount` above 1 on SQLite. To move a SQLite store across, [copy it](postgresql.md#copying-the-audit-trail) first, with Volverán stopped.

Create a Secret for the forwarding secret, at least 32 characters:

```sh
kubectl -n volveran create secret generic volveran-forwarding \
  --from-literal=forwarding-secret="$(openssl rand -hex 32)"
```

Then, in `values.yaml`:

```yaml
replicaCount: 2

postgres:
  existingSecret: volveran-postgres

forwarding:
  existingSecret: volveran-forwarding
```

With more than one Replica the chart renders:

- A **rolling update** (`maxSurge: 1`, `maxUnavailable: 0`) instead of `Recreate`, and no claim.
- A **PodDisruptionBudget** with `maxUnavailable: 1`, so a drain takes one pod at a time. With `replicaCount: 2`, a drain waits while the other pod is not ready.
- **Topology spread** over nodes and zones with `ScheduleAnyway`, so a small cluster still runs every Replica, though it may put them together. Two Replicas on one node do not survive losing that node. `pod.topologySpreadConstraints` replaces it, for example with `DoNotSchedule`.
- The **internal port** (`forwarding.port`, 8081), with `VOLVERAN_FORWARDING_SECRET`, `VOLVERAN_FORWARDING_PORT` and `VOLVERAN_FORWARDING_ADDRESS`, which is the pod's own IP and that port. A **headless Service**, `<release>-replicas`, lists the pods on it. No route and no port of the main Service leads there.
- A **NetworkPolicy**, always (below).

Nothing here needs RBAC or the Kubernetes API. Metrics stay per pod: scrape every pod ([observability](observability.md#several-replicas)). The `ServiceMonitor` does.

The forwarding address is an IPv4 pod address. A Replica whose pod IP is IPv6 refuses to start, because the address is written without the brackets IPv6 needs. IPv6 is not supported or tested.

### Who can reach the internal port

Whoever holds the secret and reaches this port can act as any Operator in any Role, and the Audit Entries will believe them ([threat model](threat-model.md), N4). So with several Replicas the chart always renders a NetworkPolicy that admits only this release's other pods to the port. There is no value that turns this off, and `extraEnv` may not set the forwarding variables.

A NetworkPolicy cannot close one port alone, so this one object also says what happens to the other ports:

- With `networkPolicy.enabled: false`, the default, the web port and the metrics port stay open to anyone in the cluster, as they are with no policy, and egress is not restricted.
- With `networkPolicy.enabled: true`, they are limited by `networkPolicy.ingressFrom` and `metricsFrom` as on one Replica. If `networkPolicy.egress` restricts egress, the chart adds a rule to the other Replicas on the internal port. Add PostgreSQL there yourself.

**This needs a CNI that enforces NetworkPolicy,** such as Calico or Cilium. Without one, the object is accepted and does nothing, and the chart cannot tell. Then the port is open to the whole cluster, with only the secret in front of it: check, by trying to connect from another pod. Anyone who can create pods in the namespace with this release's labels is also let through, so treat that as the same trust as the secret.

The secret crosses the pod network in clear, and Replicas send it to the address the audit store names, so write access to the store can capture it ([threat model](threat-model.md), N3). Changing the secret means restarting all Replicas together: during a rolling update, old and new pods refuse each other's forwarded requests, so a Checkout on another pod cannot be served until it ends.

## What failover protects

| When | What happens |
|---|---|
| A pod is deleted, drained or upgraded | It reports not ready and the others serve. Its Checkouts end as **End Checkout** does, with reason `shutdown`, which any Replica says for 15 minutes; held Messages return with no Delivery Budget used. Decisions not yet Applied are lost. An Apply in progress stops at its next step |
| A Replica crashes | Any other answers for its Checkouts as **Lost Checkouts**, with the reason, once its lease runs out, within 15 s. Unsettled Messages go back to their queues. Audit Entries it left `pending` become `uncertain`, because the step may or may not have happened |
| Operators' sessions | In the database: they survive every restart and rolling update |
| The Background Leader goes | Another holds the lease within 20 s if it went silently, within 5 s if it shut down. Samples show no gap at the default interval |
| A Replica is alive but cannot be reached | `503 replica_unreachable` with `tryAgain`. Nothing is reported lost while its lease is live |

## What it does not protect

- **A Checkout does not move.** Its Messages are in one process's AMQP connection, so when that process goes, the Checkout ends and its Decisions are gone. The Operator starts again. On a quorum queue, a crash uses one of the Delivery Budget per Message, and a Message at its limit is dropped by the broker; the Checkout warns about this.
- **The queue can stay locked about 15 s after a lost host.** A killed process's socket drops at once. A lost node or network gives no such signal, so the broker keeps the lock queue and the Messages until three heartbeats are missed: 5 s each by default, so about 15 s. A profile's `amqpUrl` can name its own `?heartbeat=`, which then sets the wait. Until then a new Checkout on that queue is refused as locked, while the Lost Checkout's reason already says so. A process that stalls for over about 10 s also loses its connections this way.
- **A Restore can be refused for about 15 s after a crash.** A Discard running on a crashed Replica is `discard_in_progress` until its lease ends.
- **A token rotation can cost a Checkout.** On an `operatorToken` profile, with a provider that rotates refresh tokens and refuses reuse, a Replica that dies during a refresh, after the provider has answered and before the new token is saved, takes the only valid refresh token with it. The Replicas left are refused at their next refresh, so that Operator's token runs out and their live Checkouts are lost, on any Replica, however healthy; they must sign in again. Shared credentials are not affected. A provider that keeps the old refresh token working for a while avoids it ([ADR 0008](adr/0008-operator-token-pass-through-per-profile.md#failure-modes)).
- **A notification can be sent twice.** Notifications are at least once across a change of leader: one in flight when the leader crashes is sent again by the next. The same goes for a graceful shutdown, where a delivery that does not finish in its 5 s is cut short and sent again, and the destination may already have it. Make webhook receivers tolerate a repeat. A job in progress may also run again.
- **PostgreSQL is now what everything depends on.** A store outage longer than a lease (15 s) costs the Checkouts of **every** Replica, at one delivery each on quorum queues, and every Replica reports not ready ([PostgreSQL guide](postgresql.md)). More Replicas do not help with that.
- **Keep the clocks in sync.** Leases compare Replicas' clocks. A clock ahead by over 15 s can cause a needless change of leader, and report a live Replica's Checkouts lost.
- **It does not add capacity.** Each Replica holds its own Checkouts in memory, and one leader does all background work.

Shared gauges are absent for up to 20 s at a silent takeover, and on PostgreSQL also while the store is lost past a lease ([observability](observability.md#several-replicas)).

## What was tested

Nothing is promised beyond this. Numbers higher than three, and clusters other than the ones below, have not been run.

**On a real cluster** (`npm run test:smoke`, in CI on every push): kind with one node, kindnet enforcing NetworkPolicy, PostgreSQL without TLS and one RabbitMQ, in a namespace enforcing the `restricted` Pod Security Standard. All pods share the node, so the loss of a node, a zone or a network was not tested, and neither was topology spread having any effect.

- **Two Replicas:** the internal port opens from one Replica to the other and is closed from an unlabelled pod in the same namespace and from another namespace, while the web port stays open, with `networkPolicy.enabled` false. A session is served by either pod. A Discard is started on one pod, and decided and Applied through the other. A live Checkout outlives deleting the other pod. Killing the owner's process with `SIGKILL` shows the Lost Checkout through the survivor, keeps the Audit Entries and the Discarded body, and gives the Message back. A rolling `helm upgrade` keeps at least one pod ready and keeps sessions, and a Checkout on a replaced pod says `shutdown`.
- **Three Replicas:** one Background Leader across the pods; a Checkout started on one pod, decided through the second and read through the third; `SIGKILL` of its owner shows the Lost Checkout through both others.

**In-process** (`startTwoReplicas`, on a real broker and PostgreSQL, two Replicas only): every forwarded route, Approvals, exports, Restore races, sign-in and refresh, Samples, Alerts and Rule Passes with failover, and shutdown.

**Not tested:** other CNIs, TLS to PostgreSQL with several Replicas, a real provider's refresh token rotation (a strict mock was used), a real lost host, running for a long time, or any load.
