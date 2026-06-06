# backend-flow

backend 主導線の仕様を、実装ファイル単位ではなく振る舞い単位でまとめたディレクトリです。
README で全体像を掴んだあと、必要な責務だけを順番に読める構成にしています。

## 仕様書の切り方

- 1 文書に入れるのは、同じ成功条件を持つ振る舞いだけ
- レビューの詳細は `03-review-orchestration.md` に集約する
- 設定の意味は `05-config-and-resolution.md` に集約する
- ログの読み方は `06-observability-and-recovery.md` に集約する
- frontend の `page` / `component` / draft はこの群に含めない

## 読み順

1. [01-design-flow.md](/Users/tsuryoryo/Desktop/repo/tdd-harness/docs/backend-flow/01-design-flow.md)
   `design` が spec / test_cases をどう準備するか
2. [02-impl-cycle.md](/Users/tsuryoryo/Desktop/repo/tdd-harness/docs/backend-flow/02-impl-cycle.md)
   `impl` がどの状態機械で TDD を進めるか
3. [03-review-orchestration.md](/Users/tsuryoryo/Desktop/repo/tdd-harness/docs/backend-flow/03-review-orchestration.md)
   レビューの段数、再試行、代替レビュー、人間フォールバック
4. [04-scope-and-drift-control.md](/Users/tsuryoryo/Desktop/repo/tdd-harness/docs/backend-flow/04-scope-and-drift-control.md)
   対象範囲の制御と安全側で停止する境界
5. [05-config-and-resolution.md](/Users/tsuryoryo/Desktop/repo/tdd-harness/docs/backend-flow/05-config-and-resolution.md)
   profile とテンプレート / レビュー観点 / skill の解決
6. [06-observability-and-recovery.md](/Users/tsuryoryo/Desktop/repo/tdd-harness/docs/backend-flow/06-observability-and-recovery.md)
   ログ、レビュー出力、再開、診断

## 読み分け

- `design` の仕様だけ確認したい:
  `01-design-flow.md`
- `impl` の進行順と停止条件を確認したい:
  `02-impl-cycle.md`
- 「何回までレビューするか」「minor はどう扱うか」を確認したい:
  `03-review-orchestration.md`
- 対象範囲外の変更や迷走検知の条件を確認したい:
  `04-scope-and-drift-control.md`
- `harness.yml` の設定がどこに効くか確認したい:
  `05-config-and-resolution.md`
- 失敗時にどのログを見るか確認したい:
  `06-observability-and-recovery.md`
