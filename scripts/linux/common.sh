#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SERVICE_NAME=server-bot.service
if [[ "$(uname -s)" != Linux ]]; then
  echo 'このスクリプトは Linux 専用です。' >&2
  exit 1
fi
command -v systemctl >/dev/null || { echo 'systemd が必要です。' >&2; exit 1; }
command -v loginctl >/dev/null || { echo 'systemd-logind (loginctl) が必要です。' >&2; exit 1; }
# Fail before making changes when no user service manager is available.
systemctl --user show-environment >/dev/null
