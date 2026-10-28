# Spring AMQP and MassTransit

Spring AMQP and MassTransit do not dead-letter through the broker. When a consumer gives up on a Message, the framework republishes it to an error queue itself, with headers describing the failure. These Messages carry no `x-death`, so without reading the framework's headers Volverán would show no dead-letter reason and no original queue. This page says what Volverán reads from each framework and where it shows it.

Volverán calls what the framework wrote the **Failure Details** of a Message ([Glossary](../GLOSSARY.md)).

## Where the Failure Details appear

- **Message list.** When a Message has no `x-death`, its dead-letter reason is the exception type and message (`System.TimeoutException: The payment API timed out`), and its original queue is MassTransit's input queue. When a Message carries both `x-death` and framework headers, `x-death` wins.
- **Message view.** A Failure Details section shows every field the framework wrote, with the stack trace collapsed. A MassTransit Message that was skipped rather than faulted is marked **skipped**.
- **Filter.** The **Failure** filter (`{ "kind": "failure", "value": "..." }`) selects the Messages whose exception type or message contains the text, in any case, so Select all matching can pick every Message that failed with the same exception.
- **Queue list.** A queue whose name ends in `_error` (MassTransit's error queues) is listed with the dead-letter queues, without configuring a filter. `_skipped` queues are not.
- **Export.** Each NDJSON line carries `failureDetails` (README, [Exporting Messages](../README.md#exporting-messages)).
- **API.** Message summaries and the Message view carry `failureDetails`, or `null` when no framework wrote any.

Replay is unchanged for now: Volverán Replays only to the queue named in a Message's `x-death` ([ADR 0005](adr/0005-replay-targets-the-dead-lettering-queue.md)). Move these Messages to the queue or exchange you choose.

## Spring AMQP

Read from the headers [`RepublishMessageRecoverer`](https://github.com/spring-projects/spring-amqp/blob/HEAD/spring-rabbit/src/main/java/org/springframework/amqp/rabbit/retry/RepublishMessageRecoverer.java) writes (also used by Spring Cloud Stream's `republishToDlq`). Volverán recognises a Spring AMQP Message by any `x-exception-*` header.

| Header | Field |
| --- | --- |
| `x-exception-message` | `message` |
| `x-exception-stacktrace` | `stackTrace` |
| `x-original-exchange` | `originalExchange` |
| `x-original-routingKey` (capital K) | `originalRoutingKey` |
| any other `x-exception-*` | `extra`, by header name |

Spring AMQP writes no separate exception type, so `exceptionType` is `null`; the type is the first line of the stack trace.

## MassTransit

Read from the headers named in [`MessageHeaders`](https://github.com/MassTransit/MassTransit/blob/HEAD/src/MassTransit.Abstractions/MessageHeaders.cs). Volverán recognises a MassTransit Message by `MT-Reason` or any `MT-Fault-*` header.

| Header | Field |
| --- | --- |
| `MT-Reason` | `reason`: `fault`, or `skip` when no consumer handled the Message type |
| `MT-Fault-ExceptionType` | `exceptionType` |
| `MT-Fault-Message` | `message` |
| `MT-Fault-StackTrace` | `stackTrace` |
| `MT-Fault-ConsumerType` | `consumerType` |
| `MT-Fault-MessageType` | `messageType` |
| `MT-Fault-Timestamp` | `faultAt` (ISO time; kept as written when it does not read as a time) |
| `MT-Fault-RetryCount` | `retryCount` |
| `MT-Fault-RedeliveryCount` | `redeliveryCount` |
| `MT-Fault-InputAddress` | `inputQueue`, and `extra` as written |
| `MT-Fault-Address` | `extra` as written |
| `MT-Host-*` | `host`, by the name after `MT-Host-` (`MachineName`, `ProcessName`, ...) |

The input queue is the last path segment of `MT-Fault-InputAddress` (`rabbitmq://rabbitmq.example.com/vhost/queue`), with the query string dropped and URL-decoded: `rabbitmq://rabbitmq.example.com/prod/submit-order?temporary=false` gives `submit-order`.

## Reading the headers

Byte-array values are decoded as UTF-8, and counts sent as text are read as numbers. A field the framework did not write is `null`. Header names are matched exactly, as AMQP header names are case-sensitive.
