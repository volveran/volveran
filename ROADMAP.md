# Roadmap

Volverán is pre-alpha: the domain model and the key decisions are written down ([`GLOSSARY.md`](GLOSSARY.md), [`docs/adr/`](docs/adr/)), and code comes next. Versions are ordered by priority. Dates are not promised.

## v0.1: Triage core and identity

**Milestone 0: broker behaviour test suite.** The RabbitMQ 4.4 behaviour the design depends on has been verified by hand ([`docs/rabbitmq-behaviour.md`](docs/rabbitmq-behaviour.md)) and turned into decisions ([ADR 0005](docs/adr/0005-replay-targets-the-dead-lettering-queue.md), [ADR 0006](docs/adr/0006-checkout-mechanics-on-rabbitmq-4.md)). The first code is a test suite in `test/broker-facts/` that checks each of those facts against a real `rabbitmq:4-management`, so a new RabbitMQ release that changes them fails the build.

**Triage**
- Broker Profiles from a YAML file, with passwords from environment variables, amqp/amqps and http/https, and an optional CA file.
- Protected Profiles: Apply and Restore require typing the queue name.
- Queue list per vhost (depth, consumers, type), with dead-letter queues first. Streams are listed but cannot be checked out.
- Checkout on classic and quorum queues: holds the oldest Messages, up to 1,000 Messages or 100 MB by default.
  - One Checkout per queue across every Volverán instance, enforced by a broker-side lock queue.
  - One active Checkout per Operator.
  - A time limit (30 minutes by default) and a browser heartbeat. A Checkout the broker cancels becomes a Lost Checkout and cannot be Applied.
- Message view: JSON pretty-printed, text as-is, everything else as hex and base64. Readable `x-death` history and Delivery Budget, with a warning when a Lost Checkout would cost a Message its last attempt.
- Filters on routing key, `x-death` reason, original queue, header value and body text. Select all matching.
- Decisions:
  - Discard (reason required).
  - Replay (back to the queue the Message was dead-lettered from).
  - Move (to a named queue, or to an exchange with a routing key).
  - Keep (returns the Message without using up Delivery Budget).
- One Apply, at-least-once ([ADR 0001](docs/adr/0001-apply-settles-each-message-at-least-once.md)), with a per-Message outcome.
- Replay, Move and Restore remove `CC`, `BCC` and dead-letter headers and add `x-volveran-replay-id` and `x-volveran-from`. The original headers are kept in the Audit Entry.
- Set-up check: warn when a quorum dead-letter queue has the default `delivery-limit` and no dead-letter exchange, because the broker drops Messages that pass the limit.

**Audit and Restore**
- An Audit Entry for every action, recording the Operator, the broker user, the Broker Profile, the queue, the Message and the outcome. Audit Entries are kept indefinitely.
- Discarded Message bodies are kept for 30 days or until the store reaches 1 GiB, whichever comes first, oldest evicted first. Both limits are configurable.
- Restore to the source queue, or to another existing queue.

**Running**
- One Docker image with two modes ([ADR 0002](docs/adr/0002-solo-and-team-modes.md)):
  - Solo Mode: no sign-in, listens on loopback only.
  - Team Mode: sign-in through any OIDC provider (JumpCloud, Keycloak, Okta, Entra…).
- Broker access uses each Broker Profile's shared credentials ([ADR 0004](docs/adr/0004-shared-broker-credentials-first.md)).
- Audit store in SQLite on a mounted volume.

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
- "Died again" detection: flag a Replayed Message that is dead-lettered again, matched by its replay id.
- NDJSON export of a Checkout.
- Filters on JSON paths inside the body.
- Dead-letter set-up checks, for example warning when a quorum dead-letter queue has a finite `delivery-limit`.
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
