import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';
import sqlite3 from 'sqlite3';
import {open} from 'sqlite';
import {PermissionFlagsBits} from 'discord.js';
import {VOICE_DEPARTURE_SETTINGS, getVoiceDeparturePolicy, getVoiceDepartureDefault, parseVoiceDepartureSetting} from '../src/voice-departure-settings.js';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
async function fixture(t, {environment = {}} = {}) {
  const db = await open({filename: ':memory:', driver: sqlite3.Database});
  t.after(() => db.close());
  await db.exec(source.match(/const DB_SCHEMA_SQL = `([\s\S]*?)`;/)[1]);
  const getGuildSetting = async (guild, key) => (await db.get('SELECT value FROM guild_settings WHERE guild_id=? AND key=?', guild, key))?.value ?? null;
  const setGuildSetting = async (guild, key, value) => db.run('INSERT OR REPLACE INTO guild_settings VALUES(?,?,?)', guild, key, value);
  const context = vm.createContext({
    getDb: async () => db, getGuildSetting, setGuildSetting,
    deleteGuildSetting: async (guild, key) => db.run('DELETE FROM guild_settings WHERE guild_id=? AND key=?', guild, key),
    getVoiceDeparturePolicy: (guild, getSetting) => getVoiceDeparturePolicy(guild, getSetting, environment),
    getVoiceDepartureDefault: key => getVoiceDepartureDefault(key, environment),
    VOICE_DEPARTURE_SETTINGS, parseVoiceDepartureSetting,
    voiceDepartureOperationQueues: new Map(), PermissionFlagsBits,
  });
  const start = source.indexOf('async function recordVoiceDeparture(');
  const end = source.indexOf('function getNextBackupDate(', start);
  vm.runInContext(source.slice(start, end), context);
  const formatStart = source.indexOf('function formatSettingValue(');
  vm.runInContext(source.slice(formatStart, source.indexOf('async function getMusicQueue(', formatStart)), context);
  const commandStart = source.indexOf("  if (interaction.commandName === 'settings') {");
  const commandEnd = source.indexOf("  if (interaction.commandName === 'premium') {", commandStart);
  const handleSettings = vm.runInContext(`(async function(interaction) {${source.slice(commandStart, commandEnd)}})`, context);
  const command = async (subcommand, key, value, allowed = true) => {
    let reply;
    await handleSettings({
      commandName: 'settings', guildId: 'guild', guild: {},
      memberPermissions: {has: flag => allowed && flag === PermissionFlagsBits.ManageGuild},
      options: {getSubcommand: () => subcommand, getString: name => ({key, value})[name]},
      reply: async response => { reply = response; },
    });
    return reply;
  };
  return {db, record: context.recordVoiceDeparture, command, getGuildSetting, setGuildSetting};
}

test('setting validation rejects invalid numbers and accepts each supported boundary', () => {
  for (const [key, definition] of Object.entries(VOICE_DEPARTURE_SETTINGS)) {
    for (const value of [null, '', ' ', '-1', '0', '1.5', '1e2', 'NaN', 'Infinity', '2回', '0x10', String(definition.max + 1)]) {
      assert.equal(parseVoiceDepartureSetting(key, value), null, `${key}: ${value}`);
    }
    assert.equal(parseVoiceDepartureSetting(key, ` ${definition.min} `), definition.min);
    assert.equal(parseVoiceDepartureSetting(key, String(definition.max)), definition.max);
  }
});

test('existing default is two departures in one minute, with five-minute timeout', async t => {
  const {record} = await fixture(t);
  assert.equal((await record('guild', 'user', 100000)).shouldTimeout, false);
  const second = await record('guild', 'user', 160000);
  assert.equal(second.shouldTimeout, true);
  assert.equal(second.windowMinutes, 1);
  assert.equal(second.timeoutMinutes, 5);
  assert.equal((await record('guild', 'user', 220001)).shouldTimeout, false);
});

test('settings commands immediately change threshold, window and timeout per guild and clear restores default', async t => {
  const {record, command} = await fixture(t);
  await command('set', 'voice_departure_count', '3');
  await command('set', 'voice_departure_window_minutes', '2');
  await command('set', 'voice_departure_timeout_minutes', '10');
  assert.equal((await record('guild', 'user', 100000)).shouldTimeout, false);
  assert.equal((await record('guild', 'user', 161000)).shouldTimeout, false);
  const third = await record('guild', 'user', 220000);
  assert.equal(third.shouldTimeout, true);
  assert.equal(third.timeoutMinutes * 60000, 600000);
  assert.equal((await record('guild', 'other-user', 220000)).shouldTimeout, false);
  assert.equal((await record('other-guild', 'user', 220000)).count, 2);
  assert.match((await command('view', 'voice_departure_timeout_minutes')).content, /10分/);
  await command('clear', 'voice_departure_count');
  await command('clear', 'voice_departure_window_minutes');
  await command('clear', 'voice_departure_timeout_minutes');
  const restored = await record('guild', 'fresh-user', 230000);
  assert.equal(restored.count, 2);
  assert.equal(restored.windowMinutes, 1);
  assert.equal(restored.timeoutMinutes, 5);
  assert.match((await command('view', 'voice_departure_timeout_minutes')).content, /5分（既定値）/);
});

test('invalid command input and users without Manage Server cannot change persisted settings', async t => {
  const {command, getGuildSetting} = await fixture(t);
  assert.match((await command('set', 'voice_departure_count', '1.5')).content, /整数/);
  assert.equal(await getGuildSetting('guild', 'voice_departure_count'), null);
  await command('set', 'voice_departure_count', ' 3 ');
  assert.equal(await getGuildSetting('guild', 'voice_departure_count'), '3');
  assert.match((await command('set', 'voice_departure_count', '4', false)).content, /権限/);
  assert.equal(await getGuildSetting('guild', 'voice_departure_count'), '3');
});

