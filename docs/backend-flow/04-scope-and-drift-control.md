# Scope And Drift Control

## 目的

自動実装が scope 外へ広がらないようにし、迷走や unsafe な修正ループを fail-closed で止める条件を整理します。

## 入力

- plan の scope
- profile の `sourceLayout`
- 変更されたファイル
- テスト失敗回数や diff 行数

## 出力

- 許可された編集範囲
- drift 検知結果
- scope 逸脱時の停止

## 正常系の進行

1. scope から source / test / allowed tools の範囲を解決する
2. source / test の変更ファイルを列挙する
3. review や lint の対象を scope 内に絞る
4. テスト再試行回数、同一失敗、diff 行数、ロールバック回数を監視する

## ループ / 再試行

- 同じテスト失敗が続くと drift guard のエスカレーションが進む
- diff 行数が期待 scope の一定倍を超えると drift とみなす
- file rollback が繰り返されると drift とみなす

## 停止条件

- scope 外変更が検出される
- プロジェクト外パスや unsafe な symlink が検出される
- drift guard が level 3 に達する

## 人間判断へ戻す条件

- テスト失敗が反復し、Codex 相談を経ても改善しない
- diff が scope を大きく逸脱する
- unsafe な rollback や timeout が続く

## 不変条件

- 書き込み可能範囲は scope、対応テスト、レビュー出力先に限定する
- プロジェクト外パスは常に reject する
- scope 外変更は fail-closed で扱う
- test cases の列挙粒度が drift の期待行数に影響する

## 関連実装

- [src/infrastructure/project/fs-project-boundary.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/infrastructure/project/fs-project-boundary.ts)
- [src/application/review/drift-guard.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/review/drift-guard.ts)
- [src/domain/services/boundary.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/domain/services/boundary.ts)
