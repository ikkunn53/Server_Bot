import assert from 'node:assert/strict';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t, {uid = "1000"} = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'server-bot-linux-'));
  t.after(() => rmSync(temporary, {recursive: true, force: true}));
  const checkout = path.join(temporary, 'bot with spaces % $');
  mkdirSync(checkout);
  cpSync(path.join(root, 'scripts/linux'), path.join(checkout, 'scripts/linux'), {recursive: true});
  cpSync(path.join(root, '.env.example'), path.join(checkout, '.env.example'));
  symlinkSync(path.join(root, 'node_modules'), path.join(checkout, 'node_modules'));
  const bin = path.join(temporary, 'bin');
  mkdirSync(bin);
  const calls = path.join(temporary, 'calls');
  // Exercise script control flow without installing services on the test host.
  const stubs = {
    systemctl: 'printf "%s\\n" "$*" >> "$TEST_CALLS"; if [ "${NO_BUS:-}" = 1 ] || { [ "$1" = --user ] && [ "${NO_USER_BUS:-}" = 1 ]; }; then exit 1; fi',
    loginctl: 'echo loginctl >> "$TEST_CALLS"; printf "%s\\n" "${LINGER:-yes}"',
    id: 'if [ "$1" = -u ]; then echo "$TEST_UID"; elif [ "$1" = -un ]; then echo testuser; else exit 1; fi',
    mkdir: 'if [ "$*" != "-p -- /etc/systemd/system" ]; then exec /bin/mkdir "$@"; fi',
    node: 'if [ "${5:-}" = /etc/systemd/system/server-bot.service ]; then echo system-unit-write >> "$TEST_CALLS"; set -- "$1" "$2" "$3" "$4" "$TEST_UNIT" "$6"; fi; exec "$TEST_NODE" "$@"',
    npm: 'printf "npm %s\\n" "$*" >> "$TEST_CALLS"',
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(path.join(bin, name), '#!/bin/sh\n' + body + '\n', {mode: 0o755});
  }
  const config = path.join(temporary, 'config');
  const unit = path.join(config, 'systemd/user/server-bot.service');
  mkdirSync(path.dirname(unit), {recursive: true});
  const run = (name, extra = {}) => spawnSync('bash', [path.join(checkout, 'scripts/linux', name + '.sh')], {
    cwd: temporary,
    env: {...process.env, PATH: bin + ':' + process.env.PATH, XDG_CONFIG_HOME: config, TEST_CALLS: calls, TEST_UID: uid, TEST_NODE: process.execPath, TEST_UNIT: unit, ...extra},
    encoding: 'utf8',
  });
  return {run, checkout, calls, unit};
}

test('setup registers a quoted unit and preserves existing configuration on rerun', t => {
  const f = fixture(t);
  let result = f.run('setup');
  assert.equal(result.status, 0, result.stderr);
  const envPath = path.join(f.checkout, '.env');
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  const content = readFileSync(f.unit, 'utf8');
  assert.ok(content.includes('WorkingDirectory=' + f.checkout.replaceAll('%', '%%') + '\n'));
  assert.ok(content.includes(f.checkout.replaceAll('%', '%%').replaceAll('$', '$$') + '/src/index.js"'));
  assert.ok(content.includes('KillSignal=SIGTERM'));
  assert.ok(content.includes('Restart=on-failure'));
  const verify = spawnSync('systemd-analyze', ['--user', 'verify', f.unit], {encoding: 'utf8', env: {...process.env, XDG_RUNTIME_DIR: path.dirname(f.unit)}});
  assert.equal(verify.status, 0, verify.stderr);
  writeFileSync(envPath, 'DISCORD_TOKEN=test-only-not-a-real-token\n');
  result = f.run('setup');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(envPath, 'utf8'), 'DISCORD_TOKEN=test-only-not-a-real-token\n');
  assert.match(readFileSync(f.calls, 'utf8'), /npm install --package-lock=false/);
  writeFileSync(path.join(f.checkout, 'package-lock.json'), '{}');
  result = f.run('setup');
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(f.calls, 'utf8'), /npm ci/);
});

test('start rejects an unset token or missing linger; start and stop manage automatic startup', t => {
  const f = fixture(t);
  assert.equal(f.run('setup').status, 0);
  assert.notEqual(f.run('start').status, 0);
  writeFileSync(path.join(f.checkout, '.env'), 'DISCORD_TOKEN=test-only-not-a-real-token\n');
  assert.notEqual(f.run('start', {LINGER: 'no'}).status, 0);
  assert.doesNotMatch(readFileSync(f.calls, 'utf8'), /enable --now/);
  let result = f.run('start');
  assert.equal(result.status, 0, result.stderr);
  result = f.run('stop');
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(f.calls, 'utf8');
  assert.match(calls, /--user enable --now server-bot.service/);
  assert.match(calls, /--user disable --now server-bot.service/);
});

test('setup fails before installing or writing configuration without a user manager', t => {
  const f = fixture(t);
  assert.notEqual(f.run('setup', {NO_BUS: '1'}).status, 0);
  assert.equal(existsSync(f.unit), false);
  assert.equal(existsSync(path.join(f.checkout, '.env')), false);
  assert.doesNotMatch(readFileSync(f.calls, 'utf8'), /npm/);
});


test('root uses the system manager without a user bus or linger', t => {
  const f = fixture(t, {uid: '0'});
  const options = {NO_USER_BUS: '1', LINGER: 'no'};
  let result = f.run('setup', options);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(f.unit, 'utf8'), /WantedBy=multi-user.target/);
  assert.match(readFileSync(f.calls, 'utf8'), /system-unit-write/);
  writeFileSync(path.join(f.checkout, '.env'), 'DISCORD_TOKEN=test-only-not-a-real-token\n');
  result = f.run('start', options);
  assert.equal(result.status, 0, result.stderr);
  result = f.run('stop', options);
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(f.calls, 'utf8');
  assert.match(calls, /^enable --now server-bot.service$/m);
  assert.match(calls, /^disable --now server-bot.service$/m);
  assert.doesNotMatch(calls, /--user|loginctl/);
});

test('root setup fails cleanly when the system manager is also unavailable', t => {
  const f = fixture(t, {uid: '0'});
  assert.notEqual(f.run('setup', {NO_BUS: '1'}).status, 0);
  assert.equal(existsSync(f.unit), false);
  assert.equal(existsSync(path.join(f.checkout, '.env')), false);
  assert.doesNotMatch(readFileSync(f.calls, 'utf8'), /npm/);
});
