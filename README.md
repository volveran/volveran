# Volverán

> *Volverán las oscuras golondrinas…* (Gustavo Adolfo Bécquer)

**Dead letters come back.** Volverán is open-source, self-hosted dead-letter triage for RabbitMQ. Hold the Messages in a dead-letter queue, decide what happens to each one, apply everything in one step, and restore anything you discarded by mistake.

> **Status: v0.2.0 released.** Solo Mode and Team Mode (OIDC sign-in), Checkout, Decisions (Discard, Replay, Move, Keep), Apply, Protected Profiles, the Audit view and Restore, and Kubernetes deployment with a signed Helm chart and a Flux CD example. Team safety (roles, four-eyes approval) is next. See the [roadmap](ROADMAP.md) and the [changelog](CHANGELOG.md).

## Why

The RabbitMQ management UI can peek at a queue, purge all of it, or shovel all of it somewhere else. Real dead-letter work is different: delete these 12, send these 40 back where they came from, move these 3 to a manual-handling queue, and keep a record of who did what.

Peeking is not free either. Every peek requeues the Message, and on quorum queues a requeue can use up one of the Message's delivery attempts.

## How it works

1. **Checkout.** Volverán takes the Messages at the head of a dead-letter queue and holds them, unacknowledged, so nobody else can act on them and nothing is requeued while you look. If Volverán or your browser dies, the broker returns every held Message to the queue.
2. **Decide.** Filter and select Messages, then give each one a Decision: **Discard**, **Replay** (back to the queue it was dead-lettered from), **Move** (to another queue, or to an exchange with a routing key) or **Keep**. All of it works from the keyboard: press `?` in the app for the shortcuts. No key Applies.
3. **Apply.** Every Decision is carried out in one step. Each Message is settled at-least-once, so a failure can create a duplicate but never loses a Message. You see the outcome for every Message.
4. **Audit and Restore.** Every action is recorded with who did it. Discarded Messages are kept so they can be Restored.

