import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const start = source.indexOf('const stickyMessageQueues = new Map();');
const end = source.indexOf("client.on('voiceStateUpdate'", start);
assert.ok(start >= 0 && end > start);

function setup({ sticky = '固定メッセージ' } = {}) {
  let handler;
  const calls = [];
  const settings = new Map([
    ['sticky_message_channel', sticky],
    ['sticky_message_id_channel', 'previous-sticky'],
  ]);
  const context = {
    client: { user: { id: 'self' }, on: (event, callback) => { handler = callback; } },
    getGuildSetting: async (guild, key) => settings.get(key),
    setGuildSetting: async (guild, key, value) => settings.set(key, value),
    getGuildChannelIdSet: async () => new Set(),
  };
  vm.runInNewContext(source.slice(start, end), context);
  const message = {
    guild: { id: 'guild' },
    author: { id: 'other-bot', bot: true },
    content: '',
    channel: {
      id: 'channel',
      messages: { delete: async (id) => calls.push(['delete', id]) },
      send: async (content) => {
        calls.push(['send', content]);
        // Discord can deliver our own message event before send() resolves.
        await handler({ ...message, author: { id: 'self', bot: true } });
        return { id: 'new-sticky' };
      },
    },
  };
  return { handler, message, calls, settings };
}

test('other bot posts refresh the sticky without invoking human-only features', async () => {
  const { handler, message, calls, settings } = setup();
  await handler(message);
  assert.deepEqual(calls, [['delete', 'previous-sticky'], ['send', '固定メッセージ']]);
  assert.equal(settings.get('sticky_message_id_channel'), 'new-sticky');
});

test('human posts still refresh the sticky', async () => {
  const { handler, message, calls } = setup();
  message.author = { id: 'human', bot: false };
  await handler(message);
  assert.equal(calls.filter(([action]) => action === 'send').length, 1);
});

test('own posts and direct messages do not refresh the sticky', async () => {
  const { handler, message, calls } = setup();
  await handler({ ...message, author: { id: 'self', bot: true } });
  await handler({ ...message, guild: null });
  assert.deepEqual(calls, []);
});

test('bot posts in channels without a sticky do not send messages', async () => {
  const { handler, message, calls } = setup({ sticky: null });
  await handler(message);
  assert.deepEqual(calls, []);
});

test('simultaneous posts delete the preceding sticky rather than leaving duplicates', async () => {
  const { handler, message, calls } = setup();
  await Promise.all([handler(message), handler(message)]);
  assert.deepEqual(calls, [
    ['delete', 'previous-sticky'], ['send', '固定メッセージ'],
    ['delete', 'new-sticky'], ['send', '固定メッセージ'],
  ]);
});
