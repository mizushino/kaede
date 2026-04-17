# 🍁 Kaede

GitHub Copilot SDK を利用した Discord AI エージェント。チャンネルやフォーラムスレッドで AI アシスタントと対話できます。

## ✨ 機能

- 💬 チャンネルでのメッセージ送受信
- 🖼️ 画像の添付・認識
- 📊 ステータス表示（ツール実行状態のリアルタイム更新）
- ⚡ イベント駆動型メッセージキューイング
- 🔀 `!model` コマンドによるモデルのランタイム切り替え
- 🧩 ホットリロード対応スキルシステム（AI が自らツールを作成・管理）
- 🔐 柔軟な権限管理（操作種別ごとの自動承認 / Discord リアクション承認）

## 🚀 セットアップ

### 1. Node.js のインストール

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
\. "$HOME/.nvm/nvm.sh"
nvm install 24
```

### 2. GitHub CLI のインストール

```sh
(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
    && sudo mkdir -p -m 755 /etc/apt/keyrings \
    && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && sudo mkdir -p -m 755 /etc/apt/sources.list.d \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && sudo apt update \
    && sudo apt install gh -y
```

### 3. リポジトリのクローン

```sh
git clone https://github.com/mizushino/kaede.git
cd kaede
```

### 4. 依存パッケージのインストール

```sh
npm install
```

### 5. 環境変数の設定

`.env.claude` をコピーして `.env.kaede` を作成:

```sh
cp .env.claude .env.kaede
```

```env
# Bot 設定
AGENT_NAME=agent                # エージェント名
COPILOT_MODEL=claude-sonnet-4.6 # 使用する AI モデル
REASONING_EFFORT=               # 推論レベル (low/medium/high/xhigh, 空=デフォルト)

# タイムアウト設定
WAIT_TIMEOUT_MS=600000          # メッセージ待機タイムアウト (default: 10min)
SESSION_TIMEOUT_MS=3600000      # セッションタイムアウト (default: 1hour)

# ディレクトリ設定 (起動時に自動作成)
WORKSPACE_DIR=./workspace       # AI の作業ディレクトリ（スキルは WORKSPACE_DIR/skills/ に配置）
TEMPORARY_DIR=./tmp             # 添付画像等の一時保存先

# 権限設定
PERMISSION_AUTO_APPROVE=*       # 自動承認する操作種別 (*=全て, 空=全て確認, カンマ区切りで個別指定)
                                # 種別: shell, write, read, url, mcp, custom-tool
USER_RESPONSE_TIMEOUT_MS=120000 # ユーザー承認待ちタイムアウト (default: 120s)

# Discord
DISCORD_BOT_TOKEN=your_bot_token_here

# GitHub
GITHUB_TOKEN=your_github_token_here
```

### 6. GitHub トークンの設定

[GitHub Personal Access Tokens](https://github.com/settings/personal-access-tokens/new) で新しいトークンを作成し、以下の権限を付与してください:

- **Copilot Chat**
- **Copilot Requests**

生成したトークンを `.env.kaede` の `GITHUB_TOKEN` に設定します。

### 7. Discord Bot の作成

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作成

**Bot 設定:**

2. 左メニューの **Bot** へ移動
3. **Message Content Intent** を **ON** にする
4. トークンをリセットして取得
5. 取得したトークンを `.env.kaede` の `DISCORD_BOT_TOKEN` に設定

**OAuth2 設定:**

6. 左メニューの **OAuth2** へ移動
7. スコープ → **bot** にチェック
8. テキスト権限（以下が必須）:
   - メッセージを送る
   - ファイルを添付
   - メッセージ履歴を読む
   - リアクションを付ける
9. 連携タイプ → **ギルドのインストール**
10. 生成された URL へアクセスして Bot をサーバーに追加

### 8. 起動

```sh
AGENT=kaede npm start
```

### 🤖 マルチエージェント

`AGENT` 環境変数で `.env.<name>` を読み込めます:

```bash
AGENT=claude npm start   # .env.claude を読み込んで起動
AGENT=gpt npm start      # .env.gpt を読み込んで起動

# package.json のショートカット
npm run claude
npm run gpt
```

エージェントごとに `.env.claude`, `.env.gpt` 等を用意し、`WORKSPACE_DIR` を分けることでスキルやファイルを隔離できます。

## 📁 プロジェクト構成

```
src/
├── index.ts              # エントリーポイント（起動・グレースフルシャットダウン）
├── core/
│   ├── agent.ts          # AI セッション管理（Copilot SDK 連携・リトライ）
│   ├── bot.ts            # Bot 基底クラス（チャンネルごとの Agent 管理）
│   ├── client.ts         # Copilot クライアント管理（遅延初期化・再接続）
│   ├── inbox.ts          # メッセージキュー（イベント駆動・タイムアウト）
│   ├── messenger.ts      # メッセージング抽象クラス（プラットフォーム共通ロジック）
│   ├── permissions.ts    # 権限管理（自動承認 / ユーザー確認）
│   ├── skills.ts         # スキルローダー（動的インポート・CRUD・ホットリロード）
│   ├── status.ts         # ステータスアイコンマップ（ツール名 → 絵文字）
│   └── tools.ts          # コアツール定義（send_message, get_messages 等）
└── discord/
    ├── bot.ts            # Discord Bot 実装（イベントハンドリング・画像DL）
    └── messenger.ts      # Discord Messenger 実装（リアクション承認・ステータス）
```

### 🏗️ アーキテクチャ

```
DiscordBot (discord/bot.ts)           ← Discord イベント受信
  └─ extends Bot (core/bot.ts)        ← チャンネルごとの Agent 管理
       ├─ CopilotClientManager        ← クライアントの遅延初期化・世代管理
       └─ Agent (core/agent.ts)       ← Copilot セッション・リトライ
            ├─ Inbox (core/inbox.ts)   ← メッセージキュー
            ├─ Tools (core/tools.ts)   ← コアツール群
            ├─ SkillLoader             ← スキルの動的読み込み
            └─ PermissionHandler       ← 操作の自動承認 / ユーザー確認

Messenger (core/messenger.ts)         ← プラットフォーム抽象化
  └─ DiscordMessenger (discord/messenger.ts)
```

プラットフォーム固有のコードは `discord/` に集約されており、`Messenger` 抽象クラスを実装すれば他のプラットフォームにも対応可能です。

## 🤖 エージェント初期設定（AGENTS.md）

AI の挙動・性格・ルールはワークスペースの `AGENTS.md` に記述することで制御できます。このファイルは Copilot SDK が自動的にシステムプロンプトに組み込みます。

### チャットで AGENTS.md を作る

ボットを起動後、チャット上で直接指示することで AGENTS.md を作成できます:

```
あなた自身の AGENTS.md を作ってください。
```

AI が `WORKSPACE_DIR/AGENTS.md` を作成します。その後も会話を通じて随時更新・改善していけます。

### AGENTS.md の例

```markdown
# My Agent — Instructions

## 基本ルール
- 返信は必ず send_message ツールを使う
- 返信後は必ず wait_messages を呼ぶ

## 性格
- 親しみやすく、丁寧に
- わからないことは正直に伝える

## 自己改善
気づいたことはこのファイルに追記する。
```

> **Note:** `.github/copilot-instructions.md` も同様に自動読み込みされます。プロジェクト共通のコーディング規約などはそちらに記述するのが一般的です。



Bot へのメンションが必要です（`@BotName !command`）。

| コマンド | 説明 |
|----------|------|
| `!reset` | 現在のセッションをリセット（会話履歴・CLI セッションを削除） |
| `!model <modelId> [effort]` | 使用モデルを切り替え（例: `!model claude-sonnet-4.6 high`） |
| `!model` | 現在のモデルと推論レベルを表示 |
| `!model list` | 利用可能なモデル一覧を表示（コンテキスト数・推論レベル対応含む） |

`effort` は `low` / `medium` / `high` / `xhigh` を指定可能。省略時はデフォルト値を使用します。

## 🛠️ AI ツール

### コアツール

| ツール | 説明 |
|--------|------|
| `send_message` | 💬 メッセージ送信（リプライ・画像添付対応、自動分割） |
| `get_messages` | 📨 チャンネルのメッセージ履歴取得 |
| `get_channels` | 📁 サーバーのチャンネル一覧取得 |
| `get_servers` | 🏠 Bot 参加サーバー一覧取得 |
| `wait_messages` | ⏳ 新着メッセージ待機（イベント駆動） |

AI は応答後 `wait_messages` を呼び出して新着を待ち、メッセージが来ると即座に処理を再開します。タイムアウト時はセッションが終了し、次のメッセージで新しいセッションが作成されます。

### スキル管理ツール

| ツール | 説明 |
|--------|------|
| `list_skills` | 🧩 インストール済みスキルの一覧 |
| `read_skill` | 📄 スキルファイルのソースコード表示 |
| `write_skill` | ✍️ スキルの作成・更新（.ts/.js/.mjs） |
| `delete_skill` | 🗑️ スキルの削除 |
| `run_skill` | 🚀 スキル内のツールを即時実行 |

### Copilot SDK 組み込みツール

Copilot SDK が提供するツール（`bash`, `view`, `create`, `edit`, `glob`, `grep`, `web_fetch` 等）も自動的に利用可能です。

## 🧩 スキルシステム

AI が自らツールを作成・管理できるホットリロード対応のプラグインシステムです。スキルファイルは `WORKSPACE_DIR/skills/` に配置され、セッション開始時に動的にインポートされます。

### スキルファイルの形式

```typescript
import { z } from 'zod';

export const name = 'my-skill';
export const description = 'スキルの説明';

export function createTools(ctx: any) {
  return [
    {
      name: 'my_tool',
      description: 'ツールの説明',
      parameters: z.object({ input: z.string() }),
      handler: async ({ input }) => {
        return { result: `Processed: ${input}` };
      },
    },
  ];
}
```

SDK への依存は不要で、`zod` のみ使用します。`write_skill` で書き込んだスキルは `run_skill` で即時実行でき、次回セッションからは自動的に読み込まれます。

## 🔐 権限管理

`PERMISSION_AUTO_APPROVE` 環境変数で操作の承認方式を制御します:

| 設定値 | 動作 |
|--------|------|
| `*` または未設定 | すべての操作を自動承認 |
| 空文字 | すべての操作でユーザー確認を要求 |
| `shell,write` | 指定した種別のみ自動承認、それ以外は確認 |

ユーザー確認が必要な場合、Discord 上で ✅ / ❌ リアクションによる承認フローが表示されます。
