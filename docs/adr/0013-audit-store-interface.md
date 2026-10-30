# The audit store is one asynchronous interface

Until v0.5 the audit store was a class over `node:sqlite`, and about 17 server modules called it synchronously. PostgreSQL (#92) has no synchronous driver, so the rest of the server has to stop assuming a call finishes before the next line runs. The audit store becomes one interface, `AuditStore` in `src/server/audit/audit-store.ts`, with the four sub-stores behind it (`ruleState`, `history`, `notifications`, `alerts`). Every call answers through a promise. SQLite and PostgreSQL implement it, and a caller sees no SQL and cannot tell which is in use.

The interface holds these promises for any implementation:

- **A call is one atomic unit of work.** When its promise resolves the work is committed and durable, and when it rejects none of it happened. There is no way to open a transaction across calls: what must be atomic is one method, which the store carries out. A failure is always a rejection, never a throw at the call.
- **ADR 0001's order is the caller's to keep, by awaiting.** A settled `record` means the `pending` Audit Entry, and a Discard's copy of its Message, are durable; the Message may be acknowledged only after that.
- **A store call is an interleave point for the caller.** Other requests can run while one is awaited. A section that must be first-wins claims its state in memory before its first store call, never after.
- **Types are the store's vocabulary, not a database's.** Rows, statements and connections stay inside an implementation.

SQLite keeps doing its work synchronously inside each call (`SqliteAuditStore` wraps the synchronous store), so its transactions cannot interleave and its speed does not change. Each write still fsyncs on the event loop, as it always has.

The move is an expand and contract: the interface comes first beside the synchronous form, `AuditStore.async` hands out the asynchronous form on the same connection so that both can run together, callers move in groups, and the synchronous form goes when none is left. During the move the interface has the name it keeps, so moving a caller changes its import and adds its awaits, and nothing is renamed at the end.

## Considered Options

- **Keep SQLite synchronous and give PostgreSQL its own code paths**: rejected, every caller would know which store is in use, and the two would drift.
- **Move SQLite to a worker thread as well, so it does not block the event loop**: rejected for now, it changes how SQLite behaves for the one set-up that must not change, and solves a problem nobody has reported.
- **A query builder or ORM shared by both stores**: rejected, the queries are few and plain, and the seam belongs at what callers ask for, not at how SQL is written.
- **A `transaction(fn)` on the interface**: rejected, it would hold a pooled connection across awaits in caller code and put the store's concerns back in the callers. A caller that needs two steps to be atomic gets a method that does both.

## Consequences

- A missing `await` on a call that answers nothing compiles (`npm run lint` is the type check, with no floating-promise rule), and on SQLite the write has already happened, so the tests pass. Only a delayed store or PostgreSQL shows it. Tests of ADR 0001's order and of the races therefore run against a delayed store.
- Each caller now has store failures arriving as rejections in code that used to throw at the call; a floating call would become an unhandled rejection, which stops the process.
- An atomic operation a later feature needs (a claim on a body, a lease) is a new method here, with a test in the contract suite on both stores.
- PostgreSQL's implementation must carry out a multi-statement method on one pooled connection, in one transaction.
