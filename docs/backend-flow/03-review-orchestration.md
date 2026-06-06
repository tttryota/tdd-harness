# Review Orchestration

## 目的

レビューの観点分離、再試行、minor 判定、代替レビュー、人間フォールバック条件を一箇所に固定します。

## 入力

- 対象ファイル
- spec
- 必要に応じた test_cases
- レビュー観点
- 必要に応じた変更 diff

## 出力

- レビュー結果
- 指摘一覧
- 修正後のレビュー記録

## 正常系の進行

- テストレビュー
  1. `test_self_quality`
  2. `test_external_review`
- 実装レビュー
  1. `impl_self_criteria`
  2. `impl_self_quality`
  3. `impl_external_review`
- design レビュー
  - `spec_review`
  - `spec_tc_review`

各段階で critical / major が無ければ次へ進みます。

## ループ / 再試行

- 通常のレビューは最大 5 サイクルまで自動で回る
- `spec_review` と `spec_tc_review` は最大 2 サイクルまで自動で回る
- minor 指摘だけが 2 サイクル続いた場合は、追加判定でそのまま許容できるか確認する
- rate limit で外部レビューが動かない場合は、代替レビューを 2 回実行して判定を補う

## 停止条件

- レビューが最大サイクル内で収束しない
- レビュー結果を解釈できない
- 代替レビューを 2 回行っても判定できない

## 人間判断へ戻す条件

- レビューが収束しない
- レビュー結果を解釈できない
- 代替レビューのあとも、そのまま許容できない minor 指摘が残る
- page / design レビューでも同様に、レビュー結果を解釈できない、または収束しない状態が起きる

## 不変条件

- テストと実装でレビューの段数を分ける
- 実装レビューは、レビュー観点に照らす確認 → 実装品質の確認 → 外部レビュー の順を保つ
- minor 判定は critical / major を上書きしない
- 外部レビューを skip するのは明示設定時だけ

## 関連実装

- [src/application/review/review-orchestrator.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/review/review-orchestrator.ts)
- [src/application/policies/retry-policy.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/policies/retry-policy.ts)
- [src/application/policies/review-acceptance-policy.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/policies/review-acceptance-policy.ts)
