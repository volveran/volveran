# Exporting Messages

The owner of an active Checkout can download its held Messages as NDJSON, every one or only those matching the current filter (the **Export** buttons, or `POST /api/v1/checkouts/:id/export` with an optional `{ "filter": [...] }`). Exporting only reads: it never acks, rejects or reorders a Message, and leaves the Decisions as they are. The file is named `volveran-<profile>-<queue>-<UTC time>.ndjson` and is streamed, so even a Checkout at the 100 MB limit is never copied whole into memory. Each export is recorded as an Audit Entry (action `export`) with the Operator, profile, queue, Checkout, filter and number of Messages, but no copy of the Messages.

An export abandoned while its last line is being written is recorded `done`: the line was handed over, and Volverán cannot tell whether it arrived.

Each line is one JSON object per Message, in queue order:

| Field | Meaning |
| --- | --- |
| `v` | Line format version, `1`. |
| `position` | Where the Message stood in the Checkout, `1` being the head of the queue. A filtered export keeps these positions. |
| `messageId` | The `message_id` property, or `null`. |
| `exchange`, `routingKey` | What the Message was delivered with (for a dead-lettered Message, the dead-letter exchange's). |
| `properties` | Every AMQP property that is set except headers, with amqplib's names (`contentType`, `deliveryMode`, `timestamp` in seconds, ...). |
| `headers` | The headers. |
| `body` | The body exactly as sent, base64. |
| `bodyKind` | `json`, `text` or `binary`: how the Message view shows the body. |
| `xDeath` | The decoded `x-death` history, most recent first: `{ queue, reason, count, time, exchange, routingKeys, originalExpiration }`. |
| `deliveryBudget` | `{ remaining, warning }` on a quorum queue with a delivery limit, otherwise `null`. |
| `decision` | The Message's Decision when exported: `{ "kind": "keep" }`, `{ "kind": "discard", "reason": ... }`, `{ "kind": "replay" }` or `{ "kind": "move", "destination": { "queue": ... } \| { "exchange": ..., "routingKey": ... } }`. |
| `diedAgain` | `{ "replayId": ... }` when the Message carries a Volverán replay id (`x-volveran-replay-id`), otherwise `null`. |
| `failureDetails` | The Failure Details Spring AMQP or MassTransit wrote into the headers, decoded, otherwise `null` ([Spring AMQP and MassTransit](spring-amqp-and-masstransit.md)). Added in 0.4 with `v` still `1`. |

`properties` and `headers` use the same lossless AMQP JSON as Audit Entries, so they hold the Message byte for byte: a byte array is `{ "$bytes": "<base64>" }`, a 64-bit integer `{ "$bigint": "<decimal>" }`, and a table with a key starting with `$` is wrapped as `{ "$table": { ... } }`. Typed values such as decimals stay as amqplib decodes them (`{ "!": "decimal", "value": { "places": 2, "digits": 1234 } }`). For example, `jq -r 'select(.bodyKind == "json") | .body | @base64d' export.ndjson` prints the JSON bodies.
