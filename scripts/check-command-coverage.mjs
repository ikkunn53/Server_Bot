import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve(process.cwd(), 'src/index.js');
const source = readFileSync(sourcePath, 'utf8');

function extractBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) {
    throw new Error(`コマンド定義の検証対象を抽出できません: ${startMarker}`);
  }
  return source.slice(start + startMarker.length, end);
}

function extractQuotedNames(block) {
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

const extraNames = extractQuotedNames(extractBlock('const EXTRA_COMMAND_NAMES = [', '];'));
const baseCommandsBlock = extractBlock('const baseCommands = [', 'const DISCORD_CHAT_INPUT_COMMAND_LIMIT');
const declaredNames = [
  ...[...baseCommandsBlock.matchAll(/new\s+SlashCommandBuilder\(\)\s*\.setName\('([^']+)'\)/g)]
    .map((match) => match[1]),
  ...extraNames,
];
const explicitlyImplementedNames = extractQuotedNames(
  extractBlock('const implementedCommandNames = new Set([', ']);'),
);
const implementedNames = new Set([...extraNames, ...explicitlyImplementedNames]);

const missingHandlers = declaredNames.filter((name) => !implementedNames.has(name));
const duplicateNames = declaredNames.filter((name, index) => declaredNames.indexOf(name) !== index);
const declaredNameSet = new Set(declaredNames);
const unknownHandlers = [...implementedNames].filter((name) => !declaredNameSet.has(name));
const exceedsDiscordLimit = declaredNames.length > 100;

if (missingHandlers.length || duplicateNames.length || unknownHandlers.length || exceedsDiscordLimit) {
  const problems = [
    missingHandlers.length ? `ハンドラ未登録: ${missingHandlers.join(', ')}` : null,
    duplicateNames.length ? `コマンド名重複: ${[...new Set(duplicateNames)].join(', ')}` : null,
    unknownHandlers.length ? `宣言のないハンドラ: ${unknownHandlers.join(', ')}` : null,
    exceedsDiscordLimit ? `Discordの上限超過: ${declaredNames.length}/100` : null,
  ].filter(Boolean);
  throw new Error(`コマンド網羅性チェックに失敗しました（${problems.join(' / ')}）`);
}

console.log(`Command coverage check passed: ${declaredNames.length} commands`);
