# Configuration

Every setting is an environment variable. Team Mode's OIDC settings are in the [Team Mode guide](team-mode.md).

| Variable | Default | Meaning |
|---|---|---|
| `VOLVERAN_PROFILES_FILE` | `./profiles.yaml` (`/config/profiles.yaml` in the image) | Broker Profiles file |
| `VOLVERAN_HOST` | `127.0.0.1` | listen address; Solo Mode accepts loopback only |
| `VOLVERAN_PORT` | `8080` | listen port |
| `VOLVERAN_AUTH` | `none` | `none` is Solo Mode; `oidc` is [Team Mode](team-mode.md) |
| `VOLVERAN_OPERATOR` | `$USER` | your name, recorded as the Operator; startup fails if neither is set (Docker sets no `USER`) |
| `VOLVERAN_WEB_ROOT` | `dist/web` | built web app |
| `VOLVERAN_DATA_DIR` | `./data` (`/data` in the image) | the audit store: Audit Entries and Discarded Messages, written with a durable commit before each Discard's ack |
| `VOLVERAN_CHECKOUT_MAX_MESSAGES` | `1000` | most Messages one Checkout holds (up to 65,535) |
| `VOLVERAN_CHECKOUT_MAX_MB` | `100` | most body megabytes one Checkout holds |
| `VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES` | `30` | how long a Checkout may hold Messages before it ends itself (1 to 1440); on quorum queues the broker's `x-consumer-timeout` backstop is set 1 minute later |
| `VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS` | `120` | a Checkout whose browser has sent no heartbeat for this long ends (10 to 3600) |
| `VOLVERAN_BODY_RETENTION_DAYS` | `30` | Discarded Message bodies older than this are evicted (1 to 36500); Audit Entries are kept indefinitely, marked "body expired", and can no longer be Restored |
| `VOLVERAN_BODY_RETENTION_MAX_BYTES` | `1GiB` | most bytes of Discarded bodies kept in total, in bytes or with `KiB`, `MiB`, `GiB`, `TiB`; beyond it the oldest bodies are evicted first. The Audit view warns at 90 % |
| `VOLVERAN_BODY_RETENTION_INTERVAL_MINUTES` | `60` | how often retention runs (1 to 1440); it also runs at startup |

A Checkout declares an exclusive lock queue `volveran.checkout.<queue>`, so each Broker Profile's broker user needs configure permission on queues matching `^volveran\.` in the vhosts it triages (see [ADR 0006](adr/0006-checkout-mechanics-on-rabbitmq-4.md)). A Canary's watch queue `volveran.canary.<checkout id>` falls under the same configure permission; the broker user also needs write and read on it (`^volveran\.`) and read on the dead-letter exchanges of the queues it Replays to. Without them the Canary is unwatched, not refused.

### Health checks

`GET /healthz` answers `200` whenever the process serves HTTP; `GET /readyz` answers `200` once startup has finished (configuration and Broker Profiles loaded, OIDC discovery done in Team Mode, audit store open; the server only starts listening after that) and `503` once shutdown starts. Both answer without a session in either mode, never check a broker (one unreachable broker does not make Volverán unready), return only `{"status":"ok"}` and are left out of the request log. Use them for Kubernetes probes or a Compose `healthcheck`.
