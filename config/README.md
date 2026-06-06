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

最初は `backend` profile を基準に設定する。`frontend` フローは未整備 / TBD として扱う。

`harness.yml` では主に次を定義する。

- `profiles`: `backend` / `frontend` などの実行単位
- `runners`: `codex`, `claude`, `generic` などの呼び出し方法
- `templates`: 特定 template の差し替えパス

## 主要項目

- `profiles.<name>.steps`
  - 各 step をどの runner で動かすかの割当
- `profiles.<name>.fallbackRunner`
  - review fallback などで使う既定 runner
- `profiles.<name>.lint`, `profiles.<name>.test`
  - その profile で使う品質ゲート
- `profiles.<name>.criteriaPreset`
  - `resources/criteria/` のどの観点セットを使うか
- `profiles.<name>.sourceLayout`
  - 実装対象の source / test / scope をどう解決するか
- `profiles.<name>.designLayout`
  - spec / test_cases の配置先をどう解決するか
- `profiles.<name>.context`
  - step ごとの agent, skills, model の追加指定
- `runners`
  - `steps` や `fallbackRunner` から参照される runner 定義
- `templates`
  - 特定 template だけ差し替えたい場合の override

## 最初に見る場所

- profile の全体像を知りたい: `harness.example.yml`
- review 観点を変えたい: `resources/criteria/`
- template を差し替えたい: `resources/templates/` または `.harness/resources/templates/`

通常は `templates` を最初から触る必要はない。まず `profiles` と `runners` を整える。

## 運用

- ハーネスは `.harness/config/harness.yml` を優先して読む
- `profiles` が無いと `design` / `impl` は起動できない
- review の観点を変えたい場合は、このディレクトリではなく `.harness/resources/criteria/` を編集する
- template を差し替えたい場合は `templates` か `.harness/resources/templates/` を使う
