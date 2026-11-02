# The audit store is one asynchronous interface

Until v0.5 the audit store was a class over `node:sqlite`, and about 17 server modules called it synchronously. PostgreSQL (#92) has no synchronous driver, so the rest of the server has to stop assuming a call finishes before the next line runs. The audit store becomes one interface, `AuditStore` in `src/server/audit/audit-store.ts`, with the four sub-stores behind it (`ruleState`, `history`, `notifications`, `alerts`). Every call answers through a promise. SQLite and PostgreSQL implement it, and a caller sees no SQL and cannot tell which is in use.

The interface holds these promises for any implementation:

- **A call is one atomic unit of work.** When its promise resolves the work is committed and durable, and when it rejects none of it happened. There is no way to open a transaction across calls: what must be atomic is one method, which the store carries out. A failure is always a rejection, never a throw at the call.
- **ADR 0001's order is the caller's to keep, by awaiting.** A settled `record` means the `pending` Audit Entry, and a Discard's copy of its Message, are durable; the Message may be acknowledged only after that.
- **A store call is an interleave point for the caller.** Other requests can run while one is awaited. A section that must be first-wins claims its state in memory before its first store call, never after.
- **Types are the store's vocabulary, not a database's.** Rows, statements and connections stay inside an implementation.

**On SQLite some of the interface is in memory.** Sessions and sign-ins in progress, Replicas' leases and Live Checkout records have no table there: one Replica needs no more, and a session then never reaches the data volume, so a restart signs everyone out. The same contract suite holds these memory stores to what PostgreSQL's tables do.

**One exception: `refreshTokens` waits on the provider inside its unit of work.** #92 asks that two Replicas refreshing at once do not spend a rotating refresh token twice, and only a lock held across the provider's answer gives that. So the exception is narrow: the method takes a callback, the lock is one of its own that no other call waits for (an advisory lock on PostgreSQL, a per-session queue in memory), at most 3 refreshes per process hold a connection, and the caller gives the provider 10 s. No other method may do this.

SQLite keeps doing its work synchronously inside each call (`SqliteAuditStore` never awaits within one), so its transactions cannot interleave and its speed does not change. Each write still fsyncs on the event loop, as it always has.

The move was an expand and contract: the interface came first beside the synchronous form, which handed out the asynchronous form on the same connection so that both could run together, callers moved in groups, and the synchronous form went when none was left. During the move the interface had the name it keeps, so moving a caller changed its import and added its awaits, and nothing was renamed at the end.

What the interface promises is checked by one contract suite, `auditStoreContract` in `test/support/audit-store-contract.ts`. It takes the implementation as a parameter and looks at nothing but the interface.

## Considered Options

- **Keep SQLite synchronous and give PostgreSQL its own code paths**: rejected, every caller would know which store is in use, and the two would drift.
- **Move SQLite to a worker thread as well, so it does not block the event loop**: rejected for now, it changes how SQLite behaves for the one set-up that must not change, and solves a problem nobody has reported.
- **A query builder or ORM shared by both stores**: rejected, the queries are few and plain, and the seam belongs at what callers ask for, not at how SQL is written. `audit/audit-entry-sql.ts` is not one: a small helper that holds the one thing the two stores must not let drift, how an Audit Entry's columns are written, searched and read back, taking only the parameter's spelling from each store. The line is that it holds finished statements for Audit Entries and composes nothing else. Each store keeps running them, and everything else stays written out per store.
- **A `transaction(fn)` on the interface**: rejected, it would hold a pooled connection across awaits in caller code and put the store's concerns back in the callers. A caller that needs two steps to be atomic gets a method that does both.

## Consequences

- A missing `await` on a call that answers nothing still compiles, and on SQLite the write has already happened, so the tests pass. `npm run lint` catches it with `no-floating-promises` unless the promise is passed on or `void`ed; beyond that, only a delayed store or PostgreSQL shows it. Tests of ADR 0001's order and of the races therefore run against a delayed store.
- Each caller now has store failures arriving as rejections in code that used to throw at the call; a floating call would become an unhandled rejection, which stops the process.
- An atomic operation a later feature needs (a claim on a body, a lease) is a new method here, with a test in the contract suite on both stores.
- PostgreSQL's implementation must carry out a multi-statement method on one pooled connection, in one transaction.
- Migrations are numbered and append-only, per store, with the version in the store (`PRAGMA user_version` on SQLite, the table `audit_store_version` on PostgreSQL). Both refuse a store newer than the binary at startup. PostgreSQL migrates under a session advisory lock, so Replicas starting together apply each migration once.
- PostgreSQL's TEXT cannot hold NUL, while a Message's message-id, a queue's name or an Operator's reason can contain one and SQLite keeps it. The PostgreSQL connection (`postgres-connection.ts`) stores NUL as U+0001 U+0001 and U+0001 as U+0001 U+0002 in every statement value, and reads every TEXT column back unchanged, so the two stores answer alike: the same value back, an exact search still exact, the same bytewise order. Stripping or replacing a NUL would have changed what the audit trail says, and BYTEA columns would have made the two schemas differ and every value unreadable to someone querying the database. Anyone reading or writing those tables other than through `createPool` must do the same.
