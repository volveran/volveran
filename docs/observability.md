# Observability

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
| `volveran_dead_letter_queue_estimated_arrived_messages_total` | counter | `profile`, `vhost`, `queue` | Estimated Messages that arrived in the dead-letter queue. Absent while arrivals are unknown. |
| `volveran_dead_letter_queue_setup_warnings` | gauge | `profile`, `vhost`, `queue`, `code`, `severity` | Set-up warnings of the queue at its latest Sample. `severity` is `loses_messages` or `may_lose_messages`. A code the queue does not have has no series, rather than 0. |
| `volveran_sampling_up` | gauge | `profile` | 1 if the Broker Profile's latest sampling run succeeded, 0 if it failed. Absent until it has ever run. |
| `volveran_sampling_last_success_timestamp_seconds` | gauge | `profile` | When the Broker Profile was last sampled successfully, in seconds since the Unix epoch. Absent if it never was. |
| `volveran_replay_rule_paused` | gauge | `profile`, `rule`, `reason` | 1 while the Replay rule is paused, 0 while it runs. `reason` says why it is paused, in the words of whoever paused it or an automatic stop's code (such as `died_again`), and is empty otherwise. |
| `volveran_replay_rule_passes_total` | counter | `profile`, `rule`, `result` | Rule Passes, by `result`: `ran`, `skipped` or `failed`. |
| `volveran_apply_messages_total` | counter | `profile`, `decision`, `outcome` | Messages an Apply acted on, Rule Passes included. `decision` is `discard`, `replay` or `move`; `outcome` is `done`, `failed` or `not-attempted`. Kept Messages are not counted. |
| `volveran_checkouts_active` | gauge | | Active Checkouts. |
| `volveran_approvals_waiting` | gauge | | Checkouts waiting for Approval. |
| `volveran_audit_store_body_bytes` | gauge | | Bytes of Discarded Message bodies kept in the audit store. |

A paused rule's `reason` can be free text typed by an Operator, so a pause and resume with new words starts a new series. Alert on `max by (profile, rule) (volveran_replay_rule_paused) == 1`, not on one reason.

Dead-letter queue metrics come from the latest Samples, so they move once per sampling interval (`VOLVERAN_HISTORY_INTERVAL_SECONDS`):

- **While a broker is down** the queue metrics keep their last values and `volveran_sampling_up` is 0, so read a depth together with it. After a restart they are absent until the first good run; the two sampling metrics still show the last known run.
- **A deleted queue's** depth and warnings leave at the next good run. Its counter stays until the process restarts, and simply stops rising.
- **Arrivals are estimated**, because the broker does not count dead-lettered Messages: the rise in depth since the Sample before, plus the Messages Volverán took out in between. A consumer outside Volverán hides arrivals. Management statistics lag by a few seconds, so a take-out can land in an earlier interval than its drop in depth and briefly overstate the count. A queue's first Sample has unknown arrivals, so its counter has no series until the second.
- **`operatorToken` profiles are absent** from all of these. Such a profile connects with the signed-in Operator's token, and with nobody signed in there is no credential to sample with. A missing series for one is expected.

### Example alerts

Prometheus Operator rules for a deep dead-letter queue, a fast arrival rate and a lost broker. Adjust the thresholds and labels to your queues and your Prometheus's `ruleSelector`.

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
```

Process metrics:

| Metric | Type | Meaning |
| --- | --- | --- |
| `process_cpu_user_seconds_total`, `process_cpu_system_seconds_total` | counter | CPU time spent, in seconds. |
| `process_resident_memory_bytes` | gauge | Resident memory size. |
| `process_start_time_seconds` | gauge | When the process started, in seconds since the Unix epoch. |
| `nodejs_heap_size_total_bytes`, `nodejs_heap_size_used_bytes` | gauge | Size and used size of the V8 heap. |
| `nodejs_external_memory_bytes` | gauge | Memory of C++ objects bound to JavaScript objects. |
| `nodejs_eventloop_lag_seconds` | gauge | Mean event-loop lag since the previous scrape. Absent until the first reading. |
