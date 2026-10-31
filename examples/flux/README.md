# Volverán with Flux CD

A layout to copy into your fleet repository. Flux fetches the signed chart from `ghcr.io`, installs it with the values in the `HelmRelease`, and decrypts the Secrets with SOPS and your own age key. Every name here is a placeholder: replace each `example.com` host, the Gateway and the Broker Profiles with your own. The [Kubernetes guide](../../docs/kubernetes.md) explains the values, exposure, upgrades and backups.

```
.sops.yaml                  # SOPS rules: encrypt secrets.yaml with your age key
cluster/volveran.yaml       # Flux Kustomization: applies app/ and decrypts its Secrets
app/
  kustomization.yaml        # the objects below
  namespace.yaml            # namespace volveran, enforcing restricted pod security, never pruned
  secrets.yaml              # TEMPLATE: OIDC and broker secrets, to fill in and encrypt
  ocirepository.yaml        # the chart, semver 0.6.x, cosign-verified
  helmrelease.yaml          # OIDC, inline Broker Profiles, persistence, HTTPRoute
```

## What it needs

- Flux installed with `flux bootstrap`, syncing a Git repository named `flux-system` (the bootstrap default).
- A Gateway API Gateway with an `https` listener for `volveran.example.com` (here `edge` in namespace `gateways`, allowing routes from namespace `volveran`).
- An OIDC client registered with redirect URL `https://volveran.example.com/auth/callback` ([Team Mode guide](../../docs/team-mode.md)).
- [`sops`](https://getsops.io) and [`age`](https://age-encryption.org) on your machine.

## Steps

1. Copy `app/` to `apps/volveran/` in your fleet repository, `cluster/volveran.yaml` to the directory `flux bootstrap` syncs for your cluster (for example `clusters/production/`), and `.sops.yaml` to the repository root. If you put `app/` elsewhere, change `spec.path` in `cluster/volveran.yaml`.

2. Edit `apps/volveran/helmrelease.yaml`: the OIDC issuer, client ID and redirect URL, the Broker Profiles, the Gateway in `httpRoute.parentRefs` and the host name. The redirect URL's host must be the route's host name. Every value is in the [chart README](../../charts/volveran/README.md#values).

3. Create an age key for the cluster, if you do not have one, and give Flux its private half:

   ```sh
   age-keygen -o age.agekey          # prints "Public key: age1..."
   kubectl create secret generic sops-age --namespace flux-system \
     --from-file=age.agekey=age.agekey
   ```

   Keep `age.agekey` out of Git and store it somewhere safe; without it the Secrets cannot be decrypted.

4. Put the public key (`age1...`) in `.sops.yaml` in place of the placeholder.

5. Fill in `apps/volveran/secrets.yaml`: the OIDC client secret, a session secret (`openssl rand -base64 48`), and one broker password per Broker Profile `passwordEnv`. Then encrypt it in place, from the repository root so SOPS finds `.sops.yaml`:

   ```sh
   sops --encrypt --in-place apps/volveran/secrets.yaml
   ```

   Only `stringData` is encrypted; names and keys stay readable. Check that no value is in plain text before you commit. To change a value later, run `sops apps/volveran/secrets.yaml`, which decrypts it in your editor and encrypts it again on save.

6. Commit and push. Flux applies the namespace, the Secrets, the `OCIRepository` and the `HelmRelease`:

   ```sh
   flux get sources oci -n volveran        # the chart version, once its signature is verified
   flux get helmreleases -n volveran       # the installed release
   ```

   An `OCIRepository` whose signature does not match Volverán's release workflow stays not ready, and nothing is installed. A value the chart refuses shows in the `HelmRelease` status, naming the value.

7. Open `https://volveran.example.com` and sign in.

## Upgrades

`ref.semver: "0.6.x"` installs every 0.6 patch release once it is published and signed. To move to a new minor version, change the range after reading the [changelog](../../CHANGELOG.md). A deploy signs everyone out and ends open Checkouts (their Messages go back to their queues; on a quorum queue, a large Checkout can use up Delivery Budget as it ends), so `flux suspend helmrelease volveran -n volveran` holds upgrades back during triage work and `flux resume` releases them.

## Removing it

`cluster/volveran.yaml` has `prune: true`: deleting it, or `app/`, from Git uninstalls Volverán. The namespace carries `kustomize.toolkit.fluxcd.io/prune: disabled`, so Flux leaves it in place, and with it the audit store's claim, which Helm keeps on uninstall. Delete the namespace by hand to delete the audit trail with it.
