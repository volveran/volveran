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
      roles:                                   # OIDC groups (oidc.groupsClaim) per Role
        viewer: [support]
        operator: [oncall]
        admin: [platform]
```

A profile without `roles` lets every signed-in Operator act as `admin` on it; see [Team Mode](../../docs/team-mode.md#roles).

A profile can instead connect with each signed-in Operator's own OAuth 2.0 access token, so RabbitMQ applies its own permissions per person: set `credentials: operatorToken` (and optionally `tokenUsernameClaim`) and leave out `username` and `passwordEnv`. See [Team Mode](../../docs/team-mode.md#the-operators-own-broker-token).

```sh
helm install volveran ./charts/volveran --namespace volveran -f values.yaml
```

The install notes print the Service name, the `kubectl port-forward` command and the redirect URL to register with the
OIDC client. Sign-in only works at the host of `oidc.redirectUrl`, and Volverán must be served at the root of that host.

## Exposure

The chart renders no route by default: reach Volverán with `kubectl port-forward` or expose it your own way. It can
render a Gateway API `HTTPRoute`, a classic `Ingress`, or both at once (for example while migrating from one to the
other). It never renders a Gateway or a cert-manager Certificate; it only references a Gateway and TLS Secrets that
already exist.

- **Host-based routing only.** Volverán is served at the root of its host: the session cookie is scoped to `/` and the
  sign-in cookie to `/auth`, and the web app loads from `/`. A route under a path prefix such as
  `https://tools.example.com/volveran` breaks sign-in, so the chart has no path value. Give Volverán its own host name.
- **The redirect URL's host must be a route host.** Set `oidc.redirectUrl` to `https://<route host>/auth/callback` and
  register that URL with the OIDC client. The install notes print the external URL and the redirect URL, and warn when
  the redirect URL's host is not one of the route hosts.
- **TLS terminates at the edge.** The pod serves plain HTTP. An `https` redirect URL makes the session cookies `Secure`
  regardless of how the request reached the pod, so there is no proxy setting to add.

Gateway API (Envoy Gateway or any other implementation), attached to the `https` listener of an existing Gateway:

```yaml
httpRoute:
  enabled: true
  parentRefs:
    - name: edge
      namespace: gateways        # a Gateway in another namespace must allow routes from this one
      sectionName: https
  hostnames: [volveran.example.com]
```

A classic ingress controller, with an existing TLS Secret:

```yaml
ingress:
  enabled: true
  className: nginx
  hosts: [volveran.example.com]
  tls:
    - secretName: volveran-tls
      hosts: [volveran.example.com]
```

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
| `image.digest` | `""` | Pins the image by digest (`sha256:<64 hex>`), so the cluster runs exactly the image you reviewed. Overrides `image.tag`. |
| `image.pullPolicy` | `IfNotPresent` | `Always`, `IfNotPresent` or `Never`. |
| `image.pullSecrets` | `[]` | Names of existing image pull Secrets, for a private mirror of `ghcr.io`, for example `[mirror-pull]`. |

### OIDC sign-in

| Value | Default | Description |
|---|---|---|
| `oidc.issuer` | required | OIDC issuer URL. Its discovery document is read at startup. `https`, unless plain `http` on loopback. |
| `oidc.clientId` | required | OIDC client ID. |
| `oidc.redirectUrl` | required | The public callback URL the OIDC client registers, ending in `/auth/callback`, for example `https://volveran.example.com/auth/callback`. An `https` URL makes the session cookies `Secure`, also behind a TLS-terminating Gateway. |
| `oidc.scopes` | `openid email profile` | Space-separated scopes; must include `openid`. |
| `oidc.groupsClaim` | `groups` | The claim holding the Operator's groups (`VOLVERAN_OIDC_GROUPS_CLAIM`), which each profile's `roles` maps: a name or dotted path such as `realm_access.roles`, read from the ID token, else from userinfo. |
| `oidc.existingSecret` | required | An existing Secret holding the OIDC client secret and the session secret. |
| `oidc.clientSecretKey` | `client-secret` | Key of `oidc.existingSecret` holding the OIDC client secret. |
| `oidc.sessionSecretKey` | `session-secret` | Key of `oidc.existingSecret` holding the session secret (at least 32 characters; it signs the session cookies). |

### Broker Profiles

