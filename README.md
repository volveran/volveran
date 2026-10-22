# Volverán

> *Volverán las oscuras golondrinas…* (Gustavo Adolfo Bécquer)

**Dead letters come back.** Volverán is open-source, self-hosted dead-letter triage for RabbitMQ. Hold the Messages in a dead-letter queue, decide what happens to each one, apply everything in one step, and restore anything you discarded by mistake.

> **Status: pre-alpha.** The design is written down. Code has not landed yet. See the [roadmap](ROADMAP.md).

## Why

The RabbitMQ management UI can peek at a queue, purge all of it, or shovel all of it somewhere else. Real dead-letter work is different: delete these 12, send these 40 back where they came from, move these 3 to a manual-handling queue, and keep a record of who did what.

Peeking is not free either. Every peek requeues the Message, and on quorum queues a requeue can use up one of the Message's delivery attempts.

## How it works

1. **Checkout.** Volverán takes the Messages at the head of a dead-letter queue and holds them, unacknowledged, so nobody else can act on them and nothing is requeued while you look. If Volverán or your browser dies, the broker returns every held Message to the queue.
2. **Decide.** Filter and select Messages, then give each one a Decision: **Discard**, **Replay** (to its original exchange and routing key), **Move** (to a queue you name) or **Keep**.
3. **Apply.** Every Decision is carried out in one step. Each Message is settled at-least-once, so a failure can create a duplicate but never loses a Message. You see the outcome for every Message.
4. **Audit and Restore.** Every action is recorded with who did it. Discarded Messages are kept so they can be Restored.

There are two modes. **Solo Mode** runs on your laptop with no sign-in and listens on loopback only. **Team Mode** is a shared service with single sign-on through any OIDC provider. A Helm chart for Kubernetes and Flux CD is planned for v0.2.

## Learn more

- [Glossary](GLOSSARY.md): the vocabulary used everywhere in Volverán.
- [Architecture decisions](docs/adr/).
- [Roadmap](ROADMAP.md).
- [How Volverán compares](docs/comparison.md) with Warren, RabbitGUI and RabbitScout.

## License

[Apache License 2.0](LICENSE).

RabbitMQ is a trademark of Broadcom Inc. Volverán is not affiliated with or endorsed by Broadcom.
