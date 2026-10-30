# Roadmap

Volverán **v0.5.0 is released** (October 2026) as `ghcr.io/volveran/volveran:0.5.0`, with the Helm chart `oci://ghcr.io/volveran/charts/volveran` at the same version; see the [changelog](CHANGELOG.md). The vocabulary is in [`GLOSSARY.md`](GLOSSARY.md) and the key decisions in [`docs/adr/`](docs/adr/). Later versions are ordered by priority. Dates are not promised.

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

## v0.2: Deployable on Kubernetes (released in 0.2.0)

- Helm chart published as a signed OCI artifact on `ghcr.io`, ready for Flux CD (`OCIRepository` + `HelmRelease`). The chart version equals the Volverán version.
- Gateway API `HTTPRoute` and classic `Ingress`, both optional.
- Secrets referenced by `existingSecret`, so SOPS, Sealed Secrets or External Secrets can manage them.
- Broker Profiles from a ConfigMap; a PVC for the audit store.
- Optional NetworkPolicy.
- Runs as a numeric non-root user with a read-only root filesystem, and passes the `restricted` Pod Security Standard.
- Exactly one replica with the `Recreate` strategy ([ADR 0003](docs/adr/0003-single-replica-on-kubernetes.md)).
- `/healthz` and `/readyz` for probes, answering without a session and never depending on a broker.
- Image and chart signed with keyless cosign by the release workflow.
- `examples/flux/`: a generic GitOps example (OCIRepository, HelmRelease, SOPS-encrypted Secret, HTTPRoute), and a Kubernetes guide (`docs/kubernetes.md`).
- A kind-cluster smoke test in CI: the chart installs under restricted pod security, an Operator signs in and Applies a Checkout, and the audit store survives a pod restart.
- The OIDC set-up docs planned here (Keycloak with a brokered identity provider such as JumpCloud, and direct providers) were delivered in v0.1 ([`docs/team-mode.md`](docs/team-mode.md)).

## v0.3: Team safety (released in 0.3.0)

Everything planned for v0.3 shipped, including the Operator token option. Upgrading from 0.2: Protected Profiles in Team Mode now require Approval by default, and the queue list API's `setupWarning` became `setupWarnings` (see the [changelog](CHANGELOG.md)).

