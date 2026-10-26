#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SERVICE_NAME=server-bot.service
if [[ "$(uname -s)" != Linux ]]; then
  echo 'このスクリプトは Linux 専用です。' >&2
  exit 1
fi
command -v systemctl >/dev/null || { echo 'systemd が必要です。' >&2; exit 1; }
# Root installs a system service and does not need a user D-Bus session.
if [[ "$(id -u)" == 0 ]]; then
  SYSTEMCTL=(systemctl)
  UNIT_DIR=/etc/systemd/system
  INSTALL_TARGET=multi-user.target
  SERVICE_SCOPE=system
else
  command -v loginctl >/dev/null || { echo 'systemd-logind (loginctl) が必要です。' >&2; exit 1; }
  # runuser changes the user without supplying a login session's bus settings.
  # Connect to that user's existing manager; never create runtime directories here.
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
  SYSTEMCTL=(systemctl --user)
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  INSTALL_TARGET=default.target
  SERVICE_SCOPE=user
fi
# Fail before changing anything if the selected service manager is unavailable.
if ! "${SYSTEMCTL[@]}" show-environment >/dev/null; then
  echo "systemd の ${SERVICE_SCOPE} サービスマネージャーへ接続できません。" >&2
  if [[ "$SERVICE_SCOPE" == user ]]; then
    echo 'root で次を一度実行してから、同じコマンドを再実行してください:' >&2
    echo "  loginctl enable-linger $(id -un)" >&2
    echo "  systemctl start user@$(id -u).service" >&2
  fi
  exit 1
fi
