import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve(process.cwd(), 'src/index.js');
const source = readFileSync(sourcePath, 'utf8');

const commandNamePattern = /new\s+SlashCommandBuilder\(\)\s*(?:\n\s*)?\.setName\('([^']+)'\)/g;
const commands = new Set();

for (const match of source.matchAll(commandNamePattern)) {
  commands.add(match[1]);
}

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
