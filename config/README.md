# config

このディレクトリには、ハーネスの設定ファイルを置く。

## ファイル

- `harness.example.yml`: tracked なサンプル設定。新規 project のたたき台として使う
- `harness.yml`: 実運用で読み込まれる設定

## 使い方

初回は `harness.example.yml` を `harness.yml` にコピーしてから編集する。

```bash
cp .harness/config/harness.example.yml .harness/config/harness.yml
```

`harness.yml` では主に次を定義する。

- `profiles`: `backend` / `frontend` などの実行単位
- `runners`: `codex`, `claude`, `generic` などの呼び出し方法
- `templates`: 特定 template の差し替えパス

## 運用

- ハーネスは `.harness/config/harness.yml` を優先して読む
- `profiles` が無いと `design` / `impl` は起動できない
- review の観点を変えたい場合は、このディレクトリではなく `.harness/resources/criteria/` を編集する
- template を差し替えたい場合は `templates` か `.harness/resources/templates/` を使う
