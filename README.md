# このHarnessの概要

LLM CLI を使った TDD 自動化オーケストレーター。
Claude Code / Codex App Server / GitHub Copilot CLI など任意の LLM 実行系をプラガブルに差し替え可能。

## できること

このハーネスの中心は `Impl` フローです。`plan` ファイルと、その `plan` が参照する仕様書 (`spec`)・テストケース (`test_cases`) を入力として TDD 実装を進めます。`Design` フローは `Impl` の前提となる仕様書・テストケースを準備する補助フローです。

- `Design` フローで spec / test cases の作成を補助する
- `Impl` フローで TDD 実装を自動実行する
- lint / test / review を runner ごとにオーケストレーションする
- 実行ログとレビューレポートを出力する

## AI 連携

README は人間向けの概要と起動手順の正本です。AI 向けの運用詳細は `harness-pilot` を参照します。

- 入口 skill: `/.harness/resources/skills/harness-pilot/SKILL.md`
- 追加ドキュメント: `/.harness/docs/architecture.md`
- ログ詳細: `/.harness/logs/README.md`
- 配布用 skill 正本: `/.harness/resources/skills/`

## セットアップ

前提条件:
- Node.js 22.18+
- 使用する runner に応じた CLI が利用可能であること（例: Codex App Server, Claude Code CLI）
- プロジェクトに応じた lint/test ツール（Python: ruff + mypy + pytest、TypeScript: eslint + tsc + vitest）

この repo では `./.harness/bin/harness` が実行入口。

設定ファイルの追跡対象は `.harness/config/harness.example.yml` です。実運用ではこれを `.harness/config/harness.yml` にコピーして使います。

```bash
cp .harness/config/harness.example.yml .harness/config/harness.yml
```

## 設定

実際に読み込む設定ファイルは `.harness/config/harness.yml` です。詳細な設定例は次を参照:

- `.harness/config/harness.example.yml`

### プロファイル

`profiles` は必須です。`profile` は次をまとめる実行単位です。

- 実行フロー: `flow`, `fallbackRunner`, `steps`
- 品質ゲート: `lint`, `test`, `criteriaPreset`
- パス解決: `toolRoot`, `sourceLayout`, `designLayout`

各 step で注入される skill は、`profile.context.defaultSkills` と、その step に対応する `profile.context.stepOverrides.<step>.skills` に指定したものだけです。

完全な設定例は `.harness/config/harness.example.yml` を参照してください。主な項目は次のとおりです。

```yaml
profiles:
  backend:
    flow: full
    fallbackRunner: codex
    steps: { ... }
    lint: [ruff, mypy]
    test: pytest
    toolRoot: backend
    criteriaPreset: backend
    sourceLayout: { ... }
    designLayout: { ... }
```

現時点の主導線は `backend` です。`frontend` フローは TBD / 開発中として扱います。

### ランナー

```yaml
runners:
  claude:
    type: claude
  codex:
    type: codex
    sandbox: read-only
  copilot:
    type: generic
    command: gh
    args: ["copilot"]
    promptFlag: "--prompt"
```

ランナー種別:

| type | 説明 |
|---|---|
| claude | Claude Code CLI (`claude -p`) |
| codex | OpenAI Codex App Server (`codex app-server`) |
| generic | 任意の CLI コマンド |

`.harness/config/harness.yml` に `profiles` が定義されていない場合はエラーになります。`README.md` と `.harness/config/harness.example.yml` を参照して設定を作成してください。

## 使い方

### Impl Flow（TDD 実装）

`Impl` フローは `plan` ファイルを入力として起動します。

必要な入力:

- `plan`
- `plan` が参照する `spec`
- `plan` が参照する `test_cases`

仕様書を期待パスに置いただけでは起動できません。`Impl` は `plan` 経由で `spec` と `test_cases` を解決します。

```bash
./.harness/bin/harness impl plan/current-task.md
```

```bash
# light フロー
./.harness/bin/harness impl plan/task.md --flow light

# 対話プロンプトをスキップ
./.harness/bin/harness impl plan/task.md --no-interactive

# チェックポイントから再開
./.harness/bin/harness impl plan/task.md --resume
```

### Design Flow（Impl の入力準備）

```bash
# sample
./.harness/bin/harness design ingestion/chunk-splitter "Markdownをチャンク分割する機能"
./.harness/bin/harness design --profile backend ingestion/chunk-splitter "Markdownをチャンク分割する機能"
```

- `Design` フローは `plan` を作るものではなく、`Impl` が参照する仕様書・テストケースを用意するためのフローです
- spec が無ければ生成する
- spec が `ready` でなければ `spec_review` を実行する
- test cases が無ければ生成する
- `spec_tc_review` を実行する
- spec / test cases の両方が `ready` でなければ、人間が frontmatter の `status` を更新して再実行する
- 自前で作成した spec / test cases を期待パスに置けば生成はスキップできるが、`ready` でなければレビューは走る

## `plan` ファイルのフォーマット

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

`spec` と `test_cases` は、この `plan` の frontmatter で参照先を指定します。

## コマンド一覧

- `./.harness/bin/harness impl <plan-file> [--resume] [--flow full|light] [--no-interactive]`
- `./.harness/bin/harness design [--profile <name>] <category/name> "<requirements>"`
- `./.harness/bin/harness sync-skills`
- `./.harness/bin/harness benchmark-summary <log-dir> [<log-dir>]`
- `./.harness/bin/harness benchmark-diagnose <log-dir> [<log-dir>]`

## ログ / レポート

- 実行ログ: `.harness/logs/`
- レビューレポート: `.harness/reviews/`

ログ構造や詳細な運用、トラブルシュートは `logs/README.md` と `harness-pilot` を参照してください。

## ライセンス

MIT
