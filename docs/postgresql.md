# Running Volverán on PostgreSQL

By default the audit store is SQLite on one volume. Setting a connection URL keeps it in a PostgreSQL database instead, one your team already backs up and monitors: Audit Entries, Discarded bodies, Replay Rule state, depth history, notifications and Alerts. Every view behaves the same on either store.

SQLite stays the default, and Solo Mode never needs a database server. Volverán still runs one Replica on PostgreSQL. Several Replicas come in a later version.

Tested against PostgreSQL 17. Volverán uses no extensions.

## Set up the database

Volverán never creates the database, but it does create its tables, so its user needs that right. Since PostgreSQL 15 a new user cannot create tables in the `public` schema until told it may. The database must be UTF8.

```sql
CREATE USER volveran WITH PASSWORD '<password>';
CREATE DATABASE volveran OWNER volveran ENCODING 'UTF8' TEMPLATE template0;
```

A user that owns its database has every right it needs. If yours does not, connect to the database and grant them:

```sql
GRANT CONNECT ON DATABASE volveran TO volveran;
GRANT USAGE, CREATE ON SCHEMA public TO volveran;
```

Migrations run at startup, under an advisory lock. A store newer than the binary is refused, so an accidental rollback cannot damage the audit trail.

Volverán holds at most 10 connections, so count those in `max_connections`. It takes session-level advisory locks while migrating, so point it at PostgreSQL itself or at a connection pooler in session mode, not one in transaction mode.

## Connect with the chart

Put the URL in a Secret, by hand or with SOPS, Sealed Secrets or External Secrets. Percent-encode any special characters in the password.

```sh
kubectl -n volveran create secret generic volveran-postgres \
  --from-literal=url='postgres://volveran:<password>@postgres.example.com:5432/volveran'
```

```yaml
# values.yaml
postgres:
  existingSecret: volveran-postgres   # the key is `url`; postgres.urlKey changes it
```

The chart then renders no PersistentVolumeClaim and no data volume, and still runs one replica with `Recreate`. A claim left from before stays in the cluster, because it carries `helm.sh/resource-policy: keep`.

With `networkPolicy.egress` set, add a rule that lets the pod reach PostgreSQL.

## TLS

Audit Entries and Message bodies should not travel in the clear. The chart requires TLS by default: `postgres.requireTls` is `true`, so Volverán refuses a server that offers no TLS and a certificate that does not verify, including its host name. When a private CA signed the server's certificate, mount it as a [CA bundle](kubernetes.md#private-cas) and name it:

```yaml
caBundles:
  bundles:
    - name: postgres-ca
      secret: postgres-internal-ca   # or configMap:

postgres:
  existingSecret: volveran-postgres
  ca:
    bundle: postgres-ca              # the file is ca.crt; postgres.ca.key changes it
```

`postgres.requireTls: false` is for a database reached over a network you trust. It leaves TLS to the URL, which may then say `?sslmode=verify-full&sslrootcert=/path/to/ca.crt`.

Outside the chart, set [`VOLVERAN_POSTGRES_URL`, `VOLVERAN_POSTGRES_REQUIRE_TLS` and `VOLVERAN_POSTGRES_CA_FILE`](configuration.md). With either of the last two, leave `ssl`, `sslmode` and `sslrootcert` out of the URL. Volverán refuses the mix, because they would override each other. `check-config` checks all of this, and reads the CA file, without contacting the database.

## When it cannot start

Volverán prints one line saying why and exits with status 1, so the pod restarts until the cause is gone. No password is printed.