| Value | Default | Description |
|---|---|---|
| `brokerProfiles.profiles` | `[]` (at least one, unless `brokerProfiles.existingConfigMap` is set) | Broker Profiles in the same shape as the profiles YAML (`profiles.example.yaml`): `name`, `managementUrl`, `amqpUrl`, `caFile`, `username`, `passwordEnv`, `credentials` (`shared`, the default, or `operatorToken`: the Operator's own access token, without `username` and `passwordEnv`), `tokenUsernameClaim` (only with `operatorToken`; default `sub`), `vhosts`, `defaultQueueFilter`, `protected`, `requireApproval` (only with `protected: true`; default `true`: an Apply waits for a second Operator's Approval), `replayRate` (`default` and/or `max`, numbers of Messages per second from 0.1 to 1000: the Replay Rate an Apply runs at, and the most an Operator may choose; Volverán refuses `default` above `max`), `canary` (`watchWindow`, a duration from `5s` to `10m`, default `30s`: how long a Canary is watched for dying again), `replayRules` (Replay rules, see `profiles.example.yaml`; the schema refuses a rule without `stopWhen` or with a `whenAttemptsUsedUp` other than `keep` or `{ moveTo: { queue } }`, and Volverán checks the ranges at startup), `roles` (any of `viewer`, `operator`, `admin`, each a non-empty list of groups; the schema refuses other role names). Rendered to a chart-managed ConfigMap mounted at `/config/profiles.yaml`; a change rolls the pod. A `password` key is refused. |
| `brokerProfiles.passwordsSecret` | `""` | An existing Secret whose keys become environment variables. Each profile's `passwordEnv` must name one of its keys. |
| `brokerProfiles.existingConfigMap` | `""` | An existing ConfigMap with a `profiles.yaml` key, mounted at `/config` instead of the chart-managed one. Leave `brokerProfiles.profiles` empty when it is set. The chart cannot see its content, so a change to it does not roll the pod: restart the Deployment yourself. A `caFile` in it is an absolute path under `/etc/volveran/ca` (see CA bundles). |

### CA bundles

Private CAs for internal brokers and an internal OIDC provider. Each bundle is an existing ConfigMap or Secret, mounted
read-only at `/etc/volveran/ca/<name>/` with one file per key:

```yaml
caBundles:
  bundles:
    - name: broker-ca
      configMap: rabbit-internal-ca     # key ca.crt -> /etc/volveran/ca/broker-ca/ca.crt
    - name: corporate-ca
      secret: corporate-root-ca         # key ca.crt -> /etc/volveran/ca/corporate-ca/ca.crt
  oidcTrust:
    bundle: corporate-ca                # NODE_EXTRA_CA_CERTS=/etc/volveran/ca/corporate-ca/ca.crt

brokerProfiles:
  profiles:
    - name: internal
      managementUrl: https://rabbit.internal.example.com:15671
      amqpUrl: amqps://rabbit.internal.example.com:5671
      caFile: /etc/volveran/ca/broker-ca/ca.crt    # absolute, under the mounted bundle
      username: volveran
      passwordEnv: VOLVERAN_INTERNAL_PASSWORD
```

| Value | Default | Description |
|---|---|---|
| `caBundles.bundles` | `[]` | CA bundles, each `{name, configMap}` or `{name, secret}`. `name` is a DNS label that names the directory `/etc/volveran/ca/<name>`. A Broker Profile's `caFile` references a file there by absolute path, so `amqps` and `https` to internal brokers work. |
| `caBundles.oidcTrust.bundle` | `""` | The name of one of `caBundles.bundles` that the OIDC provider's certificate chains to. Its file is set as `NODE_EXTRA_CA_CERTS`, which Node.js adds to the public CAs, so an internal provider's discovery document can be read. |
| `caBundles.oidcTrust.key` | `ca.crt` | The key (file) of the OIDC trust bundle holding the PEM certificates. |

### Audit store

| Value | Default | Description |
|---|---|---|
| `persistence.enabled` | `true` | `false` puts the audit store on an `emptyDir`: Audit Entries and Discarded Message bodies are lost on every restart, and the install notes warn about it. Only for trying the chart out. |
| `persistence.existingClaim` | `""` | An existing PersistentVolumeClaim to mount instead of a chart-created one, for example to migrate a volume or restore from a backup. No claim is created, and `size`, `storageClass` and `accessMode` are ignored. |
| `persistence.size` | `1Gi` | Size of the audit store PersistentVolumeClaim (Audit Entries and Discarded Message bodies, kept 30 days or 1 GiB by default). |
| `persistence.storageClass` | `""` (cluster default) | StorageClass of the claim. |
| `persistence.accessMode` | `ReadWriteOnce` | `ReadWriteOnce`, `ReadWriteOncePod` or `ReadWriteMany`. |

### Service

| Value | Default | Description |
|---|---|---|
| `service.port` | `8080` | Port of the ClusterIP Service. The container always listens on 8080. |

### Settings

