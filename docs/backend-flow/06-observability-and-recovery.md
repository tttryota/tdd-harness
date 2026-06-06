# Observability And Recovery

## 目的

実行結果がどこに出るか、失敗時にどのファイルから読むか、再開と benchmark 診断をどう使うかを整理します。

## 入力

- 実行ログ
- レビュー記録
- 再開情報
- benchmark 対象のログディレクトリ

## 出力

- `.harness/logs/` 配下の実行ログ
- `.harness/reviews/` 配下の最終レポート
- 再開情報
- benchmark 集計 / 診断結果

## 正常系の進行

1. 実行中のイベントを `harness.jsonl` に記録する
2. レビュー記録を `review-data.json` に保存する
3. 再開に必要な完了済み step を `checkpoint.json` に保存する
4. 実行完了後に markdown レポートを `.harness/reviews/` へ出力する

## ループ / 再試行

- `--resume` は再開情報を読み、完了済み step の次からだけを再実行する
- benchmark 系コマンドは既存ログを再解析するだけで、実装自体は再実行しない

## 停止条件

- 再開情報が示す状態で再開できない
- レビュー / レポートのデータを解釈できない

## 人間判断へ戻す条件

- 失敗原因が再開情報だけでは説明できない
- `harness.jsonl` / `review-data.json` を読んでも非収束理由が解けない

## 不変条件

- `.harness/logs/{timestamp}_{task}/` が実行単位のログ置き場
- `.harness/reviews/` が最終レポート置き場
- `benchmark-summary` は数値比較
- `benchmark-diagnose` は step ごとの時間・cost・レビュー回数の診断

## 関連実装

- [logs/README.md](/Users/tsuryoryo/Desktop/repo/tdd-harness/logs/README.md)
- [reviews/README.md](/Users/tsuryoryo/Desktop/repo/tdd-harness/reviews/README.md)
- [src/application/diagnostics/benchmark-summary.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/diagnostics/benchmark-summary.ts)
- [src/application/diagnostics/benchmark-diagnose.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/diagnostics/benchmark-diagnose.ts)
