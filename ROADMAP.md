# Roadmap

Volverán **v0.1.0 is released** (October 2026) as `ghcr.io/volveran/volveran:0.1.0`; see the [changelog](CHANGELOG.md). The vocabulary is in [`GLOSSARY.md`](GLOSSARY.md) and the key decisions in [`docs/adr/`](docs/adr/). Later versions are ordered by priority. Dates are not promised.

## v0.1: Triage core and identity (released in 0.1.0)

**Broker behaviour test suite.** Every RabbitMQ 4.4 behaviour the design depends on ([`docs/rabbitmq-behaviour.md`](docs/rabbitmq-behaviour.md), [ADR 0005](docs/adr/0005-replay-targets-the-dead-lettering-queue.md), [ADR 0006](docs/adr/0006-checkout-mechanics-on-rabbitmq-4.md)) is checked by a test in `test/broker-facts/` against a real broker. CI runs it on every change against a pinned version, and weekly against the latest `rabbitmq:4-management`, so a RabbitMQ release that changes one of them is caught.

**Triage**
- Broker Profiles from a YAML file, with passwords from environment variables, amqp/amqps and http/https, and an optional CA file.
- Protected Profiles: Apply and Restore require typing the queue name.
- Queue list per vhost (depth, consumers, type), with dead-letter queues first. Streams are listed but cannot be checked out.
- Checkout on classic and quorum queues: holds the oldest Messages, up to 1,000 Messages or 100 MB by default.
  - One Checkout per queue across every Volverán instance, enforced by a broker-side lock queue.
  - One active Checkout per Operator.
  - A time limit (30 minutes by default) and a browser heartbeat. A Checkout the broker cancels becomes a Lost Checkout and cannot be Applied.
- Message view: JSON pretty-printed, text as-is, everything else as hex and base64. Readable `x-death` history and Delivery Budget, with a warning when a Lost Checkout would cost a Message its last attempt.
- Filters on routing key, `x-death` reason, original queue, header value, body text and JSON path. Select all matching.
- Decisions:
  - Discard (reason required).
  - Replay (back to the queue the Message was dead-lettered from).
  - Move (to a named queue, or to an exchange with a routing key).
  - Keep (returns the Message without using up Delivery Budget).
- One Apply, at-least-once ([ADR 0001](docs/adr/0001-apply-settles-each-message-at-least-once.md)), with a per-Message outcome.
- Replay, Move and Restore remove `CC`, `BCC` and dead-letter headers and add `x-volveran-replay-id` and `x-volveran-from`. The original headers are kept in the Audit Entry.
- Set-up check: warn when a quorum dead-letter queue has a finite `delivery-limit` (including the default of 20) and no dead-letter exchange, because the broker drops Messages that pass the limit.

**Audit and Restore**
- An Audit Entry for every action, recording the Operator, the broker user, the Broker Profile, the queue, the Message and the outcome. Audit Entries are kept indefinitely.
- Discarded Message bodies are kept for 30 days or until the store reaches 1 GiB, whichever comes first, oldest evicted first. Both limits are configurable.
- Restore to the source queue, or to another existing queue.
- Search Audit Entries by Broker Profile, queue, `message_id`, action, Operator, date and replay id. Every Replay, Move and Restore records the replay id it published with.

**Running**
- One Docker image with two modes ([ADR 0002](docs/adr/0002-solo-and-team-modes.md)):
  - Solo Mode: no sign-in, listens on loopback only.
  - Team Mode: sign-in through any OIDC provider (JumpCloud, Keycloak, Okta, Entra…).
- Broker access uses each Broker Profile's shared credentials ([ADR 0004](docs/adr/0004-shared-broker-credentials-first.md)).
- Audit store in SQLite on a mounted volume.
- Release image `ghcr.io/volveran/volveran` for amd64 and arm64, with an SBOM and provenance attestation.

## v0.2: Deployable on Kubernetes

- Helm chart published as an OCI artifact on `ghcr.io`, ready for Flux CD (`OCIRepository` + `HelmRelease`).
- Gateway API `HTTPRoute` and classic `Ingress`, both optional.
- Secrets referenced by `existingSecret`, so SOPS, Sealed Secrets or External Secrets can manage them.
- Broker Profiles from a ConfigMap; a PVC for the audit store.
- Optional NetworkPolicy and Prometheus Operator ServiceMonitor.
- Runs as non-root with a read-only root filesystem.
- Exactly one replica with the `Recreate` strategy ([ADR 0003](docs/adr/0003-single-replica-on-kubernetes.md)).
- `examples/flux/`: a generic GitOps example (OCIRepository, HelmRelease, SOPS-encrypted Secret, HTTPRoute).
- Docs: OIDC set-up for Keycloak (including brokered identity providers such as JumpCloud) and for direct providers.

## v0.3: Team safety

- Roles (viewer, operator, admin) mapped from an OIDC groups claim, per Broker Profile.
- Four-eyes approval for Apply on Protected Profiles.
- Per-profile option to connect to the broker with the Operator's own OAuth2 token instead of shared credentials. This first needs verifying that `update-secret` really re-checks the token with the OAuth 2.0 backend; the internal backend accepts any password.
- "Died again" detection: flag a Replayed Message that is dead-lettered again, matched by its replay id (already recorded in every Audit Entry since v0.1).
- NDJSON export of a Checkout.
- More dead-letter set-up checks, beyond the delivery-limit check that shipped in v0.1.
- Keyboard navigation.

## v0.4: Replay at scale

- Throttled Replay (messages per second).
- Canary Replay: Replay one Message first, then confirm the rest.
- Side-by-side comparison of two Messages.
- Recognise Spring AMQP and MassTransit dead-letter headers.
- Replay rules: automatic, scheduled Replay with back-off, attempt limits and an automatic stop.

## v0.5: Observability

- Dead-letter queue depth and rate history.
- Alerts to Slack, Microsoft Teams and webhooks.
- Prometheus metrics endpoint.
- Dead-letter topology map: which queues dead-letter into which.

## v1.0: Production hardening

- PostgreSQL as an alternative audit store.
- Several replicas with Checkout coordination between them.
- Security review, upgrade guarantees and a stable configuration format.

## Later, if needed

- Editing a Message before Replay, with both versions kept in the Audit Entry.
- Masking sensitive fields in the UI.
- Protobuf and Avro decoding.
- SAML sign-in.
- Triage of stream queues.