Volverán's own settings, each mapped to the `VOLVERAN_*` variable documented in the project README. `null` leaves the
variable unset, so Volverán's own default (in brackets) applies. Values outside the range Volverán accepts are
refused at render time.

| Value | Default | Description |
|---|---|---|
| `settings.checkoutMaxMessages` | `null` (1000) | `VOLVERAN_CHECKOUT_MAX_MESSAGES`: most Messages one Checkout holds, 1 to 65535. |
| `settings.checkoutMaxMb` | `null` (100) | `VOLVERAN_CHECKOUT_MAX_MB`: most MB of Message bodies one Checkout holds. Raise `pod.resources` memory with it. |
| `settings.checkoutTimeLimitMinutes` | `null` (30) | `VOLVERAN_CHECKOUT_TIME_LIMIT_MINUTES`: Checkout time limit, 1 to 1440. |
| `settings.checkoutHeartbeatSeconds` | `null` (120) | `VOLVERAN_CHECKOUT_HEARTBEAT_SECONDS`: how long a Checkout survives without its browser tab, 10 to 3600. |
| `settings.bodyRetentionDays` | `null` (30) | `VOLVERAN_BODY_RETENTION_DAYS`: most days a Discarded Message body is kept, 1 to 36500. |
| `settings.bodyRetentionMaxBytes` | `null` (`1GiB`) | `VOLVERAN_BODY_RETENTION_MAX_BYTES`: most total size of kept Discarded Message bodies, in bytes or with `KiB`, `MiB`, `GiB` or `TiB`, for example `20GiB`. Size `persistence.size` above it. |
| `settings.bodyRetentionIntervalMinutes` | `null` (60) | `VOLVERAN_BODY_RETENTION_INTERVAL_MINUTES`: how often old bodies are evicted, 1 to 1440. |

### Extra environment

| Value | Default | Description |
|---|---|---|
| `extraEnv` | `[]` | Extra container environment variables (`name` with `value` or `valueFrom`), for a setting a later Volverán release adds before the chart names it. Quote values YAML reads as booleans or numbers (`"on"`, `"10"`). A variable the chart sets itself (Team Mode, listen address, OIDC, paths) or that a named setting covers is refused. |

### HTTPRoute

| Value | Default | Description |
|---|---|---|
| `httpRoute.enabled` | `false` | Render a Gateway API `HTTPRoute` (`gateway.networking.k8s.io/v1`) sending every path of its host names to the Service. |
| `httpRoute.parentRefs` | `[]` (at least one required when enabled) | Existing Gateways to attach to: `name`, and optionally `namespace`, `sectionName` (a listener), `port`, `group`, `kind`. |
| `httpRoute.hostnames` | `[]` (at least one required when enabled) | Host names of the route, for example `volveran.example.com`. One must be the host of `oidc.redirectUrl`. |
| `httpRoute.annotations` | `{}` | Annotations on the `HTTPRoute`. |

### Ingress

| Value | Default | Description |
|---|---|---|
| `ingress.enabled` | `false` | Render an `Ingress` (`networking.k8s.io/v1`) sending every path of its hosts to the Service. |
| `ingress.className` | `""` (cluster default) | IngressClass of the `Ingress`. |
| `ingress.hosts` | `[]` (at least one required when enabled) | Hosts of the `Ingress`, for example `volveran.example.com`. One must be the host of `oidc.redirectUrl`. |
| `ingress.tls` | `[]` | TLS entries: `secretName` of an existing TLS Secret and the `hosts` it covers. |
| `ingress.annotations` | `{}` | Annotations on the `Ingress`, for example controller settings. |

### Pod

| Value | Default | Description |
|---|---|---|
| `pod.terminationGracePeriodSeconds` | `60` | Time between `SIGTERM` and `SIGKILL`, for Volverán to end every active Checkout. |
| `pod.resources` | requests `cpu: 100m`, `memory: 256Mi`; limits `cpu: 1`, `memory: 512Mi` | Container resources, sized for the default Checkout limit (100 MB of held Message bodies). Raise the memory limit along with any larger Checkout limit. |
| `pod.automountServiceAccountToken` | `false` | Volverán never talks to the Kubernetes API, so no token is mounted. |
| `pod.nodeSelector` | `{}` | Node labels the pod must run on, for example `{pool: tools}`. |
| `pod.tolerations` | `[]` | Tolerations, for example to run on tainted tool nodes. |
| `pod.affinity` | `{}` | Node or pod affinity rules. With a `ReadWriteOnce` claim, keep the pod in the volume's zone. |
| `pod.priorityClassName` | `""` | PriorityClass of the pod. |
| `pod.labels` | `{}` | Extra labels on the pod. `app.kubernetes.io/name` and `app.kubernetes.io/instance` select the pod and are refused. |
| `pod.annotations` | `{}` | Extra annotations on the pod. `checksum/broker-profiles` is the chart's own and is refused. |

