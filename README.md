# 🍁 Kaede

GitHub Copilot SDK / Claude Agent SDK / Codex SDK / Gemini CLI (ACP) を利用した Discord AI エージェント。チャンネルやフォーラムスレッドで AI アシスタントと対話できます。

## ✨ 特徴

- 🎯 **Discord 徹底連携**: 画像認識、ステータス表示、リアクション承認、カスタムプロンプトコマンドなど、Discord の機能をフル活用した対話が可能です。
- 🧩 **自律的な拡張性**: ボット自身が自らツールを作成・実装する「関数システム」を搭載し、必要な機能を会話から追加できます。
- 📅 **スケジュール機能**: cron ベースのスケジューラを内蔵し、定期的なニュース巡回や定型タスクを自動で走らせられます。
- 🔁 **マルチ SDK 対応**: Copilot SDK / Claude Agent SDK / Codex SDK / Gemini CLI (ACP) をサポートし、用途に応じた最適なエージェントを選択できます。
- 🔀 **動的モデル切り替え**: `/model` コマンドで、対話中でも利用するモデルをワンタッチで切り替えられます。
- 🔐 **柔軟な権限管理**: 操作種別ごとの自動承認や、Discord リアクションによる対話的な承認をきめ細かく制御できます。
- 🌐 **マルチスコープ対応**: チャンネル単位／サーバー単位でセッションを使い分け、目的に応じた会話空間を構築できます。
- ⚡ **高効率メッセージング**: イベント駆動型のキューイングで、複数メッセージを取りこぼしなく順序通りに処理します。
- 💰 **圧倒的なコスト最適化**: 独自の仕組みにより、Copilot のリクエスト数を大幅に抑制します（※5月末までの限定機能）。

## 🚀 セットアップ

### 1. Node.js のインストール

👉 https://nodejs.org/ja/download

### 2. リポジトリのクローン

```sh
git clone https://github.com/mizushino/kaede.git
cd kaede
```

### 3. 依存パッケージのインストール

```sh
npm install
```

> **Note:** 各 Provider の SDK / CLI（`@github/copilot-sdk` / `@anthropic-ai/claude-agent-sdk` `@anthropic-ai/claude-code` / `@openai/codex-sdk` / `@agentclientprotocol/sdk` / `@google/gemini-cli`）は `optionalDependencies` として定義されています。`npm install` でも全部インストールされますが、利用しない Provider のインストールに失敗しても起動には影響しません。利用中の Provider に必要な依存が見つからない場合のみ、起動時にエラーが表示されます。
>
> 必要な SDK だけインストールしたい場合は、`npm install --omit=optional` の後に使う SDK だけ個別にインストールしてください。
>
> ```sh
> npm install --omit=optional
> npm install @github/copilot-sdk        # Copilot を使う場合
> # npm install @anthropic-ai/claude-agent-sdk @anthropic-ai/claude-code  # Claude を使う場合
> # npm install @openai/codex-sdk        # Codex を使う場合
> # npm install @agentclientprotocol/sdk @google/gemini-cli  # Gemini を使う場合
> ```

### 4. 環境変数の設定

#### Copilot を使用する場合
```sh
cp .env.example.copilot .env
```

#### Claude を使用する場合
```sh
cp .env.example.claude .env
```

#### Codex を使用する場合
```sh
cp .env.example.codex .env
```

#### Gemini を使用する場合
```sh
cp .env.example.gemini .env
```

### 5. AI Provider の認証設定

