# Server_Bot

Server_Bot は、Discord サーバーのチャンネル管理・チケット運用・一時ボイスチャンネル（Join to Create）・ロール管理などを行う Discord Bot です。

初めて使う人でも導入しやすいように、この README では **準備 → 起動 → 基本設定 → よく使う機能** の順で説明します。

## 目次

- [できること](#できること)
- [必要なもの](#必要なもの)
- [Discord Developer Portal 側の準備](#discord-developer-portal-側の準備)
- [インストールと起動](#インストールと起動)
- [環境変数](#環境変数)
- [データ保存とバックアップ](#データ保存とバックアップ)
- [初回セットアップ例](#初回セットアップ例)
- [主なコマンド](#主なコマンド)
- [一時VC / Join to Create の使い方](#一時vc--join-to-create-の使い方)
- [運用・トラブル対応](#運用トラブル対応)
- [権限なしユーザーが使えるコマンド](#権限なしユーザーが使えるコマンド)
- [ライセンス / 配布ポリシー](#ライセンス--配布ポリシー)

## できること

- スラッシュコマンド（`/`）で Bot を操作できます。
- チャンネルのロック、非表示、名前変更、削除、権限変更などを管理できます。
- チケットパネルを作成し、問い合わせ用チャンネルを運用できます。
- Join to Create 方式で、一時ボイスチャンネルを自動作成・自動削除できます。
- 空の一時VCが残った場合の自動掃除・手動掃除・状態診断ができます。
- ボイスチャンネル参加通知（`/voicelink`）を設定できます。
- ウェルカムメッセージ、自動ロール、ボタンロール、リアクションロールなどを管理できます。
- SQLite に設定やチケット情報を保存します。

## 必要なもの

- Node.js 20 以上
- npm
- Discord Bot Token
- Bot を追加する Discord サーバー
- Bot に必要な権限を付与できる Discord アカウント

## Discord Developer Portal 側の準備

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作成します。
2. **Bot** ページで Bot を作成し、Token を取得します。
3. Bot の **Privileged Gateway Intents** で以下を有効にしてください。
   - Server Members Intent
   - Message Content Intent
4. Bot 招待時は、少なくとも以下の権限を付与してください。
   - Manage Channels
   - Manage Roles
   - Manage Messages
   - View Channels
   - Send Messages
   - Read Message History
   - Connect / Move Members（ボイス機能を使う場合）
   - Create Public Threads / Manage Threads（自動スレッドを使う場合）

> 権限が不足していると、一部コマンドが失敗します。まずはテストサーバーで動作確認することをおすすめします。

## インストールと起動

```bash
npm install
```

`.env` を作成し、最低限 `DISCORD_TOKEN` を設定します。

```env
DISCORD_TOKEN=ここにBotTokenを入力
```

構文チェック:

```bash
npm run check
```

起動:

```bash
npm start
```

スラッシュコマンドの反映を早くしたい場合は、`.env` に `GUILD_ID` を設定してください。未設定の場合はグローバルコマンドとして登録され、反映に時間がかかる場合があります。

```env
GUILD_ID=テストまたは運用サーバーのID
```

## 環境変数

| 変数名 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | はい | なし | Discord Bot Token |
| `GUILD_ID` | いいえ | なし | 指定するとそのサーバーにギルドコマンドとして即時登録しやすくなります |
| `LOG_CHANNEL_ID` | いいえ | なし | console ログを転送するテキストチャンネルID |
| `DB_PATH` | いいえ | `data/{guild_id}/channelbot.db` | SQLite DB の保存先。`{guild_id}` を使うとサーバーごとに分離できます |
| `DB_DAILY_BACKUP_ENABLED` | いいえ | `true` | `false` で日次DBバックアップを無効化 |
| `DB_DAILY_BACKUP_TIME_UTC` | いいえ | なし | 日次バックアップ時刻。`HH:mm` UTC 形式。未指定なら自動バックアップなし |
| `DB_DAILY_BACKUP_DIR` | いいえ | `data/backups` | バックアップ保存先 |
| `DB_DAILY_BACKUP_RETENTION_DAYS` | いいえ | `14` | バックアップ保持日数 |
| `TEMP_CHANNEL_CLEANUP_INTERVAL_MS` | いいえ | `900000` | 一時VC定期掃除間隔。既定は15分 |
| `TEMP_VOICE_CONFIG_CACHE_TTL_MS` | いいえ | `30000` | 一時VC設定キャッシュTTL。既定は30秒 |
| `VOICE_LINK_CACHE_TTL_MS` | いいえ | `30000` | ボイスリンク設定キャッシュTTL。既定は30秒 |

### `.env` の例

```env
DISCORD_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx
GUILD_ID=123456789012345678
LOG_CHANNEL_ID=123456789012345678
DB_PATH=data/{guild_id}/channelbot.db
DB_DAILY_BACKUP_ENABLED=true
DB_DAILY_BACKUP_TIME_UTC=18:30
DB_DAILY_BACKUP_DIR=data/backups
DB_DAILY_BACKUP_RETENTION_DAYS=14
TEMP_CHANNEL_CLEANUP_INTERVAL_MS=900000
```

## データ保存とバックアップ

### DB 保存先

既定では、サーバーごとに DB ファイルを分けます。

```text
data/{guild_id}/channelbot.db
```

例: サーバーIDが `1234567890` の場合

```text
data/1234567890/channelbot.db
```

Docker や VPS で運用する場合、`data/` ディレクトリが消えると設定も消えます。必ず永続ボリュームやバックアップ対象にしてください。

### 日次バックアップ

`DB_DAILY_BACKUP_TIME_UTC` を指定すると、日次バックアップが有効になります。

```env
DB_DAILY_BACKUP_TIME_UTC=18:30
```

古いバックアップは `DB_DAILY_BACKUP_RETENTION_DAYS` の日数に応じて削除されます。

## 初回セットアップ例

### 1. Bot を起動する

```bash
npm start
```

### 2. Discord 側で `/ping` を実行する

Bot が応答すれば起動できています。

### 3. ヘルプを確認する

```text
/help
```

### 4. 必要な機能を設定する

例:

```text
/jointocreate action:設定 voice_channel:作成元VC category:作成先カテゴリ name_prefix:VC
/tempchannels action:設定確認
/ticket_panel
```

## 主なコマンド

### 基本

| コマンド | 説明 |
| --- | --- |
| `/ping` | Bot の疎通確認 |
| `/help` | コマンド一覧や使い方を表示 |
| `/invite` | Bot 招待案内 |
| `/support` | サポート案内 |
| `/privacy` | プライバシー案内 |
| `/dashboard` | ダッシュボード案内 |

### チャンネル管理

| コマンド | 説明 |
| --- | --- |
| `/lock` / `/unlock` | チャンネルの発言をロック/解除 |
| `/hide` / `/show` | チャンネルを非表示/再表示 |
| `/slowmode` | 低速モード設定 |
| `/settopic` | チャンネルトピック設定 |
| `/rename` | チャンネル名変更 |
| `/purge` | メッセージ一括削除 |
| `/createchannel` | チャンネル作成 |
| `/clone` | チャンネル複製 |
| `/delete` | チャンネル削除 |
| `/move` | チャンネルをカテゴリーへ移動 |
| `/archive` / `/archivedcat` | アーカイブ先カテゴリー運用 |
| `/setbitrate` | VC ビットレート変更 |
| `/addperm` / `/clearperm` / `/delperm` | チャンネル権限設定 |
| `/addpermall` / `/clearpermall` / `/delpermall` | 複数チャンネル権限設定 |

### 一時VC / ボイス

| コマンド | 説明 |
| --- | --- |
| `/jointocreate` | Join to Create の起点VCを設定/削除/一覧表示 |
| `/tempchannels` | 一時VC機能の有効化、無効化、設定確認、状態診断、手動掃除 |
| `/voicelink` | VC参加通知をテキストチャンネルへ紐付け |
| `/play` | VCアクティビティ開始とキュー操作 |

### チケット

| コマンド | 説明 |
| --- | --- |
| `/ticket_panel` | チケット作成パネルを設置 |
| `/ticket_close` | チケットをクローズ |
| `/ticket_delete` | チケット削除 |
| `/ticket_add` | チケットにユーザー追加 |
| `/ticket_remove` | チケットからユーザー削除 |
| `/ticket_rename` | チケットチャンネル名変更 |

### ロール / メンバー

| コマンド | 説明 |
| --- | --- |
| `/autorole` | 参加時自動ロール設定 |
| `/defaultroles` | 新規参加者ロール設定 |
| `/mods` | モデレーターロール設定 |
| `/mentionable` | ロールのメンション可否切替 |
| `/buttonroles` | ボタンロール投稿作成 |
| `/reactionroles` | リアクションロール投稿作成 |
| `/role` | ロール付与/解除 |
| `/roleall` | 全員へロール一括付与/解除 |
| `/resetrole` | ユーザーロールリセット |

### サーバー設定 / 情報

| コマンド | 説明 |
| --- | --- |
| `/settings` | 保存設定の閲覧/更新/全削除 |
| `/backup` | ギルド設定のバックアップ作成/復元 |
| `/serverinfo` | サーバー情報表示 |
| `/channelinfo` | チャンネル情報表示 |
| `/userinfo` | ユーザー情報表示 |
| `/roleinfo` | ロール情報表示 |
| `/permissions` | 権限状態確認 |
| `/stats` | Bot/サーバー統計表示 |
| `/premium` | プレミアム状態の確認/変更 |

### その他

| コマンド | 説明 |
| --- | --- |
| `/welcome` | ウェルカムメッセージ設定 |
| `/sticky` | スティッキーメッセージ管理 |
| `/autothread` | 自動スレッド作成設定 |
| `/setsuggestion` | 提案チャンネル設定 |
| `/suggestionwhitelist` | 提案投稿の許可ロール管理 |
| `/suggestemojis` | 提案投票絵文字設定 |
| `/addemoji` / `/delemoji` | カスタム絵文字追加/削除 |
| `/emojilock` | カスタム絵文字利用制限 |
| `/imageonly` | 画像専用チャンネル切替 |
| `/autopublish` | アナウンスチャンネル自動公開設定 |
| `/disable` / `/enable` / `/disabledlist` | コマンド無効化管理 |

## 一時VC / Join to Create の使い方

一時VCは「ユーザーが指定VCに参加すると、専用VCを自動作成して移動する」機能です。作成されたVCが空になると自動削除されます。

### 1. 起点VCを作成する

Discord 上で、例として `➕ VC作成` というボイスチャンネルを作ります。

### 2. 起点VCを登録する

```text
/jointocreate action:設定 voice_channel:➕ VC作成 category:作成先カテゴリ name_prefix:VC
```

- `voice_channel`: ユーザーが入る起点VC
- `category`: 自動作成VCの作成先カテゴリー。未指定ならサーバールート
- `name_prefix`: 作成されるVC名の先頭文字。未指定なら `VC`

### 3. 設定確認

```text
/tempchannels action:設定確認
```

### 4. 状態診断

```text
/tempchannels action:状態診断
```

以下のような情報を確認できます。

- 機能が有効か
- 起点VC数
- 保存中の一時VCメタデータ数
- 削除再試行待ち数
- キャッシュ状態
- 掃除/削除/作成/通知のカウンター
- 直近削除エラー


### 一時VCロック

Join to Create で作成された一時VCでは、作成者本人または Discord の `Administrator` 権限を持つユーザーだけがロック操作を実行できます。常設VCには適用されません。

| コマンド | 説明 |
| --- | --- |
| `/vc-lock` | 一時VCを入室禁止にします（VCは見えるが入室不可） |
| `/vc-hidden` | 一時VCを非表示にします（一般ユーザーから見えない） |
| `/vc-unlock` | 一時VCのロックを解除します |
| `/vc-lock-status` | ロック状態、作成者不在状態、自動解除までの残り時間を表示します |
| `/vc-invite user:@ユーザー` | ロック/非表示中の一時VCへ指定ユーザーを招待し、DMでVCリンクを送信します |
| `/vc-kick user:@ユーザー` | 指定ユーザーの一時VC個別権限を削除し、@everyone 権限に戻して、接続中ならVCから強制退出させます |

- `/vc-lock` と `/vc-hidden` は同時に有効になりません。片方が有効な状態でもう片方を実行すると、後から実行した方式へ切り替わります。
- `/vc-hidden` でも作成者本人はVCを見失わないよう、作成時点で作成者に個別の表示/入室権限を付与します。
- `/vc-invite` はサーバー内の指定ユーザーへ個別の表示/入室権限を付与します。自分自身は招待できません。既に招待済みの場合は権限を再設定せず、DMでVCリンクを再送します。DM送信に失敗した場合でも権限付与は維持され、実行者へ直接連絡用のVCリンクURLを表示します。
- `/vc-kick` はサーバー内の指定ユーザーの個別権限上書きを削除するため、対象ユーザーは現在の `@everyone` 権限に戻ります。対象ユーザーがその一時VCへ接続中の場合はVCから強制退出させます。個別権限がないユーザーを指定した場合は、その旨を通知します。
- `/vc-kick` の強制退出には、Bot に対象ユーザーをボイスチャンネルから切断できる権限とロール位置が必要です。権限不足などで強制退出に失敗した場合でも、個別権限の削除に成功していればその結果は維持されます。
- 作成者が対象VCから抜けて10分戻らない場合、`/vc-lock` または `/vc-hidden` による制限は自動解除され、VC作成時の権限継承状態に戻ります。
- `/tempchannels action:空VC掃除` は、空の一時VCだけでなく不要な一時VCロックメタデータも整理します。

### 5. 手動掃除

障害やメンテナンス後に空の一時VCが残った場合は、手動で掃除できます。

```text
/tempchannels action:空VC掃除
```

### 6. 無効化

```text
/tempchannels action:無効化
```

## 運用・トラブル対応

### Bot が反応しない

- `DISCORD_TOKEN` が正しいか確認してください。
- Bot がサーバーに参加しているか確認してください。
- Developer Portal で必要な Intents が有効か確認してください。
- `npm run check` で構文エラーがないか確認してください。

### スラッシュコマンドが出ない

- `.env` に `GUILD_ID` を設定して再起動すると、対象サーバーへ反映されやすくなります。
- グローバルコマンドは反映に時間がかかることがあります。

### 一時VCが消えない

1. `/tempchannels action:状態診断` を実行します。
2. 削除再試行待ちや直近削除エラーを確認します。
3. `/tempchannels action:空VC掃除` を実行します。
4. Bot に `Manage Channels` 権限があるか確認します。
5. `LOG_CHANNEL_ID` を設定している場合は、ログチャンネルのエラーも確認します。

### 設定変更のログを残したい

`LOG_CHANNEL_ID` を設定すると、console ログが指定チャンネルへ転送されます。`/jointocreate`、`/tempchannels`、`/voicelink` の設定変更もログに出ます。

### 8万人規模など大規模サーバーでの注意

- 一時VC設定とボイスリンク設定は短時間キャッシュされ、DB/API負荷を抑えています。
- `TEMP_VOICE_CONFIG_CACHE_TTL_MS` と `VOICE_LINK_CACHE_TTL_MS` を短くしすぎると DB 読み込みが増えます。
- `TEMP_CHANNEL_CLEANUP_INTERVAL_MS` を短くしすぎると定期掃除の頻度が増えます。通常は既定の15分で十分です。
- `data/` は永続ストレージに置いてください。DB が消えると設定も消えます。

## 権限なしユーザーが使えるコマンド

ここでの「権限なしユーザー」は、Manage Guild / Manage Channels / Manage Roles などの管理系権限を持たない一般ユーザーを指します。

- `/ping`
- `/help`
- `/invite`
- `/support`
- `/privacy`
- `/dashboard`
- `/serverinfo`
- `/channelinfo`
- `/userinfo`
- `/roleinfo`
- `/permissions`

サーバー設定変更、チャンネル管理、チケット管理、ロール一括操作などは管理系権限が必要です。

## 開発用コマンド

```bash
npm run check
```

`src/index.js` の構文チェックを行います。

```bash
npm run discord:checklist
```

Discord 上で手動確認するためのコマンドチェックリストを出力します。

## ライセンス / 配布ポリシー

- 本リポジトリは **利用フリー / 再配布禁止** 方針です。
- 個人・法人を問わず利用や改変は可能ですが、再配布（公開・共有・販売を含む）は禁止です。
- 再配布が必要な場合は、事前に著作権者の書面許可を取得してください。
- 依存ライブラリのライセンス表示義務がある場合は、各ライブラリの条件に従ってください。
