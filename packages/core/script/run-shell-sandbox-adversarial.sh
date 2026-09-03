#!/usr/bin/env bash
set -u

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "adversarial sandbox tests require Linux" >&2
  exit 1
fi

for command in bun bwrap prlimit python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "adversarial sandbox tests require $command" >&2
    exit 1
  fi
done

cd "$(dirname "$0")/.."

OPENCODE_RUN_SANDBOX_SECURITY_INTEGRATION=1 \
  bun test test/shell-sandbox-adversarial.test.ts
