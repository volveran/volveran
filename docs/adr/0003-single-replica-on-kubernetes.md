# Run exactly one replica on Kubernetes

Superseded by [ADR 0014](0014-replicas-forwarding-and-the-background-leader.md). One Replica on SQLite still runs as described here, and several are allowed on PostgreSQL only. What follows is why it was once the rule.

A Checkout's held Messages live in one process's AMQP connection and memory, and the audit store is SQLite on a volume with a single writer. Several replicas would need sticky sessions, a shared database and coordination over which replica holds which queue. So the Helm chart runs one replica with the `Recreate` strategy and refuses `replicaCount > 1`. A restart is safe: the broker returns every held, unsettled Message to its queue (see ADR 0001 for why settlement never loses a Message). High availability waits for the Postgres audit store and cross-replica Checkout coordination.