### Network policy

| Value | Default | Description |
|---|---|---|
| `networkPolicy.enabled` | `false` | Renders a NetworkPolicy that selects only the Volverán pod. See [Network policy](#network-policy). |
| `networkPolicy.ingressFrom` | `[]` | NetworkPolicy peers (`namespaceSelector`, `podSelector`, `ipBlock`) admitted to the http port, for example the Gateway or ingress controller. Empty admits no peer. |
| `networkPolicy.egress` | `[]` (egress open) | NetworkPolicy egress rules (`to`, `ports`), for example the brokers and the OIDC provider. Any rule restricts egress to these rules plus DNS to `networkPolicy.dnsTo`. |
| `networkPolicy.dnsTo` | namespace `kube-system`, pods `k8s-app: kube-dns` | The cluster DNS resolver as NetworkPolicy peers. Allowed on port 53, UDP and TCP, whenever egress is restricted. |

## Network policy

With `networkPolicy.enabled`, the chart renders one NetworkPolicy that selects only this release's Volverán pod.
It needs a CNI that enforces NetworkPolicy, such as Calico or Cilium. Without one, the object is accepted and has no
effect.

**Ingress.** Only the peers in `networkPolicy.ingressFrom` reach the pod, and only on its http port (8080), so nothing
else in the cluster reaches the sign-in or the API. Each entry is a standard NetworkPolicy peer. A peer with both
`namespaceSelector` and `podSelector` matches those pods in those namespaces. Two separate entries match either one. With
no peers, the policy admits nothing.

**Probes.** No peer is needed for the kubelet probes on `/healthz` and `/readyz`. Kubernetes defines that a pod
isolated for ingress still accepts connections from its own node, and the kubelet runs its probes from that node.
Common CNIs, Calico and Cilium among them, follow this rule by default. `kubectl port-forward` enters the pod through
the kubelet and container runtime rather than the pod network, so it usually keeps working too.

Some clusters filter node-to-pod traffic, and then the probes fail and the pod never becomes ready. Check for this if
you run:

- **Cilium with host traffic under policy** (`allow-localhost: policy`, or host firewall policies). Cilium identifies
  the node by its `host` identity, not its address, so an `ipBlock` peer does not admit it. Add a CiliumNetworkPolicy
  next to the release that selects the Volverán pod and allows `fromEntities: [host]` on TCP port 8080.
- **Calico with a GlobalNetworkPolicy or host endpoint policy** that denies traffic from nodes: allow the node
  addresses to port 8080 of the pod there, or add them in `networkPolicy.ingressFrom` as an `ipBlock` peer.
- **Host firewall rules** (iptables, nftables, a cloud security group on the node): allow the node to reach pods on
  port 8080.

In each case only TCP port 8080 from the node is needed.

**Egress.** With `networkPolicy.egress` empty, the policy leaves egress alone. Any rule turns egress restriction on,
and then Volverán can reach only those destinations plus DNS: the chart always adds a rule allowing port 53, UDP and TCP,
to `networkPolicy.dnsTo`, so name resolution never breaks. The default matches the CoreDNS pods of most distributions
(`k8s-app: kube-dns` in `kube-system`). Change it if your resolver is labelled differently, or use an `ipBlock` for
NodeLocal DNSCache. List every broker (management API and AMQP ports) and the OIDC provider. Volverán reads the OIDC
discovery document at startup, so a missing OIDC rule keeps the pod from becoming ready. NetworkPolicy matches the
pod IPs behind a Service, not the Service IP, so select in-cluster brokers by pod labels or use their pod CIDR.

Example: admit only the Gateway's proxy pods, and limit egress to one broker and the OIDC provider:

```yaml
networkPolicy:
  enabled: true
  ingressFrom:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: gateway-system
      podSelector:
        matchLabels:
          app.kubernetes.io/name: envoy        # the labels of your Gateway's proxy pods
  egress:
    - to:
        - ipBlock:
            cidr: 10.20.0.0/24                 # rabbit.example.com
      ports:
        - port: 15671                          # management API
          protocol: TCP
        - port: 5671                           # AMQPS
          protocol: TCP
    - to:
        - ipBlock:
            cidr: 203.0.113.10/32              # login.example.com
      ports:
        - port: 443
          protocol: TCP
```

Check which pods carry your Gateway's traffic: for in-cluster proxies (Envoy Gateway, Istio, NGINX Gateway Fabric) it is
the proxy Deployment. A cloud load balancer that sends traffic straight to pod IPs needs its source ranges as `ipBlock`
peers instead.
