# volveran Helm chart

Runs [Volverán](https://github.com/volveran/volveran) on Kubernetes as a shared service: Team Mode (OIDC sign-in), one
replica, and a PersistentVolumeClaim for the audit store. The pod passes the `restricted` Pod Security Standard.

The chart version always equals the Volverán version, and the default image tag is the chart's `appVersion`.

## What the chart fixes

These follow from Volverán's design and are not values:

- **Team Mode only**, listening on `0.0.0.0` inside the pod. Solo Mode never listens off loopback (ADR 0002), so it is
  not a value at all.
- **One replica with the `Recreate` strategy.** A Checkout's held Messages live in one process and the audit store is
  SQLite with a single writer, so `replicaCount` must be `1` (ADR 0003, `docs/adr/0003-single-replica-on-kubernetes.md`).
- **No Secret holding a credential, no PodDisruptionBudget and no HorizontalPodAutoscaler** are ever rendered.
- **Pod security:** UID and GID 1000, `fsGroup` 1000, read-only root filesystem, no privilege escalation, all
  capabilities dropped, `RuntimeDefault` seccomp, and a 64Mi `emptyDir` at `/tmp`.
- **Probes:** liveness on `/healthz`, readiness on `/readyz` (never depends on a broker), and a startup probe that
  gives a slow OIDC provider five minutes.
- **The audit store PersistentVolumeClaim is kept on uninstall** (`helm.sh/resource-policy: keep`). Delete it by hand
  to delete the audit trail.

A deploy or pod restart signs every Operator out and ends open Checkouts. Their Messages return to their queues
without costing Delivery Budget; `pod.terminationGracePeriodSeconds` gives that time to finish.

## Install

Create the Secrets first (or let SOPS, Sealed Secrets or External Secrets create them). The chart only references them:

```sh
kubectl create namespace volveran
kubectl -n volveran create secret generic volveran-oidc \
  --from-literal=client-secret='<OIDC client secret>' \
  --from-literal=session-secret="$(openssl rand -base64 48)"
kubectl -n volveran create secret generic volveran-broker-passwords \
  --from-literal=VOLVERAN_PROD_PASSWORD='<broker password>'
```

Then write the values:

```yaml
# values.yaml
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
```

```sh
helm install volveran ./charts/volveran --namespace volveran -f values.yaml
```

The install notes print the Service name, the `kubectl port-forward` command and the redirect URL to register with the
OIDC client. Sign-in only works at the host of `oidc.redirectUrl`, and Volverán must be served at the root of that host.

## Values

Every value with its default. Values without a default are required; the chart refuses to render without them and
names the missing value.

### General

| Value | Default | Description |
|---|---|---|
| `replicaCount` | `1` | Must be `1`. Any other value is refused, citing ADR 0003. |

### Image

| Value | Default | Description |
|---|---|---|
| `image.repository` | `ghcr.io/volveran/volveran` | Container image repository. |
| `image.tag` | `""` (the chart's `appVersion`) | Image tag. |
| `image.pullPolicy` | `IfNotPresent` | `Always`, `IfNotPresent` or `Never`. |

### OIDC sign-in

| Value | Default | Description |
|---|---|---|
| `oidc.issuer` | required | OIDC issuer URL. Its discovery document is read at startup. `https`, unless plain `http` on loopback. |
| `oidc.clientId` | required | OIDC client ID. |
| `oidc.redirectUrl` | required | The public callback URL the OIDC client registers, ending in `/auth/callback`, for example `https://volveran.example.com/auth/callback`. An `https` URL makes the session cookies `Secure`, also behind a TLS-terminating Gateway. |
| `oidc.scopes` | `openid email profile` | Space-separated scopes; must include `openid`. |
| `oidc.existingSecret` | required | An existing Secret holding the OIDC client secret and the session secret. |
| `oidc.clientSecretKey` | `client-secret` | Key of `oidc.existingSecret` holding the OIDC client secret. |
| `oidc.sessionSecretKey` | `session-secret` | Key of `oidc.existingSecret` holding the session secret (at least 32 characters; it signs the session cookies). |

### Broker Profiles

| Value | Default | Description |
|---|---|---|
| `brokerProfiles.profiles` | `[]` (at least one required) | Broker Profiles in the same shape as the profiles YAML (`profiles.example.yaml`): `name`, `managementUrl`, `amqpUrl`, `caFile`, `username`, `passwordEnv`, `vhosts`, `defaultQueueFilter`, `protected`. Rendered to a chart-managed ConfigMap mounted at `/config/profiles.yaml`; a change rolls the pod. A `password` key is refused. |
| `brokerProfiles.passwordsSecret` | `""` | An existing Secret whose keys become environment variables. Each profile's `passwordEnv` must name one of its keys. |

### Audit store

| Value | Default | Description |
|---|---|---|
| `persistence.size` | `1Gi` | Size of the audit store PersistentVolumeClaim (Audit Entries and Discarded Message bodies, kept 30 days or 1 GiB by default). |
| `persistence.storageClass` | `""` (cluster default) | StorageClass of the claim. |
| `persistence.accessMode` | `ReadWriteOnce` | `ReadWriteOnce`, `ReadWriteOncePod` or `ReadWriteMany`. |

### Service

| Value | Default | Description |
|---|---|---|
| `service.port` | `8080` | Port of the ClusterIP Service. The container always listens on 8080. |

### Pod

| Value | Default | Description |
|---|---|---|
| `pod.terminationGracePeriodSeconds` | `60` | Time between `SIGTERM` and `SIGKILL`, for Volverán to end every active Checkout. |
| `pod.resources` | requests `cpu: 100m`, `memory: 256Mi`; limits `cpu: 1`, `memory: 512Mi` | Container resources, sized for the default Checkout limit (100 MB of held Message bodies). Raise the memory limit along with any larger Checkout limit. |
| `pod.automountServiceAccountToken` | `false` | Volverán never talks to the Kubernetes API, so no token is mounted. |
