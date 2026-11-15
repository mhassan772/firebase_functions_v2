#!/usr/bin/env bash
# Starts the accounts-page test stack (Auth, Firestore, Functions, Storage) from
# firebase.accounts-test.json, seeds it, and keeps running until Ctrl+C. Data is thrown away on
# exit. Build the functions first (`npm run emulators:accounts` does).
#
# The project id is a demo one on purpose and must stay so: the functions emulator runs the real
# deleteAccount code, and a demo project keeps every Firebase call local. Never put the real
# project id here.
set -euo pipefail
cd "$(dirname "$0")/../.."

PROJECT_ID="demo-mantooq"

# The web purchase callables read the Stripe keys as secrets, which the functions emulator takes
# from the gitignored .secret.local at the repository root. Only sandbox keys may be there: the
# seed makes every account a tester, so a live key would sell real premium for a test card.
if [ -f .secret.local ]; then
  if grep -qE '^STRIPE_WEB_SECRET_KEY=' .secret.local && ! grep -qE '^STRIPE_WEB_SECRET_KEY=sk_test_' .secret.local; then
    echo ".secret.local holds a Stripe key that is not a sandbox key (sk_test_). Refusing to start." >&2
    exit 1
  fi
else
  echo "No .secret.local: /subscribe and /manage will answer that sales are off (see accounts-page/README.md)."
fi

# Hide this machine's Google credentials from the emulators. Some functions in src/index.ts name
# the production project directly (getSecret in src/utils/secrets.ts uses its number), and the
# functions emulator hands its runtime the gcloud credentials or the `firebase login` account, so
# a call to one of them would reach production. Pointing the credentials at a placeholder that
# Google refuses stops the lookup of gcloud's credentials, and an empty config home hides the
# `firebase login` account, so any such call fails instead. A demo project needs no login.
CREDENTIALS_FREE_HOME="$(mktemp -d)"
cat > "$CREDENTIALS_FREE_HOME/no-credentials.json" <<'JSON'
{"type": "authorized_user", "client_id": "local-emulator-only", "client_secret": "none", "refresh_token": "none"}
JSON
export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS_FREE_HOME/no-credentials.json"
export XDG_CONFIG_HOME="$CREDENTIALS_FREE_HOME"

bash scripts/emulator/with-java.sh firebase emulators:start \
  --config firebase.accounts-test.json \
  --only auth,firestore,functions,storage \
  --project "$PROJECT_ID" &
EMULATORS_PID=$!
trap 'kill "$EMULATORS_PID" 2>/dev/null; wait "$EMULATORS_PID" 2>/dev/null; rm -rf "$CREDENTIALS_FREE_HOME"' INT TERM EXIT

echo "Waiting for the emulators..."
ready=""
for _ in $(seq 1 180); do
  if curl -sf "http://127.0.0.1:4404/emulators" >/dev/null 2>&1 \
    && curl -sf "http://127.0.0.1:8089/" >/dev/null 2>&1 \
    && curl -sf "http://127.0.0.1:9096/" >/dev/null 2>&1 \
    && curl -s -o /dev/null "http://127.0.0.1:9196/" 2>&1 \
    && curl -s -o /dev/null "http://127.0.0.1:5004/" 2>&1; then
    ready="yes"
    break
  fi
  if ! kill -0 "$EMULATORS_PID" 2>/dev/null; then
    echo "The emulators exited during startup." >&2
    exit 1
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "The emulators did not answer in time." >&2
  exit 1
fi

node scripts/emulator/seed-accounts.mjs

echo
echo "Accounts test stack ready (project $PROJECT_ID)."
echo "Run the page against it: npm --prefix accounts-page run dev, then open http://localhost:5173/delete, /subscribe or /manage"
wait "$EMULATORS_PID"
