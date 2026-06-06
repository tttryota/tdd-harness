# ハーネス アーキテクチャ仕様

## 概要

開発ハーネスは、Claude Code CLI（`claude -p`）と Codex CLI を subprocess で呼び出し、TDD サイクルとコードレビューを自動化するオーケストレーター。TypeScript で実装し、Node.js 22 の type stripping で直接実行する。

## 設計判断

### Agent SDK 不採用

Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）は `ANTHROPIC_API_KEY` が必須であり、サブスクリプション（Pro/Max）の OAuth 認証では使用できない。2026年2月に Anthropic が「OAuth は Claude Code と claude.ai 専用」と明確化したため、`claude -p` を subprocess 経由で呼び出す方式を採用。

### Codex SDK 不採用

Codex SDK（`@openai/codex-sdk`）は `codex` CLI をラップする高水準 API だが、ハーネスが必要とする制御粒度とは合わなかった。ハーネス側では以下を runner の責務として明示的に扱いたい:

- stdio 上の生 JSON-RPC 通知をそのまま transcript に残すこと
- detached review thread を通常 turn と分けて制御すること
- request 単位の timeout / close / pending request cleanup を自前で管理すること
- app-server からの protocol 変化を SDK 抽象越しではなく transport 層で直接吸収すること

そのため、SDK の `Thread.run()` 抽象には乗らず、`codex app-server --listen stdio://` に対して軽量な transport / service 層を自前実装する方式を採用した。

### Node.js type stripping

`tsx` パッケージを使わず、Node.js 22.18+ のネイティブ type stripping で `.ts` ファイルを直接実行する。以下の制約がある:

- `enum` 禁止 → `as const` + union 型
- パラメータプロパティ禁止（`constructor(public x)`）
- `import type` で型のみの import を明示
- `tsconfig.json` に `erasableSyntaxOnly: true` を設定

## ファイル構成

```
.harness/src/
├── cli/
│   ├── harness.ts           # CLI エントリポイント
│   └── interactive.ts       # 対話的ランナー割り当て
├── application/
│   ├── diagnostics/         # benchmark-summary / benchmark-diagnose
│   ├── flows/               # design / impl / component / page
│   └── review/              # lint-guard / drift-guard / review-orchestrator
├── domain/
│   ├── model/               # steps / types
│   └── services/            # boundary / plan-parser
└── infrastructure/
    ├── config/              # 設定読み込み・検証
    ├── logging/             # JSONL ログ
    ├── process/             # spawn / launcher
    ├── runners/             # claude / codex / generic / registry / step-context
    ├── templates/           # resources/templates の解決ロジック
    └── skills/              # resources/skills の同期・配布
    └── tooling/             # lint / test adapter
```

## コンポーネント詳細

### boundary.ts — 境界制御

全てのパス検証・ファイル探索はこのモジュールを通す。

