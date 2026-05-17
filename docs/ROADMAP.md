# ローカル Harness Roadmap

## 完了済み

- [x] CLI ランナーのプラガブル化（claude / codex / generic）
- [x] 設定ファイル（`.harness/config/harness.yml`）によるランナー割り当て・フロー選択
- [x] 簡易フロー（light）— 外部レビューのみ省略
- [x] 対話的ランナー割り当て（`--no-interactive` で CI 対応）
- [x] レビュー観点のテンプレート化（`resources/templates/` + プレースホルダ置換）
- [x] LICENSE (MIT) / README
- [x] レビュープロンプトのワンショット例（良い例・悪い例の対比）
- [x] チェックポイント resume 機能（`logDir` 保持）
- [x] Codex CLI 引数修正（`--sandbox read-only`）
- [x] レポートの diff 重複解消（サイクル単位で1回出力）

## 次にやること

### lint-guard の汎用化

現状は Python (ruff + mypy) 専用、`backend/pyproject.toml` 固定。

- [ ] config で lint ツール・設定パスを指定可能にする
- [ ] 言語別の lint-guard 実装を差し替え可能にする（TypeScript: ESLint + tsc 等）

### boundary の汎用化

現状は `backend/{category}/` のディレクトリ構造に固定。

- [ ] config で source layout を指定可能にする（root, testDir, scopePattern）
- [ ] テストランナーの設定化（現状 pytest 固定）

### レポート品質

- [ ] `generateJudgmentSummary` を指摘単位の理由生成に改善
- [ ] レポート出力フォーマットの選択肢（Markdown / JSON）

### 運用改善

- [ ] チェックポイント形式のバージョニング（互換性管理）
- [ ] ログ出力のカスタマイズ（verbosity、出力先）
- [ ] CI で `.harness` のテストを回す
- [ ] `DriftGuard` の Codex 固定参照を汎用化

## フロー

| ステップ | full | light |
|---|---|---|
| テスト生成 | o | o |
| テストセルフレビュー | o | o |
| テスト外部レビュー | o | 省略 |
| RED 確認 | o | o |
| 実装生成 | o | o |
| GREEN 確認 | o | o |
| 実装セルフレビュー(criteria) | o | o |
| 実装セルフレビュー(quality) | o | o |
| 実装外部レビュー | o | 省略 |

## ランナー割り当て

```yaml
runners:
  claude:
    type: claude
  codex:
    type: codex
    sandbox: read-only
  copilot:
    type: generic
    command: gh
    args: ["copilot", "suggest"]

flow: full
fallbackRunner: claude

steps:
  test_generate: claude
  test_self_quality: claude
  test_external_review: codex
  impl_generate: claude
  impl_self_criteria: claude
  impl_self_quality: copilot
  impl_external_review: codex
  lint_fix: claude
  apply_fixes: claude
  judgment_summary: claude
  judge_minor: claude
```

対話プロンプトで実行前に変更可能。`--no-interactive` でスキップ。
