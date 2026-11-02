# Upgrading from 0.x to 1.0

Upgrade directly from 0.5 or 0.6: there is no need to step through versions ([compatibility policy](compatibility.md#supported-upgrades)). Older versions are not a supported starting point, though the upgrade suite does start this version on a real store of every release since 0.1.

Most of this guide is about what 1.0 **refuses**, and what to do before it does. Everything else that changes is [further down](#what-changes-without-a-refusal).

## Before you upgrade

1. **Run `check-config` from the new image on your real file and variables** ([below](#1-an-unknown-key-in-the-profiles-file)). It finds the first three refusals here.
2. **Team Mode on PostgreSQL: add the session encryption key** ([refusal 3](#3-no-session-encryption-key-in-team-mode-on-postgresql)).
3. **Solo Mode: if you reach Volverán at any name but a loopback address, set `VOLVERAN_PUBLIC_URL`** ([refusal 7](#7-solo-mode-a-host-that-is-not-loopback)).
4. **Team Mode: if the browser reaches Volverán at more than one address, choose one** ([refusal 9](#9-team-mode-a-state-changing-request-from-a-foreign-origin)).
5. **Take a backup of the audit store**, since the upgrade migrates it and [there is no way back](#5-a-store-newer-than-the-version-starting). See [Kubernetes](kubernetes.md#backup-and-restore-of-the-audit-store) or [PostgreSQL](postgresql.md#backup-and-restore).
6. **Pick a time outside triage work.** The upgrade ends open Checkouts. Their Messages go back to their queues, but Decisions not yet Applied are lost.
7. **If you build on Volverán's image, or `exec` into it, read [the image](#the-image-moved-to-alpine).**

## What it refuses at startup

### 1. An unknown key in the profiles file

**This is the deliberate breaking change of 1.0.** A key the file does not have stops startup, at every level. It used to be ignored at the top level, in a Broker Profile and in a Replay rule's filter clause, so `protekted: true` silently left a profile unprotected.

```
Configuration error: /config/profiles.yaml: profiles[0] ("prod").protekted is not a key of a Broker Profile
```

**What is refused that may surprise you:**

- A misspelt key, of course, wherever it is: `valeu` in a filter clause, for example.
- A key that means nothing for that kind of filter clause, such as `value` on `died-again`.
- A top-level key holding YAML anchors (`x-common:`). Only `version`, `profiles` and `alertDestinations` are allowed there.
- A `<<` merge key. Write the keys out.

**Find them first.** `check-config` is the same parser and checks as startup, contacts no broker and listens on nothing. Give it what the deployment will have:

```sh
docker run --rm --read-only \
  -v "$PWD/profiles.yaml:/config/profiles.yaml:ro" \
  -e VOLVERAN_OPERATOR=ci -e VOLVERAN_DEV_PASSWORD \
  ghcr.io/volveran/volveran:<version> node dist/server/main.js check-config
```

- In Team Mode, also pass `VOLVERAN_AUTH=oidc`, the `VOLVERAN_OIDC_*` variables and `VOLVERAN_SESSION_SECRET`, or an `operatorToken` profile is refused for the wrong reason. Pass `VOLVERAN_POSTGRES_URL` if you use it, and the variables each Alert Destination names.
- It reports **the first problem only**. Fix it and run again.
- **To list all the unknown keys at once**, run the same command with `ghcr.io/volveran/volveran:0.6.1` first. It exits `2` and prints a `refused in 1.0:` line for each one. It does not see unknown keys in filter clauses, so run 1.0's afterwards anyway.

**On the chart:**

- With `brokerProfiles.existingConfigMap`, the file is yours, and the chart cannot see inside it. Get it out with `kubectl -n volveran get configmap <name> -o jsonpath='{.data.profiles\.yaml}'` and check it. One replica uses `Recreate`, so a refused file means the old pod has already gone when the new one fails.
- With inline `brokerProfiles.profiles`, the chart's values schema already refuses most unknown keys when it renders. It does not look inside a Replay rule's `filter`, so check the file too: `helm template volveran oci://ghcr.io/volveran/charts/volveran --version <version> -f values.yaml --show-only templates/configmap.yaml`, then take `profiles.yaml` out of it.

### 2. `check-config` no longer exits 2, and `version` must be 1

**`check-config` exits only `0` or `1`.** On 0.6 it exited `2` for keys that 1.0 would refuse. So a pipeline that treated `2` as a pass now gets `1` on an unknown key, because startup would refuse it. A pipeline that looks for `refused in 1.0:` lines should look for `error:`.

**A `version` other than 1 is refused** (since 0.6). A file with no `version` is still read as version 1, with a warning at startup, through 1.x. Add `version: 1` at the top of a file of your own. The chart writes it into the file it renders.

### 3. No session encryption key in Team Mode on PostgreSQL

Sessions and sign-ins in progress now live in the database, with their tokens encrypted, so Team Mode with `VOLVERAN_POSTGRES_URL` needs `VOLVERAN_SESSION_ENCRYPTION_KEY`. It must be at least 32 characters, differ from `VOLVERAN_SESSION_SECRET`, and be the same on every Replica. Nothing changes on SQLite or in Solo Mode, where it is not read.

```
Configuration error: Team Mode on PostgreSQL keeps sessions in the database, with their tokens encrypted, and needs VOLVERAN_SESSION_ENCRYPTION_KEY: ...
```

**On the chart,** add the key to the Secret named in `oidc.existingSecret` **before you upgrade**. It is read as a required Secret key (`session-encryption-key`, or `oidc.sessionEncryptionKeyKey`), so without it the pod stays in `CreateContainerConfigError`:

```sh
kubectl -n volveran patch secret volveran-oidc --type merge \
  -p "{\"stringData\":{\"session-encryption-key\":\"$(openssl rand -hex 32)\"}}"
```

If SOPS, Sealed Secrets or External Secrets manage that Secret, add it there, or the next sync removes it. A later change of key signs everyone out.

### 4. Settings that are checked if you set them

Each of these is new, and is refused only when you set it wrongly.

| Setting | Refused when | Note |
|---|---|---|
| `VOLVERAN_SESSION_IDLE_MINUTES` | Not a whole number from 1 to 720 | Default 60: see [sessions](#sessions-now-end-when-idle) |
| `VOLVERAN_FORWARDING_SECRET` | Under 32 characters | Only for several Replicas: [guide](replicas.md) |
| `VOLVERAN_FORWARDING_PORT` | Not a port, or equal to the web or metrics port | |
| `VOLVERAN_FORWARDING_ADDRESS` | Not `host:port`. IPv6 pod addresses are not supported | |
| `VOLVERAN_POSTGRES_URL` | Not a `postgres://` or `postgresql://` URL | The database must also be UTF8 and reachable, and its user able to create tables: [guide](postgresql.md) |
| `VOLVERAN_POSTGRES_REQUIRE_TLS`, `VOLVERAN_POSTGRES_CA_FILE` | Not `true` or `false`; without a URL; a CA with TLS off; `ssl`, `sslmode` or `sslrootcert` in the URL as well; a file that cannot be read | |

### 5. A store newer than the version starting

**Downgrades are refused, on both stores,** naming both schema versions. Starting 1.0 migrates a SQLite store to schema version 18, and a PostgreSQL store likewise, so a 0.x image cannot start on it afterwards:

```
Configuration error: The audit store is at schema version 18, newer than this version of Volverán understands (17). Downgrades are not supported: run the version that wrote the store, or a later one.
```

To go back, restore the store from your backup, and accept losing what was recorded since. 0.5 has no such check, so do not run it on a migrated store.

### 6. What the chart refuses to render

New since 0.5, each with a message naming the value:

- `replicaCount` above 1 without `postgres.existingSecret`, or without `forwarding.existingSecret`. Below 1 is refused as well. 0.x refused anything but 1.
- `forwarding.port` equal to 8080 or `metrics.port`.
- `postgres.ca.bundle` without `postgres.existingSecret`, with `postgres.requireTls: false`, or naming a bundle not in `caBundles.bundles`.
- `persistence.existingClaim` together with `postgres.existingSecret`.
- `extraEnv` setting a `VOLVERAN_POSTGRES_*` or `VOLVERAN_FORWARDING_*` variable. Use the values, which also add the port and close it.

With `replicaCount` above 1, a NetworkPolicy closing the internal port is always rendered, with no value to turn it off. It needs a CNI that enforces it: [guide](replicas.md).

## What it refuses per request

### 7. Solo Mode: a Host that is not loopback

Solo Mode has no credential but the loopback address, so a website could reach it through DNS rebinding. Any request, reads included, whose `Host` is not `localhost`, an address in `127.0.0.0/8` or `::1` answers `403 foreign_host`. The metrics port does too, with a bare 403.

You reach this if you use another name for your own machine, an entry in `/etc/hosts`, or a proxy or tunnel that passes its own `Host`, including a scraper reaching the metrics port that way.

**What to do:** use a loopback address, or set `VOLVERAN_PUBLIC_URL` to where you reach it, such as `http://mybox.example:8080`. That name is then accepted, and links in notifications use it too.

### 8. Solo Mode: a foreign Origin

Any request whose `Origin` is neither the `Host`'s own nor `VOLVERAN_PUBLIC_URL`'s answers `403 foreign_origin`. A page on another local port counts as another site, so a tool of your own calling Volverán from a browser at `http://localhost:3000` is refused. Scripts send no `Origin` and are not affected.

**What to do:** call it from outside a browser, or set `VOLVERAN_PUBLIC_URL` to that one origin.

### 9. Team Mode: a state-changing request from a foreign Origin

A request other than `GET`, `HEAD` or `OPTIONS` with an `Origin` other than `VOLVERAN_OIDC_REDIRECT_URL`'s or `VOLVERAN_PUBLIC_URL`'s answers `403 foreign_origin`, on any route, sign-out included. No `Origin` stays allowed, so API scripts are not affected.

You reach this if the same Volverán is reached at a second host name, or if a dashboard of yours in a browser calls its API.

**What to do:** use one address. If you need a second, set `VOLVERAN_PUBLIC_URL` to it; that is the only extra origin there is.

### 10. What a browser now refuses

Every answer carries a strict `Content-Security-Policy`, with `frame-ancestors 'none'` and `X-Frame-Options: DENY`.

- **Embedding Volverán in an iframe**, such as a portal page, stops working.
- **A proxy that injects a script or a style** into pages, such as a banner or analytics, is blocked by the browser.
- `Referrer-Policy: no-referrer` also makes a browser send `Origin: null` on a plain form POST or a `navigator.sendBeacon` to Volverán, and that is refused as foreign. Use `fetch`.

### 11. New answers a client should expect

Scripts on `/api` keep working: it is an alias of `/api/v1` through 1.x, with the same checks and answers. These codes and values are new. Treat one you do not know as an error to show, not a crash.

| Value | Where | Meaning | What a client does |
|---|---|---|---|
| `503 replica_shutting_down` | Starting a Checkout | The Replica is stopping | Try again; the answer has `error.tryAgain: true` |
| `503 replica_unreachable` | Any forwarded request | The Owner Replica cannot be reached now | Try again; nothing is reported lost |
| `409 restore_interrupted` | Restore | An earlier Restore of this body stopped before its outcome was known, in a crash. The Message may or may not be in the destination queue, so it is not republished | Look in that queue. It used to answer `already_restored` |
| `404 profile_not_found` | A Checkout whose Replica has gone and whose Broker Profile has left the file | The Messages are back, or will be | Stop asking. It also still means an unknown profile, as before |
| `lease-ran-out` | A Checkout's `endReason` | Its Replica could not reach the store for its lease (PostgreSQL only). It ended through Keep, so no Delivery Budget was used | Start another |
| `start-failed` | A Checkout's `endReason` (since 0.6) | The search for Died Again Messages failed. Today the start answers an error, so no view shows it | Nothing |

**Bad requests no longer answer 500.** Malformed or empty JSON answers `400 invalid_request`, a body over the limit `413 body_too_large`, an unsupported media type `415 unsupported_media_type`, a refused static file `403 forbidden`. An unhandled error answers a fixed `500 internal_error`, with the detail only in the log. A script that matched on an error's text from a 500 should use `error.code`.

## What changes without a refusal

### The image moved to Alpine

The image is built on `node:24-alpine`, not Debian's `node:24-slim`. Volverán itself works as before.

- **Its C library is musl.** A native npm module added to an image you build on it needs a musl build.
- **Packages come from `apk`,** not `apt-get`.
- **It has no `npm`, `npx`, `corepack` or `yarn`,** and no `bash`: use `sh`. `node` is there, so the [online backup](kubernetes.md#backup-and-restore-of-the-audit-store) and `check-config` work. Any script of yours that runs `kubectl exec ... npm` or `npx` must change.

From source, `engines` now says Node 24, not 24 or later ([why](compatibility.md#supported-versions)).

### A single SQLite pod rolls once

The chart now writes `version: 1` into the profiles file on SQLite as well, which changes the ConfigMap's checksum. A new image tag rolls the pod anyway. With `Recreate`, Volverán is unavailable until the new pod is ready, open Checkouts end, and everyone signs in again, as on any deploy. After this upgrade the version warning is gone.

### The grace period goes from 60 to 90 seconds

`pod.terminationGracePeriodSeconds` defaults to 90, as a stopping Replica now ends its Checkouts through Keep and stops a running Apply at its next step. **A value you set stays**, and should allow about 70 seconds at 1,000 Messages plus 40 ms for each Message above that. Too little, and each Message not yet taken back costs one delivery on a quorum queue. If you run Volverán outside the chart, give your orchestrator's stop the same time. See [Kubernetes](kubernetes.md#upgrades-and-restarts), which also has a known limit with `?heartbeat=0`.

### Answers now name `/api/v1`

An answer's `auditUrl` in a queue's history, and the text of `approval_required`, name `/api/v1`, under either prefix. Nothing else changes for a script. If you match on those strings or build on `auditUrl`, allow for it. The new path works; the old one still does too.

### Sessions now end when idle

In Team Mode a session ends after 60 minutes without activity, on top of the 12 hours (`VOLVERAN_SESSION_IDLE_MINUTES`). The next request answers `401 not_signed_in`, and the web app goes back through sign-in. On PostgreSQL a restart no longer signs anyone out. See [the details](configuration.md#session-idle-timeout).

### What is said about the order of returned Messages

Earlier guides and screens promised that returned Messages keep their order, and a quorum queue does not keep it on a large Checkout, with or without waiting. Volverán now says:

- **Classic queues:** back in the queue "in their original positions".
- **Quorum queues:** back in the queue "ahead of newer Messages but behind any returned earlier, in their original order unless the Checkout was large".

Nothing about the broker changed. If you relied on the old wording, do not rely on order after a large Checkout of a quorum queue ([RabbitMQ behaviour](rabbitmq-behaviour.md)).

### Ending a Checkout takes longer, and costs no Delivery Budget

On a quorum queue a Checkout's end now waits for the queue to take its Messages back before closing the channel: 40 ms per Message at most, at least 5 seconds, 40 seconds at the default limit. So `DELETE /api/v1/checkouts/:id` answers later, and the Operator and queue stay taken until it does. In exchange, Keep no longer uses up Delivery Budget, which was the known issue of 0.6.

### AMQP heartbeats default to 5 seconds

Connections ask for a 5 second heartbeat unless a profile's `amqpUrl` names its own `heartbeat`, so a lost host holds a queue's lock for about 15 seconds rather than about three minutes.

### Coming from 0.5

These arrived in 0.6, so 0.6 users already have them:

- **An Apply stops after a failed store write.** The rest are reported `not-attempted` and go back to the queue.
- **Some gauges can be up to 15 seconds old:** `volveran_replay_rule_paused`, `volveran_alerts_firing` and `volveran_audit_store_body_bytes`.
- **PostgreSQL is available, and never required.** Without `VOLVERAN_POSTGRES_URL` the store stays where it is. If you move, `postgres.requireTls` defaults to `true`, and [`copy-audit-store`](postgresql.md#copying-the-audit-trail) refuses a target that is not empty.

### Flux

`ref.semver: "0.6.x"` does not reach 1.0: change the range after doing the above. `1.0.x` skips release candidates, so use `>=1.0.0-0` to try one.

## Afterwards

- Look for a version warning in the log, and add `version: 1` to any file of your own.
- [Several Replicas](replicas.md) are optional, and need PostgreSQL. One Replica on SQLite stays a supported set-up.
- From here on, [the compatibility policy](compatibility.md) says what a version may change.

## How this was checked

Every refusal above was read from the code of this release. The profile, session key and idle timeout refusals were also run through the built `check-config`, and the Host and Origin refusals in real Firefox. The upgrade suite starts this version on real stores written by each release's own image, 0.1 to 0.6.1, on SQLite and after `copy-audit-store` on PostgreSQL, and those stores' profiles files load unchanged. They prove only the scenario's own files, not yours, which is why `check-config` comes first. Two real versions have not yet run side by side, as no later 1.x exists ([details](compatibility.md#during-a-rolling-update)).
