#!/usr/bin/env bash
# Validates the manifests charts/volveran renders against the Kubernetes API
# schemas with kubeconform, once per values fixture in test/chart/fixtures, so
# a fixture that turns on an optional object (a route, a NetworkPolicy) gets it
# validated too. CRDs such as Gateway API's HTTPRoute resolve through the
# datreeio CRDs catalog; a kind with no schema fails rather than being skipped.
#
# It then validates the Flux example (examples/flux/) the same way: app/ as
# kustomize builds it (Namespace, Secrets, OCIRepository, HelmRelease) and the
# Flux Kustomization in cluster/, with the Flux CRD schemas from the same
# catalog. Its HelmRelease values are checked against the chart's schema by
# test/chart/flux-example.test.ts.
#
#   scripts/validate-chart.sh            # needs helm, kubectl and kubeconform on PATH
#   KUBECONFORM=/opt/bin/kubeconform scripts/validate-chart.sh
#   KUBERNETES_VERSION=1.32.0 scripts/validate-chart.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
kubeconform="${KUBECONFORM:-kubeconform}"
kubernetes_version="${KUBERNETES_VERSION:-1.33.0}"
crds_catalog='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

validate() {
  "$kubeconform" -strict -summary \
    -kubernetes-version "$kubernetes_version" \
    -schema-location default \
    -schema-location "$crds_catalog" \
    "$@"
}

for fixture in "$root"/test/chart/fixtures/*.yaml; do
  echo "== $(basename "$fixture")"
  helm template volveran "$root/charts/volveran" --namespace volveran -f "$fixture" | validate -
done

echo "== examples/flux/app (kustomize build)"
kubectl kustomize "$root/examples/flux/app" | validate -
echo "== examples/flux/cluster"
validate "$root/examples/flux/cluster"
