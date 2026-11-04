#!/usr/bin/env bash
# Regenerates docs/images from a freshly seeded test broker and the built app,
# and in the same pass records the server's answers for the demo's read-only
# views into docs/demo/recording.json (record-demo.mjs). Run it from a tag, so
# the images and the recording show what people pull, then commit both:
#
#   npm run build
#   node scripts/test-broker.mjs run -- scripts/screenshots/capture.sh
#
# Needs Firefox and ffmpeg on PATH. SHOT_SLOW=3 stretches every wait.
set -euo pipefail
cd "$(dirname "$0")/../.."
here=scripts/screenshots
out=docs/images
port=${SHOT_PORT:-18090}
tmp=$(mktemp -d)
server=
hook=$((port + 1))
node -e "require('http').createServer((q,r)=>{q.resume();r.end()}).listen($hook,'127.0.0.1')" &
webhook=$!
stop_server() { if [ -n "$server" ]; then kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true; server=; fi; }
trap 'stop_server; kill "$webhook" 2>/dev/null || true; rm -rf "$tmp"' EXIT

export FIREFOX=${FIREFOX:-$(command -v firefox)}
export BASE="http://127.0.0.1:$port/"
sed "s/MGMT_PORT/$VOLVERAN_TEST_MGMT_PORT/; s/AMQP_PORT/$VOLVERAN_TEST_AMQP_PORT/" "$here/profiles.yaml" > "$tmp/profiles.yaml"

mkdir -p "$out"
for theme in light dark; do
  rm -rf "$tmp/data"
  VOLVERAN_HISTORY_INTERVAL_SECONDS=15 VOLVERAN_SHOT_WEBHOOK_URL="http://127.0.0.1:$hook/" VOLVERAN_PROFILES_FILE="$tmp/profiles.yaml" VOLVERAN_DATA_DIR="$tmp/data" VOLVERAN_PORT="$port" \
    VOLVERAN_OPERATOR=ana VOLVERAN_TEST_PASSWORD=volveran-admin-pass node dist/server/main.js > "$tmp/server.log" 2>&1 &
  server=$!
  until curl -sf "$BASE"readyz > /dev/null; do sleep 2; done
  node "$here/seed.mjs"
  node "$here/seed-history.mjs" "$tmp/data/audit.sqlite"
  sleep 40 # Sampling and the Alert Rules need a run or two.
  node "$here/shot.mjs" "$tmp/scratch" "$theme" prep
  node "$here/die-again.mjs"
  sleep 16 # Queue depths in the management API, and the Alerts and Samples read from them, catch up (15 s here).
  # The state the images below show; one theme is enough.
  if [ "$theme" = light ]; then VOLVERAN_OPERATOR=ana node "$here/record-demo.mjs" docs/demo/recording.json "http://127.0.0.1:$hook/" "$tmp"; fi
  node "$here/shot.mjs" "$out" "$theme" queues history alerts map checkout compare rules audit canary
  node "$here/shot.mjs" "$tmp/flow" "$theme" flow
  ffmpeg -y -loglevel error -framerate 0.5 -pattern_type glob -i "$tmp/flow/flow-*-$theme.png" \
    -vf 'scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none' \
    "$out/flow-$theme.gif"
  stop_server
done

ls -la "$out"
