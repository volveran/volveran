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

Nothing is settled without its Audit Entry ([ADR 0001](adr/0001-apply-settles-each-message-at-least-once.md)), and Volverán sets `synchronous_commit` to `on` on its connections, whatever the server's default:

- **An Apply stops.** If a Message's Audit Entry cannot be written, that Message is reported `failed` and the rest `not-attempted`, and all of them go back to their queue. If the database goes while a step is in progress, that step finishes, since its `pending` Audit Entry is already committed. The entry stays `pending`, because its outcome could not be written. Look at the Message in question: it was settled, and Apply's result in the web app says so.
- **`/readyz` answers `503`**, within 2 seconds even if the database has vanished without closing its connections, so traffic goes elsewhere or the Service has no endpoints. The change is logged once. `/healthz` keeps answering `200`, so the pod is not restarted. Neither ever depends on a broker.
- **Other work waits.** The audit view and anything else that reads the store answer errors. Sampling, Alerts, Replay Rules and retention log what they could not do and try again on their next run. A call that gets no answer gives up within 40 seconds: up to 10 to get a connection, and 30 for the answer.
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

Setting the URL on an existing install starts on an empty database: it does not carry over what SQLite holds, and that stays untouched on its volume. To carry it over, [copy it](#copying-the-audit-trail) first. Going back to SQLite is only a matter of removing the URL, though what was written to PostgreSQL stays there.

## Copying the audit trail

`copy-audit-store` copies a SQLite store into an empty PostgreSQL, so the record has no seam in it: Audit Entries with their ids and replay ids, Discarded bodies (Restore works on them as before), Replay Rule state, depth history, notifications and Alerts. It works on a store of any released version.

**Volverán must be stopped.** Nothing can tell whether it is running, and anything it writes after the copy starts stays behind in SQLite.

It reads the store in `VOLVERAN_DATA_DIR` and the target from `VOLVERAN_POSTGRES_URL`, with `VOLVERAN_POSTGRES_REQUIRE_TLS` and `VOLVERAN_POSTGRES_CA_FILE` as [above](#tls). It takes no arguments and needs no profiles file.

```sh
docker run --rm \
  -v volveran-data:/data:ro \
  -e VOLVERAN_POSTGRES_URL \
  ghcr.io/volveran/volveran:<version> node dist/server/main.js copy-audit-store
```

From a checkout, `npm run build`, then `node dist/server/main.js copy-audit-store`. It prints each table's row count once PostgreSQL's matches SQLite's, then `OK`. It never prints the password.

Then start Volverán with the URL set.

What it does, and what it refuses:

- **A target with rows in any of Volverán's tables is refused**, so two audit trails cannot be merged by accident. A database where Volverán has only created its tables counts as empty. One it has run on for a while does not: create a new database.
- **Everything is one transaction.** On any failure, or if a row count differs, nothing is committed: fix the cause and run it again. The exit status is `1`, with one line saying why, as in the [table above](#when-it-cannot-start).
- **The source is only read.** It stays byte for byte as it was, also on a refusal or a failure, and its volume can be mounted read-only. The store is copied, with its write-ahead log, to the system's temporary directory (`TMPDIR`, or `/tmp`), and what is read is that copy, which is removed afterwards. An older store is brought up to this version's schema there, as starting this version on it would, so run the version you will run on PostgreSQL. A store newer than this version is refused. A path with no store is refused too, and creates nothing.
- **Row ids continue** after the highest SQLite ever gave, including ones retention has since removed, so no id means two things.
- **SQLite keeps its data**, so you can go back to it by the rules above: what happens after the move is only in PostgreSQL.

The temporary directory needs room for the store, plus what a migration adds. Size the database as [above](#sizing). Bodies are sent in batches, so memory stays small, but a large store takes a while. Nothing times out.

### On Kubernetes

The chart refuses `persistence.existingClaim` together with `postgres.existingSecret`, because a release on PostgreSQL mounts no volume. So run the copy as a Job of its own, while the release is still on SQLite and stopped, and only then switch the release over.

1. Create the database and the Secret, as [above](#connect-with-the-chart).
2. Stop Volverán: with Flux, `flux suspend helmrelease volveran -n volveran` first, then `kubectl -n volveran scale deployment/volveran --replicas=0`. The claim is `ReadWriteOnce` by default, so the Job could not mount it otherwise.
3. Run the Job below and read its log. Use the image version of the release you are upgrading to, and the name of your claim (`<release fullname>-data`; `kubectl -n volveran get pvc`).

   ```yaml
   apiVersion: batch/v1
   kind: Job
   metadata:
     name: volveran-copy-audit-store
     namespace: volveran
   spec:
     backoffLimit: 0
     template:
       spec:
         restartPolicy: Never
         automountServiceAccountToken: false
         securityContext:
           runAsNonRoot: true
           runAsUser: 1000
           runAsGroup: 1000
           fsGroup: 1000
           seccompProfile:
             type: RuntimeDefault
         containers:
           - name: copy
             image: ghcr.io/volveran/volveran:<version>
             args: ["node", "dist/server/main.js", "copy-audit-store"]
             securityContext:
               readOnlyRootFilesystem: true
               allowPrivilegeEscalation: false
               capabilities:
                 drop: ["ALL"]
             env:
               - name: VOLVERAN_DATA_DIR
                 value: /data
               - name: VOLVERAN_POSTGRES_URL
                 valueFrom:
                   secretKeyRef:
                     name: volveran-postgres
                     key: url
               - name: VOLVERAN_POSTGRES_REQUIRE_TLS
                 value: "true"
               # With a private CA, mount it and name it:
               # - name: VOLVERAN_POSTGRES_CA_FILE
               #   value: /ca/ca.crt
             volumeMounts:
               - name: data
                 mountPath: /data
                 readOnly: true
               # Holds a temporary copy of the store, so it needs room for all of it.
               - name: tmp
                 mountPath: /tmp
         volumes:
           - name: data
             persistentVolumeClaim:
               claimName: volveran-data
               readOnly: true
           - name: tmp
             emptyDir: {}
   ```

   ```sh
   kubectl -n volveran wait --for=condition=complete --timeout=1h job/volveran-copy-audit-store
   kubectl -n volveran logs job/volveran-copy-audit-store
   kubectl -n volveran delete job volveran-copy-audit-store
   ```

   A NetworkPolicy of your own that limits egress in the namespace must let this pod reach PostgreSQL too.
4. Set `postgres.existingSecret` and upgrade (with Flux: commit it and `flux resume helmrelease volveran -n volveran`). The claim stays in the cluster, untouched, until you delete it.
