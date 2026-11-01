# Coding standards

Judgement calls that neither the compiler nor a test settles. Domain words are in [GLOSSARY.md](GLOSSARY.md), decisions and their reasons in [docs/adr/](docs/adr/).

## A multi-step store change that must be atomic is one method

Add a method to `AuditStore` that does all the steps, with its test in the contract suite ([ADR 0013](docs/adr/0013-audit-store-interface.md)). The test for "must be atomic": would a crash or a concurrent request between the steps leave a state another reader could see and act on wrongly? If so, it is one method, even when the two calls would sit on adjacent lines.

## A fix found in passing goes on the ticket

Write it down on the ticket you are working on, with the file and what is wrong, and leave the code as it is. The orchestrator decides whether to widen the ticket or open another. A reviewer can then read the diff as the ticket describes it. What the ticket needs in order to pass is part of the ticket, not a fix in passing.

## What "no change in behaviour" means on a ticket

It means everything an Operator or a client can observe stays identical:

- HTTP responses, status codes and error codes, and the text of messages, logs and the web app.
- Audit Entries, metric names and values, the profiles file, environment variables and the rendered chart.
- The order of effects on the broker and the store ([ADR 0001](docs/adr/0001-apply-settles-each-message-at-least-once.md)), which holds on a slow store as well as a fast one.

Internal timing, names and structure are free to change, and existing tests pass without their assertions being edited. If a difference is unavoidable, name it on the ticket: it is then a change the ticket asks for.
