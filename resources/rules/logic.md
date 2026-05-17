## 責務境界
- JSX 禁止、コンポーネント定義禁止
- 出力は .ts ファイルのみ
- hooks / atoms / API クライアントのみを扱う
- UI コンポーネントやページ構成を追加しない

## MSW（plan に msw: true がある場合のみ適用）
- MSW ハンドラは `frontend/src/mocks/handlers/` に配置する
- テストファイルから import して server.use() で適用する
- ハンドラのレスポンス形状はバックエンド API 契約と一致させる
- `msw: false` の場合は MSW に一切触れない