利用する Providerに応じて認証情報を設定します。詳細は下記の [🤖 AI Provider](#-ai-provider) セクションを参照してください。

### 6. Discord Bot の作成

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

### 7. 起動

```sh
npm start
```

## 🤖 AI Provider

Kaede は **GitHub Copilot SDK**、**Claude Agent SDK**、**Codex SDK**、**Gemini CLI (ACP)**、**汎用 ACP**（環境変数だけで任意の ACP 対応 CLI を接続）の 5 つの AI Provider に対応しています。`AGENT_PROVIDER` 環境変数で切り替えます。

| `AGENT_PROVIDER` | 実行方式 | 主なモデル環境変数 |
|------------------|----------|--------------------|
| `copilot`（デフォルト） | GitHub Copilot SDK | `AGENT_MODEL` |
| `claude` | Claude Agent SDK (`claude`) | `AGENT_MODEL` |
| `codex` | OpenAI Codex SDK (`codex`) | `AGENT_MODEL` |
| `gemini` | Gemini CLI (`gemini --acp`) | `AGENT_MODEL` |
| `acp` | 任意の ACP CLI（`ACP_COMMAND` で指定） | `AGENT_MODEL` |

### 切り替え方法

```sh
# .env で指定
AGENT_PROVIDER=claude

# または環境変数で直接
AGENT_PROVIDER=claude AGENT_MODEL=sonnet npm start
```

#### マルチエージェント（`.env.<name>` の読み込み）

`AGENT` 環境変数で `.env.<name>` を読み込めます。エージェントごとに `WORKSPACE_DIR` を分けることでプラグインやファイルを隔離できます。

```bash
AGENT=kaede npm start   # .env.kaede を読み込んで起動
```

#### AIツールを無効化する

トークン消費を抑えたい場合は、AIツールを無効化できます。どちらも既定は有効です。

| 環境変数 | 説明 |
|----------|------|
| `ENABLE_FUNCTION_TOOLS` | `0` / `false` で `list_funcs` / `read_func` / `write_func` / `delete_func` / `run_func` を無効にします |
| `ENABLE_SCHEDULE_TOOLS` | `0` / `false` で `add_schedule` / `list_schedules` / `remove_schedule` を無効にします |

```sh
ENABLE_FUNCTION_TOOLS=0
ENABLE_SCHEDULE_TOOLS=0
```

#### 応答モード（誰に反応するかを絞る）

すべてのメッセージに反応させずに、メンション・名前呼びかけ時だけ動かしたい場合に使います。

| 環境変数 | 説明 |
|----------|------|
| `RESPONSE_MODE` | `all`（既定: 全メッセージ） / `mention`（@メンション・リプライのみ） / `keyword`（メンション or キーワード一致） |
| `RESPONSE_KEYWORDS` | カンマ区切り、大文字小文字無視の部分一致。空の場合は `AGENT_NAME` を使用 |

`/response` スラッシュコマンドでチャンネルごとに上書きでき、`.kaede/<agent>/response.json` に保存されます。`mention` / `keyword` モードでも、自分への @メンションやリプライには常に反応します。

---

### 🐙 GitHub Copilot（`AGENT_PROVIDER=copilot`）

#### 認証

以下のいずれかの方法で認証します:

**方法 A: `npx copilot login`（推奨）**

Copilot CLI を起動して OAuth デバイスフローでログインします。トークンは OS のクレデンシャルストア（無ければ `~/.copilot/`）に保存されます。

```sh
npx copilot login
```

**方法 B: Personal Access Token**

[GitHub Personal Access Tokens](https://github.com/settings/personal-access-tokens/new) で新しいトークンを作成し、以下の権限を付与してください:

- **Copilot Chat**
- **Copilot Requests**

生成したトークンを `.env` の `GITHUB_TOKEN` に設定します。

#### BYOK（Bring Your Own Key）

GitHub Copilot の代わりに、任意のモデルプロバイダー（OpenAI, Azure OpenAI, Anthropic, Ollama など）を使用できます。`.env` に以下の環境変数を設定してください:

| 環境変数 | 必須 | 説明 |
|----------|------|------|
| `AGENT_MODEL` | ✅ | 使用するモデル識別子 |
| `COPILOT_PROVIDER_BASE_URL` | ✅ | モデルプロバイダーの API エンドポイント |
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
AGENT_MODEL=gpt-4o
```

**設定例（ローカル Ollama）:**

```sh
COPILOT_PROVIDER_BASE_URL=http://localhost:11434/v1
AGENT_MODEL=llama3
```

**エージェントごとにコンテキスト長を明示したい場合（例: `.env.yotsuba`）:**

```sh
AGENT_MODEL=Qwen3.6-27B
COPILOT_MAX_CONTEXT_WINDOW_TOKENS=262144
```

未指定の場合は、SDK / ランタイム側の既定値を使用します。

> **Note:** BYOK 使用時は `GITHUB_TOKEN` を設定しなくても動作します。`GITHUB_TOKEN` を設定した場合は GitHub 認証が優先されます。

---

### 🟣 Claude Agent（`AGENT_PROVIDER=claude`）

#### 認証

以下のいずれかの方法で認証します:

**方法 A: Claude Code でログイン済み**

Claude Code をインストールして起動し、ログインを済ませておけば、Claude Agent SDK は同じ認証情報を再利用します。

```sh
npx claude   # 起動して画面の指示に従いログイン
```

**方法 B: API キー**

Anthropic Console で発行した API キーを `.env` の `ANTHROPIC_API_KEY` に設定します。

```sh
ANTHROPIC_API_KEY=sk-ant-...
```

#### Claude 関連の環境変数

| 環境変数 | 説明 |
|----------|------|
| `AGENT_MODEL` | 使用するモデル（例: `sonnet`, `opus`） |
| `AGENT_REASONING_EFFORT` | Claude の思考レベル（`low` / `medium` / `high` / `xhigh`）。SDK の `effort` オプションへ渡されます |
| `CLAUDE_COMMAND` | Claude Code 実行ファイルのパスまたはコマンド（既定: SDK 同梱の glibc/musl native binary を自動選択） |
| `CLAUDE_ARGS` | Claude Agent SDK から Claude Code に追加する引数 |
| `CLAUDE_PERMISSION_MODE` | Claude Agent SDK の permission mode（既定: `bypassPermissions`） |
| `CLAUDE_ALLOWED_TOOLS` | Claude Agent SDK に渡す auto-allow ツール一覧（カンマ区切り） |
| `CLAUDE_DISALLOWED_TOOLS` | Claude Agent SDK で禁止するツール一覧（カンマ区切り、既定で `AskUserQuestion` を含む） |

---

### 🟢 Codex Agent（`AGENT_PROVIDER=codex`）

#### 認証

OpenAI Codex CLI を `npx codex login` で認証済みであれば、Codex SDK は同じ認証情報を再利用します。`CODEX_API_KEY` を `.env` に設定して直接認証することもできます。

#### Codex 関連の環境変数

| 環境変数 | 説明 |
|----------|------|
| `AGENT_MODEL` | 使用するモデル（例: `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.3-codex`） |
| `AGENT_REASONING_EFFORT` | Codex の思考レベル（`minimal` / `low` / `medium` / `high` / `xhigh`） |
| `CODEX_MODELS` | `/models` の一覧表示で使う候補をカンマ区切りで上書き（既定: `gpt-5.5,gpt-5.4,gpt-5.4-mini,gpt-5.3-codex,gpt-5.3-codex-spark,gpt-5.2`） |
| `CODEX_API_KEY` | Codex 用 API キー（`npx codex login` 済みなら不要） |
| `CODEX_BASE_URL` | カスタム OpenAI 互換エンドポイント |
| `CODEX_PATH` | `codex` 実行ファイルのパス（既定: SDK 同梱の native binary を自動選択） |
| `CODEX_SANDBOX_MODE` | サンドボックス（`read-only` / `workspace-write` / `danger-full-access`、既定: `workspace-write`） |
| `CODEX_APPROVAL_POLICY` | 承認ポリシー（`never` / `on-failure`、既定: `never`） |
| `CODEX_NETWORK_DISABLED` | 設定するとサンドボックス内のネットワークを無効化 |
| `CODEX_WEB_SEARCH_DISABLED` | 設定すると組み込みウェブ検索を無効化 |
| `CODEX_AUTO_COMPACT_TOKEN_LIMIT` | Codex の自動コンパクト閾値をトークン数で直接指定（例: `140000`） |
| `CODEX_CONFIG_JSON` | 追加の `--config` を JSON で注入（トップレベルの TOML キーへ展開） |

#### ⚠️ 承認モデルの注意

Codex SDK には Claude / Copilot のような外部承認コールバックが用意されていません。そのため `CODEX_APPROVAL_POLICY=on-request` や `untrusted` を設定すると、codex CLI が stdin で承認待ちになりボットが応答を返せなくなります。これを避けるため、本実装では `on-request` / `untrusted` が指定されても自動的に `never` にフォールバックし、警告ログを出します。承認制御が必要な場合は `CODEX_SANDBOX_MODE` を `read-only` にする等で代替してください。

---

### 🔷 Gemini CLI（`AGENT_PROVIDER=gemini`）

#### 認証

Gemini provider は **Gemini CLI を ACP server として起動**し、Discord 操作は同梱の MCP サーバー経由で実行します。

- **方法 A: `gemini` でログイン済み**  
  `npx gemini` を一度起動して Google アカウントでログインしておくと、その認証情報を再利用します。Google One AI Premium / Code Assist など、CLI 側で使える契約もそのまま活かせます。
- **方法 B: API キー**  
  `GEMINI_API_KEY` を `.env` に設定すると API キー認証で動かせます。

```sh
npx gemini   # 起動して画面の指示に従いログイン
```

#### Gemini 関連の環境変数

| 環境変数 | 説明 |
|----------|------|
| `AGENT_MODEL` | 使用するモデル（空なら Gemini CLI の既定） |
| `GEMINI_COMMAND` | `gemini` 実行ファイルのパスまたはコマンド（既定: `node_modules/.bin/gemini` → `PATH` 上の `gemini`） |
| `GEMINI_ARGS` | Gemini CLI に追加する引数（`--acp` は自動付与） |
| `GEMINI_APPROVAL_MODE` | ACP の session mode（`default` / `auto-edit` / `yolo` / `plan`、既定: `default`） |
| `GEMINI_CLI_TRUST_WORKSPACE` | headless 実行時の trust ダイアログをスキップ（既定: `true`） |
| `GEMINI_API_KEY` | API キー認証を使う場合の Gemini API キー |
| `GEMINI_CLI_HOME` | Gemini CLI の設定 / ログイン情報の保存先を切り替える場合に指定 |

> **Note:** Gemini provider は ACP の file-system proxy を使うため、`WORKSPACE_DIR` に加えてリポジトリルートと `TEMPORARY_DIR` もセッションの追加ワークスペースとして公開します。

### 🤖 汎用 ACP（`AGENT_PROVIDER=acp`）

任意の ACP（Agent Client Protocol）対応 CLI を、専用 provider クラスを書かずに環境変数だけで接続できる汎用 provider です。

#### ACP 関連の環境変数

| 環境変数 | 説明 |
|----------|------|
| `ACP_COMMAND` | **必須**。ACP CLI の実行ファイルパス |
| `ACP_ARGS` | CLI に渡す引数（スペース区切り、既定: `--acp`） |
| `ACP_NAME` | provider のスラグ名（既定: `acp`） |
| `ACP_DISPLAY_NAME` | 表示名（既定: `ACP`） |
| `ACP_ICON` | ステータスアイコン絵文字（既定: 🤖） |
| `ACP_STATE_SUBDIR` | セッション状態の保存先サブディレクトリ（既定: `acp-sessions`） |
| `ACP_APPROVAL_MODE` | 初期セッションモード（既定: `default`） |
| `ACP_CONTEXT_WINDOW` | コンテキストウィンドウのトークン数（既定: 1,048,576） |
| `ACP_PROMPT_HEADING` | 権限プロンプトの見出し |
| `ACP_AUTH_ERROR_MATCH` | 致命的な認証エラーと判定する部分文字列（既定: `authentication`） |
| `ACP_ENV_<NAME>` | CLI に追加で渡す環境変数（プレフィックスは除去されます） |

## 🌐 セッションスコープ

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

## 🔄 PM2 によるプロセス管理

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
│   ├── claude_agent.ts   # Claude 用 Agent ラッパー（MCP 経由で Discord 操作）
│   ├── codex.ts          # Codex SDK 実装
│   ├── codex_agent.ts    # Codex 用 Agent ラッパー（MCP 経由で Discord 操作）
│   ├── gemini.ts         # Gemini CLI / ACP 実装
│   ├── gemini_agent.ts   # Gemini 用 Agent ラッパー（MCP 経由で Discord 操作）
│   ├── acp.ts            # ACP 共通基底クラス（接続/セッション/権限/ファイルIO）
│   ├── acp_agent.ts      # ACP 用 Agent ラッパー（McpAgent を継承）
│   ├── acp_generic.ts    # 環境変数駆動の汎用 ACP provider
│   └── acp_generic_agent.ts # 汎用 ACP Agent ラッパー
├── discord/
│   ├── bot.ts            # Discord Bot 実装（イベントハンドリング・画像DL）
│   └── messenger.ts      # Discord Messenger 実装（リアクション承認・ステータス）
└── mcp/
    └── server.ts         # Discord 操作用 stdio MCP サーバー（Claude / Codex / Gemini provider が利用）
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
             ├─ ClaudeAgent  (providers/claude_agent.ts)
             │    └─ ClaudeCodeProvider    ← Claude Agent SDK ラップ（resume/effort/MCP）
             ├─ CodexAgent   (providers/codex_agent.ts)
             │    └─ CodexCodeProvider     ← Codex SDK ラップ（thread/MCP）
             └─ GeminiAgent  (providers/gemini_agent.ts)
                  └─ GeminiCodeProvider    ← Gemini CLI (ACP) ラップ（session/MCP）
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


## ⌨️ スラッシュコマンド

Discord のスラッシュコマンドとして利用できます。

| コマンド | 説明 |
|----------|------|
| `/clear` | 現在のセッションをリセット（会話履歴・CLI セッションを削除） |
| `/response status` / `set <mode>` / `reset` | チャンネルごとの応答モードを表示・上書き・解除（`all` / `mention` / `keyword`） |
| `/stats [days]` | リクエスト利用統計を表示（`days` で日数指定、1〜90、デフォルト 7） |
| `/context` | 現在のコンテキストウィンドウ使用量を表示（Copilot / Claude Agent SDK 両対応。1ターン以上やり取り後に利用可能） |
| `/restart [env]` | Bot プロセスを再起動（`env` 指定で `.env.<name>` に切り替え可能） |
| `/model set <model_id> [effort]` | 使用モデルを切り替え（Copilot 例: `/model set claude-sonnet-4.6 high` / Claude 例: `/model set sonnet high`） |
| `/model get` | 現在のモデルと推論レベルを表示 |
| `/model list` | 利用可能なモデル一覧を表示（Copilot はコスト含む / Claude は対応 effort 含む） |
| `/schedule add <cron> <channel> <prompt> [description]` | 定期実行スケジュールを登録 |
| `/schedule list` | 登録済みスケジュール一覧を表示 |
| `/schedule remove <id>` | スケジュールを削除 |
| `/schedule toggle <id>` | スケジュールの有効/無効を切り替え |

`effort` は `low` / `medium` / `high` / `xhigh` を指定可能。省略時はデフォルト値を使用します。

### カスタムプロンプトコマンド

デフォルトでは`{WORKSPACE_DIR}/prompts/`（及び `{WORKSPACE_DIR}/.github/prompts/`）内に存在する`.prompt.md` ファイルをファイル名でスラッシュコマンドとして自動登録します。`PROMPTS_DIR` を指定した場合はそのディレクトリだけを使います。

**プロンプトファイルの形式:**

```md
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

自然言語で「毎朝9時にニュースをまとめて」と伝えると、AI がcron式に変換してスケジュール登録します。スケジュールは `.kaede/<agent>/schedules.json` に永続化され、再起動後も自動復元されます。

### 関数管理ツール

| ツール | 説明 |
|--------|------|
| `list_funcs` | 🧩 インストール済み関数の一覧 |
| `read_func` | 📄 関数ファイルのソースコード表示 |
| `write_func` | ✍️ 関数の作成・更新（.ts/.js/.mjs） |
| `delete_func` | 🗑️ 関数の削除 |
| `run_func` | 🚀 関数内のツールを即時実行 |

### Copilot SDK / Claude Agent SDK 組み込みツール

各 SDK / CLI が提供する組み込みツール（`bash`, `view` / `Read`, `create` / `Write`, `edit`, `glob`, `grep`, `web_fetch` / `WebFetch` 等）も自動的に利用可能です。Claude / Codex / Gemini provider では Discord 操作は同梱の MCP サーバー（`mcp__discord__*`）経由で行われます。

## 🧩 関数システム

AI が自らツールを作成・管理できるホットリロード対応の関数システムです。関数ファイルは `WORKSPACE_DIR/functions/` に配置され、セッション開始時に動的にインポートされます。

### 関数ファイルの形式

```ts
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
