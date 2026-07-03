import dotenv from 'dotenv';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { access, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID || null;
const dbPath = process.env.DB_PATH || 'data/{guild_id}/channelbot.db';
const logChannelId = process.env.LOG_CHANNEL_ID || null;
const dailyDbBackupEnabled = process.env.DB_DAILY_BACKUP_ENABLED !== 'false';
const dailyDbBackupDir = process.env.DB_DAILY_BACKUP_DIR || 'data/backups';
const dailyDbBackupRetentionDays = Math.max(1, Number.parseInt(process.env.DB_DAILY_BACKUP_RETENTION_DAYS || '14', 10) || 14);
const dailyDbBackupTimeUtcRaw = process.env.DB_DAILY_BACKUP_TIME_UTC || '';

function parseDailyBackupUtcTime() {
  const hhmm = dailyDbBackupTimeUtcRaw.trim();
  if (!hhmm) {
    return null;
  }
  const match = hhmm.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (match) {
    return { hour: Number.parseInt(match[1], 10), minute: Number.parseInt(match[2], 10), source: 'DB_DAILY_BACKUP_TIME_UTC' };
  }
  console.warn(`Invalid DB_DAILY_BACKUP_TIME_UTC value "${dailyDbBackupTimeUtcRaw}". Daily backup is disabled.`);
  return null;
}

const dailyDbBackupTimeUtc = parseDailyBackupUtcTime();

function buildAutoThreadPrefixFromMessage(message, username = '') {
  const normalized = (message.content || '')
    .replace(/\s+/g, ' ')
    .trim();
  const maxPrefixLength = Math.max(1, 100 - String(username).length - 1);
  if (!normalized) {
    return 'thread';
  }
  return normalized.slice(0, maxPrefixLength);
}

if (!token) {
  throw new Error('DISCORD_TOKEN is required');
}

const CREATE_TICKET_BUTTON_ID = 'ticket:create';
const JOIN_TO_CREATE_TRIGGERS_KEY = 'jointocreate_triggers_json';
const DEFAULT_TEMP_VC_PREFIX = 'VC';
const TEMP_VOICE_LOCK_PREFIX = 'temp_voice_lock_';
const TEMP_VOICE_OWNER_ABSENT_PREFIX = 'temp_voice_owner_absent_';
const TEMP_VOICE_LOCK_MODES = {
  CONNECT: 'connect',
  HIDDEN: 'hidden',
};
const TEMP_VOICE_OWNER_ABSENT_AUTO_UNLOCK_MS = 10 * 60 * 1000;
const TEMP_CHANNEL_DELETE_RETRY_DELAYS_MS = [5000, 30000, 120000];
const TEMP_CHANNEL_CLEANUP_INTERVAL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.TEMP_CHANNEL_CLEANUP_INTERVAL_MS || '900000', 10) || 900000,
);
const TEMP_VOICE_CONFIG_CACHE_TTL_MS = Math.max(
  1_000,
  Number.parseInt(process.env.TEMP_VOICE_CONFIG_CACHE_TTL_MS || '30000', 10) || 30000,
);
const VOICE_LINK_CACHE_TTL_MS = Math.max(
  1_000,
  Number.parseInt(process.env.VOICE_LINK_CACHE_TTL_MS || '30000', 10) || 30000,
);
const BOT_CREATOR = 'IKKUNN53';

const pendingTempChannelDeleteTimers = new Map();
const tempVoiceConfigCache = new Map();
const tempVoiceOwnerChannelIdCache = new Map();
const voiceLinkCache = new Map();
const tempVoiceMetricsMap = new Map();
let tempChannelCleanupInterval = null;
let isCleaningTempChannels = false;


const EXTRA_COMMAND_NAMES = [
  'addpermall','autopublish','clearpermall','imageonly','jointocreate','setsuggestion','spookify','springify','suggestionwhitelist','tempchannels','userlock','userunlock','voicelink','winterify','buttonroles','reactionroles','resetrole','role','roleall','addemoji','backup','delemoji','emojilock','serversetup','suggestemojis'
];

const extraCommandBuilders = {
  addpermall: new SlashCommandBuilder().setName('addpermall').setDescription('複数チャンネルへ権限を許可します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) => o.setName('permission').setDescription('権限名').setRequired(true))
    .addMentionableOption((o) => o.setName('target').setDescription('対象ユーザー/ロール').setRequired(true))
    .addChannelOption((o) => o.setName('category').setDescription('対象カテゴリー').addChannelTypes(ChannelType.GuildCategory).setRequired(false)),
  clearpermall: new SlashCommandBuilder().setName('clearpermall').setDescription('複数チャンネルの権限上書きを解除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) => o.setName('permission').setDescription('権限名').setRequired(true))
    .addMentionableOption((o) => o.setName('target').setDescription('対象ユーザー/ロール').setRequired(true))
    .addChannelOption((o) => o.setName('category').setDescription('対象カテゴリー').addChannelTypes(ChannelType.GuildCategory).setRequired(false)),
  delpermall: new SlashCommandBuilder().setName('delpermall').setDescription('clearpermall と同じ動作をします')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) => o.setName('permission').setDescription('権限名').setRequired(true))
    .addMentionableOption((o) => o.setName('target').setDescription('対象ユーザー/ロール').setRequired(true))
    .addChannelOption((o) => o.setName('category').setDescription('対象カテゴリー').addChannelTypes(ChannelType.GuildCategory).setRequired(false)),
  imageonly: new SlashCommandBuilder().setName('imageonly').setDescription('画像専用チャンネルの有効/無効を切り替え').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addBooleanOption((o) => o.setName('enabled').setDescription('true=有効 false=無効').setRequired(true))
    .addChannelOption((o) => o.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  autopublish: new SlashCommandBuilder().setName('autopublish').setDescription('アナウンスチャンネルの自動公開設定を管理します').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) =>
      o.setName('action').setDescription('実行する操作').setRequired(true).addChoices(
        { name: 'ON', value: 'on' },
        { name: 'OFF', value: 'off' },
        { name: '一覧表示', value: 'list' },
      ))
    .addChannelOption((o) => o.setName('channel').setDescription('対象チャンネル（有効化/無効化時）').addChannelTypes(ChannelType.GuildAnnouncement).setRequired(false)),
  jointocreate: new SlashCommandBuilder().setName('jointocreate').setDescription('Join to Create（一時VC作成）の設定を管理します').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) =>
      o.setName('action').setDescription('実行する操作').setRequired(true).addChoices(
        { name: '設定', value: 'setup' },
        { name: '削除', value: 'delete' },
        { name: '状態確認', value: 'list' },
      ))
    .addChannelOption((o) => o.setName('voice_channel').setDescription('参加トリガーのボイスチャンネル（設定時）').addChannelTypes(ChannelType.GuildVoice).setRequired(false))
    .addChannelOption((o) => o.setName('category').setDescription('作成先カテゴリー（設定時）').addChannelTypes(ChannelType.GuildCategory).setRequired(false))
    .addStringOption((o) => o.setName('name_prefix').setDescription('作成VC名の先頭文字（未指定時:VC）').setRequired(false).setMaxLength(30)),
  tempchannels: new SlashCommandBuilder().setName('tempchannels').setDescription('一時ボイスチャンネル機能の設定を管理します').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) =>
      o.setName('action').setDescription('実行する操作').setRequired(true).addChoices(
        { name: '有効化', value: 'setup' },
        { name: '無効化', value: 'delete' },
        { name: '設定確認', value: 'config' },
        { name: '状態診断', value: 'health' },
        { name: '空VC掃除', value: 'cleanup' },
      )),
  setsuggestion: new SlashCommandBuilder().setName('setsuggestion').setDescription('提案チャンネルを設定').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((o) => o.setName('channel').setDescription('提案先チャンネル').setRequired(true)),
  suggestionwhitelist: new SlashCommandBuilder().setName('suggestionwhitelist').setDescription('提案チャンネルのホワイトリストを管理します').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addStringOption((o) =>
      o.setName('action').setDescription('実行する操作').setRequired(true).addChoices(
        { name: '一覧表示', value: 'list' },
        { name: '追加', value: 'add' },
        { name: '削除', value: 'remove' },
      ))
    .addRoleOption((o) => o.setName('role').setDescription('対象ロール（追加/削除時）').setRequired(false)),
  suggestemojis: new SlashCommandBuilder().setName('suggestemojis').setDescription('提案投票リアクションを設定').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('up').setDescription('賛成絵文字').setRequired(true))
    .addStringOption((o) => o.setName('down').setDescription('反対絵文字').setRequired(true)),
  userlock: new SlashCommandBuilder().setName('userlock').setDescription('指定ユーザーの発言を禁止').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addUserOption((o) => o.setName('user').setDescription('対象ユーザー').setRequired(true))
    .addChannelOption((o) => o.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  userunlock: new SlashCommandBuilder().setName('userunlock').setDescription('指定ユーザーの発言禁止を解除').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addUserOption((o) => o.setName('user').setDescription('対象ユーザー').setRequired(true))
    .addChannelOption((o) => o.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  voicelink: new SlashCommandBuilder().setName('voicelink').setDescription('ボイス参加通知の紐付け設定を管理します').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) =>
      o.setName('action').setDescription('実行する操作').setRequired(true).addChoices(
        { name: '紐付け', value: 'link' },
        { name: '解除', value: 'unlink' },
        { name: '一覧表示', value: 'list' },
        { name: '全解除', value: 'clear' },
      ))
    .addChannelOption((o) => o.setName('voice').setDescription('対象ボイスチャンネル（紐付け/解除時）').addChannelTypes(ChannelType.GuildVoice).setRequired(false))
    .addChannelOption((o) => o.setName('text').setDescription('通知先テキストチャンネル（紐付け時）').setRequired(false)),
  spookify: new SlashCommandBuilder().setName('spookify').setDescription('ハロウィン風のチャンネル名装飾をON/OFFします').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) => o.setName('action').setDescription('実行する操作').setRequired(true).addChoices({ name: 'ON', value: 'on' }, { name: 'OFF', value: 'off' })),
  springify: new SlashCommandBuilder().setName('springify').setDescription('春風のチャンネル名装飾をON/OFFします').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) => o.setName('action').setDescription('実行する操作').setRequired(true).addChoices({ name: 'ON', value: 'on' }, { name: 'OFF', value: 'off' })),
  winterify: new SlashCommandBuilder().setName('winterify').setDescription('冬風のチャンネル名装飾をON/OFFします').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) => o.setName('action').setDescription('実行する操作').setRequired(true).addChoices({ name: 'ON', value: 'on' }, { name: 'OFF', value: 'off' })),
  buttonroles: new SlashCommandBuilder().setName('buttonroles').setDescription('ロール選択ボタンを作成').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addStringOption((o) => o.setName('title').setDescription('案内文').setRequired(true))
    .addRoleOption((o) => o.setName('role1').setDescription('ロール1').setRequired(true))
    .addRoleOption((o) => o.setName('role2').setDescription('ロール2').setRequired(false))
    .addRoleOption((o) => o.setName('role3').setDescription('ロール3').setRequired(false)),
  reactionroles: new SlashCommandBuilder().setName('reactionroles').setDescription('リアクションロール投稿を作成').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addStringOption((o) => o.setName('title').setDescription('案内文').setRequired(true))
    .addRoleOption((o) => o.setName('role1').setDescription('ロール1').setRequired(true))
    .addStringOption((o) => o.setName('emoji1').setDescription('絵文字1').setRequired(true))
    .addRoleOption((o) => o.setName('role2').setDescription('ロール2').setRequired(false))
    .addStringOption((o) => o.setName('emoji2').setDescription('絵文字2').setRequired(false)),
  role: new SlashCommandBuilder().setName('role').setDescription('自分にロールを付与/解除').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((o) => o.setName('user').setDescription('対象ユーザー').setRequired(true))
    .addRoleOption((o) => o.setName('role').setDescription('対象ロール').setRequired(true))
    .addBooleanOption((o) => o.setName('enabled').setDescription('true=付与 false=解除').setRequired(true)),
  roleall: new SlashCommandBuilder().setName('roleall').setDescription('サーバー全員へロールを一括付与/解除します').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addRoleOption((o) => o.setName('role').setDescription('対象ロール').setRequired(true))
    .addStringOption((o) =>
      o.setName('action').setDescription('実行する操作').setRequired(true).addChoices(
        { name: '全員に付与', value: 'add' },
        { name: '全員から解除', value: 'remove' },
      )),
  resetrole: new SlashCommandBuilder().setName('resetrole').setDescription('ユーザーのロールをリセット').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((o) => o.setName('user').setDescription('対象ユーザー').setRequired(true)),
  addemoji: new SlashCommandBuilder().setName('addemoji').setDescription('カスタム絵文字を追加').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuildExpressions)
    .addStringOption((o) => o.setName('name').setDescription('絵文字名').setRequired(true))
    .addStringOption((o) => o.setName('url').setDescription('画像URL').setRequired(true)),
  delemoji: new SlashCommandBuilder().setName('delemoji').setDescription('カスタム絵文字を削除').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuildExpressions)
    .addStringOption((o) => o.setName('name').setDescription('絵文字名').setRequired(true)),
  emojilock: new SlashCommandBuilder().setName('emojilock').setDescription('カスタム絵文字の使用を禁止/解除').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption((o) => o.setName('enabled').setDescription('true=禁止 false=解除').setRequired(true)),
  backup: new SlashCommandBuilder().setName('backup').setDescription('ギルド設定のバックアップ作成/復元を行います').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName('action').setDescription('実行する操作').setRequired(true).addChoices(
        { name: 'バックアップ作成', value: 'create' },
        { name: 'バックアップ復元', value: 'restore' },
      ))
    .addAttachmentOption((o) => o.setName('file').setDescription('復元に使うバックアップJSON（restore時に必須）').setRequired(false)),
  serversetup: new SlashCommandBuilder().setName('serversetup').setDescription('初期セットアップを実行').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
};


const SETTINGS_OPTION_CHOICES = [
  { name: 'lock_message', value: 'lock_message' },
  { name: 'unlock_message', value: 'unlock_message' },
  { name: 'default_category_id', value: 'default_category_id' },
  { name: 'welcome_mode', value: 'welcome_mode' },
  { name: 'welcome_channel_id', value: 'welcome_channel_id' },
  { name: 'welcome_message', value: 'welcome_message' },
  { name: 'premium_enabled', value: 'premium_enabled' },
  { name: 'premium_plan', value: 'premium_plan' },
  { name: 'music_queue_json', value: 'music_queue_json' },
  { name: 'music_now_playing_json', value: 'music_now_playing_json' },
];

const PREMIUM_PLAN_CHOICES = [
  { name: 'free', value: 'free' },
  { name: 'plus', value: 'plus' },
  { name: 'pro', value: 'pro' },
];

const MUSIC_QUEUE_KEY = 'music_queue_json';
const MUSIC_NOW_PLAYING_KEY = 'music_now_playing_json';
const ACTIVITY_APPLICATION_IDS = {
  poker: '755827207812677713',
  chess: '832012774040141894',
  betrayal: '773336526917861400',
  fishing: '814288819477020702',
  lettertile: '879863686565621790',
  spellcast: '852509694341283871',
  watchtogether: '880218394199220334',
};

