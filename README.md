# Volverán

> *Volverán las oscuras golondrinas…* (Gustavo Adolfo Bécquer)

**Dead letters come back.** Volverán is open-source, self-hosted dead-letter triage for RabbitMQ. Hold the Messages in a dead-letter queue, decide what happens to each one, apply everything in one step, and restore anything you discarded by mistake.

> **Status: pre-alpha.** The design is written down and checked against RabbitMQ by the broker-facts suite. The application runs in Solo Mode and lists queues; Checkout, Decisions and Apply have not landed yet. See the [roadmap](ROADMAP.md).

## Why

The RabbitMQ management UI can peek at a queue, purge all of it, or shovel all of it somewhere else. Real dead-letter work is different: delete these 12, send these 40 back where they came from, move these 3 to a manual-handling queue, and keep a record of who did what.

Peeking is not free either. Every peek requeues the Message, and on quorum queues a requeue can use up one of the Message's delivery attempts.

## How it works

1. **Checkout.** Volverán takes the Messages at the head of a dead-letter queue and holds them, unacknowledged, so nobody else can act on them and nothing is requeued while you look. If Volverán or your browser dies, the broker returns every held Message to the queue.
2. **Decide.** Filter and select Messages, then give each one a Decision: **Discard**, **Replay** (back to the queue it was dead-lettered from), **Move** (to a queue you name) or **Keep**.
3. **Apply.** Every Decision is carried out in one step. Each Message is settled at-least-once, so a failure can create a duplicate but never loses a Message. You see the outcome for every Message.
4. **Audit and Restore.** Every action is recorded with who did it. Discarded Messages are kept so they can be Restored.

There are two modes. **Solo Mode** runs on your laptop with no sign-in and listens on loopback only. **Team Mode** is a shared service with single sign-on through any OIDC provider. A Helm chart for Kubernetes and Flux CD is planned for v0.2.

## Running in Solo Mode

Solo Mode is for one Operator on their own machine. It has no sign-in, so it only listens on a loopback address and refuses to start on anything else (`0.0.0.0`, a LAN address).

1. Write a profiles file from [`profiles.example.yaml`](profiles.example.yaml). Each Broker Profile names the environment variable holding its password (`passwordEnv`); passwords never go in the file. An optional `caFile` adds a PEM CA for `amqps://` and `https://` brokers signed by a private CA.
2. Run the image with the host's network, so Volverán's loopback address is your machine's loopback address:

```sh
docker build -t volveran .
docker run --rm --read-only --network host \
  -v "$PWD/profiles.yaml:/config/profiles.yaml:ro" \
  -e VOLVERAN_OPERATOR="$USER" \
  -e VOLVERAN_DEV_PASSWORD \
  volveran
```

3. Open <http://127.0.0.1:8080>.

Why `--network host`: a container's own loopback cannot be reached through a published port (`-p`), and listening on `0.0.0.0` inside the container would rely on every `docker run` publishing the port on `127.0.0.1` only. With the host's network, `127.0.0.1` inside is `127.0.0.1` on your machine, and brokers on `localhost` work as written. On Docker Desktop (macOS, Windows), turn on host networking in Settings → Resources → Network (Docker Desktop 4.34 or later). Listening on the network with a published port is reserved for Team Mode (`VOLVERAN_AUTH=oidc`), which signs every Operator in.

| Variable | Default | Meaning |
|---|---|---|
| `VOLVERAN_PROFILES_FILE` | `./profiles.yaml` (`/config/profiles.yaml` in the image) | Broker Profiles file |
| `VOLVERAN_HOST` | `127.0.0.1` | listen address; Solo Mode accepts loopback only |
| `VOLVERAN_PORT` | `8080` | listen port |
| `VOLVERAN_AUTH` | `none` | `none` is Solo Mode; `oidc` (Team Mode) is not available yet |
| `VOLVERAN_OPERATOR` | `$USER` | your name, recorded as the Operator; startup fails if neither is set (Docker sets no `USER`) |
| `VOLVERAN_WEB_ROOT` | `dist/web` | built web app |
| `VOLVERAN_CHECKOUT_MAX_MESSAGES` | `1000` | most Messages one Checkout holds (up to 65,535) |
| `VOLVERAN_CHECKOUT_MAX_MB` | `100` | most body megabytes one Checkout holds |

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
npm run dev            # server and web app with reload (Vite on :5173)
npm run lint           # typecheck server, web app and tests
npm test               # unit tests (no broker)
npm run test:broker    # starts the test broker, runs test/broker-facts/, stops the broker
npm run test:integration  # same for test/integration/
npm run build          # dist/server and dist/web
```

`npm run dev` needs a `profiles.yaml` in the checkout (ignored by git) and the password variables it names. Integration tests start the app in-process through `startApp` in `test/integration/harness.ts`, on a random loopback port with a generated profiles file; `testProfile` points a Broker Profile at the checkout's test broker. TLS tests put `startTlsProxy` (certificates in `test/fixtures/tls/`) in front of a broker port.

**Broker-facts suite.** `test/broker-facts/` checks every fact in [`docs/rabbitmq-behaviour.md`](docs/rabbitmq-behaviour.md) against a real RabbitMQ. Each test is named after the bullet it covers, word for word, and a unit test fails when a bullet has no test. When a RabbitMQ release changes a fact, fix the document, the ADRs that depend on it and the test together. CI runs the suite against the pinned image on every push and against the latest `rabbitmq:4-management` every week.

**Test broker.** `test/broker/` holds the compose file, `rabbitmq.conf` (15 s global `consumer_timeout`) and `definitions.json` (users, vhosts, origin queues and dead-letter queues). Every checkout gets its own broker: the compose project is named after the checkout's directory and path (`volveran-test-<dir>-<hash>`), and the host ports are random free ports on 127.0.0.1, so several worktrees can run tests at once. `npm run test:broker` and `test:integration` always tear their broker down. To iterate against a running broker:

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
| `VOLVERAN_TEST_KEEP_BROKER` | unset | `1` leaves the broker running after `test:broker` / `test:integration` |
| `VOLVERAN_TEST_RABBITMQ_IMAGE` | `rabbitmq:4.4.0-management` | RabbitMQ image to test against |

## License

[Apache License 2.0](LICENSE).

RabbitMQ is a trademark of Broadcom Inc. Volverán is not affiliated with or endorsed by Broadcom.
