# Scope And Drift Control

## 目的

自動実装が対象範囲の外へ広がらないようにし、迷走や危険な修正ループを安全側で止める条件を整理します。

## 入力

- plan の対象範囲
- profile の `sourceLayout`
- 変更されたファイル
- テスト失敗回数や diff 行数

## 出力

- 許可された編集範囲
- 迷走検知結果
- 対象範囲逸脱時の停止

## 正常系の進行

1. 対象範囲から source / test / allowed tools の範囲を解決する
2. source / test の変更ファイルを列挙する
3. レビューや lint の対象を対象範囲内に絞る
4. テスト再試行回数、同一失敗、diff 行数、ロールバック回数を監視する

## ループ / 再試行

- 同じテスト失敗が続くと迷走検知の段階が上がる
- diff 行数が想定した対象範囲の一定倍を超えると迷走とみなす
- file rollback が繰り返されると迷走とみなす

## 停止条件

- 対象範囲外の変更が検出される
- プロジェクト外パスや危険な symlink が検出される
- 迷走検知が level 3 に達する

## 人間判断へ戻す条件

- テスト失敗が反復し、Codex 相談を経ても改善しない
- diff が対象範囲を大きく逸脱する
- 危険な rollback や timeout が続く

## 不変条件

- 書き込み可能範囲は対象範囲、対応テスト、レビュー出力先に限定する
- プロジェクト外パスは常に reject する
- 対象範囲外変更は安全側で停止する
- test cases の列挙粒度が迷走判定の期待行数に影響する

## 関連実装

- [src/infrastructure/project/fs-project-boundary.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/infrastructure/project/fs-project-boundary.ts)
- [src/application/review/drift-guard.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/review/drift-guard.ts)
- [src/domain/services/boundary.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/domain/services/boundary.ts)
