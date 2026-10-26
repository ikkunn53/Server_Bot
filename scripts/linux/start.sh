#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
cd -- "$PROJECT_DIR"
# The service reads .env itself; this shell's exported variables are not inherited.
node --input-type=module <<'JS'
import dotenv from 'dotenv';
import {readFileSync} from 'node:fs';
const config = dotenv.parse(readFileSync('.env'));
if (!config.DISCORD_TOKEN || config.DISCORD_TOKEN === 'your-bot-token') {
  console.error('.env に有効な DISCORD_TOKEN を設定してください。');
  process.exit(1);
}
JS
if [[ "$SERVICE_SCOPE" == user ]] && [[ "$(loginctl show-user "$(id -un)" -p Linger --value)" != yes ]]; then
  echo "ログアウト後の継続に必要です: sudo loginctl enable-linger $(id -un)" >&2
  exit 1
fi
"${SYSTEMCTL[@]}" enable --now "$SERVICE_NAME"
echo 'サービスを起動しました。Discord 接続の成功はログの Logged in as と /ping で確認してください。'
"${SYSTEMCTL[@]}" status "$SERVICE_NAME" --no-pager
