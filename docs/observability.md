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
| `volveran_replay_rule_paused` | gauge | `profile`, `rule`, `reason` | 1 while the Replay rule is paused, 0 while it runs. `reason` says why it is paused, in the words of whoever paused it or an automatic stop's code (such as `died_again`), and is empty otherwise. |
| `volveran_replay_rule_passes_total` | counter | `profile`, `rule`, `result` | Rule Passes, by `result`: `ran`, `skipped` or `failed`. |
| `volveran_apply_messages_total` | counter | `profile`, `decision`, `outcome` | Messages an Apply acted on, Rule Passes included. `decision` is `discard`, `replay` or `move`; `outcome` is `done`, `failed` or `not-attempted`. Kept Messages are not counted. |
| `volveran_checkouts_active` | gauge | | Active Checkouts. |
| `volveran_approvals_waiting` | gauge | | Checkouts waiting for Approval. |
| `volveran_audit_store_body_bytes` | gauge | | Bytes of Discarded Message bodies kept in the audit store. |

A paused rule's `reason` can be free text typed by an Operator, so a pause and resume with new words starts a new series. Alert on `max by (profile, rule) (volveran_replay_rule_paused) == 1`, not on one reason.

Process metrics:

| Metric | Type | Meaning |
| --- | --- | --- |
| `process_cpu_user_seconds_total`, `process_cpu_system_seconds_total` | counter | CPU time spent, in seconds. |
| `process_resident_memory_bytes` | gauge | Resident memory size. |
| `process_start_time_seconds` | gauge | When the process started, in seconds since the Unix epoch. |
| `nodejs_heap_size_total_bytes`, `nodejs_heap_size_used_bytes` | gauge | Size and used size of the V8 heap. |
| `nodejs_external_memory_bytes` | gauge | Memory of C++ objects bound to JavaScript objects. |
| `nodejs_eventloop_lag_seconds` | gauge | Mean event-loop lag since the previous scrape. Absent until the first reading. |
