# Harness

LLM CLI を使った TDD 自動化オーケストレーター。
Claude Code / Codex App Server / GitHub Copilot CLI など任意の LLM 実行系をプラガブルに差し替え可能。

## AI First

ローカル LLM にこのハーネスを扱わせるときは、まずこの README を読ませる。
追加で必要になったら次も読む。

- `/.harness/docs/setup-guide.md`
- `/.harness/docs/architecture.md`
- `/.harness/resources/skills/`

## セットアップ

前提条件:
- Node.js 22.18+
- `claude` CLI が PATH に存在（external review などで使う場合）
- プロジェクトに応じた lint/test ツール（Python: ruff + mypy + pytest、TypeScript: eslint + tsc + vitest）

この repo では `./.harness/bin/harness` が実行入口。

セットアップガイドを表示:
```bash
./.harness/bin/harness init
```

配布用 skill を `.codex/skills/` と `.claude/skills/` に同期:
```bash
./.harness/bin/harness sync-skills
```

## 設定

設定ファイルの追跡対象は `.harness/config/harness.example.yml` です。実運用ではこれを `.harness/config/harness.yml` にコピーして使います。

```bash
cp .harness/config/harness.example.yml .harness/config/harness.yml
```

実際に読み込む設定ファイルは `.harness/config/harness.yml` です:

### プロファイル

```yaml
profiles:
  backend:
    flow: full
    fallbackRunner: codex
    steps:
      test_generate: codex
      test_self_quality: codex
      test_external_review: claude
      impl_generate: codex
      impl_self_criteria: codex
      impl_self_quality: codex
      impl_external_review: claude
      lint_fix: codex
      apply_fixes: codex
      judgment_summary: codex
      judge_minor: codex
      spec_generate: codex
      test_case_generate: codex
      component_generate: codex
      component_self_review: codex
      page_generate: codex
      page_review_design: codex
      page_review_behavior: codex
      page_review_code: codex
      page_browser_verify: codex
    lint: [ruff, mypy]
    test: pytest
    toolRoot: backend
    criteriaPreset: backend
    context:
      defaultAgent: harness-backend-general
      defaultSkills: [harness-backend-core]
      stepOverrides:
        impl_generate:
          agent: harness-backend-impl
          skills: [harness-backend-impl, harness-backend-failure-modes]
        impl_self_criteria:
          agent: harness-backend-reviewer
          skills: [harness-backend-review-criteria]
        impl_self_quality:
          agent: harness-backend-reviewer
          skills: [harness-backend-review-quality]
        impl_external_review:
          agent: harness-backend-reviewer
          model: claude-opus-4-6
          skills: [harness-backend-review-quality]
    sourceLayout:
      sourceDir: "backend/{{category}}"
      testDir: "backend/{{category}}/tests"
      scopePattern: "backend/{{category}}/*"
    designLayout:
      specDir: "docs/spec/backend/{{category}}"
      testCaseDir: "tests/test-cases/backend/{{category}}"
  frontend:
    flow: full
    fallbackRunner: codex
    steps:
      test_generate: codex
      test_self_quality: codex
      test_external_review: claude
      impl_generate: codex
      impl_self_criteria: codex
      impl_self_quality: codex
      impl_external_review: claude
      lint_fix: codex
      apply_fixes: codex
      judgment_summary: codex
      judge_minor: codex
      spec_generate: codex
      test_case_generate: codex
      component_generate: codex
      component_self_review: codex
      page_generate: codex
      page_review_design: codex
      page_review_behavior: codex
      page_review_code: codex
      page_browser_verify: codex
    lint: [eslint, tsc]
    test: vitest
    toolRoot: frontend
    criteriaPreset: frontend
    sourceLayout:
      sourceDir: "frontend/src/{{category}}/{{name}}"
      testDir: "frontend/src/{{category}}/{{name}}/__tests__"
      scopePattern: "frontend/src/{{category}}/{{name}}/*"
      additionalAllowedPrefixes: [".harness/reviews/", "frontend/src/mocks/handlers/"]
    designLayout:
      specDir: "docs/spec/frontend/{{category}}"
      testCaseDir: "tests/test-cases/frontend/{{category}}"
    storybook:
      renderCommand: ["pnpm", "storybook", "build", "--test", "--docs", "--output-dir", ".storybook-static-{{target}}"]
      smokeCommand: ["pnpm", "storybook", "test", "--stories-json", "{{storyFile}}"]
```

