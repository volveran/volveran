#!/usr/bin/env bash
# Regenerates docs/images from a freshly seeded test broker and the built app.
# Run it from a tag, so the images show what people pull:
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
stop_server() { if [ -n "$server" ]; then kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true; server=; fi; }
trap 'stop_server; rm -rf "$tmp"' EXIT

export FIREFOX=${FIREFOX:-$(command -v firefox)}
export BASE="http://127.0.0.1:$port/"
sed "s/MGMT_PORT/$VOLVERAN_TEST_MGMT_PORT/; s/AMQP_PORT/$VOLVERAN_TEST_AMQP_PORT/" "$here/profiles.yaml" > "$tmp/profiles.yaml"

mkdir -p "$out"
for theme in light dark; do
  rm -rf "$tmp/data"
  VOLVERAN_PROFILES_FILE="$tmp/profiles.yaml" VOLVERAN_DATA_DIR="$tmp/data" VOLVERAN_PORT="$port" \
    VOLVERAN_OPERATOR=ana VOLVERAN_TEST_PASSWORD=volveran-admin-pass node dist/server/main.js > "$tmp/server.log" 2>&1 &
  server=$!
  until curl -sf "$BASE"readyz > /dev/null; do sleep 2; done
  node "$here/seed.mjs"
  node "$here/shot.mjs" "$tmp/scratch" "$theme" prep
  node "$here/die-again.mjs"
  node "$here/shot.mjs" "$out" "$theme" queues checkout compare rules audit canary
  if [ "$theme" = dark ]; then node "$here/shot.mjs" "$tmp/flow" dark flow; fi
  stop_server
done

ffmpeg -y -loglevel error -framerate 0.5 -pattern_type glob -i "$tmp/flow/flow-*-dark.png" \
  -vf 'scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none' \
  "$out/flow.gif"
ls -la "$out"