const baseCommands = [
  new SlashCommandBuilder().setName('ping').setDescription('Botの疎通を確認します'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('利用可能なコマンド一覧や詳細を表示します')
    .addStringOption((option) => option.setName('command').setDescription('詳細を見たいコマンド名（例: lock）').setRequired(false)),
  new SlashCommandBuilder().setName('invite').setDescription('Bot招待に関する案内を表示します'),
  new SlashCommandBuilder().setName('support').setDescription('サポート案内を表示します'),
  new SlashCommandBuilder().setName('dashboard').setDescription('ダッシュボード機能の案内を表示します'),
  new SlashCommandBuilder().setName('privacy').setDescription('プライバシーポリシーと利用規約の案内を表示します'),
  new SlashCommandBuilder()
    .setName('prefix')
    .setDescription('コマンド接頭辞（prefix）の案内を表示します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) => option.setName('new_prefix').setDescription('新しいprefix（互換案内用）').setRequired(false)),
  new SlashCommandBuilder()
    .setName('debug')
    .setDescription('コマンドの簡易デバッグ情報を表示します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) => option.setName('command').setDescription('確認したいコマンド名').setRequired(false)),
  new SlashCommandBuilder()
    .setName('lock')
    .setDescription('チャンネルをロックします（任意で時間指定）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false))
    .addStringOption((option) => option.setName('duration').setDescription('継続時間（例: 10m, 2h）').setRequired(false)),
  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('チャンネルのロックを解除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('hide')
    .setDescription('チャンネルを非表示にします（任意で時間指定）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false))
    .addStringOption((option) => option.setName('duration').setDescription('継続時間（例: 10m, 2h）').setRequired(false)),
  new SlashCommandBuilder()
    .setName('show')
    .setDescription('非表示チャンネルを表示状態に戻します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('チャンネルの低速モードを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) => option.setName('time').setDescription('時間（例: 10s, 5m, 1h, off）').setRequired(true))
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('settopic')
    .setDescription('チャンネルのトピックを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) => option.setName('text').setDescription('新しいトピック').setRequired(true).setMaxLength(1024))
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('rename')
    .setDescription('チャンネル名を変更します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) => option.setName('name').setDescription('新しいチャンネル名').setRequired(true).setMaxLength(100))
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('チャンネルのメッセージを一括削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((option) => option.setName('count').setDescription('削除件数（1-100）').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption((option) => option.setName('user').setDescription('このユーザーの投稿のみ削除').setRequired(false)),
  new SlashCommandBuilder()
    .setName('createchannel')
    .setDescription('チャンネルを作成します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) => option.setName('name').setDescription('チャンネル名').setRequired(true))
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('チャンネルタイプ')
        .setRequired(false)
        .addChoices(
          { name: 'テキスト', value: 'text' },
          { name: 'ボイス', value: 'voice' },
          { name: 'カテゴリー', value: 'category' },
          { name: 'アナウンス', value: 'announcement' },
        ),
    )
    .addChannelOption((option) =>
      option.setName('category').setDescription('親カテゴリー').addChannelTypes(ChannelType.GuildCategory).setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('clone')
    .setDescription('チャンネルを複製します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('delete')
    .setDescription('チャンネルを削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('togglensfw')
    .setDescription('チャンネルのNSFW設定を切り替えます')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('投票を作成します')
    .addStringOption((option) => option.setName('question').setDescription('質問内容').setRequired(true)),
  new SlashCommandBuilder()
    .setName('archive')
    .setDescription('チャンネルをアーカイブカテゴリーへ移動します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('archivedcat')
    .setDescription('アーカイブ先カテゴリーを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option.setName('category').setDescription('アーカイブ先カテゴリー').addChannelTypes(ChannelType.GuildCategory).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('deletecategory')
    .setDescription('カテゴリーを削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option.setName('category').setDescription('削除するカテゴリー').addChannelTypes(ChannelType.GuildCategory).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('move')
    .setDescription('チャンネルをカテゴリーへ移動します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option.setName('category').setDescription('移動先カテゴリー').addChannelTypes(ChannelType.GuildCategory).setRequired(true),
    )
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル（未指定時は現在チャンネル）').setRequired(false)),
  new SlashCommandBuilder()
    .setName('setbitrate')
    .setDescription('ボイスチャンネルのビットレートを変更します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption((option) => option.setName('bitrate').setDescription('ビットレート(bps)').setRequired(true).setMinValue(8000).setMaxValue(384000))
    .addChannelOption((option) => option.setName('channel').setDescription('対象ボイスチャンネル').addChannelTypes(ChannelType.GuildVoice).setRequired(false)),
  new SlashCommandBuilder()
    .setName('addperm')
    .setDescription('チャンネル権限を許可します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) => option.setName('permission').setDescription('権限名 (ViewChannel/SendMessages/AttachFiles)').setRequired(true))
    .addMentionableOption((option) => option.setName('target').setDescription('対象ユーザーまたはロール').setRequired(true))
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('clearperm')
    .setDescription('チャンネル権限の上書きを解除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) => option.setName('permission').setDescription('権限名 (ViewChannel/SendMessages/AttachFiles)').setRequired(true))
    .addMentionableOption((option) => option.setName('target').setDescription('対象ユーザーまたはロール').setRequired(true))
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('delperm')
    .setDescription('clearperm のエイリアス')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) => option.setName('permission').setDescription('権限名 (ViewChannel/SendMessages/AttachFiles)').setRequired(true))
    .addMentionableOption((option) => option.setName('target').setDescription('対象ユーザーまたはロール').setRequired(true))
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('mentionable')
    .setDescription('ロールのメンション可能設定を切り替えます')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addRoleOption((option) => option.setName('role').setDescription('対象ロール').setRequired(true))
    .addBooleanOption((option) => option.setName('enabled').setDescription('true:許可 false:禁止').setRequired(true)),
  new SlashCommandBuilder()
    .setName('lockmessage')
    .setDescription('ロック時の通知メッセージを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) => option.setName('message').setDescription('通知文').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder()
    .setName('unlockmessage')
    .setDescription('ロック解除時の通知メッセージを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) => option.setName('message').setDescription('通知文').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder()
    .setName('disable')
    .setDescription('このBotコマンドをサーバーで無効化します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) => option.setName('command').setDescription('無効化するコマンド名 (先頭/なし)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('enable')
    .setDescription('無効化したBotコマンドを再有効化します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) => option.setName('command').setDescription('再有効化するコマンド名 (先頭/なし)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('disabledlist')
    .setDescription('無効化中のBotコマンド一覧を表示します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('clearchannel')
    .setDescription('チャンネル内メッセージを可能な範囲で削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('sync')
    .setDescription('現在チャンネルの権限を親カテゴリーと同期します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName('synccat')
    .setDescription('指定カテゴリー配下チャンネルの権限を同期します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option.setName('category').setDescription('対象カテゴリー').addChannelTypes(ChannelType.GuildCategory).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('multilock')
    .setDescription('指定カテゴリー配下チャンネルを一括ロックします')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option.setName('category').setDescription('対象カテゴリー').addChannelTypes(ChannelType.GuildCategory).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('multiunlock')
    .setDescription('指定カテゴリー配下チャンネルを一括アンロックします')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option.setName('category').setDescription('対象カテゴリー').addChannelTypes(ChannelType.GuildCategory).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('ウェルカムメッセージ設定')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('送信モード')
        .setRequired(true)
        .addChoices(
          { name: 'チャンネル送信', value: 'channel' },
          { name: 'DM送信', value: 'dm' },
          { name: '無効化', value: 'disable' },
        ),
    )
    .addChannelOption((option) => option.setName('channel').setDescription('送信先チャンネル').setRequired(false))
    .addStringOption((option) => option.setName('message').setDescription('メッセージ本文').setRequired(false).setMaxLength(1000)),
  new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('参加時自動ロールを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addRoleOption((option) => option.setName('role').setDescription('対象ロール').setRequired(true))
    .addBooleanOption((option) => option.setName('enabled').setDescription('true=追加 false=解除').setRequired(true)),
  new SlashCommandBuilder()
    .setName('mods')
    .setDescription('モデレーターロールを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption((option) => option.setName('role').setDescription('対象ロール').setRequired(true))
    .addBooleanOption((option) => option.setName('enabled').setDescription('true=追加 false=解除').setRequired(true)),
  new SlashCommandBuilder()
    .setName('defaultroles')
    .setDescription('新規参加者へのデフォルトロールを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addRoleOption((option) => option.setName('role').setDescription('対象ロール').setRequired(true))
    .addBooleanOption((option) => option.setName('enabled').setDescription('true=追加 false=解除').setRequired(true)),
  new SlashCommandBuilder()
    .setName('defaultcategory')
    .setDescription('新規作成系で使うデフォルトカテゴリーを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option.setName('category').setDescription('デフォルトカテゴリー').addChannelTypes(ChannelType.GuildCategory).setRequired(false),
    )
    .addBooleanOption((option) => option.setName('clear').setDescription('設定をクリア').setRequired(false)),
  new SlashCommandBuilder()
    .setName('sticky')
    .setDescription('チャンネル固定メッセージ（スティッキー）を管理します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('実行する操作')
        .setRequired(true)
        .addChoices(
          { name: '有効化', value: 'enable' },
          { name: '無効化', value: 'disable' },
          { name: '削除', value: 'clear' },
        ),
    )
    .addStringOption((option) => option.setName('message').setDescription('固定メッセージ（有効化時に必須）').setRequired(false).setMaxLength(1500)),
  new SlashCommandBuilder()
    .setName('autothread')
    .setDescription('メッセージ投稿時に自動スレッドを作成するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addBooleanOption((option) => option.setName('enabled').setDescription('true=有効 false=無効').setRequired(true))
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('listwebhooks')
    .setDescription('チャンネルのWebhook一覧を表示します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageWebhooks)
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Bot名義でメッセージを送信します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((option) => option.setName('message').setDescription('送信内容').setRequired(true).setMaxLength(1800)),
  new SlashCommandBuilder()
    .setName('embed')
    .setDescription('埋め込みメッセージを送信します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((option) => option.setName('title').setDescription('タイトル').setRequired(true).setMaxLength(256))
    .addStringOption((option) => option.setName('description').setDescription('本文').setRequired(true).setMaxLength(4000)),
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Bot / サーバー / DB の統計を表示します'),
  new SlashCommandBuilder()
    .setName('permissions')
    .setDescription('ユーザーまたはロールの権限を確認します')
    .addUserOption((option) => option.setName('user').setDescription('確認対象ユーザー').setRequired(false))
    .addRoleOption((option) => option.setName('role').setDescription('確認対象ロール').setRequired(false))
    .addChannelOption((option) => option.setName('channel').setDescription('確認対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('settings')
    .setDescription('主要なBot設定を確認・変更します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('view')
        .setDescription('設定を表示します')
        .addStringOption((option) =>
          option.setName('key').setDescription('表示する設定キー').setRequired(false).addChoices(...SETTINGS_OPTION_CHOICES),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('set')
        .setDescription('設定を更新します')
        .addStringOption((option) =>
          option.setName('key').setDescription('設定キー').setRequired(true).addChoices(...SETTINGS_OPTION_CHOICES),
        )
        .addStringOption((option) => option.setName('value').setDescription('設定値').setRequired(true).setMaxLength(1800)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('clear')
        .setDescription('設定を削除します')
        .addStringOption((option) =>
          option.setName('key').setDescription('削除する設定キー').setRequired(true).addChoices(...SETTINGS_OPTION_CHOICES),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('clearall')
        .setDescription('このサーバーに紐づくBot設定/チケット情報を全削除します')
        .addStringOption((option) =>
          option
            .setName('confirm')
            .setDescription('確認文字列')
            .setRequired(true)
            .addChoices({ name: 'CONFIRM', value: 'CONFIRM' }),
        )
        .addBooleanOption((option) =>
          option
            .setName('delete_channels')
            .setDescription('true にすると関連チケットチャンネルも削除します（権限が必要）')
            .setRequired(false),
        ),
    ),
  new SlashCommandBuilder()
    .setName('premium')
    .setDescription('プレミアム機能の状態を確認・切替します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) => subcommand.setName('check').setDescription('プレミアム状態を表示します（互換）'))
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('プレミアム状態を表示します（互換）'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('activate')
        .setDescription('このサーバーでプレミアムを有効化します（互換）')
        .addStringOption((option) =>
          option.setName('plan').setDescription('プラン').setRequired(false).addChoices(...PREMIUM_PLAN_CHOICES),
        ),
    )
    .addSubcommand((subcommand) => subcommand.setName('deactivate').setDescription('このサーバーのプレミアムを無効化します（互換）'))
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('プレミアム状態を表示します'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('enable')
        .setDescription('このサーバーでプレミアムを有効化します')
        .addStringOption((option) =>
          option.setName('plan').setDescription('プラン').setRequired(false).addChoices(...PREMIUM_PLAN_CHOICES),
        ),
    )
    .addSubcommand((subcommand) => subcommand.setName('disable').setDescription('このサーバーのプレミアムを無効化します')),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('ボイスチャンネルのアクティビティ開始と簡易キュー管理を行います')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('start')
        .setDescription('ボイスチャンネルでアクティビティ（ゲーム）を開始します')
        .addStringOption((option) =>
          option
            .setName('game')
            .setDescription('開始するアクティビティ')
            .setRequired(true)
            .addChoices(
              { name: 'Poker Night', value: 'poker' },
              { name: 'Chess In The Park', value: 'chess' },
              { name: 'Betrayal.io', value: 'betrayal' },
              { name: 'Fishington.io', value: 'fishing' },
              { name: 'Letter League', value: 'lettertile' },
              { name: 'SpellCast', value: 'spellcast' },
              { name: 'Watch Together', value: 'watchtogether' },
            ),
        )
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('開始先のボイスチャンネル（未指定時は参加中VC）')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('enqueue')
        .setDescription('曲をキューに追加します')
        .addStringOption((option) => option.setName('title').setDescription('曲名').setRequired(true).setMaxLength(200))
        .addStringOption((option) => option.setName('url').setDescription('参照URL').setRequired(false).setMaxLength(1000)),
    )
    .addSubcommand((subcommand) => subcommand.setName('queue').setDescription('現在のキューを表示します'))
    .addSubcommand((subcommand) => subcommand.setName('skip').setDescription('先頭曲をスキップします'))
    .addSubcommand((subcommand) => subcommand.setName('clear').setDescription('キューをクリアします')),
  new SlashCommandBuilder().setName('serverinfo').setDescription('サーバー情報を表示します'),
  new SlashCommandBuilder()
    .setName('channelinfo')
    .setDescription('チャンネル情報を表示します')
    .addChannelOption((option) => option.setName('channel').setDescription('対象チャンネル').setRequired(false)),
  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('ユーザー情報を表示します')
    .addUserOption((option) => option.setName('user').setDescription('対象ユーザー').setRequired(false)),
  new SlashCommandBuilder()
    .setName('roleinfo')
    .setDescription('ロール情報を表示します')
    .addRoleOption((option) => option.setName('role').setDescription('対象ロール').setRequired(true)),
  new SlashCommandBuilder()
    .setName('vc-lock')
    .setDescription('自分の一時VCを入室禁止にします'),
  new SlashCommandBuilder()
    .setName('vc-hidden')
    .setDescription('自分の一時VCを非表示にします'),
  new SlashCommandBuilder()
    .setName('vc-unlock')
    .setDescription('自分の一時VCロックを解除します'),
  new SlashCommandBuilder()
    .setName('vc-lock-status')
    .setDescription('自分の一時VCロック状態を表示します'),
  new SlashCommandBuilder()
    .setName('vc-invite')
    .setDescription('自分の一時VCへユーザーを招待します')
    .addUserOption((option) => option.setName('user').setDescription('招待するユーザー').setRequired(true)),
  new SlashCommandBuilder()
    .setName('vc-kick')
    .setDescription('自分の一時VCからユーザーの招待権限を削除します')
    .addUserOption((option) => option.setName('user').setDescription('招待権限を削除するユーザー').setRequired(true)),
  new SlashCommandBuilder()
    .setName('ch_lock')
    .setDescription('現在のチャンネルを書き込みロックします')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName('ch_unlock')
    .setDescription('現在のチャンネルの書き込みロックを解除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName('ch_slowmode')
    .setDescription('現在のチャンネルに低速モードを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption((option) =>
      option
        .setName('seconds')
        .setDescription('低速モード秒数（0で解除）')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(21600),
    ),
  new SlashCommandBuilder()
    .setName('ch_topic')
    .setDescription('現在のチャンネルのトピックを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) =>
      option
        .setName('text')
        .setDescription('新しいトピック（空で解除）')
        .setRequired(false)
        .setMaxLength(1024),
    ),
  new SlashCommandBuilder()
    .setName('ticket_panel')
    .setDescription('チケット作成パネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option.setName('post_channel').setDescription('パネルを投稿するチャンネル').setRequired(true),
    )
    .addChannelOption((option) =>
      option
        .setName('category')
        .setDescription('チケットを作るカテゴリー')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false),
    )
    .addRoleOption((option) =>
      option.setName('support_role').setDescription('サポートロール').setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('max_open_per_user')
        .setDescription('同時に開けるチケット数')
        .setMinValue(1)
        .setMaxValue(5)
        .setRequired(false),
    ),
  new SlashCommandBuilder().setName('ticket_close').setDescription('現在のチケットをクローズ'),
  new SlashCommandBuilder().setName('ticket_delete').setDescription('現在のチケットを削除'),
  new SlashCommandBuilder()
    .setName('ticket_add')
    .setDescription('ユーザーを現在のチケットに追加')
    .addUserOption((option) => option.setName('user').setDescription('追加するユーザー').setRequired(true)),
  new SlashCommandBuilder()
    .setName('ticket_remove')
    .setDescription('ユーザーを現在のチケットから削除')
    .addUserOption((option) => option.setName('user').setDescription('削除するユーザー').setRequired(true)),
  new SlashCommandBuilder()
    .setName('ticket_rename')
    .setDescription('現在のチケット名を変更')
    .addStringOption((option) => option.setName('new_name').setDescription('新しいチャンネル名').setRequired(true)),
];

const DISCORD_CHAT_INPUT_COMMAND_LIMIT = 100;

const commands = [
  ...baseCommands,
  ...EXTRA_COMMAND_NAMES.map((name) => extraCommandBuilders[name]),
].map((command) => command.toJSON());

const commandPermissionRequirements = new Map(
  commands
    .filter((command) => command.default_member_permissions)
    .map((command) => [command.name, BigInt(command.default_member_permissions)]),
);

const ticketPanelEmbed = new EmbedBuilder()
  .setTitle('サポートチケット')
  .setDescription('下のボタンを押すとチケットを作成できます。')
  .setColor(0x5865f2);

const createTicketRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(CREATE_TICKET_BUTTON_ID).setLabel('チケットを作成').setStyle(ButtonStyle.Primary),
);

const implementedCommandNames = new Set([
  ...EXTRA_COMMAND_NAMES,
  'ping',
  'help',
  'invite',
  'support',
  'dashboard',
  'privacy',
  'prefix',
  'debug',
  'lock',
  'unlock',
  'hide',
  'show',
  'slowmode',
  'settopic',
  'rename',
  'purge',
  'createchannel',
  'clone',
  'delete',
  'togglensfw',
  'poll',
  'archive',
  'archivedcat',
  'deletecategory',
  'move',
  'setbitrate',
  'addperm',
  'clearperm',
  'delperm',
  'mentionable',
  'lockmessage',
  'unlockmessage',
  'disable',
  'enable',
  'disabledlist',
  'clearchannel',
  'sync',
  'synccat',
  'multilock',
  'multiunlock',
  'welcome',
  'autorole',
  'mods',
  'defaultroles',
  'defaultcategory',
  'sticky',
  'autothread',
  'listwebhooks',
  'say',
  'embed',
  'stats',
  'permissions',
  'settings',
  'premium',
  'play',
  'serverinfo',
  'channelinfo',
  'userinfo',
  'roleinfo',
  'vc-lock',
  'vc-hidden',
  'vc-unlock',
  'vc-lock-status',
  'vc-invite',
  'vc-kick',
  'ch_lock',
  'ch_unlock',
  'ch_slowmode',
  'ch_topic',
  'ticket_panel',
  'ticket_close',
  'ticket_delete',
  'ticket_add',
  'ticket_remove',
  'ticket_rename',
]);

function isExtraCommand(name) {
  return EXTRA_COMMAND_NAMES.includes(name);
}

function assertCommandCoverage() {
  const declaredCommandNames = commands.map((command) => command.name);
  const missingHandlers = declaredCommandNames.filter((name) => !implementedCommandNames.has(name));
  const duplicateCommandNames = declaredCommandNames.filter((name, index) => declaredCommandNames.indexOf(name) !== index);
  const unknownImplementedNames = [...implementedCommandNames].filter((name) => !declaredCommandNames.includes(name));

  if (missingHandlers.length > 0) {
    throw new Error(`Missing command handlers: ${missingHandlers.join(', ')}`);
  }

  if (duplicateCommandNames.length > 0) {
    throw new Error(`Duplicate command names detected: ${[...new Set(duplicateCommandNames)].join(', ')}`);
  }

  if (unknownImplementedNames.length > 0) {
    throw new Error(`Implemented command names not declared in slash commands: ${unknownImplementedNames.join(', ')}`);
  }

  if (declaredCommandNames.length > DISCORD_CHAT_INPUT_COMMAND_LIMIT) {
    throw new Error(
      `Too many slash commands declared: ${declaredCommandNames.length}/${DISCORD_CHAT_INPUT_COMMAND_LIMIT}. `
      + 'Discord allows at most 100 chat input commands per application scope.',
    );
  }
}

assertCommandCoverage();

const DB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ticket_panels (
  guild_id TEXT NOT NULL,
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  category_id TEXT,
  support_role_id TEXT,
  max_open_per_user INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  panel_message_id TEXT,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  subject TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_owner_open ON tickets(owner_id, status);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (guild_id, key)
);
`;

const dbConnectionMap = new Map();
const dbOpenPromiseMap = new Map();

function resolveDbPath(guildIdValue) {
  if (!dbPath.includes('{guild_id}')) {
    return dbPath;
  }
  return dbPath.replaceAll('{guild_id}', guildIdValue || 'global');
}

async function getDb(guildIdValue) {
  const filename = resolveDbPath(guildIdValue);
  const key = filename;
  const existing = dbConnectionMap.get(key);
  if (existing) {
    return existing;
  }

  const inFlight = dbOpenPromiseMap.get(key);
  if (inFlight) {
    return inFlight;
  }

  const openPromise = (async () => {
    const dir = path.dirname(filename);
    if (dir && dir !== '.') {
      await mkdir(dir, { recursive: true });
    }
    const connection = await open({ filename, driver: sqlite3.Database });
    await connection.exec(DB_SCHEMA_SQL);
    dbConnectionMap.set(key, connection);
    return connection;
  })();

  dbOpenPromiseMap.set(key, openPromise);
  try {
    return await openPromise;
  } finally {
    dbOpenPromiseMap.delete(key);
  }
}

async function closeAllDbs() {
  const closeTargets = [...new Set(dbConnectionMap.values())];
  await Promise.all(closeTargets.map(async (connection) => {
    try {
      await connection.close();
    } catch (error) {
      console.warn('failed to close sqlite connection', error);
    }
  }));
}

function getNextBackupDate(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(dailyDbBackupTimeUtc.hour, dailyDbBackupTimeUtc.minute, 0, 0);
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

async function fileExists(filepath) {
  try {
    await access(filepath);
    return true;
  } catch {
    return false;
  }
}

async function collectDbPathsForDailyBackup() {
  const discovered = new Set(dbConnectionMap.keys());
  if (!dbPath.includes('{guild_id}')) {
    discovered.add(dbPath);
    return [...discovered];
  }

  const [prefixRaw, suffixRaw] = dbPath.split('{guild_id}');
  const prefix = prefixRaw || '';
  const suffix = suffixRaw || '';
  const rootDir = path.resolve(prefix || '.');
  let entries = [];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [...discovered];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(rootDir, entry.name, suffix);
    if (await fileExists(candidate)) {
      discovered.add(candidate);
    }
  }
  return [...discovered];
}

async function createDailyDbBackup(sourcePath) {
  const sourceAbsPath = path.resolve(sourcePath);
  const relativeSourcePath = sourcePath.replace(/\\/g, '/').replace(/\//g, '__');
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const backupFilename = `${relativeSourcePath}.${stamp}.sqlite3`;
  const backupTargetPath = path.join(dailyDbBackupDir, backupFilename);
  await mkdir(path.dirname(backupTargetPath), { recursive: true });

  const backupDb = await open({ filename: sourceAbsPath, driver: sqlite3.Database });
  try {
    const escapedBackupPath = backupTargetPath.replaceAll("'", "''");
    await backupDb.exec(`VACUUM INTO '${escapedBackupPath}'`);
  } finally {
    await backupDb.close();
  }
  return backupTargetPath;
}

async function cleanupOldDailyBackups() {
  const retentionMs = dailyDbBackupRetentionDays * 24 * 60 * 60 * 1000;
  const threshold = Date.now() - retentionMs;
  let entries = [];
  try {
    entries = await readdir(dailyDbBackupDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let deletedCount = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dailyDbBackupDir, entry.name);
    const info = await stat(filePath).catch(() => null);
    if (!info || info.mtimeMs >= threshold) continue;
    await unlink(filePath).catch(() => null);
    deletedCount += 1;
  }
  return deletedCount;
}

let dailyDbBackupTimer = null;
let dailyDbBackupInterval = null;

async function runDailyDbBackup() {
  if (!dailyDbBackupEnabled) return;
  const dbPaths = await collectDbPathsForDailyBackup();
  if (!dbPaths.length) {
    console.info('daily-db-backup skipped: no database files found');
    return;
  }
  let success = 0;
  let failed = 0;
  for (const targetDbPath of dbPaths) {
    try {
      const backupFile = await createDailyDbBackup(targetDbPath);
      success += 1;
      console.info('daily-db-backup created', { source: targetDbPath, backup: backupFile });
    } catch (error) {
      failed += 1;
      console.error('daily-db-backup failed', { source: targetDbPath, error });
    }
  }
  const deletedCount = await cleanupOldDailyBackups();
  console.info('daily-db-backup finished', { success, failed, deletedCount, retentionDays: dailyDbBackupRetentionDays });
}

function scheduleDailyDbBackup() {
  if (!dailyDbBackupEnabled) {
    console.info('daily-db-backup disabled by DB_DAILY_BACKUP_ENABLED=false');
    return;
  }
  if (!dailyDbBackupTimeUtc) {
    console.info('daily-db-backup disabled because DB_DAILY_BACKUP_TIME_UTC is not set');
    return;
  }
  const nextDate = getNextBackupDate();
  const initialDelay = nextDate.getTime() - Date.now();
  console.info('daily-db-backup scheduled', {
    hourUtc: dailyDbBackupTimeUtc.hour,
    minuteUtc: dailyDbBackupTimeUtc.minute,
    scheduleSource: dailyDbBackupTimeUtc.source,
    nextRunAtUtc: nextDate.toISOString(),
    backupDir: dailyDbBackupDir,
    retentionDays: dailyDbBackupRetentionDays,
  });
  dailyDbBackupTimer = setTimeout(async () => {
    await runDailyDbBackup();
    dailyDbBackupInterval = setInterval(() => {
      runDailyDbBackup().catch((error) => {
        console.error('daily-db-backup interval run failed', error);
      });
    }, 24 * 60 * 60 * 1000);
  }, Math.max(1_000, initialDelay));
}

// NOTE:
// - GUILD_ID 指定時は起動時に対象ギルドDBを初期化
// - 共有DBパス時（{guild_id} なし）も起動時に初期化
// - {guild_id} テンプレート運用かつ GUILD_ID 未指定では不要な global DB 作成を避ける
if (guildId || !dbPath.includes('{guild_id}')) {
  await getDb(guildId);
}

function stopTempChannelCleanupTimers() {
  if (tempChannelCleanupInterval) {
    clearInterval(tempChannelCleanupInterval);
    tempChannelCleanupInterval = null;
  }

  for (const timer of pendingTempChannelDeleteTimers.values()) {
    clearTimeout(timer);
  }
  pendingTempChannelDeleteTimers.clear();
}

process.once('SIGINT', async () => {
  if (dailyDbBackupTimer) clearTimeout(dailyDbBackupTimer);
  if (dailyDbBackupInterval) clearInterval(dailyDbBackupInterval);
  stopTempChannelCleanupTimers();
  await closeAllDbs();
  process.exit(0);
});

process.once('SIGTERM', async () => {
  if (dailyDbBackupTimer) clearTimeout(dailyDbBackupTimer);
  if (dailyDbBackupInterval) clearInterval(dailyDbBackupInterval);
  stopTempChannelCleanupTimers();
  await closeAllDbs();
  process.exit(0);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const nativeConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let discordLogChannel = null;
const pendingLogs = [];
let isFlushingLogs = false;

function stringifyArg(arg) {
  if (typeof arg === 'string') {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function splitLogChunks(message, maxLength = 1800) {
  const chunks = [];
  for (let i = 0; i < message.length; i += maxLength) {
    chunks.push(message.slice(i, i + maxLength));
  }
  return chunks;
}

function enqueueDiscordLog(level, args) {
  if (!logChannelId) {
    return;
  }

  const timestamp = new Date().toISOString();
  const body = args.map((arg) => stringifyArg(arg)).join(' ');
  const line = `[${timestamp}] [${level.toUpperCase()}] ${body}`;

  for (const chunk of splitLogChunks(line)) {
    pendingLogs.push(`\`\`\`${chunk}\`\`\``);
  }
  void flushDiscordLogs();
}

async function flushDiscordLogs() {
  if (isFlushingLogs || !discordLogChannel || pendingLogs.length === 0) {
    return;
  }

  isFlushingLogs = true;
  try {
    while (pendingLogs.length > 0) {
      const message = pendingLogs.shift();
      await discordLogChannel.send(message);
    }
  } finally {
    isFlushingLogs = false;
  }
}

function setupConsoleForwarding() {
  for (const level of ['log', 'info', 'warn', 'error']) {
    console[level] = (...args) => {
      nativeConsole[level](...args);
      enqueueDiscordLog(level, args);
    };
  }
}

setupConsoleForwarding();

process.on('uncaughtException', (error) => {
  console.error('uncaughtException', error?.stack || error);
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
});

async function getTicketRow(guildIdValue, channelId) {
  const db = await getDb(guildIdValue);
  return db.get('SELECT * FROM tickets WHERE channel_id = ?', channelId);
}


async function setGuildSetting(guildIdValue, key, value) {
  const db = await getDb(guildIdValue);
  if (value == null) {
    await db.run('DELETE FROM guild_settings WHERE guild_id = ? AND key = ?', guildIdValue, key);
    return;
  }

  await db.run('INSERT OR REPLACE INTO guild_settings(guild_id, key, value) VALUES(?, ?, ?)', guildIdValue, key, value);
}

async function getGuildSetting(guildIdValue, key) {
  const db = await getDb(guildIdValue);
  const row = await db.get('SELECT value FROM guild_settings WHERE guild_id = ? AND key = ?', guildIdValue, key);
  return row?.value || null;
}


async function getDisabledCommands(guildIdValue) {
  const raw = await getGuildSetting(guildIdValue, 'disabled_commands_json');
  if (!raw) {
    return new Set();
  }
  try {
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function saveDisabledCommands(guildIdValue, commandSet) {
  await setGuildSetting(guildIdValue, 'disabled_commands_json', JSON.stringify([...commandSet]));
}

function normalizeCommandNameInput(name) {
  return name.trim().toLowerCase().replace(/^\/+/, '');
}


async function getGuildIdSet(guildIdValue, key) {
  const raw = await getGuildSetting(guildIdValue, key);
  if (!raw) {
    return new Set();
  }
  try {
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function saveGuildIdSet(guildIdValue, key, setValue) {
  await setGuildSetting(guildIdValue, key, JSON.stringify([...setValue]));
}

function applyWelcomeTemplate(message, member) {
  return message
    .replaceAll('[user]', member.user.username)
    .replaceAll('[usermention]', `<@${member.id}>`)
    .replaceAll('[servername]', member.guild.name)
    .replaceAll('[membercount]', String(member.guild.memberCount));
}


async function getGuildChannelIdSet(guildIdValue, key) {
  return getGuildIdSet(guildIdValue, key);
}

async function saveGuildChannelIdSet(guildIdValue, key, setValue) {
  await saveGuildIdSet(guildIdValue, key, setValue);
}

function clearTempVoiceConfigCache(guildIdValue) {
  tempVoiceConfigCache.delete(guildIdValue);
}

function clearVoiceLinkCache(guildIdValue) {
  voiceLinkCache.delete(guildIdValue);
}

function createTempVoiceMetrics() {
  return {
    cleanupRuns: 0,
    cleanupScanned: 0,
    cleanupRemoved: 0,
    deleteAttempts: 0,
    deleteSuccess: 0,
    deleteSkippedOccupied: 0,
    deleteRetriesScheduled: 0,
    createAttempts: 0,
    createSuccess: 0,
    moveFailures: 0,
    voiceLinkNotifications: 0,
    voiceLinkFailures: 0,
    lastCleanupAt: null,
    lastCleanupScanned: 0,
    lastCleanupRemoved: 0,
    lastDeleteErrorAt: null,
    lastDeleteError: null,
  };
}

function getTempVoiceMetrics(guildIdValue) {
  let metrics = tempVoiceMetricsMap.get(guildIdValue);
  if (!metrics) {
    metrics = createTempVoiceMetrics();
    tempVoiceMetricsMap.set(guildIdValue, metrics);
  }
  return metrics;
}

function countPendingTempChannelDeleteTimers(guildIdValue) {
  const prefix = `${guildIdValue}:`;
  let count = 0;
  for (const key of pendingTempChannelDeleteTimers.keys()) {
    if (key.startsWith(prefix)) {
      count += 1;
    }
  }
  return count;
}

function formatNullableIso(value) {
  return value ? new Date(value).toISOString() : 'なし';
}

function getTempVoiceLockKey(channelId) {
  return `${TEMP_VOICE_LOCK_PREFIX}${channelId}`;
}

function getTempVoiceOwnerAbsentKey(channelId) {
  return `${TEMP_VOICE_OWNER_ABSENT_PREFIX}${channelId}`;
}

function formatTempVoiceLockMode(mode) {
  if (mode === TEMP_VOICE_LOCK_MODES.CONNECT) return '入室禁止';
  if (mode === TEMP_VOICE_LOCK_MODES.HIDDEN) return '非表示';
  return '未ロック';
}

function parseTempVoiceLock(raw) {
  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  if (!Object.values(TEMP_VOICE_LOCK_MODES).includes(parsed.mode)) {
    return null;
  }
  return {
    mode: parsed.mode,
    lockedBy: parsed.lockedBy || null,
    lockedAt: Number(parsed.lockedAt) || null,
  };
}

async function getTempVoiceLock(guildIdValue, channelId) {
  return parseTempVoiceLock(await getGuildSetting(guildIdValue, getTempVoiceLockKey(channelId)));
}

async function saveTempVoiceLock(guildIdValue, channelId, lock) {
  await setGuildSetting(guildIdValue, getTempVoiceLockKey(channelId), JSON.stringify(lock));
}

async function clearTempVoiceLockState(guildIdValue, channelId) {
  await deleteGuildSetting(guildIdValue, getTempVoiceLockKey(channelId));
  await deleteGuildSetting(guildIdValue, getTempVoiceOwnerAbsentKey(channelId));
}

function parseTimestampSetting(raw) {
  const timestamp = Number(raw);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function formatRemainingDurationJa(ms) {
  if (ms <= 0) return '0秒';
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0 && seconds > 0) return `${minutes}分${seconds}秒`;
  if (minutes > 0) return `${minutes}分`;
  return `${seconds}秒`;
}


function logTempVoiceSettingChange(guildIdValue, actorTag, action, details = {}) {
  console.info('[tempchannels.settingChange]', {
    guildId: guildIdValue,
    actor: actorTag,
    action,
    ...details,
  });
}

async function buildTempVoiceHealthReport(guild) {
  const guildIdValue = guild.id;
  const config = await getTempVoiceConfig(guildIdValue);
  const ownerChannelIds = await getTempVoiceOwnerChannelIds(guildIdValue);
  const metrics = getTempVoiceMetrics(guildIdValue);
  const triggerCount = Object.keys(config.triggers).length;
  const pendingDeleteTimers = countPendingTempChannelDeleteTimers(guildIdValue);
  const tempConfigCached = tempVoiceConfigCache.has(guildIdValue);
  const ownerCacheSize = tempVoiceOwnerChannelIdCache.get(guildIdValue)?.size || 0;
  const voiceLinkCacheSize = voiceLinkCache.get(guildIdValue)?.value?.size || 0;

  return [
    '一時VC 状態診断',
    `- 機能: ${config.enabled ? '有効' : '無効'}`,
    `- Join to Create 起点数: ${triggerCount}`,
    `- 保存中の一時VCメタデータ: ${ownerChannelIds.length}`,
    `- 削除再試行待ち: ${pendingDeleteTimers}`,
    `- キャッシュ: tempConfig=${tempConfigCached ? '有' : '無'} / ownerIds=${ownerCacheSize} / voiceLinks=${voiceLinkCacheSize}`,
    `- 掃除: 実行 ${metrics.cleanupRuns} 回 / 累計確認 ${metrics.cleanupScanned} / 累計整理 ${metrics.cleanupRemoved}`,
    `- 直近掃除: ${formatNullableIso(metrics.lastCleanupAt)} / 確認 ${metrics.lastCleanupScanned} / 整理 ${metrics.lastCleanupRemoved}`,
    `- 削除: 試行 ${metrics.deleteAttempts} / 成功 ${metrics.deleteSuccess} / 使用中スキップ ${metrics.deleteSkippedOccupied} / 再試行予約 ${metrics.deleteRetriesScheduled}`,
    `- 作成: 試行 ${metrics.createAttempts} / 成功 ${metrics.createSuccess} / 移動失敗 ${metrics.moveFailures}`,
    `- ボイスリンク通知: 成功 ${metrics.voiceLinkNotifications} / 失敗 ${metrics.voiceLinkFailures}`,
    `- 直近削除エラー: ${formatNullableIso(metrics.lastDeleteErrorAt)}${metrics.lastDeleteError ? ` / ${metrics.lastDeleteError}` : ''}`,
  ].join('\n');
}

function addTempVoiceOwnerChannelIdToCache(guildIdValue, channelId) {
  const existing = tempVoiceOwnerChannelIdCache.get(guildIdValue);
  if (existing) {
    existing.add(channelId);
  }
}

function removeTempVoiceOwnerChannelIdFromCache(guildIdValue, channelId) {
  tempVoiceOwnerChannelIdCache.get(guildIdValue)?.delete(channelId);
}

function isKnownNonTempVoiceChannel(guildIdValue, channelId) {
  const cachedIds = tempVoiceOwnerChannelIdCache.get(guildIdValue);
  return cachedIds ? !cachedIds.has(channelId) : false;
}

async function getTempVoiceConfig(guildIdValue) {
  const now = Date.now();
  const cached = tempVoiceConfigCache.get(guildIdValue);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const enabled = (await getGuildSetting(guildIdValue, 'tempchannels_enabled')) === 'true';
  const value = {
    enabled,
    triggers: enabled ? await getJoinToCreateTriggers(guildIdValue) : {},
  };
  tempVoiceConfigCache.set(guildIdValue, {
    value,
    expiresAt: now + TEMP_VOICE_CONFIG_CACHE_TTL_MS,
  });
  return value;
}

async function getVoiceLinkTextChannelId(guildIdValue, voiceChannelId) {
  const now = Date.now();
  const cached = voiceLinkCache.get(guildIdValue);
  if (cached && cached.expiresAt > now) {
    return cached.value.get(voiceChannelId) || null;
  }

  const db = await getDb(guildIdValue);
  const rows = await db.all(
    "SELECT key, value FROM guild_settings WHERE guild_id = ? AND key LIKE 'voicelink_%'",
    guildIdValue,
  );
  const links = new Map(rows.map((row) => [row.key.slice('voicelink_'.length), row.value]));
  voiceLinkCache.set(guildIdValue, {
    value: links,
    expiresAt: now + VOICE_LINK_CACHE_TTL_MS,
  });
  return links.get(voiceChannelId) || null;
}

function normalizeTempVcPrefix(rawPrefix) {
  const normalized = (rawPrefix || '').trim();
  return normalized || DEFAULT_TEMP_VC_PREFIX;
}

function getDiscordErrorStatus(error) {
  return error?.status ?? error?.httpStatus ?? error?.rawError?.status ?? null;
}

function getDiscordErrorCode(error) {
  return error?.code ?? error?.rawError?.code ?? null;
}

function isMissingDiscordChannelError(error) {
  const status = getDiscordErrorStatus(error);
  const code = getDiscordErrorCode(error);
  return status === 404 || code === 10003 || code === '10003';
}

function isRetryableDiscordChannelDeleteError(error) {
  const status = getDiscordErrorStatus(error);
  const message = getErrorMessage(error).toLowerCase();
  return [500, 502, 503, 504].includes(status) || message.includes('service unavailable');
}

function clearPendingTempChannelDelete(guildIdValue, channelId) {
  const key = `${guildIdValue}:${channelId}`;
  const timer = pendingTempChannelDeleteTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingTempChannelDeleteTimers.delete(key);
  }
}

function scheduleTempChannelDeleteRetry(guild, channelId, attempt) {
  const delayMs = TEMP_CHANNEL_DELETE_RETRY_DELAYS_MS[attempt];
  if (delayMs == null) {
    return;
  }

  const guildIdValue = guild.id;
  const key = `${guildIdValue}:${channelId}`;
  if (pendingTempChannelDeleteTimers.has(key)) {
    return;
  }

  const timer = setTimeout(() => {
    pendingTempChannelDeleteTimers.delete(key);
    deleteTempVoiceChannelIfEmpty(guild, channelId, attempt + 1).catch((error) => {
      logOperationError('scheduleTempChannelDeleteRetry', error, {
        guildId: guild.id,
        channelId,
        attempt: attempt + 1,
      });
    });
  }, delayMs);
  timer.unref?.();
  pendingTempChannelDeleteTimers.set(key, timer);
  getTempVoiceMetrics(guildIdValue).deleteRetriesScheduled += 1;
}

async function getTempVoiceOwnerChannelIds(guildIdValue) {
  const db = await getDb(guildIdValue);
  const rows = await db.all(
    "SELECT key FROM guild_settings WHERE guild_id = ? AND key LIKE 'temp_voice_owner_%'",
    guildIdValue,
  );
  const channelIds = rows
    .map((row) => row.key.slice('temp_voice_owner_'.length))
    .filter((channelId) => /^\d+$/.test(channelId));
  tempVoiceOwnerChannelIdCache.set(guildIdValue, new Set(channelIds));
  return channelIds;
}

async function cleanupEmptyTempVoiceChannels(guild, reason = 'cleanupEmptyTempVoiceChannels', options = {}) {
  const { requireEnabled = true } = options;
  const config = await getTempVoiceConfig(guild.id);
  if (requireEnabled && !config.enabled) {
    return { scanned: 0, removed: 0 };
  }

  const channelIds = await getTempVoiceOwnerChannelIds(guild.id);
  let removed = await cleanupTempVoiceLockMetadata(guild);
  for (const channelId of channelIds) {
    const didRemove = await deleteTempVoiceChannelIfEmpty(guild, channelId).catch((error) => {
      logOperationError(reason, error, {
        guildId: guild.id,
        channelId,
      });
      return false;
    });
    if (didRemove) {
      removed += 1;
    }
  }
  const metrics = getTempVoiceMetrics(guild.id);
  metrics.cleanupRuns += 1;
  metrics.cleanupScanned += channelIds.length;
  metrics.cleanupRemoved += removed;
  metrics.lastCleanupAt = Date.now();
  metrics.lastCleanupScanned = channelIds.length;
  metrics.lastCleanupRemoved = removed;
  return { scanned: channelIds.length, removed };
}

async function cleanupEmptyTempVoiceChannelsForKnownGuilds(reason = 'cleanupEmptyTempVoiceChannelsForKnownGuilds') {
  if (isCleaningTempChannels) {
    return;
  }

  isCleaningTempChannels = true;
  try {
    if (guildId) {
      const cachedGuild = client.guilds.cache.get(guildId);
      const guild = cachedGuild || await client.guilds.fetch(guildId).catch((error) => {
        logOperationError(`${reason}.fetchGuild`, error, { guildId });
        return null;
      });
      if (guild) {
        await cleanupEmptyTempVoiceChannels(guild, reason);
      }
      return;
    }

    for (const guild of client.guilds.cache.values()) {
      await cleanupEmptyTempVoiceChannels(guild, reason);
    }
  } finally {
    isCleaningTempChannels = false;
  }
}

function startTempChannelCleanupInterval() {
  if (tempChannelCleanupInterval) {
    return;
  }

  tempChannelCleanupInterval = setInterval(() => {
    cleanupEmptyTempVoiceChannelsForKnownGuilds('tempChannelCleanupInterval').catch((error) => {
      logOperationError('tempChannelCleanupInterval', error);
    });
  }, TEMP_CHANNEL_CLEANUP_INTERVAL_MS);
  tempChannelCleanupInterval.unref?.();
}

async function deleteTempVoiceChannelIfEmpty(guild, channelId, attempt = 0) {
  const guildIdValue = guild.id;
  const metrics = getTempVoiceMetrics(guildIdValue);
  metrics.deleteAttempts += 1;
  const owner = await getGuildSetting(guildIdValue, `temp_voice_owner_${channelId}`);
  if (!owner) {
    clearPendingTempChannelDelete(guildIdValue, channelId);
    removeTempVoiceOwnerChannelIdFromCache(guildIdValue, channelId);
    return false;
  }

  const channel = await guild.channels.fetch(channelId).catch((error) => {
    if (isMissingDiscordChannelError(error)) {
      return null;
    }

    logOperationError('voiceStateUpdate.fetchTempChannelForDelete', error, {
      guildId: guildIdValue,
      channelId,
      attempt,
    });
    return undefined;
  });

  if (channel === undefined) {
    scheduleTempChannelDeleteRetry(guild, channelId, attempt);
    return false;
  }

  if (!channel) {
    clearPendingTempChannelDelete(guildIdValue, channelId);
    removeTempVoiceOwnerChannelIdFromCache(guildIdValue, channelId);
    await deleteGuildSetting(guildIdValue, `temp_voice_owner_${channelId}`);
    await clearTempVoiceLockState(guildIdValue, channelId);
    metrics.deleteSuccess += 1;
    return true;
  }

  if (channel.members?.size > 0) {
    clearPendingTempChannelDelete(guildIdValue, channelId);
    metrics.deleteSkippedOccupied += 1;
    return false;
  }

  let removed = false;
  await channel.delete('Empty temporary voice channel').then(async () => {
    clearPendingTempChannelDelete(guildIdValue, channelId);
    removeTempVoiceOwnerChannelIdFromCache(guildIdValue, channelId);
    await deleteGuildSetting(guildIdValue, `temp_voice_owner_${channelId}`);
    await clearTempVoiceLockState(guildIdValue, channelId);
    metrics.deleteSuccess += 1;
    removed = true;
  }).catch(async (error) => {
    metrics.lastDeleteErrorAt = Date.now();
    metrics.lastDeleteError = getErrorMessage(error);
    logOperationError('voiceStateUpdate.deleteTempChannel', error, {
      guildId: guildIdValue,
      channelId,
      attempt,
    });

    if (isMissingDiscordChannelError(error)) {
      clearPendingTempChannelDelete(guildIdValue, channelId);
      removeTempVoiceOwnerChannelIdFromCache(guildIdValue, channelId);
      await deleteGuildSetting(guildIdValue, `temp_voice_owner_${channelId}`);
      await clearTempVoiceLockState(guildIdValue, channelId);
      metrics.deleteSuccess += 1;
      removed = true;
      return;
    }

    if (isRetryableDiscordChannelDeleteError(error)) {
      scheduleTempChannelDeleteRetry(guild, channelId, attempt);
    }
  });

  return removed;
}

async function getJoinToCreateTriggers(guildIdValue) {
  const raw = await getGuildSetting(guildIdValue, JOIN_TO_CREATE_TRIGGERS_KEY);
  const parsed = safeJsonParse(raw, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const normalized = {};
  for (const [triggerId, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    normalized[triggerId] = {
      categoryId: value.categoryId || null,
      namePrefix: normalizeTempVcPrefix(value.namePrefix),
    };
  }

  const legacyTriggerChannelId = await getGuildSetting(guildIdValue, 'jointocreate_channel_id');
  if (legacyTriggerChannelId) {
    const legacyCategoryId = await getGuildSetting(guildIdValue, 'jointocreate_category_id');
    if (!normalized[legacyTriggerChannelId]) {
      normalized[legacyTriggerChannelId] = {
        categoryId: legacyCategoryId || null,
        namePrefix: DEFAULT_TEMP_VC_PREFIX,
      };
      await saveJoinToCreateTriggers(guildIdValue, normalized);
    }
    await deleteGuildSetting(guildIdValue, 'jointocreate_channel_id');
    await deleteGuildSetting(guildIdValue, 'jointocreate_category_id');
  }

  return normalized;
}

async function saveJoinToCreateTriggers(guildIdValue, triggers) {
  await setGuildSetting(guildIdValue, JOIN_TO_CREATE_TRIGGERS_KEY, JSON.stringify(triggers));
}

async function canManageTicket(member, ticketRow, guildIdValue) {
  const db = await getDb(guildIdValue);
  if (member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return true;
  }

  if (!ticketRow?.panel_message_id) {
    return false;
  }

  const panel = await db.get(
    'SELECT support_role_id FROM ticket_panels WHERE message_id = ?',
    ticketRow.panel_message_id,
  );
  if (!panel?.support_role_id) {
    return false;
  }

  return member.roles.cache.has(panel.support_role_id);
}

function isManageChannelMember(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
}

function isAdministratorMember(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function resolveCurrentTempVoiceContext(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    return { error: 'このコマンドは対象の一時VCに参加中のみ使用できます。' };
  }

  const ownerId = await getGuildSetting(interaction.guildId, `temp_voice_owner_${channel.id}`);
  if (!ownerId) {
    return { error: 'このVCは一時VCではないため、このコマンドは使用できません。' };
  }

  const isOwner = ownerId === interaction.user.id;
  const isAdmin = isAdministratorMember(interaction);
  if (!isOwner && !isAdmin) {
    return { error: 'この操作は一時VCの作成者本人、またはAdministrator権限を持つユーザーのみ実行できます。' };
  }

  return { channel, ownerId, isOwner, isAdminOverride: !isOwner && isAdmin };
}

async function setTempVoiceOwnerOverwrite(channel, ownerId) {
  await channel.permissionOverwrites.edit(ownerId, {
    ViewChannel: true,
    Connect: true,
  });
}

function buildDiscordChannelUrl(guildIdValue, channelId) {
  return `https://discord.com/channels/${guildIdValue}/${channelId}`;
}

function hasTempVoiceInviteOverwrite(channel, userId) {
  const overwrite = channel.permissionOverwrites.cache.get(userId);
  return Boolean(
    overwrite
      && overwrite.allow.has(PermissionFlagsBits.ViewChannel)
      && overwrite.allow.has(PermissionFlagsBits.Connect),
  );
}

async function unlockTempVoiceChannel(guild, channel, reason = 'Temporary voice channel lock reset') {
  await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
    ViewChannel: null,
    Connect: null,
  }, { reason });
  await clearTempVoiceLockState(guild.id, channel.id);
}

async function applyTempVoiceLock(interaction, mode) {
  const context = await resolveCurrentTempVoiceContext(interaction);
  if (context.error) {
    await interaction.reply({ content: context.error, ephemeral: true });
    return;
  }

  const { channel, ownerId, isAdminOverride } = context;
  const currentLock = await getTempVoiceLock(interaction.guildId, channel.id);
  const switchedFrom = currentLock && currentLock.mode !== mode ? currentLock.mode : null;

  if (mode === TEMP_VOICE_LOCK_MODES.CONNECT) {
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, {
      Connect: false,
      ViewChannel: null,
    });
  } else {
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, {
      ViewChannel: false,
      Connect: null,
    });
  }

  await setTempVoiceOwnerOverwrite(channel, ownerId).catch((error) => {
    logOperationError('tempVoiceLock.ownerOverwrite', error, {
      guildId: interaction.guildId,
      channelId: channel.id,
      ownerId,
    });
  });
  await saveTempVoiceLock(interaction.guildId, channel.id, {
    mode,
    lockedBy: interaction.user.id,
    lockedAt: Date.now(),
  });

  const adminPrefix = isAdminOverride ? '管理者権限により、' : '';
  if (switchedFrom) {
    await interaction.reply(`${adminPrefix}${formatTempVoiceLockMode(switchedFrom)}ロックから${formatTempVoiceLockMode(mode)}ロックへ切り替えました。`);
    return;
  }

  if (currentLock?.mode === mode) {
    await interaction.reply(`${adminPrefix}この一時VCは既に${formatTempVoiceLockMode(mode)}ロック中です。`);
    return;
  }

  await interaction.reply(`${adminPrefix}この一時VCを${formatTempVoiceLockMode(mode)}ロックにしました。`);
}

async function handleTempVoiceUnlock(interaction) {
  const context = await resolveCurrentTempVoiceContext(interaction);
  if (context.error) {
    await interaction.reply({ content: context.error, ephemeral: true });
    return;
  }

  const { channel, isAdminOverride } = context;
  await unlockTempVoiceChannel(interaction.guild, channel, `Temporary voice unlock by ${interaction.user.tag}`);
  const adminPrefix = isAdminOverride ? '管理者権限により、' : '';
  await interaction.reply(`${adminPrefix}この一時VCのロックを解除しました。`);
}

async function handleTempVoiceInvite(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const context = await resolveCurrentTempVoiceContext(interaction);
  if (context.error) {
    await interaction.editReply({ content: context.error });
    return;
  }

  const { channel, isAdminOverride } = context;
  const user = interaction.options.getUser('user', true);
  if (user.id === interaction.user.id) {
    await interaction.editReply({ content: '自分自身を一時VCへ招待する必要はありません。' });
    return;
  }

  const invitedMember = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!invitedMember) {
    await interaction.editReply({ content: '指定ユーザーはこのサーバーに参加していないため、一時VCへ招待できません。' });
    return;
  }

  const vcUrl = buildDiscordChannelUrl(interaction.guildId, channel.id);
  const alreadyInvited = hasTempVoiceInviteOverwrite(channel, user.id);

  if (!alreadyInvited) {
    await channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true,
      Connect: true,
    }, { reason: `Temporary voice invite by ${interaction.user.tag}` });
  }

  const dmMessage = [
    `${interaction.user.tag} さんから ${interaction.guild.name} の一時VCへ招待されました。`,
    `VC: ${channel}`,
    `参加リンク: ${vcUrl}`,
  ].join('\n');

  const dmSent = await user.send(dmMessage).then(() => true).catch((error) => {
    logOperationError('tempVoiceInvite.dm', error, {
      guildId: interaction.guildId,
      channelId: channel.id,
      inviterId: interaction.user.id,
      invitedUserId: user.id,
    });
    return false;
  });

  const adminPrefix = isAdminOverride ? '管理者権限により、' : '';
  const dmNotice = dmSent
    ? 'DMでVCリンクを送信しました。'
    : `DM送信に失敗しました。権限付与は完了しているため、次のVCリンクURLを対象ユーザーへ直接連絡してください: ${vcUrl}`;
  const inviteNotice = alreadyInvited
    ? `${user} は既にこの一時VCへ招待済みです。`
    : `${user} をこの一時VCへ招待しました。`;
  await interaction.editReply({
    content: `${adminPrefix}${inviteNotice}\n${dmNotice}`,
  });
}

async function handleTempVoiceKick(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const context = await resolveCurrentTempVoiceContext(interaction);
  if (context.error) {
    await interaction.editReply({ content: context.error });
    return;
  }

  const { channel, ownerId, isAdminOverride } = context;
  const user = interaction.options.getUser('user', true);
  const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!targetMember) {
    await interaction.editReply({ content: '指定ユーザーはこのサーバーに参加していないため、一時VCからキックできません。' });
    return;
  }

  if (user.id === ownerId) {
    await interaction.editReply({ content: '一時VCの作成者の権限は削除できません。' });
    return;
  }

  const hadIndividualOverwrite = channel.permissionOverwrites.cache.has(user.id);
  if (hadIndividualOverwrite) {
    await channel.permissionOverwrites.delete(user.id, `Temporary voice invite removed by ${interaction.user.tag}`);
  }

  const isConnectedToTargetChannel = targetMember.voice.channelId === channel.id;
  let disconnectNotice = isConnectedToTargetChannel
    ? null
    : '対象ユーザーはこのVCに接続していませんでした。';
  if (isConnectedToTargetChannel) {
    const disconnected = await targetMember.voice.disconnect(`Temporary voice kick by ${interaction.user.tag}`).then(() => true).catch((error) => {
      logOperationError('tempVoiceKick.disconnect', error, {
        guildId: interaction.guildId,
        channelId: channel.id,
        actorId: interaction.user.id,
        kickedUserId: user.id,
      });
      return false;
    });
    if (!hadIndividualOverwrite && disconnected) {
      disconnectNotice = 'VC接続中だったため切断しました。';
    } else if (!hadIndividualOverwrite) {
      disconnectNotice = 'VCからの強制退出に失敗しました。';
    } else {
      disconnectNotice = disconnected
        ? '対象ユーザーをVCから強制退出しました。'
        : '対象ユーザーの個別権限は削除しましたが、VCからの強制退出に失敗しました。';
    }
  }

  const adminPrefix = isAdminOverride ? '管理者権限により、' : '';
  const permissionNotice = hadIndividualOverwrite
    ? `${user} のこの一時VCに対する個別権限を削除し、@everyone の権限に戻しました。`
    : 'このユーザーには個別権限がありませんでした。';
  await interaction.editReply({
    content: `${adminPrefix}${permissionNotice}\n${disconnectNotice}`,
  });
}

async function handleTempVoiceLockStatus(interaction) {
  const context = await resolveCurrentTempVoiceContext(interaction);
  if (context.error) {
    await interaction.reply({ content: context.error, ephemeral: true });
    return;
  }

  const { channel, ownerId } = context;
  const lock = await getTempVoiceLock(interaction.guildId, channel.id);
  const absentSince = parseTimestampSetting(await getGuildSetting(interaction.guildId, getTempVoiceOwnerAbsentKey(channel.id)));
  const remainingMs = absentSince ? Math.max(0, TEMP_VOICE_OWNER_ABSENT_AUTO_UNLOCK_MS - (Date.now() - absentSince)) : null;
  await interaction.reply({
    content: [
      `対象VC: ${channel}`,
      `作成者: <@${ownerId}>`,
      `ロック状態: ${formatTempVoiceLockMode(lock?.mode)}`,
      `作成者不在: ${absentSince ? 'あり' : 'なし'}`,
      `自動解除まで: ${remainingMs == null ? 'なし' : formatRemainingDurationJa(remainingMs)}`,
    ].join('\n'),
    ephemeral: true,
  });
}

async function recordTempVoiceOwnerPresenceChange(guild, channelId, memberId, isPresent) {
  const guildIdValue = guild.id;
  const ownerId = await getGuildSetting(guildIdValue, `temp_voice_owner_${channelId}`);
  if (!memberId || !ownerId || ownerId !== memberId) {
    return;
  }

  if (isPresent) {
    await deleteGuildSetting(guildIdValue, getTempVoiceOwnerAbsentKey(channelId));
    return;
  }

  const lock = await getTempVoiceLock(guildIdValue, channelId);
  if (!lock) {
    await deleteGuildSetting(guildIdValue, getTempVoiceOwnerAbsentKey(channelId));
    return;
  }

  await setGuildSetting(guildIdValue, getTempVoiceOwnerAbsentKey(channelId), String(Date.now()));
}

async function cleanupTempVoiceLockMetadata(guild) {
  const guildIdValue = guild.id;
  const db = await getDb(guildIdValue);
  const rows = await db.all(
    `SELECT key, value FROM guild_settings WHERE guild_id = ? AND (key LIKE ? OR key LIKE ?)`,
    guildIdValue,
    `${TEMP_VOICE_LOCK_PREFIX}%`,
    `${TEMP_VOICE_OWNER_ABSENT_PREFIX}%`,
  );
  const channelIds = new Set();
  for (const row of rows) {
    if (row.key.startsWith(TEMP_VOICE_LOCK_PREFIX)) {
      channelIds.add(row.key.slice(TEMP_VOICE_LOCK_PREFIX.length));
    }
    if (row.key.startsWith(TEMP_VOICE_OWNER_ABSENT_PREFIX)) {
      channelIds.add(row.key.slice(TEMP_VOICE_OWNER_ABSENT_PREFIX.length));
    }
  }

  let removed = 0;
  for (const channelId of channelIds) {
    const ownerId = await getGuildSetting(guildIdValue, `temp_voice_owner_${channelId}`);
    if (!ownerId) {
      await clearTempVoiceLockState(guildIdValue, channelId);
      removed += 1;
      continue;
    }

    const channel = await guild.channels.fetch(channelId).catch((error) => {
      if (isMissingDiscordChannelError(error)) {
        return null;
      }
      logOperationError('cleanupTempVoiceLockMetadata.fetchChannel', error, { guildId: guildIdValue, channelId });
      return undefined;
    });
    if (channel === undefined) {
      continue;
    }
    if (!channel) {
      await clearTempVoiceLockState(guildIdValue, channelId);
      removed += 1;
      continue;
    }

    const absentSince = parseTimestampSetting(await getGuildSetting(guildIdValue, getTempVoiceOwnerAbsentKey(channelId)));
    if (channel.members?.has(ownerId)) {
      if (absentSince) {
        await deleteGuildSetting(guildIdValue, getTempVoiceOwnerAbsentKey(channelId));
        removed += 1;
      }
      continue;
    }

    const lock = await getTempVoiceLock(guildIdValue, channelId);
    if (lock && absentSince && Date.now() - absentSince >= TEMP_VOICE_OWNER_ABSENT_AUTO_UNLOCK_MS) {
      await unlockTempVoiceChannel(guild, channel, 'Temporary voice owner absent auto unlock').catch((error) => {
        logOperationError('cleanupTempVoiceLockMetadata.autoUnlock', error, { guildId: guildIdValue, channelId });
      });
      removed += 1;
    }
  }

  return removed;
}



async function deleteGuildSetting(guildIdValue, key) {
  const db = await getDb(guildIdValue);
  await db.run('DELETE FROM guild_settings WHERE guild_id = ? AND key = ?', guildIdValue, key);
}

function safeJsonParse(raw, fallback) {
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function formatSettingValue(key, value, guild) {
  if (!value) {
    return '`未設定`';
  }

  if (key.endsWith('_id')) {
    if (key.includes('channel')) {
      return `<#${value}> (${value})`;
    }
    if (key.includes('category')) {
      return `<#${value}> (${value})`;
    }
  }

  if (key === 'music_queue_json' || key === 'music_now_playing_json') {
    try {
      const parsed = JSON.parse(value);
      return `\`\`\`json
${JSON.stringify(parsed, null, 2).slice(0, 1200)}
\`\`\``;
    } catch {
      return `\`${value}\``;
    }
  }

  return value.length > 250 ? `${value.slice(0, 250)}...` : `\`${value}\``;
}

async function getMusicQueue(guildIdValue) {
  const raw = await getGuildSetting(guildIdValue, MUSIC_QUEUE_KEY);
  const parsed = safeJsonParse(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

async function saveMusicQueue(guildIdValue, queue) {
  if (!queue.length) {
    await deleteGuildSetting(guildIdValue, MUSIC_QUEUE_KEY);
    return;
  }

  await setGuildSetting(guildIdValue, MUSIC_QUEUE_KEY, JSON.stringify(queue));
}

async function getNowPlaying(guildIdValue) {
  const raw = await getGuildSetting(guildIdValue, MUSIC_NOW_PLAYING_KEY);
  const parsed = safeJsonParse(raw, null);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

async function saveNowPlaying(guildIdValue, track) {
  if (!track) {
    await deleteGuildSetting(guildIdValue, MUSIC_NOW_PLAYING_KEY);
    return;
  }

  await setGuildSetting(guildIdValue, MUSIC_NOW_PLAYING_KEY, JSON.stringify(track));
}

function sanitizeChannelName(input) {
  return input
    .trim()
    .toLowerCase()
    .replaceAll(' ', '-')
    .replace(/[^a-z0-9-_]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 100);
}

function parseDurationToMs(raw) {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  if (!text || text === 'off' || text === '0') return 0;
  const matched = text.match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)?$/i);
  if (!matched) return null;
  const amount = Number(matched[1]);
  const unit = (matched[2] || 's').toLowerCase();
  const unitMap = {
    s: 1000,
    sec: 1000,
    secs: 1000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    hrs: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
  };
  const base = unitMap[unit];
  if (!base) return null;
  return amount * base;
}

function formatDurationJa(ms) {
  if (!ms) return '0秒';
  const sec = Math.floor(ms / 1000);
  if (sec % 86400 === 0) return `${sec / 86400}日`;
  if (sec % 3600 === 0) return `${sec / 3600}時間`;
  if (sec % 60 === 0) return `${sec / 60}分`;
  return `${sec}秒`;
}

function schedulePermissionReset(channel, targetId, overwrite, ms) {
  if (!ms || ms <= 0) return;
  setTimeout(() => {
    channel.permissionOverwrites.edit(targetId, overwrite).catch(() => null);
  }, ms);
}


function resolvePermissionName(name) {
  const raw = (name || '').trim().toLowerCase();
  const map = {
    viewchannel: PermissionFlagsBits.ViewChannel,
    sendmessages: PermissionFlagsBits.SendMessages,
    attachfiles: PermissionFlagsBits.AttachFiles,
    readmessagehistory: PermissionFlagsBits.ReadMessageHistory,
    managechannels: PermissionFlagsBits.ManageChannels,
  };
  return map[raw] || null;
}

function getErrorMessage(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function createErrorId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function logOperationError(scope, error, context = {}) {
  const errorId = createErrorId();
  console.error(`[${scope}] failed (${errorId})`, {
    ...context,
    error: getErrorMessage(error),
  });
  return errorId;
}

function normalizeInteractionResponsePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('ephemeral' in payload)) {
    return payload;
  }

  const { ephemeral, ...rest } = payload;
  if (!ephemeral) {
    return rest;
  }

  let flags = rest.flags;
  if (flags == null) {
    flags = MessageFlags.Ephemeral;
  } else if (typeof flags === 'number') {
    flags |= MessageFlags.Ephemeral;
  } else if (typeof flags === 'bigint') {
    flags |= BigInt(MessageFlags.Ephemeral);
  } else if (Array.isArray(flags)) {
    flags = [...flags, MessageFlags.Ephemeral];
  } else {
    flags = [flags, MessageFlags.Ephemeral];
  }

  return { ...rest, flags };
}

function patchInteractionResponseOptions(interaction) {
  for (const methodName of ['reply', 'deferReply', 'followUp']) {
    const original = interaction[methodName];
    if (typeof original !== 'function') continue;

    interaction[methodName] = function patchedInteractionResponse(payload, ...args) {
      return original.call(this, normalizeInteractionResponsePayload(payload), ...args);
    };
  }
}


async function bulkApplyPermission(guild, permissionName, targetId, categoryId, mode) {
  const permission = resolvePermissionName(permissionName);
  if (!permission) {
    return { ok: false, message: '未知の権限名です。' };
  }

  const channels = guild.channels.cache.filter((channel) => {
    if (!('permissionOverwrites' in channel)) return false;
    if (categoryId && channel.parentId !== categoryId) return false;
    return channel.type !== ChannelType.GuildCategory;
  });

  let success = 0;
  const batchResult = await processInBatches([...channels.values()], 5, async (channel) => {
    if (mode === 'allow') {
      await channel.permissionOverwrites.edit(targetId, { [permission]: true });
    } else {
      await channel.permissionOverwrites.edit(targetId, { [permission]: null });
    }
    success += 1;
  }, {
    label: 'bulkApplyPermission',
    guildId: guild.id,
    permissionName,
    targetId,
    mode,
  });

  return { ok: true, total: channels.size, success, failed: batchResult.failed, errorIds: batchResult.errorIds };
}

async function applySeasonPrefix(guild, prefix) {
  const channels = guild.channels.cache.filter((channel) => channel.type !== ChannelType.GuildCategory);
  let updated = 0;
  const batchResult = await processInBatches([...channels.values()], 5, async (channel) => {
    if (!channel.manageable) return;
    const base = channel.name.replace(/^([❄️🌸🎃]-)/u, '');
    const next = `${prefix}${base}`.slice(0, 100);
    if (next !== channel.name) {
      await channel.setName(next);
      updated += 1;
    }
  }, {
    label: 'applySeasonPrefix',
    guildId: guild.id,
    prefix,
  });
  return { updated, failed: batchResult.failed, errorIds: batchResult.errorIds };
}

async function processInBatches(items, batchSize, worker, meta = {}) {
  let failed = 0;
  const errorIds = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const results = await Promise.allSettled(chunk.map((item) => worker(item)));
    for (let idx = 0; idx < results.length; idx += 1) {
      const result = results[idx];
      if (result.status === 'rejected') {
        failed += 1;
        const errorId = logOperationError(meta.label || 'processInBatches', result.reason, {
          ...meta,
          itemIndex: i + idx,
        });
        if (errorIds.length < 5) {
          errorIds.push(errorId);
        }
      }
    }
  }
  return { total: items.length, failed, errorIds };
}

function getRoleButtonCustomId(roleId) {
  return `selfrole:${roleId}`;
}

async function registerSlashCommands() {
  if (!client.application) {
    return;
  }

  if (guildId) {
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.set(commands);
    await client.application.commands.set([]);
    console.log(`Registered ${commands.length} guild commands to ${guild.id} and cleared global commands to avoid duplicates`);
    return;
  }

  await client.application.commands.set(commands);
  console.log(`Registered ${commands.length} global commands`);

  const guilds = await client.guilds.fetch();
  for (const oauthGuild of guilds.values()) {
    try {
      const guild = await client.guilds.fetch(oauthGuild.id);
      await guild.commands.set([]);
    } catch (error) {
      console.warn('Guild command cleanup failed', oauthGuild.id, error?.message || error);
    }
  }
  console.log('Cleared guild-scoped commands to avoid duplicate command suggestions');
}

client.once('clientReady', async () => {
  if (!client.application) {
    return;
  }

  if (logChannelId) {
    const channel = await client.channels.fetch(logChannelId);
    if (!channel?.isTextBased()) {
      throw new Error('LOG_CHANNEL_ID must be a text based channel');
    }
    discordLogChannel = channel;
  }

  await registerSlashCommands();
  console.log(`Logged in as ${client.user.tag}`);

  cleanupEmptyTempVoiceChannelsForKnownGuilds('clientReady.cleanupEmptyTempVoiceChannels').catch((error) => {
    logOperationError('clientReady.cleanupEmptyTempVoiceChannels', error);
  });
  startTempChannelCleanupInterval();

  await flushDiscordLogs();
});


client.on('guildMemberAdd', async (member) => {
  const autoRoles = await getGuildIdSet(member.guild.id, 'autorole_role_ids_json');
  const defaultRoles = await getGuildIdSet(member.guild.id, 'default_roles_json');
  const roleIds = new Set([...autoRoles, ...defaultRoles]);

  for (const roleId of roleIds) {
    try {
      await member.roles.add(roleId, 'ChannelBot autorole/defaultroles');
    } catch (error) {
      console.warn('failed to add role on member join', roleId, error?.message || error);
    }
  }

  const welcomeMode = await getGuildSetting(member.guild.id, 'welcome_mode');
  const welcomeMessage = await getGuildSetting(member.guild.id, 'welcome_message');

  if (!welcomeMode || !welcomeMessage) {
    return;
  }

  const rendered = applyWelcomeTemplate(welcomeMessage, member);

  if (welcomeMode === 'channel') {
    const channelId = await getGuildSetting(member.guild.id, 'welcome_channel_id');
    if (!channelId) {
      return;
    }
    const channel = await member.guild.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased()) {
      await channel.send(rendered).catch(() => null);
    }
    return;
  }

  if (welcomeMode === 'dm') {
    await member.send(rendered).catch(() => null);
  }
});


client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) {
    return;
  }

  const emojiLockRaw = await getGuildSetting(message.guild.id, 'emoji_lock_enabled');
  if (emojiLockRaw === 'true' && /<a?:\w+:\d+>/.test(message.content)) {
    await message.delete().catch(() => null);
    return;
  }

  const imageOnlyChannels = await getGuildChannelIdSet(message.guild.id, 'image_only_channels_json');
  if (imageOnlyChannels.has(message.channel.id)) {
    const hasAttachment = message.attachments.some((a) => a.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name || ''));
    const hasImageLink = /(https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp))/i.test(message.content);
    if (!hasAttachment && !hasImageLink) {
      await message.delete().catch(() => null);
      const notice = await message.channel.send(`${message.author} ここは画像専用チャンネルです。`).catch(() => null);
      if (notice) {
        setTimeout(() => notice.delete().catch(() => null), 4000);
      }
      return;
    }
  }

  const suggestionChannelId = await getGuildSetting(message.guild.id, 'suggestion_channel_id');
  if (suggestionChannelId && message.channel.id === suggestionChannelId) {
    const whitelist = await getGuildIdSet(message.guild.id, 'suggestion_whitelist_roles_json');
    if (whitelist.size > 0 && !message.member.roles.cache.some((role) => whitelist.has(role.id))) {
      await message.delete().catch(() => null);
      return;
    }

    const up = (await getGuildSetting(message.guild.id, 'suggestion_up_emoji')) || '👍';
    const down = (await getGuildSetting(message.guild.id, 'suggestion_down_emoji')) || '👎';
    await message.react(up).catch(() => null);
    await message.react(down).catch(() => null);
  }

  const autoPublishChannels = await getGuildChannelIdSet(message.guild.id, 'autopublish_channel_ids_json');
  if (autoPublishChannels.has(message.channel.id) && message.crosspostable) {
    await message.crosspost().catch(() => null);
  }

  const stickyMessage = await getGuildSetting(message.guild.id, `sticky_message_${message.channel.id}`);
  if (stickyMessage) {
    const stickyMessageId = await getGuildSetting(message.guild.id, `sticky_message_id_${message.channel.id}`);
    if (stickyMessageId) {
      await message.channel.messages.delete(stickyMessageId).catch(() => null);
    }
    const sent = await message.channel.send(stickyMessage).catch(() => null);
    if (sent) {
      await setGuildSetting(message.guild.id, `sticky_message_id_${message.channel.id}`, sent.id);
    }
  }

  const autoThreadChannels = await getGuildChannelIdSet(message.guild.id, 'autothread_channel_ids_json');
  if (autoThreadChannels.has(message.channel.id) && message.channel.isTextBased() && !message.hasThread) {
    const threadPrefix = buildAutoThreadPrefixFromMessage(message, message.author.username);
    await message.startThread({ name: `${threadPrefix}-${message.author.username}`.slice(0, 100), autoArchiveDuration: 1440 }).catch(() => null);
  }
});


client.on('voiceStateUpdate', async (oldState, newState) => {
  if (oldState.channelId === newState.channelId) {
    return;
  }

  const guildIdValue = newState.guild.id;
  const tempVoiceConfig = await getTempVoiceConfig(guildIdValue);

  if (tempVoiceConfig.enabled) {
    const triggerConfig = newState.channelId ? tempVoiceConfig.triggers[newState.channelId] : null;

    if (triggerConfig) {
      const metrics = getTempVoiceMetrics(guildIdValue);
      metrics.createAttempts += 1;
      const categoryId = triggerConfig.categoryId || null;
      const namePrefix = normalizeTempVcPrefix(triggerConfig.namePrefix);
      const channel = await newState.guild.channels.create({
        name: `${namePrefix}-${newState.member.displayName}`.toLowerCase().replaceAll(' ', '-').slice(0, 90),
        type: ChannelType.GuildVoice,
        parent: categoryId || null,
      }).catch((error) => {
        logOperationError('voiceStateUpdate.createTempChannel', error, {
          guildId: guildIdValue,
          memberId: newState.member?.id || null,
          triggerChannelId: newState.channelId,
          categoryId,
          namePrefix,
        });
        return null;
      });

      if (channel) {
        metrics.createSuccess += 1;
        await setGuildSetting(guildIdValue, `temp_voice_owner_${channel.id}`, newState.member.id);
        await setTempVoiceOwnerOverwrite(channel, newState.member.id).catch((error) => {
          logOperationError('voiceStateUpdate.setTempVoiceOwnerOverwrite', error, {
            guildId: guildIdValue,
            channelId: channel.id,
            ownerId: newState.member.id,
          });
        });
        addTempVoiceOwnerChannelIdToCache(guildIdValue, channel.id);
        await newState.setChannel(channel).catch((error) => {
          metrics.moveFailures += 1;
          logOperationError('voiceStateUpdate.moveToTempChannel', error, {
            guildId: guildIdValue,
            memberId: newState.member?.id || null,
            createdChannelId: channel.id,
          });
          deleteTempVoiceChannelIfEmpty(newState.guild, channel.id).catch((cleanupError) => {
            logOperationError('voiceStateUpdate.cleanupFailedMoveChannel', cleanupError, {
              guildId: guildIdValue,
              channelId: channel.id,
            });
          });
        });
      }
    }

    if (oldState.channelId) {
      await recordTempVoiceOwnerPresenceChange(newState.guild, oldState.channelId, oldState.member?.id, false).catch((error) => {
        logOperationError('voiceStateUpdate.recordOwnerAbsent', error, {
          guildId: guildIdValue,
          channelId: oldState.channelId,
          memberId: oldState.member?.id || null,
        });
      });
    }

    if (newState.channelId) {
      await recordTempVoiceOwnerPresenceChange(newState.guild, newState.channelId, newState.member?.id, true).catch((error) => {
        logOperationError('voiceStateUpdate.recordOwnerPresent', error, {
          guildId: guildIdValue,
          channelId: newState.channelId,
          memberId: newState.member?.id || null,
        });
      });
    }

    if (oldState.channel && oldState.channel.members.size === 0 && !isKnownNonTempVoiceChannel(guildIdValue, oldState.channel.id)) {
      const oldChannelId = oldState.channel.id;
      deleteTempVoiceChannelIfEmpty(newState.guild, oldChannelId).catch((error) => {
        logOperationError('voiceStateUpdate.cleanupEmptyOldChannel', error, {
          guildId: guildIdValue,
          channelId: oldChannelId,
        });
      });
    }
  }

  if (newState.channelId) {
    const linkedTextId = await getVoiceLinkTextChannelId(guildIdValue, newState.channelId);
    if (linkedTextId) {
      newState.guild.channels.fetch(linkedTextId)
        .then((textChannel) => {
          if (textChannel?.isTextBased()) {
            return textChannel.send(`${newState.member} が ${newState.channel} に参加しました。`).then(() => {
              getTempVoiceMetrics(guildIdValue).voiceLinkNotifications += 1;
            });
          }
          return null;
        })
        .catch((error) => {
          getTempVoiceMetrics(guildIdValue).voiceLinkFailures += 1;
          logOperationError('voiceStateUpdate.sendVoiceLinkNotification', error, {
            guildId: guildIdValue,
            voiceChannelId: newState.channelId,
            textChannelId: linkedTextId,
          });
        });
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  patchInteractionResponseOptions(interaction);
  try {
  if (interaction.isButton() && interaction.customId.startsWith('selfrole:')) {
    const roleId = interaction.customId.split(':')[1];
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
      await interaction.reply({ content: 'ロールが見つかりません。', ephemeral: true });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const hasRole = member.roles.cache.has(roleId);
    if (hasRole) {
      await member.roles.remove(roleId).catch(() => null);
    } else {
      await member.roles.add(roleId).catch(() => null);
    }
    await interaction.reply({ content: `${role} を ${hasRole ? '解除' : '付与'}しました。`, ephemeral: true });
    return;
  }

  if (interaction.isButton() && interaction.customId === CREATE_TICKET_BUTTON_ID) {
    const guildDb = await getDb(interaction.guildId);
    const panel = await guildDb.get('SELECT * FROM ticket_panels WHERE message_id = ?', interaction.message.id);
    if (!panel) {
      await interaction.reply({ content: 'このパネル設定が見つかりません。', ephemeral: true });
      console.warn('ticket:create failed because panel not found', {
        guildId: interaction.guildId,
        messageId: interaction.message.id,
        userId: interaction.user.id,
      });
      return;
    }

    const openCountRow = await guildDb.get(
      "SELECT COUNT(*) as cnt FROM tickets WHERE guild_id = ? AND owner_id = ? AND status = 'open'",
      interaction.guildId,
      interaction.user.id,
    );

    if ((openCountRow?.cnt || 0) >= panel.max_open_per_user) {
      await interaction.reply({
        content: `同時に開けるチケット数の上限(${panel.max_open_per_user})に達しています。`,
        ephemeral: true,
      });
      console.info('ticket:create blocked by limit', {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        maxOpen: panel.max_open_per_user,
      });
      return;
    }

    const guild = interaction.guild;
    const member = await guild.members.fetch(interaction.user.id);
    const supportRole = panel.support_role_id ? guild.roles.cache.get(panel.support_role_id) : null;

    const overwrite = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: member.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
    ];

    if (supportRole) {
      overwrite.push({
        id: supportRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
        ],
      });
    }

    const channel = await guild.channels.create({
      name: `ticket-${member.displayName}`.toLowerCase().replaceAll(' ', '-').slice(0, 90),
      type: ChannelType.GuildText,
      parent: panel.category_id || undefined,
      permissionOverwrites: overwrite,
      topic: `Ticket owner: ${member.id}`,
      reason: `Ticket created by ${member.user.tag}`,
    });

    await guildDb.run(
      "INSERT OR REPLACE INTO tickets(channel_id, guild_id, panel_message_id, owner_id, status, subject) VALUES(?, ?, ?, ?, 'open', ?)",
      channel.id,
      guild.id,
      panel.message_id,
      member.id,
      `Ticket for ${member.displayName}`,
    );

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🎫 チケットが作成されました')
          .setDescription('サポートが来るまでお待ちください。\n`/ticket_close` でクローズできます。')
          .setColor(0x57f287),
      ],
    });

    await interaction.reply({ content: `チケットを作成しました: ${channel}`, ephemeral: true });
    console.info('ticket:create success', {
      guildId: guild.id,
      channelId: channel.id,
      ownerId: member.id,
      panelMessageId: panel.message_id,
    });
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (!interaction.inGuild() || !interaction.guild || !interaction.channel) {
    await interaction.reply({
      content: 'このBotのコマンドはサーバー内でのみ利用できます。',
      ephemeral: true,
    });
    return;
  }

  const disabledCommands = await getDisabledCommands(interaction.guildId);
  if (disabledCommands.has(interaction.commandName) && !['disable', 'enable', 'disabledlist'].includes(interaction.commandName)) {
    await interaction.reply({ content: `\`/${interaction.commandName}\` はこのサーバーで無効化されています。`, ephemeral: true });
    return;
  }

  const requiredPermission = commandPermissionRequirements.get(interaction.commandName);
  if (requiredPermission && !interaction.memberPermissions?.has(requiredPermission)) {
    await interaction.reply({ content: 'このコマンドを実行する権限がありません。', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'ping') {
    await interaction.reply({ content: `ポング！ ${client.ws.ping}ms`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'vc-lock') {
    await applyTempVoiceLock(interaction, TEMP_VOICE_LOCK_MODES.CONNECT);
    return;
  }

  if (interaction.commandName === 'vc-hidden') {
    await applyTempVoiceLock(interaction, TEMP_VOICE_LOCK_MODES.HIDDEN);
    return;
  }

  if (interaction.commandName === 'vc-unlock') {
    await handleTempVoiceUnlock(interaction);
    return;
  }

  if (interaction.commandName === 'vc-lock-status') {
    await handleTempVoiceLockStatus(interaction);
    return;
  }

  if (interaction.commandName === 'vc-invite') {
    await handleTempVoiceInvite(interaction);
    return;
  }

  if (interaction.commandName === 'vc-kick') {
    await handleTempVoiceKick(interaction);
    return;
  }

  if (interaction.commandName === 'ch_lock') {
    if (!isManageChannelMember(interaction)) {
      await interaction.reply({ content: 'この操作を行う権限がありません。', ephemeral: true });
      return;
    }
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, {
      SendMessages: false,
    });
    await interaction.reply('このチャンネルをロックしました。');
    return;
  }

  if (interaction.commandName === 'ch_unlock') {
    if (!isManageChannelMember(interaction)) {
      await interaction.reply({ content: 'この操作を行う権限がありません。', ephemeral: true });
      return;
    }
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, {
      SendMessages: null,
    });
    await interaction.reply('このチャンネルのロックを解除しました。');
    return;
  }

  if (interaction.commandName === 'ch_slowmode') {
    if (!isManageChannelMember(interaction)) {
      await interaction.reply({ content: 'この操作を行う権限がありません。', ephemeral: true });
      return;
    }
    const seconds = interaction.options.getInteger('seconds', true);
    await interaction.channel.setRateLimitPerUser(seconds);
    await interaction.reply(seconds === 0 ? '低速モードを解除しました。' : `低速モードを ${seconds} 秒に設定しました。`);
    return;
  }

  if (interaction.commandName === 'ch_topic') {
    if (!isManageChannelMember(interaction)) {
      await interaction.reply({ content: 'この操作を行う権限がありません。', ephemeral: true });
      return;
    }
    const topic = interaction.options.getString('text', false);
    await interaction.channel.setTopic(topic || null);
    await interaction.reply(topic ? 'チャンネルトピックを更新しました。' : 'チャンネルトピックを解除しました。');
    return;
  }


  if (interaction.commandName === 'help') {
    const requested = interaction.options.getString('command', false)?.replace(/^\//, '').trim();
    if (!requested) {
      await interaction.reply({ content: '主なコマンド: /ping /help /invite /support /dashboard /privacy /lock /unlock /hide /show /slowmode /settopic /rename /purge /createchannel /clone /delete /poll /serverinfo /channelinfo /userinfo /roleinfo /settings /permissions /stats /premium /play とチケット系コマンド', ephemeral: true });
      return;
    }
    const found = commands.find((command) => command.name === requested);
    if (!found) {
      await interaction.reply({ content: `\`/${requested}\` は見つかりませんでした。`, ephemeral: true });
      return;
    }
    const options = (found.options || []).map((option) => `- \`${option.name}\` : ${option.description}`).join('\n');
    await interaction.reply({
      content: `**/${found.name}**\n説明: ${found.description}${options ? `\nオプション:\n${options}` : '\nオプション: なし'}`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'invite') {
    await interaction.reply({ content: 'Bot招待リンクはDiscord Developer PortalでこのBotのOAuth2 URLを生成してください。', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'support') {
    await interaction.reply({ content: `サポート用チャンネルまたはサポートサーバーの案内を管理者が設定してください。\n制作者: ${BOT_CREATOR}`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'dashboard') {
    await interaction.reply({ content: 'このクローンにはWebダッシュボード機能はありません。コマンドで設定してください。', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'privacy') {
    await interaction.reply({ content: `このクローンには専用のプライバシーポリシーURLはありません。必要な場合は運営サーバーのルール/ポリシーチャンネルを案内してください。\n制作者: ${BOT_CREATOR}`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'prefix') {
    const newPrefix = interaction.options.getString('new_prefix', false);
    if (newPrefix) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: 'この操作にはサーバー管理（Manage Server）権限が必要です。', ephemeral: true });
        return;
      }
      await setGuildSetting(interaction.guildId, 'legacy_prefix', newPrefix);
      await interaction.reply({ content: `互換表示用 prefix を \`${newPrefix}\` に設定しました（実行は今後も \`/\` スラッシュコマンドを使用します）。`, ephemeral: true });
      return;
    }
    const currentPrefix = await getGuildSetting(interaction.guildId, 'legacy_prefix');
    await interaction.reply({ content: `現在の互換表示用 prefix: \`${currentPrefix || '/'}\`\nこのBotの実行形式は \`/\` スラッシュコマンド固定です。`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'debug') {
    const target = interaction.options.getString('command', false)?.replace(/^\//, '').trim();
    if (target) {
      const exists = commands.some((command) => command.name === target);
      const disabled = (await getDisabledCommands(interaction.guildId)).has(target);
      await interaction.reply({
        content: `デバッグ結果\n- 対象: \`/${target}\`\n- 登録: ${exists ? 'あり' : 'なし'}\n- このサーバーで無効化: ${disabled ? 'はい' : 'いいえ'}`,
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      content: `デバッグ情報\n- 登録コマンド数: ${commands.length}\n- ギルドID: \`${interaction.guildId}\`\n- Ping: \`${client.ws.ping}ms\``,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'serverinfo') {
    await interaction.reply({ content: `サーバー名: **${interaction.guild.name}**
メンバー数: **${interaction.guild.memberCount}**`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'channelinfo') {
    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    await interaction.reply({ content: `チャンネル: ${channel}
名前: **${channel.name}**
ID: **${channel.id}**`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'userinfo') {
    const user = interaction.options.getUser('user', false) || interaction.user;
    await interaction.reply({ content: `ユーザー: ${user}
ID: **${user.id}**`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'roleinfo') {
    const role = interaction.options.getRole('role', true);
    await interaction.reply({ content: `ロール: **${role.name}**
ID: **${role.id}**`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'lock') {
    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    const durationRaw = interaction.options.getString('duration', false);
    const durationMs = parseDurationToMs(durationRaw);
    if (durationRaw && durationMs === null) {
      await interaction.reply({ content: 'duration は `10m` / `2h` / `30s` の形式で指定してください。', ephemeral: true });
      return;
    }
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, { SendMessages: false });
    schedulePermissionReset(channel, interaction.guild.roles.everyone.id, { SendMessages: null }, durationMs);
    const customMessage = await getGuildSetting(interaction.guildId, 'lock_message');
    await interaction.reply(customMessage || `${channel} をロックしました。${durationMs ? `（${formatDurationJa(durationMs)}後に自動解除）` : ''}`);
    return;
  }

  if (interaction.commandName === 'unlock') {
    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, { SendMessages: null });
    const customMessage = await getGuildSetting(interaction.guildId, 'unlock_message');
    await interaction.reply(customMessage || `${channel} のロックを解除しました。`);
    return;
  }

  if (interaction.commandName === 'hide') {
    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    const durationRaw = interaction.options.getString('duration', false);
    const durationMs = parseDurationToMs(durationRaw);
    if (durationRaw && durationMs === null) {
      await interaction.reply({ content: 'duration は `10m` / `2h` / `30s` の形式で指定してください。', ephemeral: true });
      return;
    }
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, { ViewChannel: false });
    schedulePermissionReset(channel, interaction.guild.roles.everyone.id, { ViewChannel: null }, durationMs);
    await interaction.reply(`${channel} を非表示にしました。${durationMs ? `（${formatDurationJa(durationMs)}後に自動解除）` : ''}`);
    return;
  }

  if (interaction.commandName === 'show') {
    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, { ViewChannel: null });
    await interaction.reply(`${channel} を表示状態に戻しました。`);
    return;
  }

  if (interaction.commandName === 'slowmode') {
    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    const timeRaw = interaction.options.getString('time', true);
    const ms = parseDurationToMs(timeRaw);
    if (ms === null) {
      await interaction.reply({ content: 'time は `10s` / `5m` / `1h` / `off` の形式で指定してください。', ephemeral: true });
      return;
    }
    const sec = Math.max(0, Math.min(21600, Math.floor(ms / 1000)));
    await channel.setRateLimitPerUser(sec);
    await interaction.reply(sec === 0 ? `${channel} の低速モードを解除しました。` : `${channel} の低速モードを ${sec} 秒に設定しました。`);
    return;
  }

  if (interaction.commandName === 'settopic') {
    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    const topic = interaction.options.getString('text', true);
    await channel.setTopic(topic);
    await interaction.reply(`${channel} のトピックを更新しました。`);
    return;
  }

  if (interaction.commandName === 'rename') {
    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    const newName = sanitizeChannelName(interaction.options.getString('name', true));
    if (!newName) {
      await interaction.reply({ content: '有効なチャンネル名を入力してください（英数字/ハイフン/アンダースコア）。', ephemeral: true });
      return;
    }
    await channel.setName(newName);
    await interaction.reply(`${channel} の名前を \`${newName}\` に変更しました。`);
    return;
  }

  if (interaction.commandName === 'purge') {
    const count = interaction.options.getInteger('count', true);
    const user = interaction.options.getUser('user', false);
    if (!user) {
      const deleted = await interaction.channel.bulkDelete(count, true);
      await interaction.reply({ content: `${deleted.size} 件のメッセージを削除しました。`, ephemeral: true });
      return;
    }

    const fetched = await interaction.channel.messages.fetch({ limit: 100 });
    const targets = [...fetched.values()]
      .filter((m) => m.author.id === user.id && Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000)
      .slice(0, count);
    if (!targets.length) {
      await interaction.reply({ content: `${user} の削除対象メッセージが見つかりませんでした。`, ephemeral: true });
      return;
    }
    const deleted = await interaction.channel.bulkDelete(targets, true);
    await interaction.reply({ content: `${user} のメッセージを ${deleted.size} 件削除しました。`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'createchannel') {
    const name = sanitizeChannelName(interaction.options.getString('name', true));
    if (!name) {
      await interaction.reply({ content: '有効なチャンネル名を入力してください（英数字/ハイフン/アンダースコア）。', ephemeral: true });
      return;
    }
    const typeRaw = interaction.options.getString('type', false) || 'text';
    const category = interaction.options.getChannel('category', false);
    const typeMap = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, category: ChannelType.GuildCategory, announcement: ChannelType.GuildAnnouncement };
    const targetType = typeMap[typeRaw] || ChannelType.GuildText;
    const created = await interaction.guild.channels.create({
      name,
      type: targetType,
      parent: targetType === ChannelType.GuildCategory ? null : category?.id || null,
    });
    await interaction.reply(`チャンネルを作成しました: ${created}`);
    return;
  }

  if (interaction.commandName === 'clone') {
    const target = interaction.options.getChannel('channel', false) || interaction.channel;
    const cloned = await target.clone();
    await interaction.reply(`チャンネルを複製しました: ${cloned}`);
    return;
  }

  if (interaction.commandName === 'delete') {
    const target = interaction.options.getChannel('channel', false) || interaction.channel;
    await interaction.reply(`${target} を削除します。`);
    await target.delete(`Deleted by ${interaction.user.tag}`);
    return;
  }

  if (interaction.commandName === 'togglensfw') {
    const target = interaction.options.getChannel('channel', false) || interaction.channel;
    await target.setNSFW(!target.nsfw);
    await interaction.reply(`${target} のNSFWを ${target.nsfw ? '有効' : '無効'} にしました。`);
    return;
  }

  if (interaction.commandName === 'poll') {
    const question = interaction.options.getString('question', true);
    const pollMessage = await interaction.channel.send(`📊 **投票:** ${question}`);
    await pollMessage.react('👍');
    await pollMessage.react('👎');
    await interaction.reply({ content: '投票を作成しました。', ephemeral: true });
    return;
  }



  if (interaction.commandName === 'archivedcat') {
    const category = interaction.options.getChannel('category', true);
    await setGuildSetting(interaction.guildId, 'archive_category_id', category.id);
    await interaction.reply(`アーカイブ先カテゴリーを ${category} に設定しました。`);
    return;
  }

  if (interaction.commandName === 'archive') {
    const target = interaction.options.getChannel('channel', false) || interaction.channel;
    const archiveCategoryId = await getGuildSetting(interaction.guildId, 'archive_category_id');
    if (!archiveCategoryId) {
      await interaction.reply({ content: '`/archivedcat` でアーカイブ先カテゴリーを先に設定してください。', ephemeral: true });
      return;
    }
    await target.setParent(archiveCategoryId);
    await target.permissionOverwrites.edit(interaction.guild.roles.everyone.id, { SendMessages: false });
    await interaction.reply(`${target} をアーカイブしました。`);
    return;
  }

  if (interaction.commandName === 'deletecategory') {
    const category = interaction.options.getChannel('category', true);
    await interaction.reply(`カテゴリー ${category.name} を削除します。`);
    await category.delete(`Deleted by ${interaction.user.tag}`);
    return;
  }

  if (interaction.commandName === 'move') {
    const target = interaction.options.getChannel('channel', false) || interaction.channel;
    const category = interaction.options.getChannel('category', true);
    await target.setParent(category.id);
    await interaction.reply(`${target} を ${category} へ移動しました。`);
    return;
  }

  if (interaction.commandName === 'setbitrate') {
    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    const bitrate = interaction.options.getInteger('bitrate', true);
    if (channel.type !== ChannelType.GuildVoice) {
      await interaction.reply({ content: 'ボイスチャンネルで実行するか、`channel` にボイスチャンネルを指定してください。', ephemeral: true });
      return;
    }
    await channel.setBitrate(bitrate);
    await interaction.reply(`${channel} のビットレートを ${bitrate} に変更しました。`);
    return;
  }


  if (interaction.commandName === 'mentionable') {
    const role = interaction.options.getRole('role', true);
    const enabled = interaction.options.getBoolean('enabled', true);
    await role.setMentionable(enabled);
    await interaction.reply(`${role} のメンション可能設定を ${enabled ? '有効' : '無効'} にしました。`);
    return;
  }

  if (interaction.commandName === 'lockmessage') {
    const message = interaction.options.getString('message', true);
    await setGuildSetting(interaction.guildId, 'lock_message', message);
    await interaction.reply('ロック時メッセージを更新しました。');
    return;
  }

  if (interaction.commandName === 'unlockmessage') {
    const message = interaction.options.getString('message', true);
    await setGuildSetting(interaction.guildId, 'unlock_message', message);
    await interaction.reply('ロック解除時メッセージを更新しました。');
    return;
  }

  if (interaction.commandName === 'addperm' || interaction.commandName === 'clearperm' || interaction.commandName === 'delperm') {
    const permissionName = interaction.options.getString('permission', true);
    const permissionFlag = resolvePermissionName(permissionName);
    if (!permissionFlag) {
      await interaction.reply({ content: '対応権限: ViewChannel / SendMessages / AttachFiles / ReadMessageHistory / ManageChannels', ephemeral: true });
      return;
    }

    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    const target = interaction.options.getMentionable('target', true);

    if (interaction.commandName === 'addperm') {
      await channel.permissionOverwrites.edit(target.id, { [permissionFlag]: true });
      await interaction.reply(`${channel} で ${target} に ${permissionName} を許可しました。`);
      return;
    }

    await channel.permissionOverwrites.edit(target.id, { [permissionFlag]: null });
    await interaction.reply(`${channel} で ${target} の ${permissionName} 上書きを解除しました。`);
    return;
  }


  if (interaction.commandName === 'disable') {
    const commandName = normalizeCommandNameInput(interaction.options.getString('command', true));
    const declared = new Set(commands.map((c) => c.name));
    if (!declared.has(commandName)) {
      await interaction.reply({ content: `コマンド \`/${commandName}\` は存在しません。`, ephemeral: true });
      return;
    }
    if (['disable', 'enable', 'disabledlist'].includes(commandName)) {
      await interaction.reply({ content: 'この管理コマンドは無効化できません。', ephemeral: true });
      return;
    }
    disabledCommands.add(commandName);
    await saveDisabledCommands(interaction.guildId, disabledCommands);
    await interaction.reply(`\`/${commandName}\` を無効化しました。`);
    return;
  }

  if (interaction.commandName === 'enable') {
    const commandName = normalizeCommandNameInput(interaction.options.getString('command', true));
    if (!disabledCommands.has(commandName)) {
      await interaction.reply({ content: `\`/${commandName}\` は無効化されていません。`, ephemeral: true });
      return;
    }
    disabledCommands.delete(commandName);
    await saveDisabledCommands(interaction.guildId, disabledCommands);
    await interaction.reply(`\`/${commandName}\` を再有効化しました。`);
    return;
  }

  if (interaction.commandName === 'disabledlist') {
    const list = [...disabledCommands].sort();
    await interaction.reply({ content: list.length ? `無効化中: ${list.map((x) => `/${x}`).join(', ')}` : '無効化中のコマンドはありません。', ephemeral: true });
    return;
  }


  if (interaction.commandName === 'clearchannel') {
    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    if (!channel?.isTextBased()) {
      await interaction.reply({ content: 'テキストチャンネルを指定してください。', ephemeral: true });
      return;
    }

    let deletedTotal = 0;
    for (let i = 0; i < 20; i += 1) {
      const messages = await channel.messages.fetch({ limit: 100 });
      if (messages.size === 0) {
        break;
      }
      const deleted = await channel.bulkDelete(messages, true);
      deletedTotal += deleted.size;
      if (messages.size < 100) {
        break;
      }
    }

    await interaction.reply({ content: `${channel} のメッセージを ${deletedTotal} 件削除しました。`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'sync') {
    if (!interaction.channel.parent) {
      await interaction.reply({ content: 'このチャンネルはカテゴリー配下ではありません。', ephemeral: true });
      return;
    }
    await interaction.channel.lockPermissions();
    await interaction.reply('現在チャンネルの権限を親カテゴリーと同期しました。');
    return;
  }

  if (interaction.commandName === 'synccat') {
    const category = interaction.options.getChannel('category', true);
    const targets = interaction.guild.channels.cache.filter((ch) => ch.parentId === category.id);
    let done = 0;
    for (const ch of targets.values()) {
      await ch.lockPermissions();
      done += 1;
    }
    await interaction.reply(`${category} 配下 ${done} チャンネルの権限を同期しました。`);
    return;
  }

  if (interaction.commandName === 'multilock' || interaction.commandName === 'multiunlock') {
    const category = interaction.options.getChannel('category', true);
    const lockValue = interaction.commandName === 'multilock' ? false : null;
    const targets = interaction.guild.channels.cache.filter((ch) => ch.parentId === category.id && ch.type === ChannelType.GuildText);
    let done = 0;
    for (const ch of targets.values()) {
      await ch.permissionOverwrites.edit(interaction.guild.roles.everyone.id, { SendMessages: lockValue });
      done += 1;
    }
    await interaction.reply(`${category} 配下 ${done} テキストチャンネルを ${interaction.commandName === 'multilock' ? 'ロック' : 'アンロック'}しました。`);
    return;
  }


  if (interaction.commandName === 'welcome') {
    const mode = interaction.options.getString('mode', true);

    if (mode === 'disable') {
      await setGuildSetting(interaction.guildId, 'welcome_mode', null);
      await setGuildSetting(interaction.guildId, 'welcome_channel_id', null);
      await setGuildSetting(interaction.guildId, 'welcome_message', null);
      await interaction.reply('ウェルカム設定を無効化しました。');
      return;
    }

    const message = interaction.options.getString('message', false);
    if (!message) {
      await interaction.reply({ content: '`message` を指定してください。', ephemeral: true });
      return;
    }

    if (mode === 'channel') {
      const channel = interaction.options.getChannel('channel', false);
      if (!channel?.isTextBased()) {
        await interaction.reply({ content: '`channel` にテキストチャンネルを指定してください。', ephemeral: true });
        return;
      }
      await setGuildSetting(interaction.guildId, 'welcome_mode', 'channel');
      await setGuildSetting(interaction.guildId, 'welcome_channel_id', channel.id);
      await setGuildSetting(interaction.guildId, 'welcome_message', message);
      await interaction.reply(`ウェルカムをチャンネル送信に設定しました: ${channel}`);
      return;
    }

    await setGuildSetting(interaction.guildId, 'welcome_mode', 'dm');
    await setGuildSetting(interaction.guildId, 'welcome_channel_id', null);
    await setGuildSetting(interaction.guildId, 'welcome_message', message);
    await interaction.reply('ウェルカムをDM送信に設定しました。');
    return;
  }

  if (interaction.commandName === 'autorole' || interaction.commandName === 'mods' || interaction.commandName === 'defaultroles') {
    const keyMap = {
      autorole: 'autorole_role_ids_json',
      mods: 'mods_role_ids_json',
      defaultroles: 'default_roles_json',
    };

    const key = keyMap[interaction.commandName];
    const role = interaction.options.getRole('role', true);
    const enabled = interaction.options.getBoolean('enabled', true);
    const roleIds = await getGuildIdSet(interaction.guildId, key);

    if (enabled) {
      roleIds.add(role.id);
    } else {
      roleIds.delete(role.id);
    }

    await saveGuildIdSet(interaction.guildId, key, roleIds);
    await interaction.reply(`${interaction.commandName} に ${role} を ${enabled ? '追加' : '削除'} しました。`);
    return;
  }

  if (interaction.commandName === 'defaultcategory') {
    const clear = interaction.options.getBoolean('clear', false) || false;
    if (clear) {
      await setGuildSetting(interaction.guildId, 'default_category_id', null);
      await interaction.reply('デフォルトカテゴリー設定をクリアしました。');
      return;
    }

    const category = interaction.options.getChannel('category', false);
    if (!category || category.type !== ChannelType.GuildCategory) {
      await interaction.reply({ content: '`category` にカテゴリーを指定してください。', ephemeral: true });
      return;
    }
    await setGuildSetting(interaction.guildId, 'default_category_id', category.id);
    await interaction.reply(`デフォルトカテゴリーを ${category} に設定しました。`);
    return;
  }


  if (interaction.commandName === 'sticky') {
    const action = interaction.options.getString('action', true);
    const stickyKey = `sticky_message_${interaction.channelId}`;
    const stickyMessageIdKey = `sticky_message_id_${interaction.channelId}`;

    if (action === 'enable') {
      const sticky = interaction.options.getString('message', true);
      await setGuildSetting(interaction.guildId, stickyKey, sticky);
      await interaction.reply('このチャンネルの固定メッセージを有効化しました。');
      return;
    }

    if (action === 'disable' || action === 'clear') {
      const stickyMessageId = await getGuildSetting(interaction.guildId, stickyMessageIdKey);
      if (stickyMessageId && interaction.channel?.isTextBased()) {
        await interaction.channel.messages.delete(stickyMessageId).catch(() => null);
      }
      await deleteGuildSetting(interaction.guildId, stickyKey);
      await deleteGuildSetting(interaction.guildId, stickyMessageIdKey);
      await interaction.reply(action === 'disable' ? '固定メッセージを無効化しました。' : '固定メッセージ設定を削除しました。');
      return;
    }

    await interaction.reply({ content: '不明な操作です。', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'autothread') {
    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    const enabled = interaction.options.getBoolean('enabled', true);
    const channels = await getGuildChannelIdSet(interaction.guildId, 'autothread_channel_ids_json');
    if (enabled) {
      channels.add(channel.id);
    } else {
      channels.delete(channel.id);
    }
    await saveGuildChannelIdSet(interaction.guildId, 'autothread_channel_ids_json', channels);
    await interaction.reply(`${channel} の autothread を ${enabled ? '有効' : '無効'} にしました。`);
    return;
  }

  if (interaction.commandName === 'listwebhooks') {
    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    const webhooks = await channel.fetchWebhooks();
    const list = [...webhooks.values()].map((hook) => `${hook.name} (${hook.id})`);
    await interaction.reply({ content: list.length ? list.join('\n') : 'Webhook はありません。', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'say') {
    const message = interaction.options.getString('message', true);
    await interaction.channel.send(message);
    await interaction.reply({ content: 'メッセージを送信しました。', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'embed') {
    const title = interaction.options.getString('title', true);
    const description = interaction.options.getString('description', true);
    await interaction.channel.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(0x5865f2)] });
    await interaction.reply({ content: '埋め込みメッセージを送信しました。', ephemeral: true });
    return;
  }

  if (isExtraCommand(interaction.commandName)) {
    const name = interaction.commandName;

    if (name === 'addpermall' || name === 'clearpermall') {
      const permissionName = interaction.options.getString('permission', true);
      const target = interaction.options.getMentionable('target', true);
      const category = interaction.options.getChannel('category', false);
      const mode = name === 'addpermall' ? 'allow' : 'clear';
      const result = await bulkApplyPermission(interaction.guild, permissionName, target.id, category?.id, mode);
      if (!result.ok) {
        await interaction.reply({ content: result.message, ephemeral: true });
        return;
      }
      await interaction.reply(
        `${result.success}/${result.total} チャンネルの権限を更新しました。${result.failed ? `（失敗: ${result.failed} / 代表エラーID: ${result.errorIds.join(', ')}）` : ''}`,
      );
      return;
    }

    if (name === 'imageonly') {
      const channel = interaction.options.getChannel('channel', false) || interaction.channel;
      const enabled = interaction.options.getBoolean('enabled', true);
      const channels = await getGuildChannelIdSet(interaction.guildId, 'image_only_channels_json');
      if (enabled) channels.add(channel.id); else channels.delete(channel.id);
      await saveGuildChannelIdSet(interaction.guildId, 'image_only_channels_json', channels);
      await interaction.reply(`${channel} の imageonly を ${enabled ? '有効' : '無効'} にしました。`);
      return;
    }

    if (name === 'autopublish') {
      const action = interaction.options.getString('action', true);
      const channels = await getGuildChannelIdSet(interaction.guildId, 'autopublish_channel_ids_json');

      if (action === 'list') {
        const mentions = [...channels].map((id) => interaction.guild.channels.cache.get(id)?.toString() || `\`${id}\``);
        await interaction.reply({ content: mentions.length ? `自動公開チャンネル一覧:\n${mentions.join('\n')}` : '自動公開チャンネルは設定されていません。', ephemeral: true });
        return;
      }

      const channel = interaction.options.getChannel('channel', false) || interaction.channel;
      if (action === 'on') {
        channels.add(channel.id);
      } else {
        channels.delete(channel.id);
      }
      await saveGuildChannelIdSet(interaction.guildId, 'autopublish_channel_ids_json', channels);
      await interaction.reply(`${channel} の自動公開を ${action === 'on' ? 'ON' : 'OFF'} にしました。`);
      return;
    }

    if (name === 'jointocreate') {
      const action = interaction.options.getString('action', true);
      const voice = interaction.options.getChannel('voice_channel', false);
      const category = interaction.options.getChannel('category', false);
      const namePrefix = normalizeTempVcPrefix(interaction.options.getString('name_prefix', false));
      const triggers = await getJoinToCreateTriggers(interaction.guildId);

      if (action === 'delete') {
        if (voice) {
          if (!triggers[voice.id]) {
            await interaction.reply({ content: `${voice} は Join to Create 起点として未登録です。`, ephemeral: true });
            return;
          }
          delete triggers[voice.id];
          await saveJoinToCreateTriggers(interaction.guildId, triggers);
          clearTempVoiceConfigCache(interaction.guildId);
          logTempVoiceSettingChange(interaction.guildId, interaction.user.tag, 'jointocreate.delete', { triggerChannelId: voice.id });
          await interaction.reply(`${voice} の Join to Create 起点設定を削除しました。`);
          return;
        }

        await saveJoinToCreateTriggers(interaction.guildId, {});
        await deleteGuildSetting(interaction.guildId, 'jointocreate_channel_id');
        await deleteGuildSetting(interaction.guildId, 'jointocreate_category_id');
        clearTempVoiceConfigCache(interaction.guildId);
        logTempVoiceSettingChange(interaction.guildId, interaction.user.tag, 'jointocreate.deleteAll');
        await interaction.reply('Join to Create の起点設定をすべて削除しました。');
        return;
      }

      if (action === 'list') {
        const lines = Object.entries(triggers).map(([triggerChannelId, config]) => (
          `起点VC: <#${triggerChannelId}> / 作成先カテゴリー: ${config.categoryId ? `<#${config.categoryId}>` : '未設定（サーバールート）'} / 先頭名: \`${normalizeTempVcPrefix(config.namePrefix)}\``
        ));

        await interaction.reply({
          content: lines.length
            ? `現在の設定:\n${lines.join('\n')}`
            : 'Join to Create は未設定です。',
          ephemeral: true,
        });
        return;
      }

      if (!voice) {
        await interaction.reply({ content: '`action=設定` のときは `voice_channel` を指定してください。', ephemeral: true });
        return;
      }

      triggers[voice.id] = {
        categoryId: category?.id || null,
        namePrefix,
      };
      await saveJoinToCreateTriggers(interaction.guildId, triggers);
      await deleteGuildSetting(interaction.guildId, 'jointocreate_channel_id');
      await deleteGuildSetting(interaction.guildId, 'jointocreate_category_id');
      await setGuildSetting(interaction.guildId, 'tempchannels_enabled', 'true');
      clearTempVoiceConfigCache(interaction.guildId);
      logTempVoiceSettingChange(interaction.guildId, interaction.user.tag, 'jointocreate.setup', { triggerChannelId: voice.id, categoryId: category?.id || null, namePrefix });
      await interaction.reply(`Join to Create の起点を ${voice} に設定しました。（先頭名: \`${namePrefix}\`）`);
      return;
    }

    if (name === 'tempchannels') {
      const action = interaction.options.getString('action', true);
      if (action === 'config') {
        const enabled = (await getGuildSetting(interaction.guildId, 'tempchannels_enabled')) === 'true';
        const triggers = await getJoinToCreateTriggers(interaction.guildId);
        const lines = Object.entries(triggers).map(([triggerChannelId, config]) => (
          `- <#${triggerChannelId}> → ${config.categoryId ? `<#${config.categoryId}>` : 'サーバールート'} / 先頭名: \`${normalizeTempVcPrefix(config.namePrefix)}\``
        ));
        await interaction.reply({
          content: `一時VC設定:\n機能: ${enabled ? '有効' : '無効'}\n起点一覧:\n${lines.length ? lines.join('\n') : '未設定'}`,
          ephemeral: true,
        });
        return;
      }

      if (action === 'health') {
        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply(await buildTempVoiceHealthReport(interaction.guild));
        return;
      }

      if (action === 'cleanup') {
        await interaction.deferReply({ ephemeral: true });
        const result = await cleanupEmptyTempVoiceChannels(interaction.guild, 'tempchannels.cleanupCommand', { requireEnabled: false });
        await interaction.editReply(`一時VCの掃除を実行しました。確認対象: ${result.scanned} / 削除またはメタデータ整理: ${result.removed}`);
        return;
      }

      if (action === 'delete') {
        await setGuildSetting(interaction.guildId, 'tempchannels_enabled', 'false');
        clearTempVoiceConfigCache(interaction.guildId);
        logTempVoiceSettingChange(interaction.guildId, interaction.user.tag, 'tempchannels.disable');
        await interaction.reply('一時ボイスチャンネル機能を無効化しました。');
        return;
      }

      await setGuildSetting(interaction.guildId, 'tempchannels_enabled', 'true');
      clearTempVoiceConfigCache(interaction.guildId);
      logTempVoiceSettingChange(interaction.guildId, interaction.user.tag, 'tempchannels.enable');
      await interaction.reply('一時ボイスチャンネル機能を有効化しました。');
      return;
    }

    if (name === 'setsuggestion') {
      const channel = interaction.options.getChannel('channel', true);
      await setGuildSetting(interaction.guildId, 'suggestion_channel_id', channel.id);
      await interaction.reply(`提案チャンネルを ${channel} に設定しました。`);
      return;
    }

    if (name === 'suggestionwhitelist') {
      const action = interaction.options.getString('action', true);
      const roles = await getGuildIdSet(interaction.guildId, 'suggestion_whitelist_roles_json');

      if (action === 'list') {
        const mentions = [...roles].map((roleId) => interaction.guild.roles.cache.get(roleId)?.toString() || `\`${roleId}\``);
        await interaction.reply({ content: mentions.length ? `ホワイトリストロール一覧:\n${mentions.join('\n')}` : 'ホワイトリストロールは未設定です。', ephemeral: true });
        return;
      }

      const role = interaction.options.getRole('role', true);
      if (action === 'add') {
        roles.add(role.id);
      } else {
        roles.delete(role.id);
      }
      await saveGuildIdSet(interaction.guildId, 'suggestion_whitelist_roles_json', roles);
      await interaction.reply(`提案ホワイトリストを更新しました（${role} を ${action === 'add' ? '追加' : '削除'}）。`);
      return;
    }

    if (name === 'suggestemojis') {
      await setGuildSetting(interaction.guildId, 'suggestion_up_emoji', interaction.options.getString('up', true));
      await setGuildSetting(interaction.guildId, 'suggestion_down_emoji', interaction.options.getString('down', true));
      await interaction.reply('提案用絵文字を更新しました。');
      return;
    }

    if (name === 'userlock' || name === 'userunlock') {
      const user = interaction.options.getUser('user', true);
      const channel = interaction.options.getChannel('channel', false) || interaction.channel;
      const value = name === 'userlock' ? false : null;
      await channel.permissionOverwrites.edit(user.id, { SendMessages: value });
      await interaction.reply(`${channel} で ${user} を ${name === 'userlock' ? 'ロック' : 'アンロック'}しました。`);
      return;
    }

    if (name === 'voicelink') {
      const action = interaction.options.getString('action', true);

      if (action === 'list') {
        const guildDb = await getDb(interaction.guildId);
        const rows = await guildDb.all(
          "SELECT key, value FROM guild_settings WHERE guild_id = ? AND key LIKE 'voicelink_%' ORDER BY key",
          interaction.guildId,
        );
        if (!rows.length) {
          await interaction.reply({ content: 'ボイスリンク設定はありません。', ephemeral: true });
          return;
        }
        const lines = rows.map((row) => {
          const voiceId = row.key.replace('voicelink_', '');
          return `<#${voiceId}> → <#${row.value}>`;
        });
        await interaction.reply({ content: `ボイスリンク一覧:\n${lines.join('\n')}`, ephemeral: true });
        return;
      }

      if (action === 'clear') {
        const guildDb = await getDb(interaction.guildId);
        await guildDb.run("DELETE FROM guild_settings WHERE guild_id = ? AND key LIKE 'voicelink_%'", interaction.guildId);
        clearVoiceLinkCache(interaction.guildId);
        logTempVoiceSettingChange(interaction.guildId, interaction.user.tag, 'voicelink.clear');
        await interaction.reply('すべてのボイスリンク設定を解除しました。');
        return;
      }

      const voice = interaction.options.getChannel('voice', true);
      if (action === 'unlink') {
        await deleteGuildSetting(interaction.guildId, `voicelink_${voice.id}`);
        clearVoiceLinkCache(interaction.guildId);
        logTempVoiceSettingChange(interaction.guildId, interaction.user.tag, 'voicelink.unlink', { voiceChannelId: voice.id });
        await interaction.reply(`${voice} のボイスリンクを解除しました。`);
        return;
      }

      const text = interaction.options.getChannel('text', true);
      await setGuildSetting(interaction.guildId, `voicelink_${voice.id}`, text.id);
      clearVoiceLinkCache(interaction.guildId);
      logTempVoiceSettingChange(interaction.guildId, interaction.user.tag, 'voicelink.link', { voiceChannelId: voice.id, textChannelId: text.id });
      await interaction.reply(`${voice} → ${text} のボイスリンクを設定しました。`);
      return;
    }

    if (name === 'spookify' || name === 'springify' || name === 'winterify') {
      const prefix = name === 'spookify' ? '🎃-' : name === 'springify' ? '🌸-' : '❄️-';
      const action = interaction.options.getString('action', true);
      const { updated, failed, errorIds } = await applySeasonPrefix(interaction.guild, action === 'on' ? prefix : '');
      await interaction.reply(`${updated} チャンネル名を更新しました（${action.toUpperCase()}）。${failed ? `（失敗: ${failed} / 代表エラーID: ${errorIds.join(', ')}）` : ''}`);
      return;
    }

    if (name === 'buttonroles') {
      const title = interaction.options.getString('title', true);
      const roles = [
        interaction.options.getRole('role1', true),
        interaction.options.getRole('role2', false),
        interaction.options.getRole('role3', false),
      ].filter(Boolean);
      const row = new ActionRowBuilder().addComponents(
        ...roles.map((role) => new ButtonBuilder().setCustomId(getRoleButtonCustomId(role.id)).setLabel(role.name.slice(0, 80)).setStyle(ButtonStyle.Secondary)),
      );
      await interaction.channel.send({ content: title, components: [row] });
      await interaction.reply({ content: 'buttonroles メッセージを作成しました。', ephemeral: true });
      return;
    }

    if (name === 'reactionroles') {
      const title = interaction.options.getString('title', true);
      const role1 = interaction.options.getRole('role1', true);
      const emoji1 = interaction.options.getString('emoji1', true);
      const role2 = interaction.options.getRole('role2', false);
      const emoji2 = interaction.options.getString('emoji2', false);
      let body = `${emoji1} : ${role1}`;
      if (role2 && emoji2) body += `
${emoji2} : ${role2}`;
      const sent = await interaction.channel.send(`${title}
${body}`);
      await sent.react(emoji1).catch(() => null);
      if (role2 && emoji2) await sent.react(emoji2).catch(() => null);
      await interaction.reply({ content: 'reactionroles 投稿を作成しました。', ephemeral: true });
      return;
    }

    if (name === 'role') {
      const targetUser = interaction.options.getUser('user', true);
      const role = interaction.options.getRole('role', true);
      const enabled = interaction.options.getBoolean('enabled', true);
      const member = await interaction.guild.members.fetch(targetUser.id);
      if (enabled) await member.roles.add(role); else await member.roles.remove(role);
      await interaction.reply(`${member} の ${role} を ${enabled ? '付与' : '解除'}しました。`);
      return;
    }

    if (name === 'roleall') {
      const role = interaction.options.getRole('role', true);
      const action = interaction.options.getString('action', true);
      await interaction.deferReply({ ephemeral: true });
      if (!role.editable) {
        await interaction.editReply('このロールはBotより上位のため一括変更できません。ロール階層を確認してください。');
        return;
      }

      const members = await interaction.guild.members.fetch();
      const targets = [...members.values()].filter((member) => !member.user.bot);

      const batchResult = await processInBatches(targets, 5, async (member) => {
        if (action === 'add') {
          if (!member.roles.cache.has(role.id)) await member.roles.add(role);
          return;
        }
        if (member.roles.cache.has(role.id)) await member.roles.remove(role);
      }, {
        label: 'roleall',
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        roleId: role.id,
        action,
      });

      const success = batchResult.total - batchResult.failed;
      await interaction.editReply(`${role} を ${action === 'add' ? '付与' : '解除'}しました。対象: ${batchResult.total}人 / 成功: ${success} / 失敗: ${batchResult.failed}${batchResult.failed ? `（代表エラーID: ${batchResult.errorIds.join(', ')}）` : ''}`);
      return;
    }

    if (name === 'resetrole') {
      const targetUser = interaction.options.getUser('user', true);
      const member = await interaction.guild.members.fetch(targetUser.id);
      const removable = member.roles.cache.filter((r) => r.id !== interaction.guild.roles.everyone.id && r.editable);
      const batchResult = await processInBatches([...removable.values()], 3, async (role) => {
        await member.roles.remove(role);
      }, {
        label: 'resetrole',
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        targetUserId: targetUser.id,
      });
      await interaction.reply(`${member} のロールをリセットしました。${batchResult.failed ? `（失敗: ${batchResult.failed} / 代表エラーID: ${batchResult.errorIds.join(', ')}）` : ''}`);
      return;
    }

    if (name === 'addemoji') {
      const emoji = await interaction.guild.emojis.create({ name: interaction.options.getString('name', true), attachment: interaction.options.getString('url', true) });
      await interaction.reply(`絵文字 ${emoji} を追加しました。`);
      return;
    }

    if (name === 'delemoji') {
      const emojiName = interaction.options.getString('name', true);
      const emoji = interaction.guild.emojis.cache.find((e) => e.name === emojiName);
      if (!emoji) {
        await interaction.reply({ content: '絵文字が見つかりません。', ephemeral: true });
        return;
      }
      await emoji.delete();
      await interaction.reply(`:${emojiName}: を削除しました。`);
      return;
    }

    if (name === 'emojilock') {
      const enabled = interaction.options.getBoolean('enabled', true);
      await setGuildSetting(interaction.guildId, 'emoji_lock_enabled', String(enabled));
      await interaction.reply(`emojilock を ${enabled ? '有効' : '無効'} にしました。`);
      return;
    }

    if (name === 'backup') {
      const guildDb = await getDb(interaction.guildId);
      const action = interaction.options.getString('action', true);
      await interaction.deferReply({ ephemeral: true });
      if (action === 'create') {
        const rows = await guildDb.all('SELECT key, value FROM guild_settings WHERE guild_id = ?', interaction.guildId);
        const json = JSON.stringify({ guildId: interaction.guildId, exportedAt: new Date().toISOString(), settings: rows }, null, 2);
        const file = Buffer.from(json, 'utf8');
        await interaction.editReply({ content: 'バックアップを生成しました。', files: [{ attachment: file, name: `backup-${interaction.guildId}.json` }] });
        return;
      }

      const file = interaction.options.getAttachment('file', false);
      if (!file) {
        await interaction.editReply('復元には `file` にバックアップJSONを指定してください。');
        return;
      }

      const response = await fetch(file.url);
      if (!response.ok) {
        await interaction.editReply('バックアップファイルを取得できませんでした。');
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(await response.text());
      } catch {
        await interaction.editReply('JSONの解析に失敗しました。正しいバックアップファイルを指定してください。');
        return;
      }

      const settings = Array.isArray(parsed?.settings) ? parsed.settings : null;
      if (!settings) {
        await interaction.editReply('バックアップ形式が不正です。`settings` 配列が必要です。');
        return;
      }

      await guildDb.run('BEGIN TRANSACTION');
      try {
        await guildDb.run('DELETE FROM guild_settings WHERE guild_id = ?', interaction.guildId);
        for (const row of settings) {
          if (typeof row?.key !== 'string') continue;
          await guildDb.run(
            'INSERT OR REPLACE INTO guild_settings (guild_id, key, value) VALUES (?, ?, ?)',
            interaction.guildId,
            row.key,
            row.value ?? null,
          );
        }
        await guildDb.run('COMMIT');
      } catch (error) {
        await guildDb.run('ROLLBACK');
        throw error;
      }

      await interaction.editReply(`バックアップを復元しました（${settings.length}件）。`);
      return;
    }

    if (name === 'serversetup') {
      const setupCategory = await interaction.guild.channels.create({ name: 'ChannelBot', type: ChannelType.GuildCategory }).catch(() => null);
      if (setupCategory) {
        await setGuildSetting(interaction.guildId, 'default_category_id', setupCategory.id);
      }
      await interaction.reply('基本セットアップが完了しました。必要に応じて各コマンドで微調整してください。');
      return;
    }

    await interaction.reply({ content: `/${name} は実装済みですが、この状況では実行対象が見つかりませんでした。`, ephemeral: true });
    return;
  }


  if (interaction.commandName === 'stats') {
    const guildDb = await getDb(interaction.guildId);
    const [ticketCountRow, openTicketCountRow, panelCountRow, settingsCountRow] = await Promise.all([
      guildDb.get('SELECT COUNT(*) AS count FROM tickets WHERE guild_id = ?', interaction.guildId),
      guildDb.get("SELECT COUNT(*) AS count FROM tickets WHERE guild_id = ? AND status = 'open'", interaction.guildId),
      guildDb.get('SELECT COUNT(*) AS count FROM ticket_panels WHERE guild_id = ?', interaction.guildId),
      guildDb.get('SELECT COUNT(*) AS count FROM guild_settings WHERE guild_id = ?', interaction.guildId),
    ]);

    const embed = new EmbedBuilder()
      .setTitle('Bot統計')
      .setColor(0x57f287)
      .addFields(
        { name: 'サーバー', value: interaction.guild?.name || '不明', inline: true },
        { name: 'メンバー数', value: String(interaction.guild?.memberCount || 0), inline: true },
        { name: 'チャンネル数', value: String(interaction.guild?.channels.cache.size || 0), inline: true },
        { name: '参加サーバー数', value: String(client.guilds.cache.size), inline: true },
        { name: 'WebSocket遅延', value: `${client.ws.ping}ms`, inline: true },
        { name: '稼働時間', value: `${Math.floor(process.uptime())}秒`, inline: true },
        { name: 'チケットパネル数', value: String(panelCountRow?.count || 0), inline: true },
        { name: 'オープンチケット数', value: String(openTicketCountRow?.count || 0), inline: true },
        { name: '総チケット数', value: String(ticketCountRow?.count || 0), inline: true },
        { name: '保存設定数', value: String(settingsCountRow?.count || 0), inline: true },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (interaction.commandName === 'permissions') {
    const channel = interaction.options.getChannel('channel', false) || interaction.channel;
    const role = interaction.options.getRole('role', false);
    const user = interaction.options.getUser('user', false);
    const guildMember = user ? await interaction.guild.members.fetch(user.id).catch(() => null) : interaction.member;

    if (role && user) {
      await interaction.reply({ content: '`user` と `role` はどちらか片方だけ指定してください。', ephemeral: true });
      return;
    }

    const permissionSource = role || guildMember;
    if (!permissionSource) {
      await interaction.reply({ content: '権限を確認できる対象が見つかりませんでした。', ephemeral: true });
      return;
    }

    const permissions = role
      ? channel.permissionsFor(role)
      : channel.permissionsFor(guildMember);

    if (!permissions) {
      await interaction.reply({ content: '指定対象の権限を取得できませんでした。', ephemeral: true });
      return;
    }

    const importantFlags = [
      'ViewChannel',
      'SendMessages',
      'ManageChannels',
      'ManageMessages',
      'ManageRoles',
      'ManageGuild',
      'Connect',
      'Speak',
      'Administrator',
    ];

    const embed = new EmbedBuilder()
      .setTitle('権限一覧')
      .setColor(0x5865f2)
      .setDescription(`対象: ${role ? role.toString() : guildMember.toString()}
チャンネル: ${channel}`)
      .addFields(
        { name: '許可', value: importantFlags.filter((flag) => permissions.has(flag)).join('\n') || 'なし', inline: true },
        { name: '未許可', value: importantFlags.filter((flag) => !permissions.has(flag)).join('\n') || 'なし', inline: true },
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (interaction.commandName === 'settings') {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'view') {
      const key = interaction.options.getString('key', false);
      if (key) {
        const value = await getGuildSetting(interaction.guildId, key);
        await interaction.reply({ content: `**${key}**: ${formatSettingValue(key, value, interaction.guild)}`, ephemeral: true });
        return;
      }

      const guildDb = await getDb(interaction.guildId);
      const rows = await guildDb.all('SELECT key, value FROM guild_settings WHERE guild_id = ? ORDER BY key', interaction.guildId);
      if (!rows.length) {
        await interaction.reply({ content: '保存済み設定はありません。', ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('サーバー設定')
        .setColor(0xfaa61a)
        .setDescription(rows.map((row) => `**${row.key}**: ${formatSettingValue(row.key, row.value, interaction.guild)}`).join('\n'));
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'この操作にはサーバー管理（Manage Server）権限が必要です。', ephemeral: true });
      return;
    }

    if (subcommand === 'clearall') {
      const confirmValue = interaction.options.getString('confirm', true);
      if (confirmValue !== 'CONFIRM') {
        await interaction.reply({ content: '確認文字列が一致しないため中止しました。', ephemeral: true });
        return;
      }
      const shouldDeleteChannels = interaction.options.getBoolean('delete_channels', false) === true;
      const guildDb = await getDb(interaction.guildId);
      const ticketRows = shouldDeleteChannels
        ? await guildDb.all('SELECT channel_id FROM tickets WHERE guild_id = ?', interaction.guildId)
        : [];
      await guildDb.run('BEGIN TRANSACTION');
      try {
        const deletedSettings = await guildDb.run('DELETE FROM guild_settings WHERE guild_id = ?', interaction.guildId);
        const deletedTickets = await guildDb.run('DELETE FROM tickets WHERE guild_id = ?', interaction.guildId);
        const deletedPanels = await guildDb.run('DELETE FROM ticket_panels WHERE guild_id = ?', interaction.guildId);
        await guildDb.run('COMMIT');
        let deletedChannels = 0;
        if (shouldDeleteChannels) {
          for (const row of ticketRows) {
            const channel = await interaction.guild.channels.fetch(row.channel_id).catch(() => null);
            if (!channel) continue;
            const deleted = await channel.delete(`settings clearall requested by ${interaction.user.tag}`).catch(() => null);
            if (deleted) deletedChannels += 1;
          }
        }
        await interaction.reply({
          content: `このサーバーのBotデータを全削除しました。\n- settings: ${deletedSettings?.changes || 0}\n- tickets: ${deletedTickets?.changes || 0}\n- ticket_panels: ${deletedPanels?.changes || 0}${shouldDeleteChannels ? `\n- deleted_channels: ${deletedChannels}` : ''}`,
          ephemeral: true,
        });
      } catch (error) {
        await guildDb.run('ROLLBACK');
        throw error;
      }
      return;
    }

    const key = interaction.options.getString('key', true);
    if (subcommand === 'set') {
      const value = interaction.options.getString('value', true);
      await setGuildSetting(interaction.guildId, key, value);
      await interaction.reply({ content: `設定 **${key}** を更新しました: ${formatSettingValue(key, value, interaction.guild)}`, ephemeral: true });
      return;
    }

    await deleteGuildSetting(interaction.guildId, key);
    await interaction.reply({ content: `設定 **${key}** を削除しました。`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'premium') {
    const subcommand = interaction.options.getSubcommand();
    if (['status', 'check', 'list'].includes(subcommand)) {
      const enabled = (await getGuildSetting(interaction.guildId, 'premium_enabled')) === 'true';
      const plan = await getGuildSetting(interaction.guildId, 'premium_plan') || 'free';
      const queue = await getMusicQueue(interaction.guildId);
      const embed = new EmbedBuilder()
        .setTitle('プレミアム状態')
        .setColor(enabled ? 0xf1c40f : 0x95a5a6)
        .addFields(
          { name: '有効状態', value: enabled ? '有効' : '無効', inline: true },
          { name: 'プラン', value: plan, inline: true },
          { name: 'キュー上限', value: enabled ? '50曲' : '5曲', inline: true },
          { name: '現在のキュー数', value: `${queue.length}曲`, inline: true },
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'この操作にはサーバー管理（Manage Server）権限が必要です。', ephemeral: true });
      return;
    }

    if (['enable', 'activate'].includes(subcommand)) {
      const plan = interaction.options.getString('plan', false) || 'plus';
      await setGuildSetting(interaction.guildId, 'premium_enabled', 'true');
      await setGuildSetting(interaction.guildId, 'premium_plan', plan);
      await interaction.reply({ content: `プレミアムを有効化しました。プラン: **${plan}**`, ephemeral: true });
      return;
    }

    await setGuildSetting(interaction.guildId, 'premium_enabled', 'false');
    await setGuildSetting(interaction.guildId, 'premium_plan', 'free');
    await interaction.reply({ content: 'プレミアムを無効化しました。', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'play') {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'start') {
      const game = interaction.options.getString('game', true);
      const voice = interaction.options.getChannel('channel', false)
        || interaction.member?.voice?.channel;
      if (!voice || voice.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '開始先のボイスチャンネルを指定するか、先にVCへ参加してください。', ephemeral: true });
        return;
      }
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.CreateInstantInvite)) {
        await interaction.reply({ content: 'この操作には「招待を作成」権限が必要です。', ephemeral: true });
        return;
      }
      const targetApplicationId = ACTIVITY_APPLICATION_IDS[game];
      if (!targetApplicationId) {
        await interaction.reply({ content: '指定されたゲームは未対応です。', ephemeral: true });
        return;
      }
      const invite = await voice.invites.create({
        maxAge: 0,
        maxUses: 0,
        targetType: 2,
        targetApplication: targetApplicationId,
      });
      await interaction.reply({
        content: `${voice} でアクティビティを開始できます。\n参加リンク: ${invite.url}`,
        ephemeral: true,
      });
      return;
    }

    const premiumEnabled = (await getGuildSetting(interaction.guildId, 'premium_enabled')) === 'true';
    const maxQueueSize = premiumEnabled ? 50 : 5;
    const queue = await getMusicQueue(interaction.guildId);
    const nowPlaying = await getNowPlaying(interaction.guildId);

    if (subcommand === 'queue') {
      const description = [
        nowPlaying ? `**再生中**: ${nowPlaying.title}${nowPlaying.url ? `\n${nowPlaying.url}` : ''}` : '**再生中**: なし',
        '',
        queue.length
          ? queue.map((track, index) => `${index + 1}. ${track.title}${track.url ? ` — ${track.url}` : ''}`).join('\n')
          : 'キューは空です。',
      ].join('\n');
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle('再生キュー').setColor(0x3498db).setDescription(description)], ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({ content: 'play の変更操作にはチャンネル管理（Manage Channels）権限が必要です。', ephemeral: true });
      return;
    }

    if (subcommand === 'enqueue') {
      const queueUsage = nowPlaying ? queue.length + 1 : queue.length;
      if (queueUsage >= maxQueueSize) {
        await interaction.reply({ content: `キュー上限です。現在の上限は ${maxQueueSize} 件です。`, ephemeral: true });
        return;
      }
      const track = {
        title: interaction.options.getString('title', true),
        url: interaction.options.getString('url', false),
        requestedBy: interaction.user.id,
        requestedAt: new Date().toISOString(),
      };

      if (!nowPlaying) {
        await saveNowPlaying(interaction.guildId, track);
        await interaction.reply({ content: `再生を開始しました (1/${maxQueueSize}): **${track.title}**`, ephemeral: true });
        return;
      }

      queue.push(track);
      await saveMusicQueue(interaction.guildId, queue);
      await interaction.reply({ content: `キューに追加しました (${queue.length + 1}/${maxQueueSize}): **${track.title}**`, ephemeral: true });
      return;
    }

    if (subcommand === 'skip') {
      if (!nowPlaying) {
        await interaction.reply({ content: 'スキップする曲がありません。', ephemeral: true });
        return;
      }

      const skipped = nowPlaying;
      const nextTrack = queue.shift() || null;
      await saveMusicQueue(interaction.guildId, queue);
      await saveNowPlaying(interaction.guildId, nextTrack);
      await interaction.reply({
        content: nextTrack
          ? `スキップしました: **${skipped.title}** → 次は **${nextTrack.title}**`
          : `スキップしました: **${skipped.title}**。キューは空になりました。`,
        ephemeral: true,
      });
      return;
    }

    await saveMusicQueue(interaction.guildId, []);
    await saveNowPlaying(interaction.guildId, null);
    await interaction.reply({ content: 'キューをクリアしました。', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'ticket_panel') {
    const guildDb = await getDb(interaction.guildId);
    const postChannel = interaction.options.getChannel('post_channel', true);
    const category = interaction.options.getChannel('category', false);
    const supportRole = interaction.options.getRole('support_role', false);
    const maxOpen = interaction.options.getInteger('max_open_per_user', false) ?? 1;

    const message = await postChannel.send({ embeds: [ticketPanelEmbed], components: [createTicketRow] });
    await guildDb.run(
      'INSERT OR REPLACE INTO ticket_panels(message_id, guild_id, channel_id, category_id, support_role_id, max_open_per_user, created_by) VALUES(?, ?, ?, ?, ?, ?, ?)',
      message.id,
      interaction.guildId,
      postChannel.id,
      category?.id || null,
      supportRole?.id || null,
      maxOpen,
      interaction.user.id,
    );

    await interaction.reply({ content: `パネルを設置しました: ${message.url}`, ephemeral: true });
    console.info('ticket_panel created', {
      guildId: interaction.guildId,
      panelMessageId: message.id,
      postChannelId: postChannel.id,
      supportRoleId: supportRole?.id || null,
    });
    return;
  }

  const member = interaction.member;
  const row = await getTicketRow(interaction.guildId, interaction.channelId);
  if (!row) {
    await interaction.reply({ content: 'このチャンネルはチケットではありません。', ephemeral: true });
    console.warn('ticket command on non-ticket channel', {
      command: interaction.commandName,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
    });
    return;
  }

  if (interaction.commandName === 'ticket_close') {
    const owner = row.owner_id === interaction.user.id;
    if (!owner && !(await canManageTicket(member, row, interaction.guildId))) {
      await interaction.reply({ content: 'この操作を行う権限がありません。', ephemeral: true });
      console.warn('ticket_close denied', {
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      return;
    }
    const guildDb = await getDb(interaction.guildId);
    await guildDb.run(
      "UPDATE tickets SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE channel_id = ?",
      interaction.channelId,
    );
    await interaction.channel.setName(`closed-${interaction.channel.name}`.slice(0, 100));
    await interaction.reply('チケットをクローズしました。`/ticket_delete` で削除できます。');
    console.info('ticket_close success', {
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
    });
    return;
  }

  if (interaction.commandName === 'ticket_delete') {
    if (!(await canManageTicket(member, row, interaction.guildId))) {
      await interaction.reply({ content: 'この操作を行う権限がありません。', ephemeral: true });
      console.warn('ticket_delete denied', {
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      return;
    }
    const guildDb = await getDb(interaction.guildId);
    await guildDb.run('DELETE FROM tickets WHERE channel_id = ?', interaction.channelId);
    await interaction.reply('チケットを削除します。');
    console.info('ticket_delete success', {
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
    });
    await interaction.channel.delete(`Ticket deleted by ${interaction.user.tag}`);
    return;
  }

  if (interaction.commandName === 'ticket_add') {
    if (!(await canManageTicket(member, row, interaction.guildId))) {
      await interaction.reply({ content: 'この操作を行う権限がありません。', ephemeral: true });
      console.warn('ticket_add denied', {
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      return;
    }
    const user = interaction.options.getUser('user', true);
    await interaction.channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    });
    await interaction.reply(`${user} をチケットに追加しました。`);
    console.info('ticket_add success', {
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      actorId: interaction.user.id,
      targetUserId: user.id,
    });
    return;
  }

  if (interaction.commandName === 'ticket_remove') {
    if (!(await canManageTicket(member, row, interaction.guildId))) {
      await interaction.reply({ content: 'この操作を行う権限がありません。', ephemeral: true });
      console.warn('ticket_remove denied', {
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      return;
    }
    const user = interaction.options.getUser('user', true);
    await interaction.channel.permissionOverwrites.delete(user.id);
    await interaction.reply(`${user} をチケットから削除しました。`);
    console.info('ticket_remove success', {
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      actorId: interaction.user.id,
      targetUserId: user.id,
    });
    return;
  }

  if (interaction.commandName === 'ticket_rename') {
    if (!(await canManageTicket(member, row, interaction.guildId))) {
      await interaction.reply({ content: 'この操作を行う権限がありません。', ephemeral: true });
      console.warn('ticket_rename denied', {
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      return;
    }
    const newName = interaction.options.getString('new_name', true);
    const sanitized = sanitizeChannelName(newName);
    if (!sanitized) {
      await interaction.reply({ content: '有効なチャンネル名を入力してください（英数字/ハイフン/アンダースコア）。', ephemeral: true });
      return;
    }
    await interaction.channel.setName(sanitized);
    await interaction.reply(`チャンネル名を \`${sanitized}\` に変更しました。`);
    console.info('ticket_rename success', {
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      newName: sanitized,
    });
  }
  } catch (error) {
    const errorId = logOperationError('interactionCreate', error, {
      interactionType: interaction.type,
      commandName: interaction.isChatInputCommand() ? interaction.commandName : null,
      customId: interaction.isButton() ? interaction.customId : null,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user?.id,
    });

    if (!interaction.isRepliable()) {
      return;
    }

    const errorMessage = `内部エラーが発生しました。管理者へ以下のエラーIDを共有してください: \`${errorId}\``;
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: errorMessage, ephemeral: true }).catch(() => null);
    } else {
      await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => null);
    }
  }
});



scheduleDailyDbBackup();
client.login(token).catch((error) => {
  console.error('Failed to login to Discord gateway.', error);
  process.exitCode = 1;
});
