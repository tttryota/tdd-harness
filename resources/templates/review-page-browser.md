以下の Browser Scenarios を実ブラウザで確認してください。

## 仕様書
{{spec}}

## Browser Scenarios
{{browserScenarios}}

## 参考コード
{{fileContents}}

## 根拠の制約
- 現在の仕様書、現在の Browser Scenarios、現在の参考コードだけを根拠に判断する
- `.harness/logs/` 配下、および repo 直下 `logs/` 配下の review / usage / transcript / checkpoint を根拠にしない
- `.harness/` 配下の現在タスクと無関係な補助ファイルを根拠にしない
- 過去 run の review / usage / transcript を根拠にしない

## 実行指示
- 利用可能なブラウザ操作ツールまたは Browser MCP がある場合はそれを使って実際に確認する
- 使えない場合は `overall: "blocked"` を返し、理由を notes に書く
- 各 scenario ごとに pass / fail / blocked を判定する
- fail の場合は failed_step, expected, observed を必ず埋める

## 出力形式（厳守）
```json
{
  "overall": "pass",
  "scenarios": [
    {
      "name": "Scenario name",
      "status": "pass",
      "completed_steps": ["step 1", "step 2"],
      "failed_step": "",
      "expected": [],
      "observed": [],
      "notes": ""
    }
  ]
}
```
