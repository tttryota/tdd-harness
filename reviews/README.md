# Reviews

Impl フロー完了時に、最終レポートを Markdown で出力するディレクトリです。

## 出力先

- パス: `.harness/reviews/{timestamp}_{scope}.md`
- 例: `.harness/reviews/2026-06-06T12-34-56_ingestion_chunk-splitter.md`

## レポートに含まれる内容

生成されるレポートは、概ね次の構造です。

1. タスク概要
   - 実行日
   - スコープ
   - 結果
   - レビューサイクル数
   - 修正件数
   - LLM 実行回数
2. 対象テストケース
3. TDD サイクル
   - 何回目の実装で GREEN になったか
   - 既に GREEN だったため実装生成をスキップしたか
4. レビュー詳細
   - レビューステップごとの指摘
   - severity
   - 修正 diff の抜粋
   - エスカレーション有無
5. 事前定義の設計判断
   - plan に含まれる `設計判断`
6. レビュー中に許容した指摘
7. サマリー
   - レビューステップ数
   - レビューサイクル総数
   - 修正した指摘数
   - 通過ステップ数
   - 設計判断数
   - 許容件数
   - LLM 実行回数
   - Input / Output tokens
   - Cost USD
8. Claude Usage By Step
   - step ごとの runs / input / output / cost

## 関連ファイル

- 実行中の構造化データ: `.harness/logs/{timestamp}_{task}/review-data.json`
- イベント時系列: `.harness/logs/{timestamp}_{task}/harness.jsonl`
- ログ全体の説明: `/.harness/logs/README.md`

このディレクトリの Markdown は、人間がレビュー結果を読み返すための最終出力です。
より詳細な集計や診断が必要な場合は、`benchmark-summary` / `benchmark-diagnose` と `review-data.json` を使います。
