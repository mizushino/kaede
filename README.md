# 🍁 Kaede

GitHub Copilot SDK / Claude Agent SDK を利用した Discord AI エージェント。チャンネルやフォーラムスレッドで AI アシスタントと対話できます。

## ✨ 機能

- 💬 チャンネルでのメッセージ送受信
- 🖼️ 画像の添付・認識
- 📊 ステータス表示（ツール実行状態のリアルタイム更新）
- ⚡ イベント駆動型メッセージキューイング
- 🔁 `AI_PROVIDER` による Copilot SDK / Claude Agent SDK 切り替え
- 🔀 `/model` コマンドによるモデルのランタイム切り替え
- 🧩 ホットリロード対応プラグインシステム（AI が自らツールを作成・管理）
- 📝 カスタムプロンプトコマンド（`.prompt.md` ファイルで自動登録）
- 🔐 柔軟な権限管理（操作種別ごとの自動承認 / Discord リアクション承認）
- 🌐 セッションスコープ切り替え（チャンネル単位 / サーバー単位）
- 📅 cronベースのスケジュール実行（定期タスクの自動実行）

## 🚀 セットアップ

### 1. Node.js のインストール

👉 https://nodejs.org/ja/download

### 2. Agent Clientのインストール

(GitHubCopilot) GitHub CLI のインストール
👉 https://github.com/cli/cli#installation

(ClaudeCode) Claude Code のインストール
👉 https://code.claude.com/docs/ja/overview

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

`.env.claude`または`.env.copilot` をコピーして `.env` を作成:

```sh
cp .env.claude .env
```

### 6. AI Provider の認証設定

利用する Provider に応じて、以下のいずれかを設定してください。

#### GitHub Copilot を使う場合（`AI_PROVIDER=copilot`）

以下のいずれかの方法で認証します:

**方法 A: Personal Access Token（推奨）**

