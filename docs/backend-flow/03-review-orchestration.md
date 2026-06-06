# Review Orchestration

## 目的

review の観点分離、再試行、minor 判定、fallback、人間フォールバック条件を一箇所に固定します。

## 入力

- 対象ファイル
- spec
- 必要に応じた test_cases
- review criteria
- 必要に応じた変更 diff

## 出力

- review 結果
- 指摘一覧
- 修正後の review 記録

## 正常系の進行

- test review
  1. `test_self_quality`
  2. `test_external_review`
- implementation review
  1. `impl_self_criteria`
  2. `impl_self_quality`
  3. `impl_external_review`
- design review
  - `spec_review`
  - `spec_tc_review`

各段階で critical / major が無ければ次へ進みます。

## ループ / 再試行

- 通常 review は最大 5 サイクルまで自動で回る
- `spec_review` と `spec_tc_review` は最大 2 サイクルまで自動で回る
- minor 指摘だけが 2 サイクル続いた場合は、追加判定でそのまま許容できるか確認する
- rate limit で外部 review が動かない場合は dual fallback を試す

## 停止条件

- review が最大サイクル内で収束しない
- review 結果の parse に失敗する
- dual fallback でも判定不能なまま止まる

## 人間判断へ戻す条件

- non-convergence
- parse failure
- dual fallback 後も unsafe な minor 指摘が残る
- page / design review でも同様に parse failure や非収束が起きる

## 不変条件

- テストと実装で review の段数を分ける
- implementation review は criteria → quality → external の順を保つ
- minor 判定は critical / major を上書きしない
- external review を skip するのは明示設定時だけ

## 関連実装

- [src/application/review/review-orchestrator.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/review/review-orchestrator.ts)
- [src/application/policies/retry-policy.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/policies/retry-policy.ts)
- [src/application/policies/review-acceptance-policy.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/policies/review-acceptance-policy.ts)
