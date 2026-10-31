# Configuration

Every setting is an environment variable.

| Variable | Default | Meaning |
|---|---|---|
| `VOLVERAN_PROFILES_FILE` | `./profiles.yaml` (`/config/profiles.yaml` in the image) | Broker Profiles file |
| `VOLVERAN_HOST` | `127.0.0.1` | listen address; Solo Mode accepts loopback only |
| `VOLVERAN_PORT` | `8080` | listen port |
| `VOLVERAN_AUTH` | `none` | `none` is Solo Mode; `oidc` is [Team Mode](team-mode.md) |
| `VOLVERAN_OPERATOR` | `$USER` | your name, recorded as the Operator; startup fails if neither is set (Docker sets no `USER`) |
| `VOLVERAN_WEB_ROOT` | `dist/web` | built web app |
| `VOLVERAN_DATA_DIR` | `./data` (`/data` in the image) | the audit store: Audit Entries and Discarded Messages, written with a durable commit before each Discard's ack |
| `VOLVERAN_POSTGRES_URL` | unset | keeps the audit store in this PostgreSQL database (`postgres://user:password@postgres.example.com:5432/volveran`) instead of SQLite in `VOLVERAN_DATA_DIR`. The database must exist and be UTF8; Volverán creates its tables in it, so its user needs that right ([PostgreSQL guide](postgresql.md)). |
| `VOLVERAN_POSTGRES_REQUIRE_TLS` | `false` | `true` refuses a connection to PostgreSQL without TLS, or with a certificate that does not verify; then leave `ssl`, `sslmode` and `sslrootcert` out of the URL |
| `VOLVERAN_POSTGRES_CA_FILE` | unset | PEM file with the CA of PostgreSQL's certificate, instead of the system's CAs. Requires TLS as above |
| `VOLVERAN_CHECKOUT_MAX_MESSAGES` | `1000` | most Messages one Checkout holds (up to 65,535) |
| `VOLVERAN_CHECKOUT_MAX_MB` | `100` | most body megabytes one Checkout holds |
| `VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES` | `30` | how long a Checkout may hold Messages before it ends itself (1 to 1440); on quorum queues the broker's `x-consumer-timeout` backstop is set 1 minute later |
| `VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS` | `120` | a Checkout whose browser has sent no heartbeat for this long ends (10 to 3600) |
| `VOLVERAN_BODY_RETENTION_DAYS` | `30` | Discarded Message bodies older than this are evicted (1 to 36500); Audit Entries are kept indefinitely, marked "body expired", and can no longer be Restored |
| `VOLVERAN_BODY_RETENTION_MAX_BYTES` | `1GiB` | most bytes of Discarded bodies kept in total, in bytes or with `KiB`, `MiB`, `GiB`, `TiB`; beyond it the oldest bodies are evicted first. The Audit view warns at 90 % |
| `VOLVERAN_BODY_RETENTION_INTERVAL_MINUTES` | `60` | how often retention runs (1 to 1440); it also runs at startup |
| `VOLVERAN_HISTORY_INTERVAL_SECONDS` | `60` | how often Volverán samples the dead-letter queues of every Broker Profile with shared credentials, reading only the management API (15 to 3600) |
| `VOLVERAN_HISTORY_RETENTION_DAYS` | `14` | how long Samples and the outcomes of notifications are kept (1 to 90); the retention job removes older ones ([sizing](observability.md#sizing)) |
| `VOLVERAN_PUBLIC_URL` | in Team Mode, the origin of `VOLVERAN_OIDC_REDIRECT_URL` | the base of the links in notifications; with neither, they carry no link |
| `VOLVERAN_METRICS_PORT` | off | serves Prometheus metrics at `/metrics` on this port, at `VOLVERAN_HOST`'s address, with no session; never on the web app's port ([metric reference](observability.md#metrics)) |

A Checkout declares an exclusive lock queue `volveran.checkout.<queue>`, so each Broker Profile's broker user needs configure permission on queues matching `^volveran\.` in the vhosts it triages (see [ADR 0006](adr/0006-checkout-mechanics-on-rabbitmq-4.md)). A Canary's watch queue `volveran.canary.<checkout id>` falls under the same configure permission; the broker user also needs write and read on it (`^volveran\.`) and read on the dead-letter exchanges of the queues it Replays to. Without them the Canary is unwatched, not refused.

### Health checks

`GET /healthz` answers `200` whenever the process serves HTTP; `GET /readyz` answers `200` once startup has finished (configuration and Broker Profiles loaded, OIDC discovery done in Team Mode, audit store open; the server only starts listening after that), `503` once shutdown starts, and on PostgreSQL `503` with `{"status":"unavailable"}` while the database cannot be reached, [recovering by itself](postgresql.md#when-the-database-goes-away). Both answer without a session in either mode, never check a broker (one unreachable broker does not make Volverán unready), otherwise return only `{"status":"ok"}` and are left out of the request log. Use them for Kubernetes probes or a Compose `healthcheck`.

## Checking the configuration

`check-config` is a mode of the image: it reads the profiles file and the environment as startup does, reports what it finds and exits. Use it in CI, or to try a file before an upgrade. Give it the file and the variables the deployment will have:

```sh
docker run --rm --read-only \
  -v "$PWD/profiles.yaml:/config/profiles.yaml:ro" \
  -e VOLVERAN_OPERATOR=ci -e VOLVERAN_DEV_PASSWORD \
  ghcr.io/volveran/volveran:<version> node dist/server/main.js check-config
```

From a checkout, `npm run build`, then `node dist/server/main.js check-config`. It takes no arguments: the file is the one `VOLVERAN_PROFILES_FILE` names.

| Exit status | Meaning |
|---|---|
| `0` | Volverán would start with this, and 1.0 will read the file. There may be warnings |
| `1` | Startup would refuse this. The first problem is printed; fix it and run again to see the next |
| `2` | Volverán would start with this, ignoring keys that 1.0 will refuse. Each is listed |

To accept unknown keys for now, treat `2` as a pass in your pipeline. A misspelt key is why it fails by default: `protekted: true` leaves a profile unprotected without a word.

It prints one finding a line, on stdout, starting `error:`, `refused in 1.0:` or `warning:`, then a summary. It names keys and variables, never their values. Warnings are a file without a version and a password variable that is not set, which startup also accepts (using that profile reports `password_not_set`).

It uses the same parser and checks as startup, so the two cannot disagree. It contacts no broker, opens no audit store and listens on nothing, which also means it cannot tell whether a broker is reachable, a password is right, or (in Team Mode) the OIDC issuer answers.

### The version of the profiles file

`version: 1` goes at the top of the file. A file without it is read as version 1, with a warning at startup. Any other value is refused, at startup and by `check-config`. The chart writes the version into the file it renders; a ConfigMap of your own (`brokerProfiles.existingConfigMap`) should carry it.

## Team Mode settings

| Variable | Default | Meaning |
|---|---|---|
| `VOLVERAN_AUTH` | `none` | `oidc` turns Team Mode on |
| `VOLVERAN_HOST` | `127.0.0.1` | `0.0.0.0` to listen on the network (only Team Mode may) |
| `VOLVERAN_OIDC_ISSUER` | required | the provider's issuer URL; Volverán reads `<issuer>/.well-known/openid-configuration` at startup and exits if it cannot |
| `VOLVERAN_OIDC_CLIENT_ID` | required | client ID |
| `VOLVERAN_OIDC_CLIENT_SECRET` | required | client secret (sent as `client_secret_post`) |
| `VOLVERAN_OIDC_REDIRECT_URL` | required | `https://<volveran-host>/auth/callback`, as the browser reaches it |
| `VOLVERAN_OIDC_SCOPES` | `openid email profile` | space-separated; must include `openid` |
| `VOLVERAN_OIDC_GROUPS_CLAIM` | `groups` | the claim listing the Operator's groups, which each Broker Profile's `roles` maps to a Role: a name or dotted path (`realm_access.roles`), read from the ID token, else from userinfo ([Team Mode guide](team-mode.md#the-groups-claim)) |
| `VOLVERAN_SESSION_SECRET` | required | at least 32 characters (`openssl rand -hex 32`); signs the session cookie |

The issuer and redirect URL must use `https`, except on `localhost`/`127.0.0.1`. Sessions live in the Volverán process (one replica, see [ADR 0003](adr/0003-single-replica-on-kubernetes.md)): they last 12 hours, **Sign out** ends them at once, and a restart signs everyone out. The session cookie is HTTP-only and `SameSite=Lax`, and `Secure` when the redirect URL is `https`.

## The audit store volume

The volume at `/data` holds the audit store (`audit.sqlite`): every Audit Entry and the full copy of every Discarded Message. Keep it across upgrades and back it up; it is the only thing Volverán writes, so the rest of the container stays `--read-only`. The image runs as the numeric user `1000:1000` (the `node` user), so Kubernetes can verify `runAsNonRoot`. A named volume (`volveran-data` above) is writable by it out of the box; to bind-mount a host directory instead, make it writable by uid 1000.

## Why Solo Mode uses the host network

Why `--network host`: a container's own loopback cannot be reached through a published port (`-p`), and listening on `0.0.0.0` inside the container would rely on every `docker run` publishing the port on `127.0.0.1` only. With the host's network, `127.0.0.1` inside is `127.0.0.1` on your machine, and brokers on `localhost` work as written. On Docker Desktop (macOS, Windows), turn on host networking in Settings → Resources → Network (Docker Desktop 4.34 or later). Listening on the network with a published port is reserved for Team Mode (`VOLVERAN_AUTH=oidc`), which signs every Operator in.
