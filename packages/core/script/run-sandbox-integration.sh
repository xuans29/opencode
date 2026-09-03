#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "sandbox integration requires Linux" >&2
  exit 1
fi

for command in bun bwrap prlimit python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "sandbox integration requires $command" >&2
    exit 1
  fi
done

cd "$(dirname "$0")/.."

bun test \
  test/sandbox-bwrap.test.ts \
  test/tool-shell.test.ts

OPENCODE_RUN_SANDBOX_INTEGRATION=1 \
  bun test test/sandbox-integration.test.ts
