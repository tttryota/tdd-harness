# Impl Cycle

## 目的

`impl` は plan を入力契約として受け取り、TDD の進行順を固定しながら RED から GREEN、review、report まで進める主フローです。

## 入力

- plan ファイル
- plan が参照する spec
- plan が参照する test_cases
- profile の `steps`, `fallbackRunner`, `criteriaPreset`

## 出力

- 実装コードとテストコード
- review レポート
- 実行ログと checkpoint

## 正常系の進行

1. plan を読み込み、spec / test_cases / scope の入力契約を検証する
2. test_generate で対象テストケースに対応するテストコードを生成する
3. テスト review を通す
4. RED を確認する
5. implementation を行う
6. GREEN を確認する
7. implementation review を通す
8. レポートとログを出力して終了する

## ループ / 再試行

- `test_generate` が `contract_revision_required` を返した場合は、その時点で停止する
- GREEN 確認に失敗した場合、implementation を最大 3 回まで再試行する
- `--resume` 指定時は checkpoint の completed step 以降だけを再開する
- GREEN 済み checkpoint からの resume では、implementation を飛ばして review から再開できる

## 停止条件

- plan / spec / test_cases の入力契約が壊れている
- `test_generate` が `contract_revision_required` を返す
- GREEN が最大試行回数に達しても成立しない
- review / lint / drift guard が fail-closed で停止する

## 人間判断へ戻す条件

- 依存契約やテストコード側の契約定義を見直す必要がある
- drift や scope 逸脱で自動継続が unsafe になった
- review が非収束または parse failure で止まった

## 不変条件

- `impl` は plan を唯一の起動入口とする
- RED 確認を通らずに implementation へ進まない
- GREEN 確認を通らずに implementation review へ進まない
- checkpoint は completed step 単位で再開点を保存する

## 関連実装

- [src/application/flows/impl-flow.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/flows/impl-flow.ts)
- [src/application/plan/validated-plan.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/plan/validated-plan.ts)
- [src/domain/services/plan-parser.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/domain/services/plan-parser.ts)
