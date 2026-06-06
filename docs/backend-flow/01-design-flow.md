# Design Flow

## 目的

`design` は backend 実装に必要な spec と test_cases を準備し、人間が `status: ready` を付けられる状態まで整えるフローです。

## 入力

- `category/name` 形式の feature 名
- requirements 文字列
- profile の `designLayout`
- spec / test_cases テンプレート

## 出力

- spec ファイル
- test_cases ファイル
- 必要に応じた review 修正結果

## 正常系の進行

1. spec と test_cases の出力先を解決する
2. 両方が既に `ready` なら何も生成せず終了する
3. spec が無ければ生成する
4. spec が `ready` でなければ `spec_review` を実行する
5. test_cases が無ければ生成する
6. `spec_tc_review` を実行する
7. spec / test_cases の両方が `ready` なら `impl` へ進める状態として終了する

## ループ / 再試行

- `spec_review` は最大 2 サイクルまで自動で回る
- `spec_tc_review` は最大 2 サイクルまで自動で回る
- spec が draft のままでも、test_cases 生成と `spec_tc_review` までは進む

## 停止条件

- spec または test_cases の生成結果が出力先に存在しない
- review が最大サイクル内で収束しない
- review 修正後も spec / test_cases の `status` が `ready` にならない

## 人間判断へ戻す条件

- `spec_tc_review` 完了後も spec / test_cases のどちらかが `ready` でない
- review 指摘を踏まえて frontmatter の `status` を更新する必要がある

## 不変条件

- `design` は plan を作らない
- spec と test_cases の書き込み先だけに編集権限を絞る
- `impl` の入力契約は spec / test_cases と人間が用意する plan である

## 関連実装

- [src/application/flows/design-flow.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/flows/design-flow.ts)
- [src/application/review/review-orchestrator.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/review/review-orchestrator.ts)
- [resources/templates/spec-template.md](/Users/tsuryoryo/Desktop/repo/tdd-harness/resources/templates/spec-template.md)
- [resources/templates/test-case-template.md](/Users/tsuryoryo/Desktop/repo/tdd-harness/resources/templates/test-case-template.md)
