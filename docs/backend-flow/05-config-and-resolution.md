# Config And Resolution

## 目的

`harness.yml` の設定と、template / criteria / rules / skills の解決順を固定します。

## 入力

- `.harness/config/harness.yml`
- profile 名
- project-local resources
- 同梱 resources

## 出力

- 解決済み profile
- step と runner の対応
- review criteria と prompt 断片

## 正常系の進行

1. `profiles` を必須として設定を読む
2. profile から `steps`, `fallbackRunner`, `criteriaPreset`, `sourceLayout`, `designLayout`, `context` を解決する
3. 各 step に対応する runner を決める
4. template / criteria / rules / skills を必要な場所で解決する

## ループ / 再試行

- 設定解決自体に再試行はない
- ただし review / impl 中の retry は、この解決結果に依存して動く

## 停止条件

- `profiles` が無い
- profile に必須 step が足りない
- runner, criteria, template の参照先が壊れている
- path template が不正

## 人間判断へ戻す条件

- runtime safety を満たさない設定で GuardError が出る
- project 固有の review criteria や template override が不足している

## 不変条件

- `profiles` は必須
- `steps` は flow step と runner の対応を表す
- `criteriaPreset` は review criteria の束を選ぶ
- templates は `config override` → `project-local` → `bundled` の順で解決する
- 各 step で注入される skill は、`profile.context.defaultSkills` と、その step に対応する `profile.context.stepOverrides.<step>.skills` に指定したものだけ

## 関連実装

- [src/infrastructure/config/config.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/infrastructure/config/config.ts)
- [src/infrastructure/templates/templates.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/infrastructure/templates/templates.ts)
- [src/application/resolvers/criteria-resolver.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/resolvers/criteria-resolver.ts)
- [src/application/resolvers/rules-resolver.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/application/resolvers/rules-resolver.ts)
- [src/infrastructure/runners/step-context.ts](/Users/tsuryoryo/Desktop/repo/tdd-harness/src/infrastructure/runners/step-context.ts)
