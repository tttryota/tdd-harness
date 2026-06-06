# このHarnessの概要

LLM CLI を使った TDD 自動化オーケストレーター。
Claude Code / Codex App Server / GitHub Copilot CLI など任意の LLM 実行系をプラガブルに差し替え可能。

## できること

このハーネスの中心は `Impl` フローです。`Design` フローは `Impl` の前提となる仕様書・テストケースを準備する補助フローです。
以下は`Impl` フローの流れです。
現時点の主導線は `backend` であり、`frontend` フローは未整備 / TBD として扱います。


| 段階 | 何をするか | 問題があれば |
|---|---|---|
| テスト生成 | 対象テストケースに対応するテストコードを生成する | 契約見直しが必要なら人間判断へ戻す |
| テストコードの品質レビュー | テストケース文書と仕様書に照らして、テストコードの妥当性と検証強度を確認する | 指摘があれば⭐︎テストコードの修正⭐︎段階へ進み、このレビューをやり直す |
| テストの仕様照合レビュー | 変更内容が仕様条件と期待結果を正しく表し、見逃しや誤検証がないかを確認する | 指摘があれば⭐︎テストコードの修正⭐︎段階へ進み、このレビューをやり直す |
| ⭐︎テストコードの修正⭐︎ | レビュー指摘を修正する計画を策定するステップ→修正計画を適用するステップの2ステップ | 修正後にテストレビューへ戻す |
| RED確認 | テストが失敗することを確認する | 想定外の状態なら人間判断へ戻す |
| 実装 | RED を GREEN にする実装を行う | GREEN になるまで実装をやり直す |
| 仕様・設計観点のレビュー | 仕様書とレビュー観点に照らして、設計・責務分離・明示規約の逸脱がないかを確認する | 指摘があれば⭐︎実装の修正⭐︎段階へ進み、このレビューをやり直す |
| 実装品質レビュー | 実装の可読性、保守性、状態変化の追いやすさに問題がないかを確認する | 指摘があれば⭐︎実装の修正⭐︎段階へ進み、このレビューをやり直す |
| 実装の仕様照合レビュー | 実装が受け入れ基準、境界条件、失敗モードと一致し、重要条件の取りこぼしがないかを確認する | 指摘があれば⭐︎実装の修正⭐︎段階へ進み、このレビューをやり直す |
| ⭐︎実装の修正⭐︎ | レビュー指摘をまとめて修正し、レビューを再実行できる状態に戻す | 修正後に該当レビューへ戻す |
| 収束後 | レポートとログを出力する | - |

### 補足
- 通常のテストレビューと実装レビューは最大 5 サイクルまで自動で回る
- 仕様書レビューと仕様書・テストケース整合レビューは最大 2 サイクルまで自動で回る
- レビューが収束しない場合は人間にフォールバックする
- 軽微な指摘だけが 2 サイクル続いた場合は、許容できるかを追加判定する
- 実装は GREEN になるまで最大 3 回まで再試行する

## お手元のAIに読ませてください

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
レビュー観点を整理したい場合は `resources/criteria/` を編集します。`criteriaPreset` はそこで管理する観点セットを選ぶための設定です。

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
