#!/usr/bin/env bash
# Runs the given command with Java 21 or newer on the PATH, which the Firestore emulator needs.
# macOS's default java is often older, so Homebrew's openjdk is preferred when it is.
set -euo pipefail

has_java_21() {
  java -version 2>&1 | grep -qE 'version "(2[1-9]|[3-9][0-9])'
}

if ! has_java_21; then
  for candidate in "$(brew --prefix openjdk@21 2>/dev/null)" "$(brew --prefix openjdk 2>/dev/null)"; do
    if [ -n "$candidate" ] && [ -x "$candidate/bin/java" ]; then
      export JAVA_HOME="$candidate"
      export PATH="$candidate/bin:$PATH"
      break
    fi
  done
fi
if ! has_java_21; then
  echo "Java 21 or newer is required for the Firestore emulator. Install it with: brew install openjdk@21" >&2
  exit 1
fi

exec "$@"