[GitHub Personal Access Tokens](https://github.com/settings/personal-access-tokens/new) で新しいトークンを作成し、以下の権限を付与してください:

- **Copilot Chat**
- **Copilot Requests**

生成したトークンを `.env` の `GITHUB_TOKEN` に設定します。

**方法 B: `gh auth login`**

`gh` CLI でログイン済みであれば、Copilot SDK はその認証情報を自動で利用できます。

> ⚠️ **注意:** `gh auth login` の標準フローではアカウント全体の権限（リポジトリ操作・Issue・PR など）が `gh` に付与されます。最小権限で運用したい場合は方法 A（Copilot Chat / Copilot Requests のみの PAT）を推奨します。

#### Claude を使う場合（`AI_PROVIDER=claude`）

以下のいずれかの方法で認証します:

**方法 A: Claude Code でログイン済み**

Claude Codeをインストールして起動し、ログインを済ませておけば、Claude Agent SDK は同じ認証情報を再利用します。

```sh
claude   # 起動して画面の指示に従いログイン
```

**方法 B: API キー**

Anthropic Console で発行した API キーを `.env` の `ANTHROPIC_API_KEY` に設定します。

```sh
ANTHROPIC_API_KEY=sk-ant-...
```

### 7. Discord Bot の作成

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作成

**Bot 設定:**

2. 左メニューの **Bot** へ移動
3. **Message Content Intent** を **ON** にする
4. トークンをリセットして取得
5. 取得したトークンを `.env` の `DISCORD_BOT_TOKEN` に設定

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
npm start
```

### 🤖 マルチエージェント

`AGENT` 環境変数で `.env.<name>` を読み込めます:

```bash
AGENT=kaede npm start   # .env.kaede を読み込んで起動

# package.json のショートカット
npm run copilot         # GitHub Copilot SDK 経由で Copilot を起動
npm run claude          # Claude Agent SDK 経由で Claude を起動
```

エージェントごとに `.env.copilot`, `.env.claude` 等を用意し、`WORKSPACE_DIR` を分けることでプラグインやファイルを隔離できます。

### 🔁 AI Provider の切り替え

既定では GitHub Copilot SDK を使用します。Claude を使う場合は `AI_PROVIDER=claude` を設定してください。Claude は Claude Agent SDK で永続セッションを再開します。

| `AI_PROVIDER` | 実行方式 | 主なモデル環境変数 |
|---------------|----------|--------------------|
| `copilot`（デフォルト） | GitHub Copilot SDK | `COPILOT_MODEL` |
| `claude` | Claude Agent SDK (`claude`) | `CLAUDE_MODEL` |

```sh
# Claude Agent SDK
AI_PROVIDER=claude CLAUDE_MODEL=sonnet npm start
```

Claude provider は Discord MCP ツール（例: `mcp__discord__send_message`）を使って返信します。このリポジトリには MCP サーバーも同梱しており、Claude Agent SDK 側へ毎回 MCP server 設定を注入します。

```sh
npm run --silent mcp
```

MCP server は作業ディレクトリをこのリポジトリにして、コマンド `npm run --silent mcp` で起動されます。`npm run` の通常出力は stdio MCP のハンドシェイクを壊すため、`--silent` を付ける必要があります。Claude は SDK 側で同じ MCP server を毎回構成します。Claude Code のパスや追加引数は以下で調整できます。

| 環境変数 | 説明 |
|----------|------|
| `CLAUDE_COMMAND` | Claude Code 実行ファイルのパスまたはコマンド（既定: SDK 同梱の glibc/musl native binary を自動選択） |
| `CLAUDE_ARGS` | Claude Agent SDK から Claude Code に追加する引数 |
| `CLAUDE_PERMISSION_MODE` | Claude Agent SDK の permission mode（既定: `bypassPermissions`） |
| `CLAUDE_ALLOWED_TOOLS` | Claude Agent SDK に渡す auto-allow ツール一覧（カンマ区切り） |
| `CLAUDE_DISALLOWED_TOOLS` | Claude Agent SDK で禁止するツール一覧（カンマ区切り、既定で `AskUserQuestion` を含む） |
| `REASONING_EFFORT` | Claude の思考レベル（`low` / `medium` / `high` / `xhigh`）。SDK の `effort` オプションへ渡されます |

### 🌐 セッションスコープ

`SESSION_SCOPE` 環境変数でセッションの共有範囲を切り替えられます:

| 設定値 | 動作 |
|--------|------|
| `channel`（デフォルト） | チャンネルごとに独立したセッション。各チャンネルが別々の会話を持つ |
| `server` | サーバー全体で 1 つのセッションを共有。どのチャンネルで話しても同じ会話の続き |

```sh
# .env に追加
SESSION_SCOPE=server
```

`server` モードでは、Bot はサーバー内のどのチャンネルからメッセージを受けても同一のセッション（会話履歴）を使用します。タイピング表示やステータスは、最後にメッセージを受信したチャンネルに表示されます。

### 🔑 BYOK（Bring Your Own Key）

GitHub Copilot の代わりに、任意のモデルプロバイダー（OpenAI, Azure OpenAI, Anthropic, Ollama など）を使用できます。

`.env` に以下の環境変数を設定してください:

| 環境変数 | 必須 | 説明 |
|----------|------|------|
| `COPILOT_PROVIDER_BASE_URL` | ✅ | モデルプロバイダーの API エンドポイント |
| `COPILOT_MODEL` | ✅ | 使用するモデル識別子 |
| `COPILOT_PROVIDER_TYPE` | - | プロバイダーの種類: `openai`（デフォルト）, `azure`, `anthropic` |
| `COPILOT_PROVIDER_API_KEY` | - | プロバイダーの API キー（Ollama などローカルプロバイダーには不要） |
| `COPILOT_MAX_CONTEXT_WINDOW_TOKENS` | - | オープンモデルなどでコンテキスト長を明示したい場合の上書き値 |
| `COPILOT_BACKGROUND_COMPACTION_THRESHOLD` | - | バックグラウンド compaction を開始する使用率（0〜1） |
| `COPILOT_BUFFER_EXHAUSTION_THRESHOLD` | - | compaction 完了待ちに入る使用率（0〜1） |

**設定例（OpenAI）:**

```sh
COPILOT_PROVIDER_BASE_URL=https://api.openai.com/v1
COPILOT_PROVIDER_TYPE=openai
COPILOT_PROVIDER_API_KEY=sk-...
COPILOT_MODEL=gpt-4o
```

**設定例（ローカル Ollama）:**

```sh
COPILOT_PROVIDER_BASE_URL=http://localhost:11434/v1
COPILOT_MODEL=llama3
```

**エージェントごとにコンテキスト長を明示したい場合（例: `.env.yotsuba`）:**

```sh
COPILOT_MODEL=Qwen3.6-27B
COPILOT_MAX_CONTEXT_WINDOW_TOKENS=262144
```

未指定の場合は、SDK / ランタイム側の既定値を使用します。

> **Note:** BYOK 使用時は `GITHUB_TOKEN` を設定しなくても動作します。`GITHUB_TOKEN` を設定した場合は GitHub 認証が優先されます。

### 🔄 PM2 によるプロセス管理

[PM2](https://pm2.keymetrics.io/) を使うと、Bot をバックグラウンドで常駐させ、クラッシュ時の自動再起動やシステム起動時の自動起動が可能になります。

```sh
# PM2 のインストール
npm install -g pm2

# システム起動時の自動起動を設定
pm2 startup

# Bot を起動
pm2 start ecosystem.config.cjs

# 現在のプロセスリストを保存（再起動時に自動復元）
pm2 save

# ログの確認
pm2 logs kaede
```

マルチエージェント構成の場合は、`ecosystem.config.cjs` に複数のアプリ定義を追加してください。

## 📁 プロジェクト構成

```
src/
├── index.ts              # エントリーポイント（起動・グレースフルシャットダウン）
├── core/
│   ├── bot.ts            # Bot 基底クラス（チャンネル/サーバーごとの Agent 管理・provider 切替）
│   ├── client.ts         # Copilot クライアント管理（遅延初期化・再接続）
│   ├── messenger.ts      # メッセージング抽象クラス（プラットフォーム共通ロジック）
│   ├── inbox.ts          # メッセージキュー（イベント駆動・タイムアウト）
│   ├── permissions.ts    # 権限管理（自動承認 / ユーザー確認）
│   ├── functions.ts      # 関数ローダー（動的インポート・CRUD・ホットリロード）
│   ├── prompts.ts        # `.prompt.md` ローダー（カスタムスラッシュコマンド）
│   ├── scheduler.ts      # cronスケジューラー（定期タスク管理・JSON永続化）
│   ├── counter.ts        # リクエスト回数カウンター（永続化）
│   ├── queue_state.ts    # 保留メッセージ・未送信返信のスナップショット永続化
│   ├── tool_contract.ts  # Discord MCP ツール名の共有定義
│   ├── tools.ts          # Copilot SDK 向けコアツール定義
│   ├── status.ts         # ステータスアイコンマップ（ツール名 → 絵文字）
│   └── logger.ts         # シンプルなログユーティリティ
├── providers/
│   ├── provider.ts       # BaseProvider 抽象クラス（ステータス整形・env 構築・ツール名/詳細/elicitation 共通化）
│   ├── base_agent.ts     # BaseAgent 抽象クラス（共通の処理ループ・retry スケルトン・dispose 骨格）
│   ├── index.ts          # provider のエクスポート集約
│   ├── copilot.ts        # GitHub Copilot SDK 実装
│   ├── copilot_agent.ts  # Copilot 用 Agent ラッパー（ToolContext 実装）
│   ├── claude.ts         # Claude Agent SDK 実装（モデル一覧/effort/binary 解決）
│   └── claude_agent.ts   # Claude 用 Agent ラッパー（MCP 経由で Discord 操作）
├── discord/
│   ├── bot.ts            # Discord Bot 実装（イベントハンドリング・画像DL）
│   └── messenger.ts      # Discord Messenger 実装（リアクション承認・ステータス）
└── mcp/
    └── server.ts         # Discord 操作用 stdio MCP サーバー（Claude provider が利用）
```

### 🏗️ アーキテクチャ

```
DiscordBot (discord/bot.ts)               ← Discord イベント受信
  └─ extends Bot (core/bot.ts)            ← チャンネル/サーバーごとの Agent 管理
       ├─ CopilotClientManager            ← Copilot クライアントの遅延初期化・世代管理
       ├─ Scheduler                       ← cronベースの定期タスク管理
       └─ Agent (provider 切替, BaseAgent を継承)
            ├─ CopilotAgent (providers/copilot_agent.ts)
            │    └─ CopilotCodeProvider   ← Copilot セッション・リトライ・関数呼び出し
            │         ├─ Inbox / Tools / FunctionLoader
            │         └─ PermissionHandler
            └─ ClaudeAgent  (providers/claude_agent.ts)
                 └─ ClaudeCodeProvider    ← Claude Agent SDK ラップ（resume/effort/MCP）
                      └─ Discord MCP server (mcp/server.ts)

Messenger (core/messenger.ts)             ← プラットフォーム抽象化
  └─ DiscordMessenger (discord/messenger.ts)
```

プラットフォーム固有のコードは `discord/` に集約されており、`Messenger` 抽象クラスを実装すれば他のプラットフォームにも対応可能です。AI provider は `providers/` 配下で `BaseProvider` を継承する形で追加できます。

## 🤖 エージェント初期設定（AGENTS.md）

AI の挙動・性格・ルールはワークスペースの `AGENTS.md` に記述することで制御できます。Copilot SDK / Claude Agent SDK のいずれも、このファイルを自動的にシステムプロンプトに組み込みます。

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



## ⌨️ スラッシュコマンド

Discord のスラッシュコマンドとして利用できます。

| コマンド | 説明 |
|----------|------|
| `/clear` | 現在のセッションをリセット（会話履歴・CLI セッションを削除） |
| `/model set <model_id> [effort]` | 使用モデルを切り替え（Copilot 例: `/model set claude-sonnet-4.6 high` / Claude 例: `/model set sonnet high`） |
| `/model get` | 現在のモデルと推論レベルを表示 |
| `/model list` | 利用可能なモデル一覧を表示（Copilot はコスト含む / Claude は対応 effort 含む） |
| `/schedule add <cron> <channel> <prompt> [description]` | 定期実行スケジュールを登録 |
| `/schedule list` | 登録済みスケジュール一覧を表示 |
| `/schedule remove <id>` | スケジュールを削除 |
| `/schedule toggle <id>` | スケジュールの有効/無効を切り替え |

`effort` は `low` / `medium` / `high` / `xhigh` を指定可能。省略時はデフォルト値を使用します。

### カスタムプロンプトコマンド

`{WORKSPACE_DIR}/.github/prompts/` に `.prompt.md` ファイルを配置すると、ファイル名でスラッシュコマンドとして自動登録されます。

**プロンプトファイルの形式:**

```markdown
---
name: hello
description: Greet the user with a friendly message
argument-hint: Optional greeting style
---

Hello! I'm your AI assistant. How can I help you today?
```

- `name`: コマンド名（ファイル名が使われますが、上書き可能）
- `description`: コマンドの説明（Discord で表示）
- `argument-hint`: 引数の説明（省略可能、デフォルト: "Additional context or arguments"）

**例:**

- `hello.prompt.md` → `/hello` コマンドとして登録
- `/hello [args]` で実行 → プロンプト内容に `args` を追加してAIに送信

## 🛠️ AI ツール

### コアツール

| ツール | 説明 |
|--------|------|
| `send_message` | 💬 メッセージ送信（リプライ・画像添付対応、自動分割） |
| `get_messages` | 📨 チャンネルのメッセージ履歴取得 |
| `get_channels` | 📁 サーバーのチャンネル一覧取得 |
| `wait_messages` | ⏳ 新着メッセージ待機（イベント駆動） |

AI は応答後 `wait_messages` を呼び出して新着を待ち、メッセージが来ると即座に処理を再開します。タイムアウト時はセッションが終了し、次のメッセージで新しいセッションが作成されます。

### スケジュール管理ツール

| ツール | 説明 |
|--------|------|
| `add_schedule` | 📅 cronスケジュールの登録（タイムゾーン: Asia/Tokyo） |
| `list_schedules` | 📋 登録済みスケジュールの一覧表示 |
| `remove_schedule` | 🗑️ スケジュールの削除 |
| `toggle_schedule` | ⏯️ スケジュールの有効/無効切り替え |

自然言語で「毎朝9時にニュースをまとめて」と伝えると、AI がcron式に変換してスケジュール登録します。スケジュールは `workspace/schedules.json` に永続化され、再起動後も自動復元されます。

### 関数（Function）管理ツール

| ツール | 説明 |
|--------|------|
| `list_funcs` | 🧩 インストール済み関数の一覧 |
| `read_func` | 📄 関数ファイルのソースコード表示 |
| `write_func` | ✍️ 関数の作成・更新（.ts/.js/.mjs） |
| `delete_func` | 🗑️ 関数の削除 |
| `run_func` | 🚀 関数内のツールを即時実行 |

### Copilot SDK / Claude Agent SDK 組み込みツール

各 SDK が提供する組み込みツール（`bash`, `view` / `Read`, `create` / `Write`, `edit`, `glob`, `grep`, `web_fetch` / `WebFetch` 等）も自動的に利用可能です。Claude provider では Discord 操作は同梱の MCP サーバー（`mcp__discord__*`）経由で行われます。

## 🧩 関数（Function）システム

AI が自らツールを作成・管理できるホットリロード対応の関数システムです。関数ファイルは `WORKSPACE_DIR/functions/` に配置され、セッション開始時に動的にインポートされます。

### 関数ファイルの形式

```typescript
import { z } from 'zod';

export const name = 'my-function';
export const description = '関数の説明';

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

SDK への依存は不要で、`zod` のみ使用します。`write_func` で書き込んだ関数は `run_func` で即時実行でき、次回セッションからは自動的に読み込まれます。

## 🔐 権限管理

`PERMISSION_AUTO_APPROVE` 環境変数で操作の承認方式を制御します:

| 設定値 | 動作 |
|--------|------|
| `*` または未設定 | すべての操作を自動承認 |
| 空文字 | すべての操作でユーザー確認を要求 |
| `shell,write` | 指定した種別のみ自動承認、それ以外は確認 |

ユーザー確認が必要な場合、Discord 上で ✅ / ❌ リアクションによる承認フローが表示されます。