**パス検証**:
- `assertWithinProject(path)`: symlink 解決 + 最寄り祖先の realpath + プロジェクトルート境界チェック
- `validatePathSegment(segment)`: `..`, `/`, 空文字, CLIメタ文字（`,)()*?\`）を拒否
- `validateScope(scope)`: `カテゴリ/名前` 形式を強制 + 各セグメントを検証

**ファイル探索**:
- `findPythonFiles(scope)`: `backend/{category}/` と `backend/{category}/tests/` から `.py` ファイルを探索。symlink ディレクトリ・ファイルの境界チェック付き。失敗は fail-closed
- `testPathForScope(scope)`: `backend/{category}/tests` を返す（テストは各カテゴリ内に配置）
- `scopeAllowedTools(scope)`: Claude の Write/Edit を `backend/{category}/*` に限定するパターン生成（テストディレクトリも含む）

**変更検証**:
- `verifyChangedFilesWithinScope(scope)`: `git diff` + `git ls-files --others` でスコープ外変更を検出。許可プレフィクスは `backend/{category}/` と `.harness/reviews/`。git 失敗は fail-closed

**ガード**:
- `implementationGuard(plan)`: 仕様書・テストケースの存在・承認・scope 妥当性を一括検証

### claude-runner.ts — Claude CLI ラッパー

`claude -p` を spawn で呼び出す。prompt は stdin 経由、system prompt は一時ファイル経由（E2BIG 防止）。

- `is_error` フィールドをチェック（exit 0 でも内部エラーを検出）
- 一時ファイルは親ディレクトリごと `rmSync` で削除

### logger.ts — 構造化ログ

- JSONL 形式でイベントを記録
- `taskName` のパストラバーサル防止（`.` `/` `\` を `_` に置換）
- redact パターン: Anthropic, OpenAI, GitHub PAT, AWS, Slack トークン等
- `baseDir` は呼び出し側から絶対パスで指定（cwd 依存を排除）

### lint-guard.ts — リンター強制

- `ruff format` → `ruff check --fix` → `ruff check` → `mypy --strict`
- ゼロ違反を強制。3回リトライで収束しなければ DriftError
- `ruff format` 失敗は即エラー
- `mypy` 非ゼロ終了 + violations 空 = 設定エラーとして即エラー
- `ENOENT`（コマンド未導入）は即エラー

### コード品質保証の役割分担

コード品質のチェックは **ruff/mypy による機械チェック** と **LLM によるセルフレビュー** の 2 層で行う。両者の責務は明確に分離されている。

**ruff/mypy（機械チェック）— 規約の強制**

確定的に検出できるルール違反を担当。pyproject.toml で設定。

| ルール | 対応する規約 |
|--------|-------------|
| N (pep8-naming) | 命名規則（PascalCase, snake_case 等） |
| PLR0913 (max-args=4) | 引数4つ以内 |
| PLR0915 (max-statements=20) | 関数の文数制限（30行以内の近似） |
| C901 (max-complexity=10) | 関数の複雑度 |
| BLE (blind-except) | bare except 禁止 |
| EM (errmsg) | エラーメッセージの品質 |
| FLY (flynt) | f-string 推奨 |
| S (bandit) | セキュリティ |

**LLM セルフレビュー — 設計判断のチェック**

機械で検出できない意味的なルール違反を担当。`.harness/resources/criteria/review-criteria-*.md` がチェックリスト。

- 変数名の省略形（`msg` → `message` 等。ruff N は PEP8 準拠のみで意味的省略は検出できない）
- マジックナンバー（ruff にマジックナンバー検出ルールはない）
- 1 関数 1 責務（複雑度では測れない責務の混在）
- エラーの握り潰し（catch して何もしない。bare except とは異なる）
- 仕様書との整合性（機械チェック不可能）

**なぜ分離するか**

1. 機械チェックはトークンコスト $0 で確定的。LLM に委ねると見落としや非決定性が発生する
2. LLM レビューの責務を絞ることで、1 回のレビューでの網羅性が向上する
3. 機械チェックで弾けるものを LLM に渡すと、指摘の小出し → 収束遅延の原因になる

### drift-guard.ts — 迷走検知

| シグナル | 閾値 |
|---|---|
| 同一テストリトライ | 3回 |
| 同一エラー連続 | 3回（MD5ハッシュで比較） |
| タスク経過時間 | 15分 |
| ファイル巻き戻し | 2回 |
| diff行数 | 期待スコープ × 3（テストケース数 × 30行で動的推定） |

エスカレーション:
1. Level 1: 別アプローチ指示（harness が claude -p に指示）
2. Level 2: Codex に相談（レート制限時スキップ）
3. Level 3: DriftError を throw → 人間にエスカレーション

### review-orchestrator.ts — レビュー制御

**テストレビュー（テスト生成後、RED確認前）— 2ステップ:**
1. テスト品質チェック（テストケース文書との整合性、テスト膨張チェック）
2. Codex レビュー（テストデータの妥当性）

**実装レビュー（GREEN確認後）— 3ステップ:**
1. セルフレビュー（レビュー観点チェック）
2. セルフレビュー（仕様書との整合性チェック）
3. Codex レビュー（タイムアウト20分）

**Codex 使用不可時のフォールバック:**
- 2体並列レビュー + 突合（テスト/実装どちらも同じ）

**レビューサイクルの収束制御**:
- 各ステップ最大 5 サイクルまでリトライ（MAX_REVIEW_CYCLES=5）
- critical/major が消えた後、minor のみが 2 サイクル連続した場合は第三者判断工程に入る
- レビュープロンプトにスコープ制約を含む: テストケース網羅性の指摘禁止（design フェーズの責務）、レビュー観点外のリファクタ提案禁止

**minor 指摘の第三者判断**:
- 修正を試みた Claude セッションとは別の新しい claude -p で許容可否を判断
- safe=true → accepted として記録し次のステップへ
- safe=false → 修正を再試行（1回のみ）→ 解消すれば fixed、残存すれば escalated
- 自己正当化を避けるため、修正した Claude 自身には許容理由を生成させない

**レビュー結果パース**:
- コードフェンス除去 → `JSON.parse` 直接試行 → 非 greedy 正規表現フォールバック
- schema validation: `issues` が配列であること + 各要素の型検証
- 不正要素あり + 有効指摘 0 件 = fail-closed（LGTM にしない）
- パース失敗 = critical 扱い + エスカレーション（自動修正に進まない）

**修正プロンプト**:
- severity に応じて制約を変更（major/critical はバグ修正として振る舞い変更を許可）
- `scopeAllowedTools` は必須パラメータ（未指定は型エラー）

**突合ロジック（2体レビュー時）:**
- critical/major: 片方でも指摘すれば修正対象
- minor: 両方が同じ description で指摘した場合のみ修正対象

### design-flow.ts — Design Flow

- 仕様書・テストケースの生成
- 既に存在するファイルはスキップ（冪等性）
- allowedTools をディレクトリ限定（`Write(docs/spec/{category}/*)` 等）
- プロンプトに出力先パスと featureName を明示

### impl-flow.ts — Impl Flow

- 計画ファイル読み込み → ガード → テスト生成 → RED確認 → 実装 → GREEN確認 → レビュー
- GREEN リトライループ（最大3回、毎回最新の失敗ログを渡す）
- DriftGuard の `expectedScopeLines` をテストケース数 × 30行で動的推定
- スコープ外変更の事後検証
- **レビューレポート自動生成**: impl フロー完了時に `.harness/reviews/{date}_{scope}.md` を出力

### レビューレポート生成

impl フロー完了時に、レビューサイクルの全記録から人間が読める MD レポートを自動生成する。

**データ収集**:
- `review-orchestrator.ts` がレビュー中に `ReviewRecord[]` をメモリに蓄積
- 各レコードに `findings` / `decision` / `diffBefore` / `diffAfter` を保持する

**設計判断の記録**:
- 計画ファイルの `## 設計判断` セクションから読み取り
- 「対応しなかった指摘」としてレポートに記載

**出力**:
- `.harness/reviews/{date}_{scope}.md` — git 管理対象の MD レポート
- `logs/*/review-data.json` — レポート生成の元データ（.gitignore 対象）

**型定義**:
```typescript
type ReviewRecord = {
  step: string;           // "self_criteria" | "self_quality" | "codex" | "agent_a" | "agent_b"
  cycle: number;
  reviewer: string;
  findings: ReviewIssue[];
  decision: "fixed" | "accepted" | "escalated" | "lgtm";
  diffBefore: string;
  diffAfter: string;
};
```

## 設計上の意図的な限界

1. **scope のカテゴリ単位拡大**: lint/test はカテゴリ全体で走る。Claude の Write/Edit は allowedTools で制限。
2. **ログの収集範囲**: 正規表現ベースの redact。全形式の網羅は不可能。個人ツール + .gitignore で受容。
