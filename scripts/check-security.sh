#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
TASK_DIR="$(mktemp -d)"
trap 'rm -rf "$TASK_DIR"' EXIT
npm ci --no-fund
npm audit
curl --fail --location --retry 2 --connect-timeout 15 --max-time 120 \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  --output "$TASK_DIR/gitleaks.tar.gz"
echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  $TASK_DIR/gitleaks.tar.gz" | sha256sum --check --status
tar -xzf "$TASK_DIR/gitleaks.tar.gz" -C "$TASK_DIR" gitleaks
"$TASK_DIR/gitleaks" git . --log-opts=--all --redact=100 --no-banner
if [[ -v GITHUB_STEP_SUMMARY ]]; then
  printf '### Segurança\n\nLockfile sem advisories reportados; histórico verificado com Gitleaks 8.30.1.\n' >> "$GITHUB_STEP_SUMMARY"
fi
