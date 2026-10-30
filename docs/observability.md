# Observability

How to see your dead-letter queues over time, be told when something needs a person, plug Volverán into your monitoring, and see where Messages go when they die.

- [Depth history](#depth-history), and [sizing the audit store](#sizing) for it.
- [Dead-letter Map](#dead-letter-map).
- [Alerts](#alerts): [Alert Destinations](#alert-destinations) for Slack, Microsoft Teams and webhooks, [Alert Rules](#alert-rules), the [webhook schema and signature](#webhook-schema).
- [Metrics](#metrics): the [metric reference](#metric-reference), [example alerts](#example-alerts) and [ServiceMonitor set-up](#servicemonitor-set-up).

## Depth history

Volverán takes a **Sample** of every dead-letter queue of each Broker Profile once a minute, and keeps the Samples in the audit store for 14 days. Nothing needs turning on. Sampling reads only the management API, like the queue list: it never takes a Checkout or reads a Message.

| Variable | Chart value | Default | Meaning |
| --- | --- | --- | --- |
| `VOLVERAN_HISTORY_INTERVAL_SECONDS` | `settings.historyIntervalSeconds` | `60` | How often to sample, 15 to 3600. Every run lists the queues of the profile's vhosts through the management API. |
| `VOLVERAN_HISTORY_RETENTION_DAYS` | `settings.historyRetentionDays` | `14` | How long Samples, sampling runs and the outcomes of notifications are kept, 1 to 90. The retention job (`VOLVERAN_BODY_RETENTION_INTERVAL_MINUTES`) removes older ones. |

**What is sampled.** The queues the queue list calls dead-letter queues: those matching the profile's `defaultQueueFilter`, those other queues dead-letter into, and MassTransit `_error` queues. A queue that becomes one is sampled from the next run, and a deleted queue's history stays until it ages out. The first run comes one interval after startup.

**`operatorToken` profiles are not sampled.** Such a profile connects with the signed-in Operator's token ([ADR 0008](adr/0008-operator-token-pass-through-per-profile.md)), and with nobody signed in there is no credential to sample with. It has no history, no queue or set-up warning Alerts, and no queue metrics, and its history answers `409 history_not_sampled`.

**Estimated arrivals.** The broker does not count dead-lettered Messages ([RabbitMQ behaviour](rabbitmq-behaviour.md#publish-counter)), so each Sample's arrivals are estimated: the rise in depth since the Sample before, plus the Messages Volverán took out in between, from its Audit Entries.

- A consumer outside Volverán hides arrivals: what it takes away is not seen arriving.
- A queue's first Sample has unknown arrivals, shown as unknown rather than zero. So has its first Sample after a run with no depth for it.
- The management API lists a queue with no depth for some seconds after a broker restart. Volverán takes no Sample of it in that run, rather than a depth of 0, which holds its Alerts as they are. A broker with `management_agent.disable_metrics_collector = true` never reports depth, so its queues get no Samples at all, though its sampling runs succeed ([RabbitMQ behaviour](rabbitmq-behaviour.md#missing-depth)).
- Management statistics lag by a few seconds, so a take-out can land in an earlier interval than its drop in depth. The history then shows a false spike. [Alert Rules](#alert-rules) and the arrivals metric count arrivals only once the depth has borne them out, so they do not.

**Depth** is the management API's count of the queue's Messages, which lags by a few seconds, and includes those a Checkout holds.

**Failures.** Profiles are sampled independently, so one broker that cannot be reached never delays the others. If any vhost of a profile fails, the profile's whole run fails. The history shows the gap rather than a flat line.

### Seeing it

The queue list shows a 24-hour depth chart next to each dead-letter queue. A queue's history view (the link on the chart, or `h` on the focused queue) shows depth and estimated arrivals over the last hour, 24 hours, 7 days or the whole retention, the time of the latest Sample, gaps, and marks for the Applies and Rule Passes that took Messages out, linked to their Audit Entries. Any Role on the profile may read it, as with the queue list. Link to one with `#/history/<profile>/<vhost>/<queue>`.

`GET /api/profiles/:profile/vhosts/:vhost/queues/:queue/history?from=&to=` answers the same data. `from` and `to` are ISO 8601 and default to the last 24 hours. A long range is downsampled to at most about 500 buckets of Samples, each with its last depth and summed arrivals; `arrivalsPartlyUnknown` says some of its Samples, not all, had unknown arrivals, and the view hatches it like an unknown stretch.

```json
{ "from": "2026-10-29T10:00:00.000Z", "to": "2026-10-30T10:00:00.000Z", "retentionDays": 14,
  "latestSampleAt": "2026-10-30T09:59:30.000Z",
  "samples": [{ "at": "2026-10-30T09:59:30.000Z", "depth": 400, "estimatedArrivals": 12, "arrivalsPartlyUnknown": false }],
  "gaps": [{ "from": "2026-10-30T03:00:00.000Z", "to": "2026-10-30T03:20:00.000Z", "errorCode": "…" }],
  "marks": [{ "at": "2026-10-30T08:00:00.000Z", "kind": "apply", "operator": "ana", "rule": null, "checkoutId": "…",
              "counts": { "discard": 2, "replay": 40, "move": 0 }, "auditUrl": "/api/audit-entries?…" }] }
```

The queue list's response gains, on each dead-letter queue, `depthSeries` (`{ from, to, points: [[ms, depth]], gaps }`, on sampled profiles) and `firingAlerts`.

### Sizing

A Sample takes about **100 bytes** of the audit store, measured on a database with this schema and queue names of 23 characters, indexes included. Each extra character in a queue's name adds about 2 bytes. Size history as:

```
queues × (86,400 / interval in seconds) × retention in days × 100 bytes
```

Worked example: 100 dead-letter queues at one-minute Samples, for the default 14 days, make 100 × 1,440 × 14 = 2,016,000 Samples, about **190 MiB**.

| 100 dead-letter queues | 14 days | 90 days |
| --- | --- | --- |
| Every 60 s | 190 MiB | 1.2 GiB |
| Every 15 s | 750 MiB | 4.7 GiB |

- It grows for one retention period after the upgrade, then stays level: the store reuses the space of removed Samples, and its file does not shrink.
- Sampling runs and notifications add little next to the Samples.
- Add it to the room Discarded bodies may take (`VOLVERAN_BODY_RETENTION_MAX_BYTES`, 1 GiB by default). The chart's default claim is also 1 GiB, so raise `persistence.size` or lower the body limit if both can fill up. A Discard needs a durable commit to the audit store, so a full volume stops triage.

**Memory.** A history request reads every Sample of its range before downsampling. At the default settings that is at most about 20,000 Samples for one queue. The largest settings, 90 days at 15 seconds, reach about 518,000, which took about 250 MiB of memory for the length of the request when measured; the chart's default memory limit is 512 MiB. Raise `pod.resources` if you use settings like that, or keep long retention in Prometheus.

## Dead-letter Map

Each vhost has a **Dead-letter Map**: which queues dead-letter into which, through which exchange and routing key. It shows the broker's set-up, not the Messages that took a path, and it is read-only. Queues that take no part in dead-lettering are left off.

The Dead-letter Map view (`#/dead-letter-map/<profile>/<vhost>`) draws queues with their depth and set-up warnings, losses, chains and cycles, searches for one queue and shows the part connected to it, opens a queue's history or a Checkout, and lists the same graph as text to read or copy. Any Role on the profile may see it.

`GET /api/profiles/:profile/vhosts/:vhost/dead-letter-map` answers `{ nodes, edges, cycles }`:

| Part | Fields |
| --- | --- |
| Queue node | `id` (`queue:<name>`), `kind: "queue"`, `name`, `type`, `approximateMessages`, `setupWarnings`, `inCycle`, `deadLetterQueue` (it has a depth history), `checkout` (whether one can be taken), `checkedOutBy`. |
| Exchange node | `id` (`exchange:<name>`, empty for the default exchange), `kind: "exchange"`, `name`, `missing`, `inCycle`. |
| Every edge | `from`, `kind`, and `sources`: the queues whose dead-lettered Messages take this edge. To follow one queue's path, keep the edges whose `sources` include it. |
| Edge `kind` | `dead_letter` (queue to its exchange; `to`, `routingKey`, null when Messages keep their own), `binding` (`to`, `bindingKey`), `alternate_exchange` (`to`), `default_exchange` (`to`), `convention` (MassTransit's `<q>` to `<q>_error`; `to`), `drop` (a loss; `reason`: `exchange_missing` or `routes_nowhere`), `unresolved` (where Messages go next cannot be told from the set-up, which is not a loss). |
| `cycles` | Each cycle's node ids. Only cycles Messages can really travel are listed, so the graph can hold loops that are not here. |

## Alerts

Nothing notifies anyone until you declare it. Alert Destinations and Alert Rules live in the profiles file and nowhere else ([ADR 0012](adr/0012-alerting-declared-in-the-profiles-file.md)), so changing one goes through your usual review, and needs a restart. They work in Solo Mode and Team Mode. [`profiles.example.yaml`](../profiles.example.yaml) has every key.

A notification names the rule, profile, vhost, queue, condition, value, threshold and since when, and links to Volverán. It never contains a Message's body, headers or `message_id`.

The links start from `VOLVERAN_PUBLIC_URL`, which in Team Mode defaults to the origin of `VOLVERAN_OIDC_REDIRECT_URL`. With neither, notifications carry no link. A queue's Alert links to its history, and any other Alert to Volverán's root.

### Alert Destinations

Declare each one once, at the top of the profiles file, and route any Alert Rule of any profile to it. Each takes a `name` (letters, digits, `-` and `_`), a `type`, and `urlEnv`, the environment variable holding its URL. A webhook URL is a credential, so it never goes in the file.

**Slack.** Add an incoming webhook to your Slack workspace (the Incoming Webhooks feature of a Slack app) for the channel you want, and put its URL in the variable.

```yaml
alertDestinations:
  - name: ops-slack
    type: slack
    urlEnv: VOLVERAN_OPS_SLACK_URL
```

**Microsoft Teams.** In the channel, open **Workflows** and create one from the template *Post to a channel when a webhook request is received*, then copy the URL it gives you. Volverán sends it an Adaptive Card. Office 365 connector URLs are not supported.

```yaml
alertDestinations:
  - name: ops-teams
    type: teams
    urlEnv: VOLVERAN_OPS_TEAMS_URL
```

**Generic webhook.** Any `http` or `https` URL that takes a JSON `POST`, such as your own tooling or a paging tool's events endpoint, with the [body below](#webhook-schema). `signingSecretEnv` is optional, and only allowed here.

```yaml
alertDestinations:
  - name: pager
    type: webhook
    urlEnv: VOLVERAN_PAGER_URL
    signingSecretEnv: VOLVERAN_PAGER_SECRET
```

**The variables.** Pass them as you pass broker passwords. On Kubernetes, keep them in a Secret and name it in `alerts.existingSecret`, whose keys become environment variables, and put the list under `brokerProfiles.alertDestinations`. With `networkPolicy.egress` set, allow the destinations too.

```sh
kubectl -n volveran create secret generic volveran-alerts \
  --from-literal=VOLVERAN_OPS_SLACK_URL='<the webhook URL>'
```

**Delivery.** Each delivery has a 5-second timeout and up to 3 attempts with a growing wait. Redirects are not followed, so a webhook that moved counts as failed with its 3xx status. Deliveries never hold up sampling or each other. The outcome is kept in the audit store for `VOLVERAN_HISTORY_RETENTION_DAYS`, without the URL.

**Testing one.** An `admin` on any Broker Profile (anyone in Solo Mode) can send a clearly labelled test notification from the Alerts view, or with `POST /api/alert-destinations/:name/test`, which answers `{ delivery }` once the delivery has ended (`404 alert_destination_not_found` for an undeclared name, `403 role_required` without the Role).

### Alert Rules

A Broker Profile's `alerts` is a list of rules, each with a `name` unique in the profile, `destinations`, one condition under `when`, and optionally `for` and `repeatEvery`.

```yaml
profiles:
  - name: prod
    # ...
    alerts:
      - name: orders-deep
        destinations: [ops-slack, pager]
        when: { vhost: /, queue: orders.dlq, depthAbove: 100 }
        for: 5m
        repeatEvery: 1h
      - name: any-dlq-burst
        destinations: [ops-teams]
        when: { vhost: /, queuePattern: "*.dlq", arrivalsAbove: { count: 50, within: 10m } }
      - name: replay-stopped
        destinations: [pager]
        when: { replayRulePaused: true }
```

| `when` | Fires when | Value and threshold |
| --- | --- | --- |
| `vhost` and `queue` or `queuePattern`, with `depthAbove: n` | The depth is above `n` (0 or more). | The depth; `n`. |
| The same, with `arrivalsAbove: { count, within }` | More than `count` estimated arrivals within `within` (1s to 7d). | The arrivals in the window; `count`. |
| The same, with `anyArrival: true` | Any Message arrives. | The arrivals at this Sample; none. |
| `replayRulePaused: true`, optionally `rule: <name>` | A Replay Rule of the profile is paused; each rule is its own Alert. The reason is in the notification. | None. |
| `setupWarning: loses_messages` or `may_lose_messages` | A dead-letter queue has a set-up warning at least this bad (`may_lose_messages` includes `loses_messages`); each queue is its own Alert. The codes are in the notification. | How many warnings; none. |
| `samplingFailing: { for }` | The profile has had no good sampling run for `for` (1s to 7d), counted from its last good run. The error code is in the notification. | Seconds since then; `for` in seconds. |

- `queuePattern` is the same glob as `defaultQueueFilter` (`*` and `?`). Startup refuses a pattern that looks like a regular expression (one with `^`, `$`, `\`, `(`, `)`, `+`, `|`, `[` or `]`). Each matching dead-letter queue is its own Alert.
- `for` (1s to 7d) is how long the condition must hold before the Alert fires. `samplingFailing` takes its own `for` and no other.
- `repeatEvery` (1m to 7d) sends a firing Alert again. By default it is sent once.
- Durations are written `30s`, `5m`, `1h30m`, `7d`.

**A `queue:` must name a dead-letter queue.** Only those are sampled, so a rule naming another queue never fires, and startup does not refuse it because it does not ask the broker.

**How an Alert moves.** It is pending while the condition has not held for `for`, and is forgotten quietly if the condition goes false. Once it has held, it is firing and a notification goes out. It resolves, with another notification, when the condition is false at two Samples in a row, a full Sample apart, or at once when a Replay Rule resumes or sampling succeeds. The next firing is a new Alert with a new id. Evaluation runs after each sampling run and on each Replay Rule pause and resume.

- A failed sampling run changes no Alert on a queue, though it may repeat one. A Sample with unknown arrivals holds an arrival Alert as it is, and a run with no depth for a queue holds that queue's Alerts.
- **Arrival conditions count only what the depth has borne out**: a take-out counts once the next Sample shows it did not explain a drop in depth. So false spikes do not fire them, and arrivals hidden by triage alert one Sample late. The history and the metrics are not corrected in this way, and can show a spike with no Alert.
- A firing Alert survives a restart without being sent again. A crash between storing an Alert and sending it loses that notification rather than sending it twice.
- Removing an Alert Rule from the file drops its Alerts at the next restart, with no resolved notification.
- A Replay Rule already paused, or a queue already warned, fires at the next evaluation, also when the Alert Rule has just been deployed. A Replay Rule deployed with `startPaused` never fires. Removing a paused Replay Rule from the file sends a resolved notification.

**Startup refuses**, with a message naming the place in the file:

- An Alert Destination with an unknown `type`, an unset `urlEnv` or `signingSecretEnv`, a URL that is not `http` or `https`, `signingSecretEnv` on a type other than `webhook`, a malformed or duplicate name. This holds even for a destination no rule uses.
- An Alert Rule naming an undeclared destination or one twice, with a duplicate name, a malformed pattern or duration, a vhost outside the profile's `vhosts`, or anything but exactly one condition.
- A queue condition, `setupWarning` or `samplingFailing` on an `operatorToken` profile, which is not sampled.
- `replayRulePaused` on a profile with no Replay Rules, or with `rule:` naming a Replay Rule it does not have.
- A rule-level `for` on `samplingFailing`.

### Webhook schema

A generic webhook receives this JSON, in version 1. `version` changes if its shape does.

```json
{ "version": 1, "test": false, "alertId": "…", "status": "firing", "rule": "orders-deep", "profile": "prod", "vhost": "/",
  "queue": "orders.dlq", "condition": "depthAbove", "value": 500, "threshold": 100, "replayRule": null, "reason": null,
  "startedAt": "2026-10-30T10:00:00.000Z", "endedAt": null, "url": "https://volveran.example.com/…" }
```

| Field | Meaning |
| --- | --- |
| `version` | `1`. |
| `test` | `true` only on a test notification, which also has `status: firing`, `condition: test`, a new `alertId` and null `profile`. Your service should ignore these, so a test never pages anyone. |
| `alertId` | The same from an Alert's firing, through its repeats, to its resolved, so your service can deduplicate and pair them. |
| `status` | `firing` or `resolved`. A repeat is another `firing`. |
| `rule`, `profile` | The Alert Rule and its Broker Profile. |
| `vhost`, `queue` | Null when the condition is not about a queue. |
| `condition` | `depthAbove`, `arrivalsAbove`, `anyArrival`, `replayRulePaused`, `setupWarning` or `samplingFailing`. |
| `value`, `threshold` | As in the [Alert Rules table](#alert-rules), null where it says none. |
| `replayRule` | The Replay Rule of a `replayRulePaused` Alert, otherwise null. |
| `reason` | Why a condition on Volverán itself holds: the pause's reason (at most 500 characters), the set-up warning codes or the sampling error code. Otherwise null. |
| `startedAt`, `endedAt` | ISO 8601. `endedAt` is null until `resolved`. |
| `url` | Where to look in Volverán; null with no `VOLVERAN_PUBLIC_URL`. |

**Checking the signature.** With `signingSecretEnv`, a request also carries `x-volveran-timestamp` (Unix seconds) and `x-volveran-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">`. Check it over the raw body, before parsing, and refuse an old timestamp to stop replays. Each retry is signed anew, so a retried request has a fresh timestamp.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isFromVolveran(secret, rawBody, headers, maxAgeSeconds = 300) {
  const timestamp = headers['x-volveran-timestamp'];
  if (!(Math.abs(Date.now() / 1000 - Number(timestamp)) <= maxAgeSeconds)) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`);
  const given = Buffer.from(headers['x-volveran-signature'] ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

### The Alerts view

The Alerts view shows the firing and pending Alerts on the profiles you have a Role on, the selected profile's Alert Rules with their destinations, and the recent notifications with whether each was delivered and why not. A firing Alert also shows on its queue in the queue list. An `admin` can send a test notification from here.

- `GET /api/alerts` answers `{ alerts, notifications, destinations }`, with the latest 100 notifications you may see, and `403 no_role` with no Role anywhere. Test notifications belong to no profile, so only those who may send one see them.
- `GET /api/profiles/:profile/alert-rules` answers `{ rules }`. Any Role on the profile may read it.
- Destinations appear as names and types, never URLs or secrets.

Silencing, on-call schedules and grouping are out of scope. If you need them, route through Alertmanager with the [metrics](#metrics), or through the generic webhook into your paging tool.

## Metrics

Volverán serves Prometheus metrics when `VOLVERAN_METRICS_PORT` is set, and opens no port for them otherwise.

- The only route is `/metrics`, on its own port, at `VOLVERAN_HOST`'s address. In Solo Mode that is loopback.
- It needs no session, so keep the port away from anything but your scraper. The web app's port never serves metrics.
- A scrape never contacts a broker.
- Metric and label names stay stable within a minor version.
- Counters are held in memory and start again from zero after a restart, which `rate()` handles. A counter has no series until the first thing it counts.

### Metric reference

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `volveran_dead_letter_queue_messages` | gauge | `profile`, `vhost`, `queue` | Messages waiting in the dead-letter queue at its latest Sample. |
| `volveran_dead_letter_queue_estimated_arrived_messages_total` | counter | `profile`, `vhost`, `queue` | Estimated Messages that arrived in the dead-letter queue, counted once the depth has borne them out, as Alerts count them, so arrivals hidden by triage count one Sample late. Absent while arrivals are unknown. |
| `volveran_dead_letter_queue_setup_warnings` | gauge | `profile`, `vhost`, `queue`, `code`, `severity` | Set-up warnings of the queue at its latest Sample. `severity` is `loses_messages` or `may_lose_messages`. A code the queue does not have has no series, rather than 0. |
| `volveran_sampling_up` | gauge | `profile` | 1 if the Broker Profile's latest sampling run succeeded, 0 if it failed. Absent until it has ever run. |
| `volveran_sampling_last_success_timestamp_seconds` | gauge | `profile` | When the Broker Profile was last sampled successfully, in seconds since the Unix epoch. Absent if it never was. |
| `volveran_replay_rule_paused` | gauge | `profile`, `rule`, `reason` | 1 while the Replay Rule is paused, 0 while it runs. `reason` says why it is paused, in the words of whoever paused it or an automatic stop's code (such as `died_again`), and is empty otherwise. |
| `volveran_replay_rule_passes_total` | counter | `profile`, `rule`, `result` | Rule Passes, by `result`: `ran`, `skipped` or `failed`. |
| `volveran_apply_messages_total` | counter | `profile`, `decision`, `outcome` | Messages an Apply acted on, Rule Passes included. `decision` is `discard`, `replay` or `move`; `outcome` is `done`, `failed` or `not-attempted`. Kept Messages are not counted. |
| `volveran_checkouts_active` | gauge | | Active Checkouts. |
| `volveran_approvals_waiting` | gauge | | Checkouts waiting for Approval. |
| `volveran_audit_store_body_bytes` | gauge | | Bytes of Discarded Message bodies kept in the audit store. |
| `volveran_alerts_firing` | gauge | `profile`, `rule` | Alerts of the Alert Rule firing now; 0 for a rule with none. Pending Alerts are not counted. |
| `volveran_alert_notifications_total` | counter | `destination`, `outcome` | Notifications of Alerts, by Alert Destination and `outcome`: `delivered` or `failed` once its attempts are over. Test notifications are not counted. |

A paused rule's `reason` can be free text typed by an Operator, so a pause and resume with new words starts a new series. Alert on `max by (profile, rule) (volveran_replay_rule_paused) == 1`, not on one reason.

Dead-letter queue metrics come from the latest Samples, so they move once per sampling interval (`VOLVERAN_HISTORY_INTERVAL_SECONDS`):

- **While a broker is down** the queue metrics keep their last values and `volveran_sampling_up` is 0, so read a depth together with it. After a restart they are absent until the first good run; the two sampling metrics still show the last known run.
- **A deleted queue's** depth and warnings leave at the next good run. Its counter stays until the process restarts, and simply stops rising.
- **Arrivals are estimated**, because the broker does not count dead-lettered Messages: the change in depth since the Sample before, plus the Messages Volverán took out in between, never below zero. A consumer outside Volverán hides arrivals. Management statistics lag by a few seconds, so a take-out can land in an earlier interval than its drop in depth and briefly overstate the count. A queue's first Sample has unknown arrivals, so its counter has no series until the second.
- **`operatorToken` profiles are absent** from all of these. Such a profile connects with the signed-in Operator's token, and with nobody signed in there is no credential to sample with. A missing series for one is expected.

### Example alerts

Prometheus Operator rules for a deep dead-letter queue, a fast arrival rate, a lost broker and failed notifications. Adjust the thresholds and labels to your queues and your Prometheus's `ruleSelector`.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: volveran-dead-letters
spec:
  groups:
    - name: volveran-dead-letters
      rules:
        - alert: DeadLetterQueueDeep
          expr: volveran_dead_letter_queue_messages > 1000
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: '{{ $labels.queue }} on {{ $labels.profile }} holds {{ $value }} Messages'
        - alert: DeadLetterQueueFastArrivals
          # Over at least two sampling intervals; Messages per second.
          expr: rate(volveran_dead_letter_queue_estimated_arrived_messages_total[5m]) > 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: 'About {{ $value }} Messages per second arriving in {{ $labels.queue }} on {{ $labels.profile }}'
        - alert: VolveranLostBroker
          expr: volveran_sampling_up == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: 'Volverán cannot sample {{ $labels.profile }}: its queue metrics are out of date'
        - alert: VolveranNotificationsFailing
          expr: increase(volveran_alert_notifications_total{outcome="failed"}[15m]) > 0
          labels:
            severity: critical
          annotations:
            summary: 'Volverán could not deliver a notification to {{ $labels.destination }}: see the Alerts view for why'
        - alert: VolveranReplayRulePaused
          expr: max by (profile, rule) (volveran_replay_rule_paused) == 1
          labels:
            severity: warning
          annotations:
            summary: 'Replay Rule {{ $labels.rule }} on {{ $labels.profile }} is paused: see the Replay rules view for why'
        - alert: DeadLetterQueueLosesMessages
          expr: volveran_dead_letter_queue_setup_warnings{severity="loses_messages"} > 0
          labels:
            severity: critical
          annotations:
            summary: '{{ $labels.queue }} on {{ $labels.profile }} has the set-up warning {{ $labels.code }}'
```

### ServiceMonitor set-up

With the Prometheus Operator, the Helm chart does the set-up: `metrics.enabled` opens the port (9464 by default) and adds it to the Service, `metrics.serviceMonitor` renders the `ServiceMonitor`, and `networkPolicy.metricsFrom` admits the scraper to that port only. The `HTTPRoute` and `Ingress` never reference the port. Set the `ServiceMonitor`'s `labels` to what your Prometheus's `serviceMonitorSelector` matches. The [chart README](../charts/volveran/README.md#metrics-1) has the values.

Process metrics:

| Metric | Type | Meaning |
| --- | --- | --- |
| `process_cpu_user_seconds_total`, `process_cpu_system_seconds_total` | counter | CPU time spent, in seconds. |
| `process_resident_memory_bytes` | gauge | Resident memory size. |
| `process_start_time_seconds` | gauge | When the process started, in seconds since the Unix epoch. |
| `nodejs_heap_size_total_bytes`, `nodejs_heap_size_used_bytes` | gauge | Size and used size of the V8 heap. |
| `nodejs_external_memory_bytes` | gauge | Memory of C++ objects bound to JavaScript objects. |
| `nodejs_eventloop_lag_seconds` | gauge | Mean event-loop lag since the previous scrape. Absent until the first reading. |
