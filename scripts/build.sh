#!/usr/bin/env bash
# Build wrapper: injects git metadata into the compiled binary via bun --define.
# Usage: bash scripts/build.sh
set -euo pipefail

COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
# git branch --show-current is empty in detached HEAD; fall back to --abbrev-ref.
BRANCH=$(git branch --show-current 2>/dev/null)
if [ -z "$BRANCH" ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
fi
BUILD_DATE=$(date '+%Y-%m-%d %H:%M')

exec /home/florian/.bun/bin/bun build src/index.tsx \
  --compile \
  --target bun-linux-x64 \
  --outfile dist/octmux \
  --define "BUILD_BRANCH=\"${BRANCH}\"" \
  --define "BUILD_COMMIT=\"${COMMIT}\"" \
  --define "BUILD_DATE=\"${BUILD_DATE}\""
