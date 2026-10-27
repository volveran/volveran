#!/usr/bin/env bash
# Validates the manifests charts/volveran renders against the Kubernetes API
# schemas with kubeconform, once per values fixture in test/chart/fixtures, so
# a fixture that turns on an optional object (a route, a NetworkPolicy) gets it
# validated too. CRDs such as Gateway API's HTTPRoute resolve through the
# datreeio CRDs catalog; a kind with no schema fails rather than being skipped.
#
#   scripts/validate-chart.sh            # needs helm and kubeconform on PATH
#   KUBECONFORM=/opt/bin/kubeconform scripts/validate-chart.sh
#   KUBERNETES_VERSION=1.32.0 scripts/validate-chart.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
kubeconform="${KUBECONFORM:-kubeconform}"
kubernetes_version="${KUBERNETES_VERSION:-1.33.0}"
crds_catalog='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

for fixture in "$root"/test/chart/fixtures/*.yaml; do
  echo "== $(basename "$fixture")"
  helm template volveran "$root/charts/volveran" --namespace volveran -f "$fixture" |
    "$kubeconform" -strict -summary \
      -kubernetes-version "$kubernetes_version" \
      -schema-location default \
      -schema-location "$crds_catalog" \
      -
done
