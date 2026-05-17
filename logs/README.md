# .harness/logs/

開発ハーネス（`.harness/`）が実行時に出力する構造化ログの格納先。

## ディレクトリ構造

```text
.harness/logs/
└── {timestamp}_{task_name}/
    ├── harness.jsonl          # ハーネスのイベントログ（JSON Lines）
    ├── claude-code.log        # Claude runner の入出力ログ
    ├── codex-app-server.log   # Codex App Server の transcript
    └── checkpoint.json        # 途中再開用のチェックポイント
```

## 記録されるイベント例

- ガードチェック結果（仕様書・テストケースの存在確認）
- TDD サイクルの進行（RED → GREEN）
- lint / test / review の実行結果
- セルフレビュー・external review の指摘内容
- 迷走ガードやエスカレーションの記録

## 注意

- 現在のログ出力先は `/.harness/logs/` であり、repo 直下 `logs/` は旧配置です
- このディレクトリ配下の実行ログ本体は `.gitignore` で除外し、この README だけを追跡します
