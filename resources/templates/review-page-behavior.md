以下の page 実装を仕様書の動作要件に照らしてレビューしてください。
該当する問題を全て一度に列挙してください。

## 対象ファイル
{{fileContents}}

## 仕様書
{{spec}}

## Browser Scenarios
{{browserScenarios}}

## 根拠の制約
- 現在の対象コード、現在の仕様書、現在の Browser Scenarios だけを根拠に判断する
- `.harness/logs/` 配下、および repo 直下 `logs/` 配下の review / usage / transcript / checkpoint を根拠にしない
- `.harness/` 配下の現在タスクと無関係な補助ファイルを根拠にしない
- 過去 run の review / usage / transcript を根拠にしない

## 観点
- 仕様書の UX 要件と状態遷移が一致しているか
- ローディング、空データ、エラー状態の扱いが仕様と矛盾していないか
- a11y 要件や主要導線の振る舞いが仕様から逸脱していないか
- API キャッシュ戦略や mutation 後の挙動に、仕様との不整合がないか

## severity の判定基準
- critical: 正常系導線が成立しない、致命的な状態遷移バグ
- major: 仕様書の動作要件との明確な不一致
- minor: UX 意図からの軽微な逸脱

{{responseFormat}}