- Roles (`viewer`, `operator`, `admin`) per Broker Profile, mapped from an OIDC groups claim (a dotted path, read from the ID token, else from userinfo), with groups claim set-ups for Keycloak, JumpCloud, Okta and Entra ID in the [Team Mode guide](docs/team-mode.md#roles). A profile without `roles` keeps everyone `admin`, as before ([ADR 0007](docs/adr/0007-profiles-without-roles-keep-everyone-admin.md)).
- Four-eyes Approval for Apply on Protected Profiles in Team Mode, on by default (`requireApproval: false` turns it off per profile): request, withdraw, approve or reject with a reason, and an Approvals view. Both people are recorded in the Audit Entries.
- Per-profile option to connect to the broker with the Operator's own OAuth 2.0 token instead of shared credentials (`credentials: operatorToken`, Team Mode only), with the token refreshed on live connections through `update-secret` ([ADR 0008](docs/adr/0008-operator-token-pass-through-per-profile.md)). The broker-facts gate passed: with the OAuth 2.0 backend, `update-secret` accepts a refreshed token for the same user and refuses an invalid, expired or other user's token (the internal backend accepts any password); see [RabbitMQ behaviour](docs/rabbitmq-behaviour.md#oauth-20-tokens).
- Died Again detection: a Replayed, Moved or Restored Message that is dead-lettered again is flagged by its replay id, with how many times and a link to the Audit Entry of its last trip, a `died-again` filter and a warning before Replaying it again.
- NDJSON export of a Checkout (every held Message, or those matching the filter), lossless and streamed, recorded as an Audit Entry.
- More dead-letter set-up checks, beyond the delivery-limit check that shipped in v0.1: a missing or unroutable dead-letter exchange, a dead-letter queue that drops Messages (TTL, length limit, expiry), and a quorum queue that dead-letters at-most-once. A queue shows every warning that applies, and the broker behaviour behind each check is in [RabbitMQ behaviour](docs/rabbitmq-behaviour.md#dead-letter-set-up).
- Keyboard navigation of the queue list and the Checkout, with a `?` shortcut list. No key Applies, approves, rejects or Restores.

## v0.4: Replay at scale (released in 0.4.0)

Everything planned for v0.4 shipped. Upgrading from 0.3: Apply runs in the background, so `POST /api/checkouts/:id/apply` and the approve endpoint answer `202` and the outcomes are read from the Checkout view's `lastApply.outcomes` (see the [changelog](CHANGELOG.md) and [ADR 0009](docs/adr/0009-apply-runs-in-the-background-paced-between-steps.md)). Three things differ from the plan: comparing two Messages from a waiting Approval is open only to those who may approve it (`operator` and `admin`), like the rest of the Approval view, so a `viewer` cannot compare Messages there; the Apply outcomes kept their v0.3 place, `lastApply.outcomes`; and the profiles file's durations (the Watch Window, a Replay Rule's `every`, `backoff` and `stopWhen.within`) use a new format, such as `30s`, `5m`, `1h30m` or `7d`, because the profiles file had no duration format to reuse.

- Throttled Replay: a Replay Rate in Messages per second for an Apply's Replay and Move steps, with a default and a maximum per Broker Profile, the estimated duration in the Apply confirmation, and the rate in every Audit Entry. Apply runs in the background with its progress on the Checkout, and the owner or the approver can stop it part way, after which the rest falls back to Keep.
- Canary Replay: an Apply can start with one Replay carried out alone, watched for the Watch Window through a watch queue bound to the dead-letter exchange, then continued or stopped by the Operator. A Broker Profile can require one above a number of Replays, and on a Protected Profile the Canary is part of the Approval. The broker facts it relies on (the watch, and how soon a Message is dead-lettered again) are checked in [RabbitMQ behaviour](docs/rabbitmq-behaviour.md).
- Side-by-side comparison of two Messages, from a Checkout (Compare or the `c` key) and from a waiting Approval: properties and headers by name, `x-death` by position, Failure Details by field, and bodies by kind (JSON by path, text by line, binary by size and first differing byte).
- Spring AMQP and MassTransit: their Failure Details in the Message list, the Message view, a filter and the export; `_error` queues listed as dead-letter queues; MassTransit Messages Replayed to their input queue and Spring AMQP Messages offered a prefilled Move ([ADR 0010](docs/adr/0010-replay-origin-from-framework-headers.md), [guide](docs/spring-amqp-and-masstransit.md)).
- Replay rules declared in the profiles file ([ADR 0011](docs/adr/0011-replay-rules-declared-in-the-profiles-file.md)): scheduled Rule Passes over ordinary Checkouts, back-off and attempt limits counted from Died Again, Keep or Move for used-up Messages, a required automatic stop, pause by an `operator` and resume by an `admin`, state kept in the audit store, and a Replay rules view ([guide](docs/replay-rules.md)).

## v0.5: Observability (released in 0.5.0)

Everything planned for v0.5 shipped. Upgrading from 0.4 changes no behaviour you did not ask for, apart from sampling and the audit store's growth (see the [changelog](CHANGELOG.md)). These things differ from the plan:

- **Estimated arrivals.** The plan read arrivals from the broker's `message_stats.publish`, if a broker-facts gate proved that dead-lettered Messages count there. They do not, on classic or quorum queues, for rejected or expired Messages, directly or through exchange-to-exchange bindings ([RabbitMQ behaviour](docs/rabbitmq-behaviour.md#publish-counter)). So the planned fallback applies: **estimated arrivals**, the change in depth between Samples plus the Messages Volverán took out in between, never below zero, named so in the web app, the API (`estimatedArrivals`) and the metrics. A consumer outside Volverán hides arrivals, which the plan's counter would not have done. Depth survives a broker restart, so there is no reset to handle, but the management API lists a queue with no depth for some seconds after one ([RabbitMQ behaviour](docs/rabbitmq-behaviour.md#missing-depth)). That gives no Sample, not a depth of 0, and arrivals are unknown at a queue's first Sample and at the first one after a good run missed it.
- **The metric name.** `volveran_dead_letter_queue_arrived_messages_total` became `volveran_dead_letter_queue_estimated_arrived_messages_total`.
- **False spikes are corrected for Alerts and metrics, not the history.** Management statistics lag, so a take-out can land in an earlier interval than its drop in depth, which reports arrivals that never happened. `anyArrival`, `arrivalsAbove` and the arrivals counter count an arrival only once the depth has borne it out, so arrivals hidden by triage count one Sample late. The history keeps its estimate and says such a rise can be false.
- **Refusals beyond the plan.** Alert Destination and Alert Rule names may only contain letters, digits, `-` and `_`. `repeatEvery` is at least 1 minute. A `queuePattern` that looks like a regular expression is refused. The chart refuses `metrics.port` equal to the web app's port or `service.port`, a `metrics.serviceMonitor` without `metrics.enabled`, and an `extraEnv` setting `VOLVERAN_METRICS_PORT`.
- **Redirects are not followed.** A webhook that moves counts as failed with its 3xx status, rather than handing notifications to an address nobody reviewed ([ADR 0012](docs/adr/0012-alerting-declared-in-the-profiles-file.md)).
- **More labels on metrics.** `volveran_alerts_firing`, `volveran_replay_rule_paused`, `volveran_replay_rule_passes_total` and `volveran_apply_messages_total` also carry `profile`, and the rule metrics `rule`, so that two profiles' rules with one name stay apart. Test notifications are not counted in `volveran_alert_notifications_total`.
- **Extra fields in the generic webhook's body**, still `version: 1`: `test` (`true` on a test notification, which your service should ignore), `replayRule` and `reason` (null when they do not apply).
- **Extra refusals at startup.** Besides those planned, startup refuses `replayRulePaused` on a profile with no Replay Rules, `setupWarning` and `samplingFailing` on an `operatorToken` profile, as well as queue conditions, and a rule-level `for` on `samplingFailing`, which has its own.
- **A `queue:` is not checked against the broker.** An Alert Rule naming a queue that is not a dead-letter queue is not refused, but that queue is never sampled, so the rule never fires.
- **What `setupWarning` and `replayRulePaused` fire on.** The plan said a queue "gains" a warning. A queue already warned, or a rule already paused, fires at the next evaluation, including right after the Alert Rule is deployed, while a Replay Rule deployed with `startPaused` never fires. Removing a paused Replay Rule from the file sends a resolved notification; only removing the Alert Rule is quiet. `samplingFailing`'s `for` counts from the profile's last good run, and its value and threshold are seconds. Alerts about no queue link to Volverán's root. A pause's reason is cut at 500 characters in notifications.
- **More on the Dead-letter Map.** Queue nodes also carry `deadLetterQueue`, `checkout` and `checkedOutBy`, so the map can start a Checkout. Edges carry `sources`, and gain the kinds `alternate_exchange`, `default_exchange` and `unresolved`: where Messages go next cannot be told from the set-up, which is not drawn as a loss. Only cycles Messages can really travel are flagged.
- **Audit migrations** are split per feature (v12 notifications, v13 history, v14 and v15 Alerts, v16 the interval of each sampling run and the Replay Rule of each notification), not one migration.
- **A sampling run covers a whole profile**, so one failing vhost fails the profile's run.
- **Long ranges are not bounded.** A history range reads all its Samples before downsampling, so the largest settings (90 days at 15 seconds, about 518,000 Samples for one queue) take about 250 MiB of memory for that request. The [observability guide](docs/observability.md#sizing) says so; it is not limited in 0.5.

What shipped:

- Depth history: a Sample of every dead-letter queue of each shared-credentials Broker Profile once a minute, from the management API only, kept 14 days (both configurable), a history API, a 24-hour depth chart in the queue list, and a history view with estimated arrivals, gaps and marks linking to the Audit Entries of Applies and Rule Passes.
- Alerts to Slack, Microsoft Teams and webhooks: Alert Destinations and Alert Rules declared in the profiles file ([ADR 0012](docs/adr/0012-alerting-declared-in-the-profiles-file.md)), on depth, arrivals, a paused Replay Rule, a set-up warning or failed sampling, with `for`, `repeatEvery`, retried and recorded deliveries, a signed webhook, an Alerts view and test notifications. Notifications never hold Message content.
- Prometheus metrics on a separate port, off by default, and a `metrics` section in the Helm chart with a Prometheus Operator ServiceMonitor and a NetworkPolicy peer list for the scraper. A scrape never contacts a broker.
- Dead-letter Map: which queues dead-letter into which in a vhost, through which exchange and routing key, with losses, chains, cycles and MassTransit `_error` queues, in the web app (with search and a text listing to copy) and the API.

See the [observability guide](docs/observability.md).

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