### ランナー

```yaml
runners:
  claude:
    type: claude
  claude-opus-review:
    type: claude
    model: claude-opus-4-6
  codex:
    type: codex
    sandbox: read-only
  copilot:
    type: generic
    command: gh
    args: ["copilot"]
    promptFlag: "--prompt"
```

`profile` は lint / test / sourceLayout / designLayout だけでなく `flow` / `fallbackRunner` / `steps` / `context` まで含む実行単位です。runner の切り替えは `profiles.<name>.steps` で行います。`runners.<name>.model` は runner のデフォルト、`profile.context.stepOverrides.<step>.model` はその step 専用の上書きです。

`lint` は文字列配列に加えて、追加引数付きのオブジェクト形式も使えます。RED フェーズでのみ一時的に緩和したい lint がある場合に使います。

```yaml
lint:
  - name: ruff
    args: ["--ignore", "BLE001"]
  - name: mypy
    args: ["--disable-error-code", "call-arg"]
```

project-local skill は `.codex/skills/<name>/SKILL.md` を優先して読み込み、存在しない場合のみ `.claude/skills/<name>/SKILL.md` を後方互換で参照します。

`.harness/config/harness.yml` に `profiles` が定義されていない場合はエラーになる。`./.harness/bin/harness init` でセットアップガイドを表示できる。

## 使い方

### Design Flow（仕様書・テストケース生成）

```bash
./.harness/bin/harness design ingestion/chunk-splitter "Markdownをチャンク分割する機能"
./.harness/bin/harness design --profile backend ingestion/chunk-splitter "Markdownをチャンク分割する機能"
```

1. 仕様書を生成（既定: `docs/spec/{category}/{name}.md`。`designLayout.specDir` 設定時はその配下）
   テンプレートは `spec-template` を使う。project override は `.harness/resources/templates/spec-template.md` または `templates.spec-template` で行う
2. 人間が確認し、必要なら修正後に再実行して `status: ready` にする
3. 再実行するとテストケースを生成
   テンプレートは `test-case-template` を使う。project override は `.harness/resources/templates/test-case-template.md` または `templates.test-case-template` で行う
4. 人間が確認し、必要なら修正後に再実行して `status: ready` にする

### Impl Flow（TDD 実装）

```bash
./.harness/bin/harness impl plan/current-task.md
```

実行前に対話的にステップごとのランナー割り当てを確認・変更できる:

```
フロー: full
ステップ割り当て:
  1. test_generate: claude
  2. test_self_quality: claude
  3. test_external_review: codex
  ...

変更するステップ番号を入力 (Enter でそのまま実行):
```

#### フロー

| ステップ | full | light |
|---|---|---|
| テスト生成 | o | o |
| テストセルフレビュー | o | o |
| テスト外部レビュー | o | 省略 |
| RED 確認 | o | o |
| 実装生成 | o | o |
| GREEN 確認 | o | o |
| 実装セルフレビュー(criteria) | o | o |
| 実装セルフレビュー(quality) | o | o |
| 実装外部レビュー | o | 省略 |

```bash
# light フロー
./.harness/bin/harness impl plan/task.md --flow light

# 対話プロンプトをスキップ
./.harness/bin/harness impl plan/task.md --no-interactive

# チェックポイントから再開
./.harness/bin/harness impl plan/task.md --resume
```

```bash
./.harness/bin/harness component plan/components-task.md
./.harness/bin/harness page plan/page-task.md
```

### Page Flow（Page UI 実装）

```bash
./.harness/bin/harness page plan/page-task.md
```

