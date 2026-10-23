# Changelog

All notable changes to Volverán are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Volverán follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Work towards v0.1 (see the [roadmap](ROADMAP.md)).

### Added

- Solo Mode: no sign-in, listens on a loopback address only and refuses to start on any other. The Operator is taken from `VOLVERAN_OPERATOR`, else `USER`. (#2)
- Broker Profiles from a YAML file, with passwords from environment variables, `amqp`/`amqps` and `http`/`https`, and an optional CA file. (#2)
- Queue list per Broker Profile and vhost, with approximate depth, consumers and type; dead-letter queues first, streams marked as not available. (#2)
- Distinct connection errors for bad credentials, an unreachable broker, missing permissions and TLS failures. (#2)
- Docker image: multi-stage, runs as a non-root user and works with `--read-only`; Solo Mode runs with `--network host`. (#2)
- Release workflow: a tag `v<version>` publishes a multi-arch image (`linux/amd64`, `linux/arm64`) to `ghcr.io/volveran/volveran` as `<version>` and `latest`, with an SBOM and provenance attestations. (#13)
- README quick start and `docker-compose.example.yml`. (#13)
- Apply with Discard: each Discarded Message is written in full (body, properties, headers) to the audit store with a durable commit, then acked; every other Message goes back to the queue in order. Each Message gets its own outcome (done, failed and kept, not attempted); there is no rollback, and Apply is refused on a Lost Checkout. (#6)
- Audit store: SQLite with schema migrations in `VOLVERAN_DATA_DIR` (`/data` volume in the image); an Audit Entry per action records the Operator, broker user, Broker Profile, vhost, queue, `message_id`, action, reason, outcome and time. Read through `GET /api/audit-entries` and `GET /api/audit-entries/:id`. (#6)
- Replay: a Message is published through the default exchange to the queue that dead-lettered it (its latest `x-death` entry), never to other queues bound to its routing key, on a separate confirm channel with `mandatory`, and acked only once confirmed without a return. `CC`, `BCC`, `x-death`, `x-first-death-*`, `x-last-death-*`, `x-delivery-count` and `x-acquired-count` are removed and `x-volveran-replay-id` and `x-volveran-from` added; the Audit Entry keeps the original headers. A Replay the broker cannot route fails and the Message falls back to Keep. (#7)
- Audit browsing: search Audit Entries by Broker Profile, queue, `message_id`, action, Operator and date (`GET /api/audit-entries?profile=&queue=&messageId=&action=&operator=&from=&to=`), in a new Audit view of the web app. (#10)
- Restore: a Discarded Message is republished from its Audit Entry, byte for byte, to the queue it was Discarded from (default exchange) or to another existing queue, with the same header rules as Replay (`x-volveran-replay-id`, `x-volveran-from`), on a confirm channel with `mandatory`. Each Restore writes its own Audit Entry (action `restore`, linked to the Discard) as the signed-in Operator; it is refused while the Discard is still being Applied, once it has been Restored, and, unless the Operator accepts a possible duplicate, when the Discard's outcome is pending or uncertain. A Protected Profile needs the destination queue name typed. `POST /api/audit-entries/:id/restore`. (#10)
- Retention of Discarded bodies: kept for 30 days or until they reach 1 GiB in total, whichever comes first, oldest evicted first, checked at startup and hourly (`VOLVERAN_BODY_RETENTION_DAYS`, `VOLVERAN_BODY_RETENTION_MAX_BYTES`, `VOLVERAN_BODY_RETENTION_INTERVAL_MINUTES`). Audit Entries are kept indefinitely; an evicted one shows "body expired" and Restore is refused with the reason (`410 body_expired`). `GET /api/audit-store` reports the stored size against the limit, and the Audit view warns at 90 %. Audit store migration 2 adds `restore_of` and `body_expired_at`. (#10)
- Broker-facts suite: every fact in `docs/rabbitmq-behaviour.md` that the design depends on is checked against a real RabbitMQ, on every push against the pinned image and weekly against the latest `rabbitmq:4-management`. (#1)

[Unreleased]: https://github.com/volveran/volveran/commits/main
