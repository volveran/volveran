# Roadmap

Volverán is pre-alpha: the domain model and the key decisions are written down ([`GLOSSARY.md`](GLOSSARY.md), [`docs/adr/`](docs/adr/)), and code comes next. Versions are ordered by priority. Dates are not promised.

## v0.1: Triage core and identity

**Milestone 0: verify RabbitMQ 4.x behaviour.** Before the Checkout is built, a test suite in `test/broker-facts/` runs against a real `rabbitmq:4-management` and pins down the behaviour the design depends on. It stays in the repo as a regression suite for new RabbitMQ releases. Open decisions this milestone settles:

1. Whether Volverán enforces its own Checkout time limit, and for which queue types (`consumer_timeout` behaviour on classic vs quorum queues, and what happens to held deliveries after a `basic.cancel`).
2. How "one Checkout per queue" is enforced when quorum queues ignore exclusive consumers, including across two Volverán instances.
3. How Keep returns a Message (`nack` with requeue, reject, or channel close), how each affects `x-delivery-count`, and what the delivery-limit warning warns about.
4. Whether Replay, Move and Restore strip `CC`/`BCC` headers so a republish does not copy the Message to extra queues.
5. Whether publishing uses a channel separate from the Checkout's, so a publish error never drops held Messages.
6. How a Checkout learns its size N and its deadline, given that management API stats lag.
7. Whether queue order matters after Keep (classic queues keep position, quorum queues move the Message to the back).
8. Whether Replay keeps, resets or records the `x-death` history.

**Triage**
- Broker Profiles from a YAML file, with passwords from environment variables, amqp/amqps and http/https, and an optional CA file.
- Protected Profiles: Apply and Restore require typing the queue name.
- Queue list per vhost (depth, consumers, type), with dead-letter queues first. Streams are listed but cannot be checked out.
- Checkout on classic and quorum queues: holds the oldest Messages, up to 1,000 Messages or 100 MB by default.
- Message view: JSON pretty-printed, text as-is, everything else as hex and base64. Readable `x-death` history and remaining delivery budget.
- Filters on routing key, `x-death` reason, original queue, header value and body text. Select all matching.
- Decisions: Discard (reason required), Replay, Move, Keep. One Apply, at-least-once ([ADR 0001](docs/adr/0001-apply-settles-each-message-at-least-once.md)), with a per-Message outcome.
- Replayed and Moved Messages carry an `x-volveran-replay-id` header and provenance headers.

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
- Per-profile option to connect to the broker with the Operator's own OAuth2 token instead of shared credentials.
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