| The line says | What to do |
|---|---|
| `Could not reach PostgreSQL at <host>:<port>` | Check that it is running, the host and port, and any NetworkPolicy. A connection attempt gives up after 10 seconds. |
| `Could not make a TLS connection to PostgreSQL` | Check that the server offers TLS, that its certificate names the host in the URL, and that the CA file holds its CA. |
| `PostgreSQL at <host>:<port> refused the user` | Check the user and password in the URL, and `pg_hba.conf`. |
| `PostgreSQL at <host>:<port> has no database` | Create it, or correct the URL. |
| `The PostgreSQL user lacks a permission` | Grant the rights [above](#set-up-the-database). |
| `is encoded in LATIN1, and Volverán needs UTF8` | Create a new database with `ENCODING 'UTF8'`. A database that is not UTF8 could refuse a Message's headers or an Operator's reason, so it is refused before anything is written to it. |
| `The audit store is at schema version` | The store is newer than this version. Run the version that wrote it, or a later one. |

## When the database goes away

Nothing is settled without its Audit Entry ([ADR 0001](adr/0001-apply-settles-each-message-at-least-once.md)):

- **An Apply stops.** If a Message's Audit Entry cannot be written, that Message is reported `failed` and the rest `not-attempted`, and all of them go back to their queue without using up Delivery Budget. If the database goes while a step is in progress, that step finishes, since its `pending` Audit Entry is already committed. The entry stays `pending`, because its outcome could not be written. Look at the Message in question: it was settled, and Apply's result in the web app says so.
- **`/readyz` answers `503`**, within 2 seconds even if the database has vanished without closing its connections, so traffic goes elsewhere or the Service has no endpoints. The change is logged once. `/healthz` keeps answering `200`, so the pod is not restarted. Neither ever depends on a broker.
- **Other work waits.** The audit view and anything else that reads the store answer errors. Sampling, Alerts, Replay Rules and retention log what they could not do and try again on their next run. A call that gets no answer gives up after 30 seconds.
- **Volverán reconnects by itself.** Every call asks for a connection, so the first one after the database returns makes a new one. A failover needs no restart, and `/readyz` goes back to `200`.

Point the URL at a name that follows the primary, as failover set-ups provide. Volverán's tables cannot live on a read replica.

To alert on this, watch the pod's readiness, as `/readyz` follows the database.

## Sizing

Measured on PostgreSQL 17 with this schema, indexes included:

| What | Size | Notes |
|---|---|---|
| A Sample | about 150 bytes | with a queue name of 23 characters |
| An Audit Entry | about 650 bytes | a typical one with headers. Kept indefinitely |
| A Discarded body | about 1.3 × its size | Random bytes, so the worst case; text compresses. Bounded by `settings.bodyRetentionMaxBytes` |

So the default limit of 1 GiB of bodies can take about 1.3 GiB. Depth history is:

```
queues × (86,400 / interval in seconds) × retention in days × 150 bytes
```

| 100 dead-letter queues | 14 days | 90 days |
| --- | --- | --- |
| Every 60 s | 290 MiB | 1.8 GiB |
| Every 15 s | 1.2 GiB | 7.3 GiB |

Provision for this before turning on history at a short interval, and allow a further margin of about 30 %: PostgreSQL keeps removed rows' space for reuse rather than giving it back, so the tables grow for one retention period and then stay level, as long as autovacuum keeps up. A full disk stops every write, and with it every Apply.

The memory a long history request takes is the same as on SQLite ([sizing](observability.md#sizing)).

## Backup and restore

Back it up as you back up your other databases: `pg_dump`, or your provider's snapshots and point-in-time recovery. The whole audit trail is in this one database, including the only copy of each Discarded body, which Restore republishes.

Restore into an empty database of the same version or later, and point the URL at it. Restoring an older backup loses what happened since. Messages Discarded since then are gone for good, which is why retention of backups should at least cover your Restore window.

## Moving from SQLite

Setting the URL on an existing install starts on an empty database: it does not carry over what SQLite holds, and that stays untouched on its volume. Going back to SQLite is only a matter of removing the URL, though what was written to PostgreSQL stays there.

<!-- #104 describes copying an existing store here: the `copy-audit-store` command, while Volverán is stopped, into an empty database, verifying row counts. -->
