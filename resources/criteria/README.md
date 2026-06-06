# Review Criteria

`resources/criteria/` は、レビュー時の判定基準を置くディレクトリです。
コード生成用のプロンプトではなく、`impl_self_criteria` や `page` / `component` のレビュー段階で「何を違反として指摘するか」を定義します。

## 使い方

- `review-criteria-common.md`
  - 共通のレビュー観点
- `review-criteria-backend.md`
  - `criteriaPreset: backend` の追加観点
- `review-criteria-frontend.md`
  - `criteriaPreset: frontend` の追加観点
- `review-criteria-component.md`
  - `component` フロー専用の観点

レビュー観点を整理したい場合は、このディレクトリのファイルを編集します。
bundled の backend / frontend / component criteria は最小限のプレースホルダにしてあり、project 固有のルールはここで育てる前提です。

## 注意

- `review-criteria-*.md` の本文は、レビュー時の入力プロンプトとしてそのまま注入されます
- 運用説明やメタ説明は criteria 本文ではなく、この README に書きます
- criteria 本文には、実際にレビューで使いたい観点だけを書きます

## sample

以下は、project に応じて criteria へ追加しうる観点の例です。

### common

- 変数名は省略しない
- 関数名は責務が分かる名前にする
- 数値や文字列のマジックリテラルを増やさない
- エラーメッセージに具体的文脈を含める
- エラーを握り潰さない

### backend

- dataclass / TypedDict などで構造を明示する
- async / sync の責務を混在させない
- 依存契約や返却契約を曖昧にしない
- 失敗モードを隠す fallback を入れない

### frontend

- 関数コンポーネントと Props の型を明示する
- state / event handler の責務を UI に閉じる
- テーマトークンや共通 UI ルールを崩さない
- グローバル state や API 呼び出しの責務を component に持ち込まない

### component

- プレゼンテーション責務だけに閉じる
- API 呼び出しや business logic を含めない
- Story は props ベースで状態を再現する
- 要素欠落や明らかなアクセシビリティ欠陥がない
