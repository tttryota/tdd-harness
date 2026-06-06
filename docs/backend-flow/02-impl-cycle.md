# Impl Cycle

## 目的

`impl` は plan を入力契約として受け取り、TDD の進行順を固定しながら RED から GREEN、レビュー、レポート出力まで進める主フローです。

## 入力

- plan ファイル
- plan が参照する spec
- plan が参照する test_cases
- profile の `steps`, `fallbackRunner`, `criteriaPreset`

## 出力

- 実装コードとテストコード
- レビュー結果をまとめたレポート
- 実行ログと再開情報

## 正常系の進行

1. plan を読み込み、spec / test_cases / 対象範囲の入力契約を検証する
2. test_generate で対象テストケースに対応するテストコードを生成する
3. テストレビューを通す
4. RED を確認する
5. 実装を行う
6. GREEN を確認する
7. 実装レビューを通す
8. レポートとログを出力して終了する

## ループ / 再試行

- `test_generate` が `contract_revision_required` を返した場合は、その時点で停止する
- GREEN 確認に失敗した場合、実装を最大 3 回まで再試行する
- `--resume` 指定時は再開情報に記録された完了済み step 以降だけを再開する
- GREEN 済みの再開情報から再開する場合は、実装を飛ばして実装レビューから再開できる

## 停止条件

- plan / spec / test_cases の入力契約が壊れている
- `test_generate` が `contract_revision_required` を返す
- GREEN が最大試行回数に達しても成立しない
- レビュー / lint / 迷走検知が安全側で停止する

## 人間判断へ戻す条件

- 依存契約やテストコード側の契約定義を見直す必要がある
- 迷走や対象範囲逸脱で自動継続が危険になった
- レビューが収束しない、またはレビュー結果を解釈できずに止まった

## 不変条件

- `impl` は plan を唯一の起動入口とする
- RED 確認を通らずに実装へ進まない
- GREEN 確認を通らずに実装レビューへ進まない
- 再開情報は completed step 単位で再開点を保存する

## 関連実装

- [src/application/flows/impl-flow.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/flows/impl-flow.ts)
- [src/application/plan/validated-plan.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/plan/validated-plan.ts)
- [src/domain/services/plan-parser.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/domain/services/plan-parser.ts)
