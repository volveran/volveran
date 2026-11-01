# Running Volverán on Kubernetes

The Helm chart `oci://ghcr.io/volveran/charts/volveran` runs Volverán as a shared service: Team Mode (OIDC sign-in), one replica, and a PersistentVolumeClaim for the audit store, or [several Replicas](replicas.md) on PostgreSQL. This guide covers installing it with Helm or Flux CD, the values, exposure, secrets, private CAs, upgrades, and backing up the audit store. Every value is listed in the [chart README](../charts/volveran/README.md#values).

The chart is Team Mode only: Solo Mode has no sign-in and never listens off loopback ([ADR 0002](adr/0002-solo-and-team-modes.md)). By default it runs one replica with the `Recreate` strategy. Above that it needs PostgreSQL, and uses a rolling update ([Running several Replicas](replicas.md), [ADR 0014](adr/0014-replicas-forwarding-and-the-background-leader.md)). Its pods pass the `restricted` Pod Security Standard.

## What you need

- A Kubernetes cluster (the chart is validated against the 1.33 API) and Helm 3.8 or later, for OCI charts.
- A default StorageClass, or a `persistence.storageClass` to use. The claim is `ReadWriteOnce` by default.
- An OIDC provider and a confidential client registered for Volverán, with redirect URL `https://<volveran-host>/auth/callback` ([Team Mode guide](team-mode.md)). The pod must reach the provider: it reads the discovery document at startup and is not ready until it has.
- A Gateway API Gateway or an ingress controller that terminates TLS for `<volveran-host>`. Without one, you can still try Volverán through `kubectl port-forward`.
- The brokers' management API and AMQP ports reachable from the pod, and a broker user per Broker Profile.

## Install with Helm

The chart version always equals the Volverán version, and the chart runs the image of that version by default.

1. Create the namespace, labelled to enforce the `restricted` Pod Security Standard:

   ```sh
   kubectl create namespace volveran
   kubectl label namespace volveran pod-security.kubernetes.io/enforce=restricted
   ```

2. Create the Secrets. The chart never takes a secret as a value; it reads them from Secrets you name (see [Secrets](#secrets)):

   ```sh
   kubectl -n volveran create secret generic volveran-oidc \
     --from-literal=client-secret='<OIDC client secret>' \
     --from-literal=session-secret="$(openssl rand -base64 48)"
   kubectl -n volveran create secret generic volveran-broker-passwords \
     --from-literal=VOLVERAN_PROD_PASSWORD='<broker password>'
   ```

3. Write `values.yaml`:

   ```yaml
   oidc:
     issuer: https://login.example.com/realms/ops
     clientId: volveran
     redirectUrl: https://volveran.example.com/auth/callback
     existingSecret: volveran-oidc

   brokerProfiles:
     passwordsSecret: volveran-broker-passwords   # its keys become environment variables
     profiles:
       - name: prod
         managementUrl: https://rabbit.example.com:15671
         amqpUrl: amqps://rabbit.example.com:5671
         username: volveran
         passwordEnv: VOLVERAN_PROD_PASSWORD      # a key of passwordsSecret
         vhosts: ["/"]
         defaultQueueFilter: "*.dlq"
         protected: true

   httpRoute:
     enabled: true
     parentRefs:
       - name: edge                 # your Gateway
         namespace: gateways
         sectionName: https
     hostnames: [volveran.example.com]
   ```

4. Install:

   ```sh
   helm install volveran oci://ghcr.io/volveran/charts/volveran --version 0.6.1 \
     --namespace volveran -f values.yaml
   kubectl -n volveran rollout status deployment/volveran
   ```

   The install notes print the external URL, the redirect URL to register with the OIDC client, and a warning if the redirect URL's host is not a route host.

5. Open `https://volveran.example.com`. The browser goes to your provider and back, and the top bar shows the signed-in Operator.

The chart refuses to render, naming the value, when a required value is missing (`oidc.issuer`, `oidc.clientId`, `oidc.redirectUrl`, `oidc.existingSecret`, a Broker Profile) or wrong (`replicaCount` above 1 on SQLite or without `forwarding.existingSecret`, a `password` in a Broker Profile). `helm template` and Flux's HelmRelease status show the same message.

To try Volverán without a route, leave `httpRoute` out and port-forward:

```sh
kubectl -n volveran port-forward service/volveran 8080:8080
```

Then the redirect URL is `http://localhost:8080/auth/callback` (plain `http` is accepted on `localhost` only), registered as such with the OIDC client. The issuer must still be an `https` URL the pod can reach.

### Verify the chart's signature

The release workflow signs the chart and the image with keyless cosign, as the workflow `release.yml` of this repository running for a version tag:

```sh
cosign verify ghcr.io/volveran/charts/volveran:<version> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/volveran/volveran/\.github/workflows/release\.yml@refs/tags/v.*$'
```

The same command with `ghcr.io/volveran/volveran:<version>` verifies the image.

## Install with Flux CD

[`examples/flux/`](../examples/flux/) is a complete layout to copy into a fleet repository: a namespace enforcing `restricted` pod security, an `OCIRepository` that follows `0.6.x` and only accepts a chart signed by Volverán's release workflow, a `HelmRelease` with OIDC, inline Broker Profiles, persistence and an `HTTPRoute`, a Secret template encrypted with SOPS and your own age key, and the Flux `Kustomization` that decrypts it. Its [README](../examples/flux/README.md) walks through it.

The OIDC identity the `OCIRepository` matches is the one above:

```yaml
verify:
  provider: cosign
  matchOIDCIdentity:
    - issuer: '^https://token\.actions\.githubusercontent\.com$'
      subject: '^https://github\.com/volveran/volveran/\.github/workflows/release\.yml@refs/tags/v.*$'
```

The `ref.semver` range `0.6.x` picks up patch releases on its own and skips pre-releases (`0.6.1-rc.1`); a range such as `>=0.6.0-0` asks for them.

## Values

The [chart README](../charts/volveran/README.md#values) lists every value with its default. The values schema rejects unknown keys and wrong types, so `helm lint` and your editor catch typos. In short:

| Area | What it sets |
|---|---|
| `oidc` | Issuer, client ID, redirect URL, scopes, and the Secret with the client and session secrets. Required. |
| `brokerProfiles` | Inline `profiles` (the shape of `profiles.example.yaml`) and `alertDestinations`, or an `existingConfigMap`, and the `passwordsSecret`. A change to inline profiles rolls the pod. |
| `alerts` | The Secret holding the Alert Destinations' URLs and signing secrets. |
| `caBundles` | Private CAs mounted under `/etc/volveran/ca/<name>/`, for brokers and the OIDC provider. |
| `settings`, `extraEnv` | Checkout limits, time limit, heartbeat, body retention, and the depth history's interval and retention; other `VOLVERAN_*` variables. |
| `persistence` | The audit store claim: size, StorageClass, access mode, or an `existingClaim`. |
| `postgres` | The audit store on PostgreSQL instead: the Secret holding the URL, required TLS and a CA ([PostgreSQL guide](postgresql.md)). |
| `replicaCount`, `forwarding` | Several Replicas on PostgreSQL, the Secret they forward requests under, and their internal port ([guide](replicas.md)). |
| `httpRoute`, `ingress` | Exposure. Neither is rendered by default. |
| `metrics` | The Prometheus metrics port, off by default, and an optional `ServiceMonitor`. |
| `networkPolicy` | Who may reach the pod (`ingressFrom` the web app, `metricsFrom` the metrics port), and optionally where it may connect. With several Replicas, a policy always closes the internal port. |
| `image`, `pod`, `service` | Image repository, tag or digest, pull Secrets; resources, grace period, scheduling; the Service port. |

Pin the image by digest with `image.digest: sha256:<digest>`, and pull from a private mirror with `image.repository` and `image.pullSecrets`. Raise `pod.resources` memory together with `settings.checkoutMaxMb`: a Checkout holds its Message bodies in memory.

## Exposure

The chart renders a Gateway API `HTTPRoute` (`httpRoute`), a classic `Ingress` (`ingress`), both (for example while migrating), or neither. It never renders a Gateway or a certificate; it references a Gateway and TLS Secrets that already exist. An `HTTPRoute` needs the Gateway API CRDs (v1.0 or later) and a Gateway whose listener allows routes from Volverán's namespace.

- **Host-based routing only.** Volverán is served at the root of its own host: the session cookie is scoped to `/`, the sign-in cookie to `/auth`, and the web app loads from `/`. A path prefix (`https://tools.example.com/volveran`) breaks sign-in.
- **The redirect URL's host is the route host.** `oidc.redirectUrl` is `https://<route host>/auth/callback`, registered exactly so with the OIDC client. See [Team Mode on Kubernetes](team-mode.md#kubernetes).
- **TLS terminates at the Gateway or ingress controller.** The pod serves plain HTTP. An `https` redirect URL makes the session cookies `Secure` however the request reached the pod, so there is no proxy setting to add.

The [chart README](../charts/volveran/README.md#exposure) has an `Ingress` example. With `networkPolicy.enabled`, admit the Gateway's or ingress controller's pods in `networkPolicy.ingressFrom` ([Network policy](../charts/volveran/README.md#network-policy)).

## Metrics

`metrics.enabled` turns on the [metrics](observability.md#metrics) port (9464 by default) and adds it to the Service; the `HTTPRoute` and `Ingress` never reference it. `metrics.serviceMonitor` renders a `ServiceMonitor`, which needs the Prometheus Operator's CRDs: set its `labels` to what your Prometheus's `serviceMonitorSelector` matches, and optionally `interval` and `scrapeTimeout`.

The port has no session and listens on the pod's `0.0.0.0`. With `networkPolicy.enabled`, name the scraper in `networkPolicy.metricsFrom`, which admits it to that port only; until you do, nothing can scrape the pod. The [chart README](../charts/volveran/README.md#metrics-1) has an example.

## Alerts

Alert Rules go under each profile (`alerts`) and Alert Destinations under `brokerProfiles.alertDestinations`, or both in the file of an `existingConfigMap`. Nothing notifies anyone until you declare them. Destination URLs and signing secrets go in the Secret named by `alerts.existingSecret`, and Volverán refuses to start when one is not set. The links in notifications use the origin of `oidc.redirectUrl`; set `VOLVERAN_PUBLIC_URL` through `extraEnv` for another. With `networkPolicy.egress` set, allow the destinations. The [observability guide](observability.md#alerts) has Slack, Teams and webhook set-ups.

## Sizing the audit store

This is for SQLite. On PostgreSQL, see its [sizing](postgresql.md#sizing).

The audit store holds Discarded bodies and, since 0.5, the depth history. A Sample takes about 100 bytes, so 100 dead-letter queues at the default one-minute Samples and 14 days take about 190 MiB ([sizing](observability.md#sizing)). Discarded bodies may take up to `settings.bodyRetentionMaxBytes`, 1 GiB by default, which is also the default `persistence.size`, so raise the claim or lower that limit. A claim can only grow if its StorageClass allows expansion. Set `settings.historyIntervalSeconds` and `settings.historyRetentionDays` with this in mind, and raise `pod.resources` memory with very long or very fine history.

## Secrets

The chart only references Secrets by name, so SOPS, Sealed Secrets, External Secrets or `kubectl create secret` can manage them, and no credential ever sits in values or in a chart-rendered object.

| Secret | Value | Keys |
|---|---|---|
| OIDC | `oidc.existingSecret` | `client-secret` (`oidc.clientSecretKey`): the OIDC client secret. `session-secret` (`oidc.sessionSecretKey`): at least 32 characters, signs the session cookies. On PostgreSQL, `session-encryption-key` (`oidc.sessionEncryptionKeyKey`): at least 32 characters, encrypts the tokens of sessions in the database. |
| Broker passwords | `brokerProfiles.passwordsSecret` | One key per Broker Profile, named as its `passwordEnv`. Every key becomes an environment variable of the pod, so name keys as environment variables (`VOLVERAN_PROD_PASSWORD`). |
| Alert Destinations | `alerts.existingSecret` | One key per `urlEnv` and `signingSecretEnv`. Every key becomes an environment variable of the pod. |

Adding a Broker Profile means adding its profile to the values and its key to the passwords Secret, with no template change.

The pod reads Secrets at startup. After changing one, restart Volverán (`kubectl -n volveran rollout restart deployment/volveran`), which signs everyone out on SQLite (see [Upgrades](#upgrades-and-restarts)). A new session secret also invalidates every session cookie, and a new session encryption key every session in the database.

## Private CAs

Mount a private CA from an existing ConfigMap or Secret with `caBundles.bundles`. Each bundle is a directory `/etc/volveran/ca/<name>/` with one file per key.

- **Brokers.** Reference the file from the Broker Profile's `caFile`, by absolute path: `caFile: /etc/volveran/ca/broker-ca/ca.crt`. It applies to that profile's `amqps` and `https` connections.
- **OIDC provider.** Name the bundle in `caBundles.oidcTrust.bundle` (and its key in `caBundles.oidcTrust.key`, `ca.crt` by default). The chart sets `NODE_EXTRA_CA_CERTS` to it, which Node.js adds to the public CAs, so an internal Keycloak's discovery document, token endpoint and keys can be read.

```yaml
caBundles:
  bundles:
    - name: broker-ca
      configMap: rabbit-internal-ca
    - name: corporate-ca
      secret: corporate-root-ca
  oidcTrust:
    bundle: corporate-ca
```

## Upgrades and restarts

Upgrade with `helm upgrade volveran oci://ghcr.io/volveran/charts/volveran --version <version> --namespace volveran -f values.yaml`, or let Flux's `semver` range pick the new version up. Read the [changelog](../CHANGELOG.md) first; the chart and the app share one version.

**A deploy ends open Checkouts and, on SQLite, signs everyone out.** The same is true of every pod restart: a values change that rolls the pod, a node drain or an eviction.

- On SQLite, sessions live in the Volverán process, so every Operator signs in again afterwards. On PostgreSQL they live in the database and survive it.
- On `SIGTERM`, Volverán reports not ready at once (`/healthz` stays `200`), refuses new Checkouts with `503` `replica_shutting_down`, gives up the Background Leader lease, and ends every open Checkout the way **End Checkout** does: its held Messages go back to their queues, with no Delivery Budget used. An Apply in progress stops at its next step: the step under way finishes, and the rest go back as Keep. Decisions not yet Applied are lost. The Checkout's end reason is `shutdown`, which the web app says, through any Replica, for as long as a Checkout that is over stays readable. With one Replica there is no other to say so: after the restart the Checkout is simply not found. If the pod is killed before that is done, the broker returns every unsettled Message when the connection drops ([ADR 0001](adr/0001-apply-settles-each-message-at-least-once.md)).
- `pod.terminationGracePeriodSeconds` (90 by default) is the time it has for that before `SIGKILL`. At the default limit of 1,000 Messages the worst case per Checkout is about 70 seconds: up to 15 for the Apply step or start under way on a broker going silent (its heartbeats), up to 40 for a quorum queue to take its Messages back (40 ms per Message, at least 5 seconds; about 20 measured on a busy machine), and up to 5 each for closing the channel, deleting the lock queue and closing the connection. Checkouts end side by side, so this does not add up across them, and background work stops alongside rather than before, notifications in progress included (up to 5 seconds). The other 20 seconds are for writing the records and ending the lease, which are milliseconds with a healthy database, and up to 5 for requests still in progress; running out there costs no Delivery Budget. To keep the margin, add 40 ms for each Message above 1,000 when you raise `VOLVERAN_CHECKOUT_MAX_MESSAGES`: 5,000 needs about 250 seconds.
- With one replica, the `Recreate` strategy stops the old pod before the new one starts, so two pods never write the audit store. Volverán is unavailable until the new pod is ready. With [several Replicas](replicas.md), a rolling update keeps one serving, and each pod's Checkouts end as it goes.

Plan deploys outside triage work, and tell Operators before one.

A change to inline `brokerProfiles.profiles` rolls the pod by itself. A change to an `existingConfigMap` or a Secret does not: restart the Deployment.

## Backup and restore of the audit store

On PostgreSQL, see [backup and restore](postgresql.md#backup-and-restore) there. On SQLite, the audit store is one SQLite database, `/data/audit.sqlite`, on the chart's PersistentVolumeClaim (`volveran-data` for a release named `volveran`). It holds every Audit Entry, the full copy of every Discarded Message, which Restore republishes, the depth history and the state of Alerts. The claim carries `helm.sh/resource-policy: keep`, so `helm uninstall`, and Flux uninstalling a pruned `HelmRelease`, leave it in place; delete it by hand to delete the audit trail. The keep policy does not survive deleting the namespace, which deletes every claim in it. The Flux example's namespace carries `kustomize.toolkit.fluxcd.io/prune: disabled`, so removing the example's Flux `Kustomization` (which has `prune: true`) uninstalls Volverán but leaves the namespace and the claim; delete the namespace by hand when you mean to. If you manage the namespace some other way, keep it out of anything that prunes it.

The database runs in WAL mode, so a copy of the file alone, taken while Volverán runs, can miss recent commits. Use one of these:

- **Volume snapshots.** A CSI `VolumeSnapshot` of the claim is a point-in-time copy of the database and its WAL, which SQLite opens as after a power loss, losing nothing that was committed. Schedule them with your snapshot or backup tool (Velero, for example).
- **An online copy.** SQLite's backup API makes a consistent copy while Volverán runs. Node.js has it built in, so the Volverán image can make the copy itself:

  ```sh
  kubectl -n volveran exec deployment/volveran -- node -e \
    "const s = require('node:sqlite'); s.backup(new s.DatabaseSync('/data/audit.sqlite'), '/data/audit-backup.sqlite')"
  kubectl -n volveran cp "$(kubectl -n volveran get pod -l app.kubernetes.io/name=volveran -o name | cut -d/ -f2)":/data/audit-backup.sqlite ./audit-backup.sqlite
  kubectl -n volveran exec deployment/volveran -- rm /data/audit-backup.sqlite
  ```

  The copy needs as much free space on the volume as the database takes.

To bring a backup back, put the copy on a claim and point the release at it:

1. Stop Volverán: with Flux, `flux suspend helmrelease volveran -n volveran` first, then `kubectl -n volveran scale deployment/volveran --replicas=0`.
2. Create a new claim from the snapshot (`dataSource` pointing at the `VolumeSnapshot`), or create an empty claim and copy the file onto it from a pod that mounts it, named `audit.sqlite` and owned by uid 1000. Remove any `audit.sqlite-wal` and `audit.sqlite-shm` left on that volume.
3. Set `persistence.existingClaim` to the new claim and upgrade (with Flux: commit it and `flux resume helmrelease volveran -n volveran`). Volverán migrates an older database's schema at startup.

A Discarded Message whose body was evicted by retention before the backup stays "body expired" after restoring a backup. Restoring a backup does not undo anything done on the brokers since: Messages Restored or Replayed after the backup was taken are not marked so in the Audit Entries from the backup.
