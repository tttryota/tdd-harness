以下の情報から target の component と Story を実装してください。

## Target
{{target}}

## 仕様書
{{spec}}

## コンポーネント定義書
{{componentSpec}}

## Dependencies
{{dependencies}}

## Figma Slice
{{figmaSlice}}

## 設計判断
{{designDecisions}}

## 根拠の制約
- 現在の target、現在の仕様書、現在の component 定義書、現在の Figma Slice、現在の Dependencies だけを根拠に判断する
- `.harness/logs/` 配下、および repo 直下 `logs/` 配下の review / usage / transcript / checkpoint を根拠にしない
- `.harness/` 配下の現在タスクと無関係な補助ファイルを根拠にしない
- 過去 run の review / usage / transcript を根拠にしない

## 実装要件
- target に対応する component 本体と Story を同時に作成/更新する
- component の責務はプレゼンテーション責務のみに限定する
- API、server state、atom/global state、ビジネスロジックは実装しない
- props に基づく表示分岐と局所 UI state は実装してよい
- Story はコロケーションした `{{target}}.stories.tsx` とし、CSF3 形式で書く
- Story は props ベースで状態を再現し、MSW は使わない
- callback props には `fn()` を使う
- 既存の import path は Dependencies を正として使う
- Figma Slice と component 定義書に整合する見た目と状態を作る