test('corrupt stored settings fall back to defaults and concurrent departures remain serialized', async t => {
  const {setGuildSetting, record} = await fixture(t);
  await setGuildSetting('guild', 'voice_departure_count', 'NaN');
  await setGuildSetting('guild', 'voice_departure_timeout_minutes', '99999999');
  const results = await Promise.all([record('guild', 'user', 100000), record('guild', 'user', 100000)]);
  assert.deepEqual(results.map(result => result.shouldTimeout), [false, true]);
  assert.equal(results[1].timeoutMinutes, 5);
});

test('voice events apply the configured duration and audit reason while ignoring bot-triggered moves', async t => {
  const {record, command, db} = await fixture(t);
  await command('set', 'voice_departure_count', '1');
  await command('set', 'voice_departure_window_minutes', '3');
  await command('set', 'voice_departure_timeout_minutes', '10');
  const calls = [];
  let botTransition = false;
  const marker = "client.on('voiceStateUpdate', async (oldState, newState) => {";
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf("  if (!isBotVoiceTransition && memberId && !newState.member?.user?.bot && !oldState.channelId", start);
  const handle = vm.runInNewContext(`(async function(oldState, newState) {${source.slice(start, end)}})`, {
    recordVoiceDeparture: record,
    consumeBotVoiceTransition: () => botTransition,
    logOperationError: (name, error) => { throw error; },
  });
  const member = {id: 'user', user: {bot: false}, timeout: async (...args) => calls.push(args)};
  const before = {channelId: 'voice', member};
  const after = {channelId: null, guild: {id: 'guild'}, member};
  await handle(before, after);
  assert.deepEqual(calls, [[600000, '3分以内にVCから1回以上退出したため']]);
  botTransition = true;
  await handle(before, after);
  botTransition = false;
  member.user.bot = true;
  await handle(before, after);
  assert.equal(calls.length, 1);
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM voice_departures')).count, 1);
});


test('environment supplies defaults for every guild and settings view shows their source', async t => {
  const {record, command} = await fixture(t, {environment: {
    VOICE_DEPARTURE_COUNT: '3', VOICE_DEPARTURE_WINDOW_MINUTES: '2', VOICE_DEPARTURE_TIMEOUT_MINUTES: '10',
  }});
  assert.equal((await record('guild', 'user', 100000)).shouldTimeout, false);
  assert.equal((await record('guild', 'user', 161000)).shouldTimeout, false);
  const result = await record('guild', 'user', 220000);
  assert.equal(result.shouldTimeout, true);
  assert.equal(result.timeoutMinutes, 10);
  assert.equal((await record('other-guild', 'user', 220000)).count, 3);
  assert.match((await command('view', 'voice_departure_timeout_minutes')).content, /10分（環境変数）/);
});

test('guild settings override individual environment values and clearing restores the environment', async t => {
  const {record, command} = await fixture(t, {environment: {
    VOICE_DEPARTURE_COUNT: '3', VOICE_DEPARTURE_WINDOW_MINUTES: '2', VOICE_DEPARTURE_TIMEOUT_MINUTES: '10',
  }});
  await command('set', 'voice_departure_count', '1');
  await command('set', 'voice_departure_timeout_minutes', '20');
  const result = await record('guild', 'user', 100000);
  assert.equal(result.shouldTimeout, true);
  assert.equal(result.count, 1);
  assert.equal(result.windowMinutes, 2);
  assert.equal(result.timeoutMinutes, 20);
  assert.match((await command('view', 'voice_departure_timeout_minutes')).content, /20分/);
  await command('clear', 'voice_departure_count');
  await command('clear', 'voice_departure_timeout_minutes');
  const restored = await record('guild', 'fresh-user', 100000);
  assert.equal(restored.count, 3);
  assert.equal(restored.timeoutMinutes, 10);
  assert.match((await command('view', 'voice_departure_timeout_minutes')).content, /10分（環境変数）/);
});

test('invalid environment values fall back to built-in defaults', async t => {
  const {record, command} = await fixture(t, {environment: {
    VOICE_DEPARTURE_COUNT: '0', VOICE_DEPARTURE_WINDOW_MINUTES: '1.5', VOICE_DEPARTURE_TIMEOUT_MINUTES: '40321',
  }});
  const result = await record('guild', 'user', 100000);
  assert.equal(result.count, 2);
  assert.equal(result.windowMinutes, 1);
  assert.equal(result.timeoutMinutes, 5);
  assert.match((await command('view', 'voice_departure_timeout_minutes')).content, /5分（既定値）/);
});

test('dotenv loaded after module import is used by the policy', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'voice-env-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const envPath = path.join(directory, '.env');
  writeFileSync(envPath, 'VOICE_DEPARTURE_COUNT=4\nVOICE_DEPARTURE_WINDOW_MINUTES=3\nVOICE_DEPARTURE_TIMEOUT_MINUTES=15\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {getVoiceDeparturePolicy} from './src/voice-departure-settings.js';
    import dotenv from 'dotenv';
    import assert from 'node:assert/strict';
    dotenv.config({path: process.argv[1]});
    assert.deepEqual(await getVoiceDeparturePolicy('guild', async () => null), {count: 4, windowMinutes: 3, timeoutMinutes: 15});
  `, envPath], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: {...process.env, VOICE_DEPARTURE_COUNT: undefined, VOICE_DEPARTURE_WINDOW_MINUTES: undefined, VOICE_DEPARTURE_TIMEOUT_MINUTES: undefined},
  });
  assert.equal(child.status, 0, child.stderr);
});
