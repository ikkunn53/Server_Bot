import assert from 'node:assert/strict';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t) {
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
    systemctl: 'printf "%s\\n" "$*" >> "$TEST_CALLS"; if [ "$1 $2" = "--user show-environment" ] && [ "${NO_BUS:-}" = 1 ]; then exit 1; fi',
    loginctl: 'printf "%s\\n" "${LINGER:-yes}"',
    npm: 'printf "npm %s\\n" "$*" >> "$TEST_CALLS"',
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(path.join(bin, name), '#!/bin/sh\n' + body + '\n', {mode: 0o755});
  }
  const config = path.join(temporary, 'config');
  const run = (name, extra = {}) => spawnSync('bash', [path.join(checkout, 'scripts/linux', name + '.sh')], {
    cwd: temporary,
    env: {...process.env, PATH: bin + ':' + process.env.PATH, XDG_CONFIG_HOME: config, TEST_CALLS: calls, ...extra},
    encoding: 'utf8',
  });
  return {run, checkout, calls, unit: path.join(config, 'systemd/user/server-bot.service')};
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
