#!/usr/bin/env bash
# What to run before calling work done: lint, unit tests and chart tests, with
# capped workers. The steps all run; one summary line each, the full output in
# verify.log. Exits non-zero if any step failed. Needs Helm for the chart tests.
#
#   npm run verify
#   VERIFY_WORKERS=4 npm run verify
set -uo pipefail

cd "$(dirname "$0")/.."
log=verify.log
workers="${VERIFY_WORKERS:-2}"
failed=0
: >"$log"

step() {
  local name=$1 started=$SECONDS status
  shift
  echo "=== $name: $*" >>"$log"
  "$@" >>"$log" 2>&1
  status=$?
  echo "=== $name: exit $status" >>"$log"
  echo "$name: exit $status ($((SECONDS - started))s)"
  [ "$status" -eq 0 ] || failed=1
}

step lint npm run lint
step unit npm run test:unit -- --maxWorkers="$workers"
step chart npm run test:chart -- --maxWorkers="$workers"

[ "$failed" -eq 0 ] || echo "Failed; the full output is in $log"
exit "$failed"
