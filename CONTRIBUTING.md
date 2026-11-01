# Contributing

Requirements: Node.js 24 and Docker with Compose v2.

```sh
npm ci
npm run dev            # server and web app with reload (Vite on :5173; it proxies /api and /auth)
npm run lint           # typecheck server, web app and tests, then ESLint (tools/lint) for what tsc cannot see: floating promises
npm run verify         # lint, unit and chart tests with capped workers: one summary line per step, the full output in verify.log
npm test               # unit tests (no broker)
npm run test:broker    # starts the test broker, runs test/broker-facts/, stops the broker
npm run test:integration  # same for test/integration/
npm run test:chart     # renders charts/volveran with helm template and checks the manifests (needs Helm)
scripts/validate-chart.sh  # validates the rendered manifests and examples/flux/ with kubeconform (needs Helm, kubectl and kubeconform)
npm run test:chart:release  # renders the chart from the last release tag and the working tree and fails on a difference not listed in test/chart/release-diff-allow.yaml (needs Helm)
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
   - `README.md`: the image tag and the `helm install --version` of the quick start. Then retake `docs/images` if the UI changed: `npm run build`, then `node scripts/test-broker.mjs run -- scripts/screenshots/capture.sh`.
   - `site/index.html` (the image tag).
   - `docs/team-mode.md` (the image tag) and `docs/kubernetes.md` (`helm install --version`).
   - `docker-compose.example.yml` (the image tag).
   - On a new minor version: `ref.semver` in `examples/flux/app/ocirepository.yaml` and, not checked, the `0.<minor>.x` mentions in `examples/flux/README.md` and `docs/kubernetes.md`.
   - On a release that finishes a roadmap version: `ROADMAP.md` (not checked).

After the release's image is published, add its upgrade fixture (see **Upgrade suite** below) and commit it. `test/integration/upgrade.test.ts` fails at the next version bump if it is missing.

**Pinning and scanning.** A workflow names an action as `owner/repo@<commit> # v1.2.3` and the Dockerfile its base image as `node:24-slim@sha256:<digest>`; `test/unit/supply-chain.test.ts` fails on anything else. Dependabot (`.github/dependabot.yml`) updates both, so take its pull requests rather than editing a pin by hand. To add an action, resolve its commit from the tag (`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`). `.github/workflows/security.yml` runs CodeQL, `npm audit` and the image scan, with a cut-off of high; the release workflow's first job repeats the last two. Reports of vulnerabilities go through [`SECURITY.md`](SECURITY.md).

**Upgrade suite.** `test/integration/upgrade.test.ts` starts the current version on a real audit store and profiles file of every release and checks, through the HTTP API, that Audit Entries, Discarded bodies and Replay Rule state are readable and that Restore works (`upgradeChecks` in `test/support/upgrade-checks.ts`). It runs with the integration suite, in CI too. On PostgreSQL the same checks run after `copy-audit-store` moved each fixture there, so the copy is proved on the same stores. Each release has `test/fixtures/upgrade/<version>/`, written once by that release's image and never edited by hand. To add one for a new release:

1. Add the version to `RELEASED_VERSIONS` in `test/support/upgrade-fixtures.ts`.
2. Run `npm run fixture:upgrade -- <version>`. It starts the test broker, runs `ghcr.io/volveran/volveran:<version>` in the broker's network, plays the scenario through its API, stops it cleanly and copies out what it wrote. If the release adds something the store or profiles file should hold, add it to the scenario for that version and up (`test/upgrade/generate-fixture.ts`), and a check to `upgradeChecks`.
3. Look through the new files for anything secret (`strings audit.sqlite`): they should hold only the scenario's made-up data, with passwords and webhook URLs in the environment.
4. Run `npx vitest run --config vitest.integration.config.ts test/integration/upgrade.test.ts` with the broker up, and commit the directory.

Another store can reuse this: copy a fixture with `copyFixtureStore`, start on it with `fixtureAppOptions`, and run `upgradeChecks`.

**Audit store contract.** `auditStoreContract` in `test/support/audit-store-contract.ts` holds what any audit store must do ([ADR 0013](docs/adr/0013-audit-store-interface.md)). It takes the implementation as a parameter and uses only the interface, so a new store method gets its test there, with nothing about a particular database. `test/unit/audit-store-contract.test.ts` runs it on SQLite; what only SQLite has, its migrations, the upgrade suite checks on real stores. `test/integration/audit-store-contract-postgres.test.ts` runs it on PostgreSQL, a database per test (`createTestDatabase` in `test/support/test-postgres.ts`), and `test/integration/postgres-migrations.test.ts` has PostgreSQL's own. Migrations are kept per store and are append-only. A change to the schema is a new entry in both.

