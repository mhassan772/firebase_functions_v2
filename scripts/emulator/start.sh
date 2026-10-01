#!/usr/bin/env bash
# Starts the local Auth and Firestore emulators with this repo's rules, seeds them, and keeps
# running until Ctrl+C. Data is thrown away on exit; run again (or `npm run emulators:seed`
# while running) for a fresh copy.
#
# The project id is the real one, because the app's native Firebase config is tied to it and
# its emulator data must live under it. That is safe only because just Auth and Firestore are
# started: neither ever calls a real Google service. Do not add the functions emulator here;
# emulated functions would still reach the real Apple, Google and Secret Manager APIs.
set -euo pipefail
cd "$(dirname "$0")/../.."

PROJECT_ID="mantooq-test"

bash scripts/emulator/with-java.sh firebase emulators:start --only auth,firestore --project "$PROJECT_ID" &
EMULATORS_PID=$!
trap 'kill "$EMULATORS_PID" 2>/dev/null; wait "$EMULATORS_PID" 2>/dev/null' INT TERM EXIT

echo "Waiting for the emulators..."
for _ in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:4401/emulators" >/dev/null 2>&1 \
    && curl -sf "http://127.0.0.1:8086/" >/dev/null 2>&1 \
    && curl -sf "http://127.0.0.1:9098/" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$EMULATORS_PID" 2>/dev/null; then
    echo "The emulators exited during startup." >&2
    exit 1
  fi
  sleep 1
done

node scripts/emulator/seed.mjs

echo
echo "Emulators ready. Emulator UI: http://127.0.0.1:4001"
echo "Run the app against them with: flutter run --dart-define=USE_FIREBASE_EMULATOR=true"
wait "$EMULATORS_PID"
