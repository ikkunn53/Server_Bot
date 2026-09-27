import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve(process.cwd(), 'src/index.js');
const source = readFileSync(sourcePath, 'utf8');

function extractBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) {
    throw new Error(`コマンド定義を抽出できません: ${startMarker}`);
  }
  return source.slice(start + startMarker.length, end);
}

const baseCommandsBlock = extractBlock('const baseCommands = [', 'const DISCORD_CHAT_INPUT_COMMAND_LIMIT');
const extraCommandsBlock = extractBlock('const EXTRA_COMMAND_NAMES = [', '];');
const baseCommands = [...baseCommandsBlock.matchAll(/new\s+SlashCommandBuilder\(\)\s*\.setName\('([^']+)'\)/g)]
  .map((match) => match[1]);
const extraCommands = [...extraCommandsBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
const commands = new Set([...baseCommands, ...extraCommands]);

const sorted = [...commands].sort((a, b) => a.localeCompare(b));

console.log('# Discord 手動E2Eチェックリスト');
console.log('');
console.log(`抽出元: ${sourcePath}`);
console.log(`総コマンド数: ${sorted.length}`);
console.log('');
console.log('## 使い方');
console.log('1. Botをテストサーバーへ招待し、GUILD_IDを設定して起動（即時反映）');
console.log('2. 各コマンドを `/` から実行');
console.log('3. 成功/失敗をこのチェックリストに記録');
console.log('');
console.log('## コマンド一覧');
for (const name of sorted) {
  console.log(`- [ ] /${name}`);
}
