# templates

このディレクトリには、ハーネスが各 step で注入する同梱の prompt template を置く。

## 役割

### Backend

| template | 注入される step |
|---|---|
| `spec-template.md` | `spec_generate` |
| `test-case-template.md` | `test_case_generate` |
| `test-generate.md` | `test_generate` |
| `impl-generate.md` | `impl_generate` の初回生成 |
| `impl-retry.md` | `impl_generate` の再試行 |
| `review-spec-consistency.md` | `spec_review` |
| `review-spec-tc-consistency.md` | `spec_tc_review` |
| `review-test-quality.md` | `test_self_quality` |
| `review-external-test.md` | `test_external_review` |
| `review-impl-criteria.md` | `impl_self_criteria`, `component_self_review`, `page_review_code` |
| `review-impl-quality.md` | `impl_self_quality` |
| `review-external-impl.md` | `impl_external_review` |

### Frontend

| template | 注入される step | 現在の扱い |
|---|---|---|
| `component-generate.md` | `component_generate` | file は同梱、frontend フローは未整備 / TBD |
| `page-generate.md` | `page_generate` | file は同梱、frontend フローは未整備 / TBD |
| `review-page-design.md` | `page_review_design` | file は同梱、frontend フローは未整備 / TBD |
| `review-page-behavior.md` | `page_review_behavior` | file は同梱、frontend フローは未整備 / TBD |
| `review-page-browser.md` | `page_browser_verify` | file は同梱、frontend フローは未整備 / TBD |

frontend の draft や補助資料は `docs/frontend-flow/` 側で管理する。

### 補助テンプレート

| template | 使われ方 |
|---|---|
| `review-response-format.md` | 各 review template に埋め込まれる共通の応答形式 |
| `review-dual-fallback.md` | 実装 review の external review が rate limit で使えない場合の fallback |

## 解決順

テンプレートは次の順で解決される。

1. `harness.yml` の `templates.<name>` で指定したパス
2. project-local の `.harness/resources/templates/<name>.md`
3. このディレクトリの同梱テンプレート

project ごとに文面を変えたい場合は、通常は `.harness/resources/templates/` に同名ファイルを置く。  
特定ファイルだけ別パスへ切り替えたい場合は `harness.yml` の `templates` を使う。

## 注意

- このディレクトリのファイルは実行時にそのまま prompt に入る
- 運用説明やメタ説明はここではなく README に書く
- frontend 側は未整備なので、ここに file があっても backend 側と同じ成熟度だとはみなさない
