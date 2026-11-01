# Compatibility policy

What you can rely on between versions of Volverán, from 1.0 on. The reasons are in [ADR 0015](adr/0015-compatibility-policy.md).

## Public contracts

| Contract | Where it is described |
|---|---|
| The profiles file | [Configuration](configuration.md), `profiles.schema.json` |
| Environment variables | [Configuration](configuration.md) |
| Chart values | `charts/volveran/values.yaml`, `values.schema.json` |
| HTTP API, under `/api/v1` and its alias `/api` | `openapi.json` |
| Metric names and labels | [Observability](observability.md#metrics) |
| The webhook body, version 1, and its signature headers | [Observability](observability.md) |
| Message headers: `x-volveran-from`, `x-volveran-replay-id` | Set on a Message Volverán sends out ([Replay Rules](replay-rules.md)) |
| HTTP headers: `x-volveran-message-count` on an export's answer, and `x-volveran-background` on a request nobody asked for by hand, which does not keep a session alive | Here |
| The NDJSON export, line version 1 | [Exporting](exporting.md) |
| The data in the audit store | Audit Entries, Discarded bodies, Replay Rule state, history and Alerts, on either store |

A test compares these with `test/fixtures/public-contracts.json`, and fails when one changes without being recorded there.

These are internal, and may change in any version:

- The audit store's tables, except that its data stays readable. SQLite is promised as data and behaviour, not as the `node:sqlite` API under it.
- Lock queue arguments, which must still work between adjacent minor versions.
- What Replicas say to each other: the internal port and the `x-volveran-forwarded-*` `x-volveran-forwarding-protocol` and `x-volveran-forwarding-refused` headers.
- `VOLVERAN_POD_IP`, which the chart sets for itself.
- The web app's own screens and text, and log lines.

## What a version may change

Within 1.x, a contract may only gain optional things: a new setting with a default that changes nothing, a new route, a new metric or label value, a new field in a webhook body or an export line. So write whatever reads a webhook body or an export line to ignore a field it does not know.

Removing something or changing its meaning needs a major version.

## Deprecation

Something that is going away is:

1. **Announced** in the [changelog](../CHANGELOG.md), and **logged at startup** when it is in use, for at least one minor version.
2. **Removed** only in a major version.

Through 1.x, `/api` keeps working as an alias of `/api/v1`, and a profiles file without `version` is read as version 1 with a startup warning.

## Supported upgrades

- **Directly from 0.5 to 1.0, and from any 1.x to any later 1.x.** There is no need to step through versions.
- **No downgrades.** A store newer than the version starting is refused at startup, on both stores. So a rollback after an upgrade that migrated the store needs the store from before it.

The upgrade suite starts this version on a real store and profiles file written by every release, on SQLite and, after `copy-audit-store`, on PostgreSQL, in CI on every change.

### During a rolling update

With several Replicas, two adjacent minor versions run side by side while a rolling update runs. This holds up as follows.

**1.x migrations only add.** New tables, indexes and columns that a Replica of the version before can ignore, and nothing that could refuse what it writes. A test holds the migrations after 1.0 to this, on both stores.

**A Replica of the version before cannot start once the store is migrated.** The check for a newer store stays as it is, so a pod of the old version that restarts during the update is refused until it is replaced. Those still running carry on. Finish the rollout, and do not scale up the old version.

**A Replica with a different forwarding protocol version is handled safely.** Every forwarded request says which version it speaks. A Replica that speaks another:

- refuses the request before reading anything else of it, so nothing is acted on;
- and the Replica that sent it answers the Operator `503 replica_unreachable`, to try again, as for any Owner Replica it cannot reach now.

The Checkout is not reported lost, since its owner's lease is live, and its Decisions stay on its owner. If the Operator's heartbeats cannot reach the owner for the whole heartbeat window, the Checkout ends as it does when a browser goes away, and its Messages go back to their queue. Each refusal adds to `volveran_forwarding_failures_total{reason="protocol_mismatch"}` on the Replica that sent it. A request without the secret learns nothing: it gets the usual refusal, with no version.

A version that changes the protocol version therefore makes Checkouts on another version's pods unavailable to requests through this pod until the rollout ends. It says so in its changelog, and the protocol version does not change without a reason. So far it has not changed: it is 1.

**Not tested yet.** No 1.x has been released for a later one to run beside, so two real versions have not yet run side by side. The test takes two real Replicas of this version and changes only the version a request says it speaks. The upgrade suite gains the real case with the first later 1.x.

## Supported versions

Only what is run is supported. A version that is not listed may work, but nothing has checked it.

| Software | Supported | What runs it |
|---|---|---|
| RabbitMQ | 4.4 | The broker-facts and integration suites on `rabbitmq:4.4.0-management` on every change, and the kind smoke test |
| PostgreSQL | 17 | The integration suite and contract suite on `postgres:17.6-alpine` on every change, and the kind smoke test |
| Kubernetes | 1.37 | The kind smoke test on `kindest/node:v1.37.0` on every change, under the `restricted` Pod Security Standard |
| Node | 24 | The image is built on `node:24-alpine`, pinned by digest, and CI runs every suite on the latest Node 24. You run Node only by building from source |

- **Later RabbitMQ 4 versions.** A weekly run takes the suites to the latest `rabbitmq:4-management` and opens an issue if they fail. It warns of a release that breaks something, and a version joins this table only once the pinned image moves to it. As of this writing that tag is also 4.4.0.
- **The OpenAPI description's depth.** Its routes, parameters and request bodies are complete. Its response schemas are exact only at the top level, and nested objects are loose: nothing checks them against real answers, so rely on the fields the guides name.
- **Other Kubernetes versions.** The rendered manifests are also checked against the schemas of the oldest and newest version the smoke test runs, with kubeconform, which adds nothing to the table. The chart sets no `kubeVersion`, so other versions are not refused.
- **Node 26** renames the `node:sqlite` API the store uses, and is not tested.

A test fails when this table disagrees with the versions CI pins. Moving one is a change to both.
