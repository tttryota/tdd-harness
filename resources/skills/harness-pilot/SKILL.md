---
name: harness-pilot
description: TDD ハーネスの操作とワークフロー実行を支援する配布用 skill。使用場面: ハーネスで仕様策定、実装、レビュー、運用案内。トリガー: "/harness-pilot", "ハーネスで", "ハーネスの"
---

# Harness Pilot

この skill は `.harness/` 配下のハーネス全体を操作するための運用ガイド。
まず `/.harness/README.md` を読むこと。実装詳細や内部構造が必要な場合のみ `/.harness/docs/architecture.md` と `/.harness/logs/README.md` を追加で読むこと。

## 最初に確認すること

1. `.harness/config/harness.yml` があるか確認する。無ければ `.harness/config/harness.example.yml` を元に作る。
2. どの profile を使うか決める。通常は `backend` か `frontend` のどちらか。
3. 選んだ profile の `steps` と `runners` が、使いたい LLM と lint/test ツールに整合しているか確認する。
4. 実行結果は `.harness/logs/` と `.harness/reviews/` に出ると理解する。失敗時は `harness.jsonl`、`review-data.json`、`checkpoint.json` を先に見る。
5. Codex / Claude からこの skill を直接使う運用なら `./.harness/bin/harness sync-skills` で `.codex/skills/` と `.claude/skills/` を同期する。
6. ここまで確認してから `design` / `impl` / `component` / `page` のどれを使うか選ぶ。

## AI への基本動作

- ハーネスの使い方を質問されたら、まず `/.harness/README.md` を根拠に答える
- ハーネス実行を依頼されたら、設定未整備なら先に profile 整備を案内し、整ってから適切なコマンドを選ぶ
- 実行依頼を受けたら `.harness/logs/` と `.harness/reviews/` が観測先だと前提共有する
- 障害調査や比較が主目的なら `benchmark-summary` / `benchmark-diagnose` を優先する
- plan / spec / test_cases / component_spec / figma_cache の前提が不足している場合は、足りない入力を具体的に指摘する
- `.harness/resources/` は配布物、`.harness/config/harness.yml` と `.harness/logs/` と `.harness/reviews/` はローカル生成物として扱う

## コマンド一覧

| コマンド | 用途 |
|---|---|
| `./.harness/bin/harness sync-skills` | `harness-pilot` と project-local skills を `.codex/skills/` と `.claude/skills/` に同期 |
| `./.harness/bin/harness design [--profile <name>] <category/name> "<requirements>"` | 仕様書・テストケース生成 |
| `./.harness/bin/harness impl <plan-file> [--resume] [--flow full\|light] [--no-interactive]` | TDD 実装 |
| `./.harness/bin/harness component <plan-file> [--flow full\|light] [--no-interactive]` | Component + Story 実装 |
| `./.harness/bin/harness page <plan-file> [--flow full\|light] [--no-interactive]` | Page 実装 + レビュー + browser verify |
| `./.harness/bin/harness benchmark-summary <log-dir> [<log-dir>]` | ベンチマーク比較サマリ |
| `./.harness/bin/harness benchmark-diagnose <log-dir> [<log-dir>]` | ベンチマーク診断 |

## 典型フロー

### バックエンド
1. `design` 初回実行で仕様書を生成する
2. 同じ `design` 実行の中で `spec_review` と `spec_tc_review` まで自動で回る
3. 人間が仕様書とテストケースを確認し、frontmatter の `status` を `ready` にする
4. plan を用意する
5. `impl` を実行する

### フロントエンド
1. 仕様書・コンポーネント定義書・Figma キャッシュ・必要ならテストケースを ready にする
2. `/harness-plan-fe <spec-path>` で plan 群を生成する
3. `component` → `impl` → `page` の順で実行する

## plan の見方

- `type`: `component` / `impl` / `page`
- `profile`: `backend` / `frontend`
- `scope`: 実装責務の境界
- `spec`: 仕様書
- `test_cases`: Logic / Page で必要
- `component_spec`: Component / Page で必要
- `figma_cache`: Component / Page で必要
- `msw`: Logic / Page で API モックが必要か

plan の詳細フォーマットは `/.harness/README.md` を正本とする。

## 運用ガイド

### design フロー生成物を ready にする前の確認

- 仕様書に DTO / Protocol の振る舞い、公開 API の形、モジュール構成パス、テストダブルのシグネチャ根拠が書かれているか確認する
- テストケース仕様書の `期待結果` に検証粒度が書かれているか確認する
- ログ検証なら、イベント名、必須キー、期待値、件数制約、追加キー許容の有無を明示する
- 例外検証なら、例外型、`message`、`cause chain`、ログ記録有無のうち何を確認するかを明示する
- 値検証なら、`完全一致` / `含まれる` / `存在確認` を区別する
- この粒度や契約が曖昧なまま impl に進めると、`spec_review` / `spec_tc_review` や `review-test-quality` が収束しにくい

### plan の書き方

- `対象テストケース` は 1 行に 1 件ずつ列挙する
- `TC-01, TC-02` のように 1 行へ圧縮しない
- diff_scope 見積もりが `targetTestCases.length` に依存するため、圧縮記法は不自然な DriftError の原因になる

### impl フローで詰まったときの見方

| エラー | 対処 |
|---|---|
| Codex タイムアウト | 一時障害の可能性が高い。`--resume` で再開する |
| DriftError (`diff_scope`) | plan の `対象テストケース` の列挙方法を見直す |
| DriftError (レビュー非収束) | impl を再試行する前に、テストケース仕様書の `期待結果` の粒度を見直す |
| GuardError (スコープ外変更) | 不要な scope 外変更を戻して `--resume` する |

## skill と設定の関係

- `profile.context.defaultSkills` と `profile.context.stepOverrides.<step>.skills` が runtime skill 名
- ハーネス内部実行時の探索順:
  1. `.codex/skills/<name>/SKILL.md`
  2. `.harness/resources/skills/<name>/SKILL.md`
  3. `.claude/skills/<name>/SKILL.md`
- repo 固有 override が不要なら `.harness/resources/skills/` を正本として扱う
- 配布元の更新後は `./.harness/bin/harness sync-skills` を実行し、展開先 `.codex/skills/` と `.claude/skills/` も同じ内容になっているか確認する

## よくある誤り

- `./.harness/bin/harness` ではなく旧パスを叩く
- `.harness/config/harness.example.yml` をそのまま実設定だと思う
- `component` フローに MSW を持ち込む
- Page フローで Logic を新規実装しようとする
- `.harness/logs/` や `.harness/reviews/` を配布物として commit しようとする