- page 実装を生成
- lint / typecheck / page テストを実行
- 3観点レビュー（design / behavior / code quality）を最大5サイクル実行
- Browser Verification を最後に1回実行
- fail した場合は修正後にレビューへ戻る

### Component Flow（Component + Story 実装）

```bash
./.harness/bin/harness component plan/components-task.md
```

- `Targets` を 1 件ずつ順に処理
- component と Story を同時生成
- lint / typecheck / configured Storybook render + smoke / セルフレビューを実行
- target ごとに最大 2 回修正
- 終了時に `未収束 target: N` を標準出力へ表示
- Storybook コマンドは `profile.storybook.renderCommand` / `smokeCommand` で指定する
- 利用可能な変数: `{{target}}`, `{{storyFile}}`, `{{toolRoot}}`

## 計画ファイルのフォーマット

```markdown
---
profile: backend
scope: ingestion/chunk-splitter
spec: docs/spec/backend/ingestion/chunk-splitter.md
test_cases: tests/test-cases/backend/ingestion/chunk-splitter.md
---

## 今回やること
chunk-splitter の Phase 1 を実装する

## 対象テストケース
- TC-01: 空ファイルを渡すと空リストが返る
- TC-02: 見出しなしファイルは1チャンクになる

## やらないこと
- Phase 2以降

## 完了条件
- 上記テストが GREEN
- lint パス

## 設計判断
- カテゴリ単位のlint拡大は import 解決のため許容
```

profile が 1 つだけの場合は frontmatter の `profile:` を省略可能。

### plan の運用ルール

- `対象テストケース` は 1 行に 1 件ずつ列挙する
- `TC-01, TC-02` のように 1 行へまとめない
- `targetTestCases.length` が impl フローの diff_scope 見積もりに使われるため、圧縮記法にすると閾値が不自然に小さくなる

例:

```markdown
## 対象テストケース
- TC-01: 単一チャンクを1件の結果へ再構成する
- TC-02: 空バッチは短絡成功
- TC-03: 永続化失敗時は既定例外を送出する
```

## design フロー生成物のレビュー観点

テストケース仕様書を `ready` にする前に、各 TC の `期待結果` に検証粒度が明示されていることを確認する。

- ログ検証:
  - イベント名
  - 必須キーと期待値
  - 件数制約: `ちょうど1件` / `少なくとも1件` / `件数は問わない`
  - 追加キー許容の有無
- 例外検証:
  - 例外型
  - `message`
  - `cause chain`
  - ログ記録方法 (`exc_info` など) のうち何を確認するか
- 値検証:
  - `完全一致` / `含まれる` / `存在確認` のどれか

検証粒度が曖昧なまま impl に進むと、`review-test-quality` が同じ論点で厳しさを振り子させ、レビューが収束しにくくなる。

## scope の命名規則

`カテゴリ/名前` 形式（例: `ingestion/chunk-splitter`）。
英数字とハイフンのみ使用可能。

## 利用可能なツール

### lint adapter

| 名前 | runtime | filePass | 説明 |
|---|---|---|---|
| ruff | python | files | Python linter/formatter |
| mypy | python | files | Python 型チェッカー |
| eslint | node | files | JavaScript/TypeScript linter |
| tsc | node | project | TypeScript 型チェッカー |

### test adapter

| 名前 | runtime | 説明 |
|---|---|---|
| pytest | python | Python テストフレームワーク |
| vitest | node | JavaScript/TypeScript テストフレームワーク |

## アーキテクチャ

```
harness（CLI エントリポイント）
  ├── cli/（entrypoint と対話 UI）
  ├── application/
  │   ├── flows/（design / impl / component / page）
  │   ├── review/（lint-guard / drift-guard / review-orchestrator）
  │   └── diagnostics/（benchmark-summary / benchmark-diagnose）
  ├── domain/
  │   ├── model/（steps / types）
  │   └── services/（boundary / plan-parser）
  └── infrastructure/
      ├── config/（.harness/config/harness.yml 読み込み + profile 解決）
      ├── runners/（claude / codex / generic / registry / codex-app-server）
      ├── logging/（JSONL 構造化ログ + redact）
      ├── process/（spawn / launcher）
      ├── resources/（criteria / templates / rules / skills）
      └── tooling/（lint / test adapter）
```