**The integration suite on either store.** `VOLVERAN_TEST_AUDIT_STORE=postgres npm run test:integration` runs the whole suite on PostgreSQL; the default is `sqlite`, and CI runs both. `startApp` and `spawnServer` give an app a database of its own through `test/integration/test-store.ts`, as they would a data directory: a `dataDir` stands for one database for the file, so a test can restart the app on it. To seed or read that store, use `openTestStore(dataDir)`, never a particular store. A test about one store names it in `env`: `VOLVERAN_POSTGRES_URL` set for PostgreSQL, set to `undefined` for SQLite. The test PostgreSQL also takes TLS with the certificate in `test/fixtures/tls/`, and `startTcpProxy` in `test/support/tcp-proxy.ts` stands between an app and a database to take it away.

**Broker-facts suite.** `test/broker-facts/` checks every fact in [`docs/rabbitmq-behaviour.md`](docs/rabbitmq-behaviour.md) against a real RabbitMQ. Each test is named after the bullet it covers, word for word, and a unit test fails when a bullet has no test. When a RabbitMQ release changes a fact, fix the document, the ADRs that depend on it and the test together. CI runs the suite against the pinned image on every push and against the latest `rabbitmq:4-management` every week.

**Test broker.** `test/broker/` holds the compose file, `rabbitmq.conf` (15 s global `consumer_timeout`) and `definitions.json` (users, vhosts, origin queues and dead-letter queues). The compose file also runs a mock OIDC provider ([mock-oauth2-server](https://github.com/navikt/mock-oauth2-server), issuer `http://127.0.0.1:<port>/default`) for the Team Mode tests; `TestBrowser` in `test/integration/oidc-provider.ts` signs in through it as any `sub`, email and name. The compose file also runs PostgreSQL for the audit store, on throwaway storage. A second RabbitMQ, `rabbitmq-oauth` (`rabbitmq-oauth.conf`), has the OAuth 2.0 backend only and trusts the mock provider's signing key, which `oidc.json` pins (`oidc-signing-key.pem` is its public half), because RabbitMQ fetches signing keys over https only; the OAuth 2.0 broker facts connect to it with tokens from `test/broker/oauth.ts`. Every checkout gets its own broker: the compose project is named after the checkout's directory and path (`volveran-test-<dir>-<hash>`), and the host ports are random free ports on 127.0.0.1, so several worktrees can run tests at once. `npm run test:broker` and `test:integration` always tear their broker down. To iterate against a running broker:

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
| `VOLVERAN_TEST_POSTGRES_PORT` | random free port | host port of PostgreSQL |
| `VOLVERAN_TEST_KEEP_BROKER` | unset | `1` leaves the broker running after `test:broker` / `test:integration` |
| `VOLVERAN_TEST_LOCK_FILE` | unset | a path: `test:broker` / `test:integration` wait for this lock file and hold it until their broker is down, so the suites of several worktrees run one at a time. Give every worktree the same path; CI needs none |
| `VOLVERAN_TEST_RABBITMQ_IMAGE` | `rabbitmq:4.4.0-management` | RabbitMQ image to test against (both brokers) |
| `VOLVERAN_TEST_POSTGRES_IMAGE` | `postgres:17.6-alpine` | PostgreSQL image to test against |
| `VOLVERAN_TEST_AUDIT_STORE` | `sqlite` | the store the integration suite runs on: `sqlite` or `postgres` |

**kind smoke test.** `npm run test:smoke` (`scripts/kind-smoke.mjs`) builds the image, loads it into a new kind cluster `volveran-smoke` with RabbitMQ (seeded from `test/broker/`) and the mock OIDC provider over https (`test/smoke/deps.yaml`, certificates in `test/smoke/tls/`), and installs the chart from the checkout into the namespace `volveran-smoke`, which enforces the `restricted` Pod Security Standard, with the chart's NetworkPolicy on (kindnet enforces it, so the pod becoming ready shows the probes get through). `test/smoke/operator.test.ts` then signs in over port-forwards (local ports 18080, 18443 and 18672; `VOLVERAN_SMOKE_APP_PORT`, `VOLVERAN_SMOKE_OIDC_PORT`, `VOLVERAN_SMOKE_MGMT_PORT` change them), checks that the paused Replay rule in the values loaded, Discards a Message, deletes the pod, checks the Audit Entry and body survived, and checks that `helm upgrade` with a changed Broker Profile rolls the pod and keeps the rule paused. A failed step prints the pods, events and logs. The cluster is deleted afterwards; `VOLVERAN_SMOKE_KEEP_CLUSTER=1` keeps it (and reuses it on the next run).
