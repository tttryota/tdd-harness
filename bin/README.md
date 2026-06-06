# bin

このディレクトリには、repo-local の起動 wrapper を置く。

## `harness`

`harness` は `src/cli/harness.ts` を起動するだけの薄い wrapper。

- `.harness/` として配置している場合は `./.harness/bin/harness`

を入口として使う。

## 役割

- 実行入口を固定する
- 呼び出し元が `src/cli/harness.ts` の場所を意識しなくてよいようにする
- README や skill から同じコマンド名で案内できるようにする

CLI の実装本体は `src/cli/harness.ts` 側にあるので、引数仕様やコマンド一覧を変える場合は wrapper ではなく CLI 本体を更新する。
