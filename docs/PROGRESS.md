# ハーネス汎用化 実装進捗

## 計画ファイル
`/Users/tsuryoryo/.claude/plans/wiggly-roaming-rossum.md`

## 全体状況

| Phase | ファイル | 状態 | Codex レビュー | セルフレビュー |
|---|---|---|---|---|
| 1 | tool-adapter.ts, config.ts | 実装済み | major 解消（5回） | — |
| 2 | launcher.ts | 実装済み | major 解消（3回） | — |
| 3 | plan-parser.ts, harness.ts | 実装済み | major 2件修正済み | major なし確認 |
| 4 | lint-guard.ts | 実装済み | major 1件修正済み | 大文字拡張子対応追加 |
| 5 | boundary.ts | 実装済み | major 3件中2件修正済み | パス境界・extractCategory 修正済み |
| 6 | impl-flow.ts, review-orchestrator.ts | 実装済み | major 5件修正済み（4回） | major なし確認 |
| 7 | drift-guard.ts | 実装済み | major 2件修正済み（3回） | major なし確認 |
| 8 | README.md, setup-guide.md | 実装済み | major 4件修正済み（3回） | major なし確認 |

## Phase 6 で解消予定の既知 major

以下は Phase 3-5 のレビューで繰り返し指摘されたが、Phase 6 の本体作業として対応する項目:

1. **ImplFlow に adapter が渡っていない**: harness.ts で解決した profile/adapter を ImplFlow に注入
2. **determineCriteriaPaths が旧ロジック**: CriteriaResolver に移行し Boundary から shim 削除
3. **テスト実行がハードコード**: TestAdapter + runTool 経由に変更
4. **テスト/実装生成プロンプトが Python 固有**: テンプレート化

## Phase 6 でやること

1. ImplFlow の ctor を `(boundary, registry, profile, testAdapter, lintAdapters)` に変更
2. `runTests` を TestAdapter + runTool 経由に変更
3. review-orchestrator の `testCommand: string[]` → `runTests: () => Promise<void>` コールバック化
4. CriteriaResolver を impl-flow に実装（Boundary.determineCriteriaPaths shim を削除）
5. テスト/実装生成プロンプトのテンプレート化（`resources/templates/test-generate.md`, `resources/templates/impl-generate.md`）
6. `Boundary.parsePlanFile` shim を削除（plan-parser.ts に一本化完了）
7. `lintCheck` で `findSourceFiles` を使用（`findPythonFiles` エイリアス削除）
8. **tsc (project-only) 対応**: LintAdapter に `filePass: "files" | "project"` を追加。lint-guard で project モードの adapter はファイル引数なしで実行し、parseOutput の結果を scope 内ファイルにフィルタする。tsc はプロジェクト全体で実行するが、scope 隔離モデルを維持するため出力を scope 内に絞る。

## Phase 7-8 でやること

- Phase 7: drift-guard.ts の codexAvailable デフォルト false + registry 判定
- Phase 8: setup-guide.md 新規作成 + README.md セットアップセクション刷新

## 変更済みファイル一覧

```
.harness/src/tool-adapter.ts  — 新規作成（BaseAdapter / LintAdapter / TestAdapter + built-in）
.harness/src/config.ts        — 全面書き換え（profiles + UserConfig/ResolvedConfig + validation）
.harness/src/launcher.ts      — 新規作成（preferLocal PATH + safeExec + runTool）
.harness/src/plan-parser.ts   — 新規作成（parsePlan + 境界チェック）
.harness/src/harness.ts       — 配線変更（parsePlan → profile → adapter → Boundary）+ init
.harness/src/lint-guard.ts    — 全面書き換え（adapter ループ + runTool + rescanFiles）
.harness/src/boundary.ts      — 全面書き換え（sourceLayout 駆動 + allowedTools 汎用化）
.harness/src/impl-flow.ts     — 全面書き換え（ctor 拡張、CriteriaResolver、TestAdapter+runTool、テンプレート化、runTests コールバック）
.harness/src/review-orchestrator.ts — ReviewParams testCommand→runTests、runTests メソッド削除
.harness/src/drift-guard.ts   — codexAvailable デフォルト false
.harness/resources/templates/test-generate.md — 新規作成（テスト生成プロンプト）
.harness/resources/templates/impl-generate.md — 新規作成（実装生成プロンプト）
.harness/resources/templates/impl-retry.md — 新規作成（実装リトライプロンプト）
.harness/docs/setup-guide.md  — 新規作成（`./.harness/bin/harness init` 用セットアップガイド）
.harness/README.md            — profiles セクション追加、前提条件汎用化、ツール一覧追加
.harness/package.json         — ローカル実行用 scripts を整備
.harness/src/types.ts         — TaskPlan に profile? 追加
```

## Codex レビュー方針

- 各 Phase 完了後に Codex にプレーンレビューを依頼
- major がなくなるまで修正→再レビューを繰り返す
- minor/low は可能な範囲で対応
- 前回の指摘をプロンプトに含めない（確認バイアス防止）
- レート制限時はセルフレビュー（Explore サブエージェント）で代替

## 設計判断メモ

- frontend impl-flow は別フロー（デザインデータ入力・ブラウザ MCP チェック等が必要）として将来実装。implementationGuard の frontend ガードは維持
- PnP 環境は自動検出しない（`exec: [yarn, exec]` で対応可能）
- tsc 対応は Phase 6 に含める（`filePass: "project"` + scope 内フィルタ）
- profile 内は単一 runtime（mixed runtime 禁止）
- scope は厳密 2 要素（category/name）
