# Harness セットアップガイド

ローカル LLM にまず読ませる文書は `/.harness/README.md`。このファイルは初期セットアップと設定コピーの詳細用。

## インストール

前提:
- Node.js 22.18+
- `claude` CLI が PATH に存在（external review などで使う場合）
- プロジェクトに応じた lint/test ツール

この repo では `./.harness/bin/harness` から起動する。

配布用 skill を `.codex/skills/` と `.claude/skills/` に同期したい場合:

```bash
./.harness/bin/harness sync-skills
```

## 設定ファイル

追跡対象のサンプル設定は `.harness/config/harness.example.yml`。実際に読み込む設定は `.harness/config/harness.yml`。

```bash
cp .harness/config/harness.example.yml .harness/config/harness.yml
```

### 例1: Python バックエンド

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
    sourceLayout:
      sourceDir: "backend/{{category}}"
      testDir: "backend/{{category}}/tests"
      scopePattern: "backend/{{category}}/*"
```

### 例2: TypeScript プロジェクト

```yaml
profiles:
  app:
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
    toolRoot: .
    criteriaPreset: frontend
    sourceLayout:
      sourceDir: "src/{{category}}/{{name}}"
      testDir: "src/{{category}}/{{name}}/__tests__"
      scopePattern: "src/{{category}}/{{name}}/*"
```

### 例3: 複数プロファイル

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
    sourceLayout:
      sourceDir: "backend/{{category}}"
      testDir: "backend/{{category}}/tests"
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

runners:
  claude:
    type: claude
  claude-opus-review:
    type: claude
    model: opus
  codex:
    type: codex
    sandbox: read-only
```

`profiles` は必須。未定義の場合はエラーになる。`./.harness/bin/harness init` でこのガイドを表示できる。

`profile` は実行単位です。lint / test / sourceLayout に加え、`flow` / `fallbackRunner` / `steps` / `context` も profile 内に置きます。

## 利用可能なツール

### lint adapter

| ツール | runtime | filePass | 説明 |
|---|---|---|---|
| ruff | python | files | Python linter/formatter |
| mypy | python | files | Python 型チェッカー |
| eslint | node | files | JavaScript/TypeScript linter |
| tsc | node | project | TypeScript 型チェッカー |

### test adapter

| ツール | runtime | 説明 |
|---|---|---|
| pytest | python | Python テストフレームワーク |
| vitest | node | JavaScript/TypeScript テストフレームワーク |

## ランナー

| type | 説明 |
|---|---|
| claude | Claude Code CLI (`claude -p`) |
| codex | OpenAI Codex App Server (`codex app-server`) |
| generic | 任意の CLI コマンド |

### generic runner の設定

| フィールド | 必須 | 説明 |
|---|---|---|
| command | o | 実行する CLI コマンド |
| args | o | コマンドの固定引数（配列） |
| promptFlag | - | プロンプトを渡すフラグ（例: `-p`）。未指定時は stdin にプロンプトを流す |
| timeoutMs | - | タイムアウト（ミリ秒） |

```yaml
runners:
  copilot:
    type: generic
    command: gh
    args: ["copilot"]
    promptFlag: "--prompt"
```

non-interactive 実行にはツール側の権限設定が必要な場合があります（例: Copilot CLI の `--allow-all-tools`）。

## 計画ファイルの書き方

```markdown
---
profile: backend
scope: ingestion/chunk-splitter
spec: docs/spec/ingestion/chunk-splitter.md
test_cases: tests/test-cases/ingestion/chunk-splitter.md
---

## 今回やること
（実装内容の説明）

## 対象テストケース
1. テストケース1
2. テストケース2

## やらないこと
- スコープ外の項目

## 完了条件
- テストが GREEN
- lint パス

## 設計判断
- 判断とその理由
```

profile が 1 つだけの場合は frontmatter の `profile:` を省略可能。

## scope の命名規則

`カテゴリ/名前` 形式（例: `ingestion/chunk-splitter`）。
英数字とハイフンのみ使用可能。

## フロー

### Design Flow（仕様書・テストケース生成）

```bash
./.harness/bin/harness design ingestion/chunk-splitter "Markdownをチャンク分割する機能"
```

### Impl Flow（TDD 実装）

```bash
./.harness/bin/harness impl plan/task.md
./.harness/bin/harness impl plan/task.md --flow light    # 外部レビュー省略
./.harness/bin/harness impl plan/task.md --resume        # チェックポイントから再開
./.harness/bin/harness impl plan/task.md --no-interactive # 対話プロンプトスキップ
```

## プロファイル設定項目

| フィールド | 型 | 説明 |
|---|---|---|
| lint | string[] | lint ツール名の配列 |
| test | string | test ツール名 |
| toolRoot | string | ツール実行時のルートディレクトリ |
| exec | string[] | ツール実行時のプレフィクス（例: `[poetry, run]`） |
| criteriaPreset | "backend" \| "frontend" | レビュー観点のプリセット |
| reviewCriteria | string[] | カスタムレビュー観点ファイルパス |
| sourceLayout | object | ソースコードのディレクトリ構成 |

### sourceLayout

| フィールド | 説明 | 例 |
|---|---|---|
| sourceDir | ソースディレクトリ | `backend/{{category}}` |
| testDir | テストディレクトリ | `backend/{{category}}/tests` |
| scopePattern | スコープパターン | `backend/{{category}}/*` |
| additionalAllowedPrefixes | 追加の許可パス | `[".harness/reviews/"]` |

`{{category}}` と `{{name}}` がスコープの値で置換される。
