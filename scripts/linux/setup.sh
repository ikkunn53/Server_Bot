#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
cd -- "$PROJECT_DIR"
command -v node >/dev/null
command -v npm >/dev/null
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("Node.js 20 以上が必要です"); process.exit(1); }'
if [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund
else
  npm install --package-lock=false --no-audit --no-fund
fi
npm run check
if [[ ! -e .env ]]; then
  (umask 077; set -o noclobber; cat .env.example > .env)
  echo '.env を作成しました。DISCORD_TOKEN を設定してください。'
fi
# Resolve the actual binary, including when Node was installed with nvm/asdf.
NODE_BIN="$(node -p 'process.execPath')"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p -- "$UNIT_DIR"
# Let Node escape systemd quoted strings, specifiers and ExecStart environment expansion.
node --input-type=module - "$PROJECT_DIR" "$NODE_BIN" "$UNIT_DIR/$SERVICE_NAME" <<'JS'
import {writeFileSync} from 'node:fs';
const [root, node, destination] = process.argv.slice(2);
function quote(value, exec = false) {
  if (/[\r\n\0]/.test(value)) throw new Error('Unsupported newline in path');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', exec ? '$$' : '$') + '"';
}
if (/[\r\n\0]/.test(root) || /\s$/.test(root)) throw new Error('Unsupported whitespace in project path');
writeFileSync(destination, `[Unit]
Description=Server Bot Discord service
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${root.replaceAll('%', '%%')}
ExecStart=${quote(node, true)} ${quote(root + '/src/index.js', true)}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`, {mode: 0o600});
JS
systemctl --user daemon-reload
if [[ "$(loginctl show-user "$(id -un)" -p Linger --value)" != yes ]]; then
  echo "ログアウト後も継続するには、一度だけ次を実行してください: sudo loginctl enable-linger $(id -un)" >&2
fi
echo 'セットアップ完了。.env を設定後、scripts/linux/start.sh で起動してください。'
