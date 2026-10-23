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
- Broker-facts suite: every fact in `docs/rabbitmq-behaviour.md` that the design depends on is checked against a real RabbitMQ, on every push against the pinned image and weekly against the latest `rabbitmq:4-management`. (#1)

[Unreleased]: https://github.com/volveran/volveran/commits/main