## レビュー観点のカスタマイズ

レビュープロンプトはテンプレートファイルとして外部化されています。
プロジェクトの `.harness/resources/templates/` に同名ファイルを配置すると上書きできます。

テンプレート内では `{{変数名}}` でプレースホルダ置換が行われます。

runtime skill の正本は `.harness/resources/skills/` に置きます。ローカル LLM が直接呼び出す `.codex/skills/` と `.claude/skills/` の managed copy は `./.harness/bin/harness sync-skills` で生成します。

同梱テンプレート:
- `review-response-format.md` — レビュー回答形式の共通指示
- `benchmark-summary` — 生成済みログディレクトリから review/token/cost 指標を集計
- `review-test-quality.md` — テストセルフレビュー
- `review-impl-quality.md` — 実装品質レビュー
- `review-impl-criteria.md` — レビュー観点チェック
- `review-external-test.md` — テスト外部レビュー
- `review-external-impl.md` — 実装外部レビュー
- `review-dual-fallback.md` — フォールバックレビュー
- `test-generate.md` — テスト生成プロンプト
- `impl-generate.md` — 実装生成プロンプト
- `impl-retry.md` — 実装リトライプロンプト

## 安全機構

- **パス検証**: symlink 解決 + プロジェクトルート境界チェック
- **スコープ制限**: ランナーの capabilities に応じた権限制御
- **変更検証**: `git diff` でスコープ外変更を検出
- **fail-closed**: パース失敗・コマンド失敗は全てエラーとして停止
- **迷走検知**: テストリトライ上限、同一エラー連続検出、タイムアウト、diff 肥大化
- **ログ redact**: API キー・トークンパターンを自動除去
- **sandbox**: Codex ランナーのデフォルトは `read-only`
- **reviewer swap**: 外部レビューは step ごとに別 LLM へ差し替え可能

## レビューレポート

impl フロー完了時に `.harness/reviews/{date}_{scope}.md` を自動生成。

レポート内容:
- TDD サイクルの結果
- 各レビューステップの指摘と対応（修正 / 許容 / エスカレーション）
- 判断理由の要約
- 設計判断の記録

## ログ

`.harness/logs/{timestamp}_{task_name}/` に出力:

- `harness.jsonl` — イベントログ
- `claude-code.log` — Claude CLI の入出力
- `codex-app-server.log` — Codex App Server transcript
- `review-data.json` — レビュー構造化データ
- `checkpoint.json` — 再開用チェックポイント

`.harness/config/harness.yml`、`.harness/logs/` 配下の実行ログ、`.harness/reviews/` 配下の生成レポート、`.harness/node_modules/` は `.gitignore` で除外されます。

## impl フローの典型エラーと対処

| エラー | 対処 |
|---|---|
| Codex タイムアウト (`codex app-server turn did not complete in time`) | 一時障害の可能性が高い。`--resume` で再開する |
| DriftError (`diff_scope`) | `対象テストケース` の列挙方法を確認する。1 行 1 件に直し、必要なら対象範囲を見直す |
| DriftError (レビュー非収束) | テストケース仕様書の `期待結果` が曖昧でないか確認し、検証粒度を補ってから再実行する |
| GuardError (スコープ外変更) | 既知の誤検知が解消済みか確認しつつ、不要な scope 外変更を戻して `--resume` する |

impl レビューが `厳しすぎる` と `緩すぎる` の間で振れる場合、根本原因は impl 実装ではなく、テストケース仕様書の `期待結果` の曖昧さであることが多い。impl を何度もやり直す前に、TC 文書を見直す方が早い。

## ベンチマーク診断

- `./.harness/bin/harness benchmark-summary <log-dir> [<log-dir>]` — review/token/cost の総量比較
- `./.harness/bin/harness benchmark-diagnose <log-dir> [<log-dir>]` — 壁時計時間、review 収束性、prompt 適切性まで含めた診断

## ライセンス

MIT
