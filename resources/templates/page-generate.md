以下の情報から page UI を実装してください。

## 仕様書
{{spec}}

## コンポーネント定義書
{{componentSpec}}

## Dependencies
{{dependencies}}

## Figma Slice
{{figmaSlice}}

## Browser Scenarios
{{browserScenarios}}

## 対象テストケース
{{targetTestCases}}

## 根拠の制約
- 現在の仕様書、現在の component 定義書、現在の Dependencies、現在の Figma Slice、現在の Browser Scenarios、現在の対象テストケースだけを根拠に判断する
- `.harness/logs/` 配下、および repo 直下 `logs/` 配下の review / usage / transcript / checkpoint を根拠にしない
- `.harness/` 配下の現在タスクと無関係な補助ファイルを根拠にしない
- 過去 run の review / usage / transcript を根拠にしない

## 実装要件
- page の役割は Component と Logic の接続、ページ構成、レイアウトに限定する
- 新しいビジネスロジックや API 呼び出しを page 内へ直書きしない
- 必要な page テストも同時に作成/更新する
- 既存の import path は Dependencies を正として使う
- 仕様書の UX 要件と Figma Slice に整合するよう実装する