Messages that go back to the queue (Keep, an ended Checkout) keep their order, with one caveat on quorum queues. A classic queue puts each one back in its original position. A quorum queue puts them back in their original order ahead of newer Messages, but behind any Messages returned to it earlier, for example by another consumer ([RabbitMQ behaviour](docs/rabbitmq-behaviour.md#order-after-a-return)).

There are two modes. **Solo Mode** runs on your laptop with no sign-in and listens on loopback only. **Team Mode** is a shared service with single sign-on through any OIDC provider. Team Mode also runs on Kubernetes, from a Helm chart or with Flux CD ([Kubernetes guide](docs/kubernetes.md)).

## Quick start

The image is `ghcr.io/volveran/volveran`, built for `linux/amd64` and `linux/arm64`. Each release is tagged with its version (`0.2.0`) and the newest one also as `latest`. Release notes are in the [changelog](CHANGELOG.md).

### Solo Mode

Solo Mode is for one Operator on their own machine. It has no sign-in, so it only listens on a loopback address and refuses to start on anything else (`0.0.0.0`, a LAN address).

1. Write `profiles.yaml` from [`profiles.example.yaml`](profiles.example.yaml). Each Broker Profile names the environment variable holding its password (`passwordEnv`); passwords never go in the file. An optional `caFile` adds a PEM CA for `amqps://` and `https://` brokers signed by a private CA.
2. Export each password variable your profiles name, for example `export VOLVERAN_DEV_PASSWORD=guest`.
3. Run the image with the host's network, so Volverán's loopback address is your machine's loopback address:

```sh
docker run --rm --read-only --network host \
  -v "$PWD/profiles.yaml:/config/profiles.yaml:ro" \
  -v volveran-data:/data \
  -e VOLVERAN_OPERATOR="$USER" \
  -e VOLVERAN_DEV_PASSWORD \
  ghcr.io/volveran/volveran:0.2.0
```

4. Open <http://127.0.0.1:8080>.

With Docker Compose, copy [`docker-compose.example.yml`](docker-compose.example.yml) to `docker-compose.yml` next to `profiles.yaml` and run `docker compose up`.

The volume at `/data` holds the audit store (`audit.sqlite`): every Audit Entry and the full copy of every Discarded Message. Keep it across upgrades and back it up; it is the only thing Volverán writes, so the rest of the container stays `--read-only`. The image runs as the numeric user `1000:1000` (the `node` user), so Kubernetes can verify `runAsNonRoot`. A named volume (`volveran-data` above) is writable by it out of the box; to bind-mount a host directory instead, make it writable by uid 1000.

Why `--network host`: a container's own loopback cannot be reached through a published port (`-p`), and listening on `0.0.0.0` inside the container would rely on every `docker run` publishing the port on `127.0.0.1` only. With the host's network, `127.0.0.1` inside is `127.0.0.1` on your machine, and brokers on `localhost` work as written. On Docker Desktop (macOS, Windows), turn on host networking in Settings → Resources → Network (Docker Desktop 4.34 or later). Listening on the network with a published port is reserved for Team Mode (`VOLVERAN_AUTH=oidc`), which signs every Operator in.

### Team Mode

Team Mode (`VOLVERAN_AUTH=oidc`) is a shared service: Operators sign in through your OIDC provider (Keycloak, JumpCloud, Okta, Entra ID, ...) and every API call needs a session. The Operator recorded for an action is the signed-in person (the provider's `sub`, shown as their email or name); brokers are still reached with each Broker Profile's shared credentials.

1. Register Volverán at your provider as a confidential client using the authorization code flow, with redirect URL `https://<volveran-host>/auth/callback`. [docs/team-mode.md](docs/team-mode.md) has a generic guide and a worked example for Keycloak brokering JumpCloud.
2. Run the image listening on the network (`-e VOLVERAN_HOST=0.0.0.0 -p 8080:8080` instead of `--network host`; only Team Mode may), behind your TLS-terminating proxy or load balancer:

```sh
docker run --rm --read-only -p 8080:8080 \
  -v "$PWD/profiles.yaml:/config/profiles.yaml:ro" \
  -v volveran-data:/data \
  -e VOLVERAN_HOST=0.0.0.0 \
  -e VOLVERAN_AUTH=oidc \
  -e VOLVERAN_OIDC_ISSUER=https://sso.example.com/realms/ops \
  -e VOLVERAN_OIDC_CLIENT_ID=volveran \
  -e VOLVERAN_OIDC_CLIENT_SECRET \
  -e VOLVERAN_OIDC_REDIRECT_URL=https://volveran.example.com/auth/callback \
  -e VOLVERAN_SESSION_SECRET \
  -e VOLVERAN_DEV_PASSWORD \
  ghcr.io/volveran/volveran:0.2.0
```

| Variable | Default | Meaning |
|---|---|---|
| `VOLVERAN_AUTH` | `none` | `oidc` turns Team Mode on |
| `VOLVERAN_HOST` | `127.0.0.1` | `0.0.0.0` to listen on the network (only Team Mode may) |
| `VOLVERAN_OIDC_ISSUER` | required | the provider's issuer URL; Volverán reads `<issuer>/.well-known/openid-configuration` at startup and exits if it cannot |
| `VOLVERAN_OIDC_CLIENT_ID` | required | client ID |
| `VOLVERAN_OIDC_CLIENT_SECRET` | required | client secret (sent as `client_secret_post`) |
| `VOLVERAN_OIDC_REDIRECT_URL` | required | `https://<volveran-host>/auth/callback`, as the browser reaches it |
| `VOLVERAN_OIDC_SCOPES` | `openid email profile` | space-separated; must include `openid` |
| `VOLVERAN_OIDC_GROUPS_CLAIM` | `groups` | the claim listing the Operator's groups, which each Broker Profile's `roles` maps to a Role: a name or dotted path (`realm_access.roles`), read from the ID token, else from userinfo ([Team Mode guide](docs/team-mode.md#the-groups-claim)) |
| `VOLVERAN_SESSION_SECRET` | required | at least 32 characters (`openssl rand -hex 32`); signs the session cookie |

The issuer and redirect URL must use `https`, except on `localhost`/`127.0.0.1`. Sessions live in the Volverán process (one replica, see [ADR 0003](docs/adr/0003-single-replica-on-kubernetes.md)): they last 12 hours, **Sign out** ends them at once, and a restart signs everyone out. The session cookie is HTTP-only and `SameSite=Lax`, and `Secure` when the redirect URL is `https`.

### Kubernetes

The Helm chart `oci://ghcr.io/volveran/charts/volveran` runs Team Mode as a shared service: one replica, a PersistentVolumeClaim for the audit store, a pod that passes the `restricted` Pod Security Standard, and an optional `HTTPRoute` or `Ingress`. The chart version equals the Volverán version, and the chart is signed with keyless cosign like the image. Create the Secrets it references, write the values (OIDC settings, Broker Profiles, the route), and install:

```sh
kubectl create namespace volveran
kubectl -n volveran create secret generic volveran-oidc \
  --from-literal=client-secret='<OIDC client secret>' \
  --from-literal=session-secret="$(openssl rand -base64 48)"
kubectl -n volveran create secret generic volveran-broker-passwords \
  --from-literal=VOLVERAN_PROD_PASSWORD='<broker password>'
helm install volveran oci://ghcr.io/volveran/charts/volveran --version 0.2.0 \
  --namespace volveran -f values.yaml
```

The [Kubernetes guide](docs/kubernetes.md) has the values file and covers exposure, secrets, private CAs, upgrades and backups; every value is in the [chart README](charts/volveran/README.md). For GitOps, [`examples/flux/`](examples/flux/) is a Flux CD layout with a cosign-verified `OCIRepository`, a `HelmRelease` and SOPS-encrypted Secrets.

### Health checks

`GET /healthz` answers `200` whenever the process serves HTTP; `GET /readyz` answers `200` once startup has finished (configuration and Broker Profiles loaded, OIDC discovery done in Team Mode, audit store open; the server only starts listening after that) and `503` once shutdown starts. Both answer without a session in either mode, never check a broker (one unreachable broker does not make Volverán unready), return only `{"status":"ok"}` and are left out of the request log. Use them for Kubernetes probes or a Compose `healthcheck`.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VOLVERAN_PROFILES_FILE` | `./profiles.yaml` (`/config/profiles.yaml` in the image) | Broker Profiles file |
| `VOLVERAN_HOST` | `127.0.0.1` | listen address; Solo Mode accepts loopback only |
| `VOLVERAN_PORT` | `8080` | listen port |
| `VOLVERAN_AUTH` | `none` | `none` is Solo Mode; `oidc` is [Team Mode](#team-mode) |
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

A Checkout declares an exclusive lock queue `volveran.checkout.<queue>`, so each Broker Profile's broker user needs configure permission on queues matching `^volveran\.` in the vhosts it triages (see [ADR 0006](docs/adr/0006-checkout-mechanics-on-rabbitmq-4.md)).

## Learn more

- [Glossary](GLOSSARY.md): the vocabulary used everywhere in Volverán.
- [Architecture decisions](docs/adr/).
- [Roadmap](ROADMAP.md).
- [How Volverán compares](docs/comparison.md) with Warren, RabbitGUI and RabbitScout.

## Development

Requirements: Node.js 24 and Docker with Compose v2.

```sh
npm ci
npm run dev            # server and web app with reload (Vite on :5173; it proxies /api and /auth)
npm run lint           # typecheck server, web app and tests
npm test               # unit tests (no broker)
npm run test:broker    # starts the test broker, runs test/broker-facts/, stops the broker
npm run test:integration  # same for test/integration/
npm run test:chart     # renders charts/volveran with helm template and checks the manifests (needs Helm)
scripts/validate-chart.sh  # validates the rendered manifests and examples/flux/ with kubeconform (needs Helm, kubectl and kubeconform)
npm run test:smoke     # kind smoke test: installs the chart in a throwaway kind cluster and plays an Operator (needs kind, kubectl, Helm)
npm run build          # dist/server and dist/web
docker build -t volveran .   # the image, as the release workflow builds it
```

`npm run dev` needs a `profiles.yaml` in the checkout (ignored by git) and the password variables it names. Open the web app on `http://localhost:5173`: in development the server on `:8080` serves only the API (it serves the web app that `npm run build` makes). Integration tests start the app in-process through `startApp` in `test/integration/harness.ts`, on a random loopback port with a generated profiles file; `testProfile` points a Broker Profile at the checkout's test broker. TLS tests put `startTlsProxy` (certificates in `test/fixtures/tls/`) in front of a broker port.

**Releases.** Pushing a tag `v<version>` that matches `package.json` and `charts/volveran/Chart.yaml` (checked by `scripts/check-release-version.mjs` before anything is pushed) runs `.github/workflows/release.yml`: lint, unit tests and chart checks, then a multi-arch image (amd64, arm64) pushed to `ghcr.io/volveran/volveran:<version>` and `:latest` with an SBOM and provenance attestations, then the chart pushed to `oci://ghcr.io/volveran/charts/volveran`, and both signed with keyless cosign. A pre-release tag (`v0.2.0-rc.1`) gets no `latest` and publishes a pre-release chart version. The workflow's header comment has the `cosign verify` commands and the identity a Flux `OCIRepository` should match. Before tagging:

1. Move the `Unreleased` entries in [`CHANGELOG.md`](CHANGELOG.md) under the new version, with its compare and tag links at the bottom.
2. Bump the version in every file that names it. `npm run test:unit` and `npm run test:chart` fail on any that disagree with `package.json`, except the prose marked below.
   - `package.json` and (not checked) `package-lock.json`: `npm version <version> --no-git-tag-version` updates both.
   - `src/shared/product.ts` (the version the app reports; the server build compiles only `src/`, so it cannot import `package.json`).
   - `charts/volveran/Chart.yaml`: `version` and `appVersion`.
   - `README.md`: the image tags and the `helm install --version` of the quick start, and (not checked) the status line and the example tag in the quick start's introduction.
   - `docs/team-mode.md` (the image tag) and `docs/kubernetes.md` (`helm install --version`).
   - `docker-compose.example.yml` (the image tag).
   - On a new minor version: `ref.semver` in `examples/flux/app/ocirepository.yaml` and, not checked, the `0.<minor>.x` mentions in `examples/flux/README.md` and `docs/kubernetes.md`.
   - On a release that finishes a roadmap version: `ROADMAP.md` (not checked).

**Broker-facts suite.** `test/broker-facts/` checks every fact in [`docs/rabbitmq-behaviour.md`](docs/rabbitmq-behaviour.md) against a real RabbitMQ. Each test is named after the bullet it covers, word for word, and a unit test fails when a bullet has no test. When a RabbitMQ release changes a fact, fix the document, the ADRs that depend on it and the test together. CI runs the suite against the pinned image on every push and against the latest `rabbitmq:4-management` every week.

**Test broker.** `test/broker/` holds the compose file, `rabbitmq.conf` (15 s global `consumer_timeout`) and `definitions.json` (users, vhosts, origin queues and dead-letter queues). The compose file also runs a mock OIDC provider ([mock-oauth2-server](https://github.com/navikt/mock-oauth2-server), issuer `http://127.0.0.1:<port>/default`) for the Team Mode tests; `TestBrowser` in `test/integration/oidc-provider.ts` signs in through it as any `sub`, email and name. A second RabbitMQ, `rabbitmq-oauth` (`rabbitmq-oauth.conf`), has the OAuth 2.0 backend only and trusts the mock provider's signing key, which `oidc.json` pins (`oidc-signing-key.pem` is its public half), because RabbitMQ fetches signing keys over https only; the OAuth 2.0 broker facts connect to it with tokens from `test/broker/oauth.ts`. Every checkout gets its own broker: the compose project is named after the checkout's directory and path (`volveran-test-<dir>-<hash>`), and the host ports are random free ports on 127.0.0.1, so several worktrees can run tests at once. `npm run test:broker` and `test:integration` always tear their broker down. To iterate against a running broker:

```sh
npm run broker:up      # prints the project name and ports
npx vitest run --config vitest.broker-facts.config.ts test/broker-facts/publishing.test.ts
npm run broker:down
```

The test helpers find the running broker of the checkout on their own. Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `VOLVERAN_TEST_PROJECT` | derived from the checkout path | compose project name |
| `VOLVERAN_TEST_AMQP_PORT`, `VOLVERAN_TEST_MGMT_PORT` | random free ports | host ports of the broker |
| `VOLVERAN_TEST_OIDC_PORT` | random free port | host port of the mock OIDC provider |
| `VOLVERAN_TEST_OAUTH_AMQP_PORT`, `VOLVERAN_TEST_OAUTH_MGMT_PORT` | random free ports | host ports of the OAuth 2.0 broker |
| `VOLVERAN_TEST_KEEP_BROKER` | unset | `1` leaves the broker running after `test:broker` / `test:integration` |
| `VOLVERAN_TEST_RABBITMQ_IMAGE` | `rabbitmq:4.4.0-management` | RabbitMQ image to test against (both brokers) |

**kind smoke test.** `npm run test:smoke` (`scripts/kind-smoke.mjs`) builds the image, loads it into a new kind cluster `volveran-smoke` with RabbitMQ (seeded from `test/broker/`) and the mock OIDC provider over https (`test/smoke/deps.yaml`, certificates in `test/smoke/tls/`), and installs the chart from the checkout into the namespace `volveran-smoke`, which enforces the `restricted` Pod Security Standard, with the chart's NetworkPolicy on (kindnet enforces it, so the pod becoming ready shows the probes get through). `test/smoke/operator.test.ts` then signs in over port-forwards (local ports 18080, 18443 and 18672; `VOLVERAN_SMOKE_APP_PORT`, `VOLVERAN_SMOKE_OIDC_PORT`, `VOLVERAN_SMOKE_MGMT_PORT` change them), Discards a Message, deletes the pod, checks the Audit Entry and body survived, and checks that `helm upgrade` with a changed Broker Profile rolls the pod. A failed step prints the pods, events and logs. The cluster is deleted afterwards; `VOLVERAN_SMOKE_KEEP_CLUSTER=1` keeps it (and reuses it on the next run).

## License

[Apache License 2.0](LICENSE).

RabbitMQ is a trademark of Broadcom Inc. Volverán is not affiliated with or endorsed by Broadcom.
