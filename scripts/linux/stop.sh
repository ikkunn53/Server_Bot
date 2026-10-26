#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
"${SYSTEMCTL[@]}" disable --now "$SERVICE_NAME"
echo 'サービスを停止し、自動起動を無効にしました。'
