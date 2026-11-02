# The compatibility policy

What it means for someone running Volverán is in the [guide](../compatibility.md).

Up to 0.x nothing was promised between versions: the API changed incompatibly in 0.3 and 0.4, and metric names were stable only within a minor version. A team cannot depend on that as shared infrastructure.

## Decision

**The public contracts are named, and within 1.x they may only gain optional things.** They are the profiles file, environment variables, chart values, HTTP API, metric names and labels, webhook body, `x-volveran-*` headers meant for others, NDJSON export and the data in the audit store. Removal or a change of meaning needs a major version, after a deprecation announced in the changelog and logged at startup for at least one minor version.

**Direct upgrades from 0.5 to 1.0 and from any 1.x to any later 1.x. No downgrades.** Stepping through versions is what nobody does, so it would go untested in practice. A downgrade is refused by the store version check.

**A recorded snapshot, written by hand, fails on an unrecorded change.** `test/fixtures/public-contracts.json` is compared with what the code, the chart and the running server actually have. Each contract is read from the product and not from a list kept beside it, and the metric and header names are also found by searching the source, so that a new module cannot go unseen. There is no command to regenerate the record, because the moment of writing it is the review. Additions and removals fail alike: the record cannot tell whether a removal is allowed, a person reading the failure can.

**Migrations after the 1.0 baseline are checked against a list of what is allowed.** `CREATE TABLE`, non-unique `CREATE INDEX` and `ALTER TABLE ... ADD COLUMN`, without anything that could refuse what the version before writes. A list of the forbidden would pass whatever nobody thought of. The migrations up to the baseline are recorded by hash, so they cannot change either. It reads the SQL and runs nothing, so it cannot prove a statement is harmless, and errs towards refusing. A pre-1.0 migration may be non-additive and is left alone: 0.x promised nothing. If a migration lands before 1.0 ships, its ticket moves the baseline.

**The check for a newer store is not relaxed for a rolling update.** The cost is that a pod of the old version that restarts during the update is refused until it is replaced. Letting an old version start on a newer store would mean deciding, per pair of versions, that it is safe, and an accidental rollback is what the check is there to stop (#92, story 7). A rollout is short, and those already running are unaffected.

**Forwarding carries a protocol version, checked exactly.** After the secret and before anything else, because what follows may mean something else in another version. Without the secret, the port says nothing of its version. The refusal is a 400 with `x-volveran-forwarding-protocol`, and its shape cannot change through 1.x, because it is how every Replica recognises it. No released version forwards at all, so a request without a version is refused too.

To the Operator a refusal is what an unreachable Owner Replica already is: `503 replica_unreachable`, try again, nothing reported lost, since the owner's lease is live. Treating it as anything else would tell an Operator that work is gone when it is not. It is its own `reason` on the failure metric, on the sender only, so that a sum across Replicas counts each once and does not read as an attack on the port.

We considered having each Replica accept a range of versions and send what the other understands. That is more code for a case that has not arisen, and it can be added when a protocol change needs it, because the refusal is enough for either side to see the difference.

**Supported versions are what CI runs, and a test keeps the guide to it.** One each of RabbitMQ, PostgreSQL, Kubernetes and Node. A wider table needs more CI runs behind it, and can come when someone needs it. The Kubernetes version is now pinned by digest: it used to be whatever kind's default was, which would have moved a promise without anyone deciding to.

## Consequences

- Two real 1.x versions have not run side by side, since only one exists. The test takes real Replicas and changes the version a request says it speaks. The upgrade suite must gain the real case with the first later 1.x.
- A change to a contract costs an edit to the record, which is the point. A branch adding an environment variable fails until it records it.
- A change of protocol version makes a rollout unavailable for Checkouts across versions until it ends, safely.
