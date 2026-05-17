## Component 責務
- プレゼンテーション責務のみを持つこと
- API 呼び出し、server state、atom/global state、ビジネスロジックを含めないこと
- props に基づく表示分岐と局所 UI state に責務が閉じていること

## React / TypeScript
- 関数コンポーネントのみを使うこと
- Props の型定義が明示されていること
- 不要な any、型アサーション、暗黙の children 受け渡しを作らないこと
- local state とイベントハンドラが UI 振る舞いに対して過不足なく閉じていること

## Story
- Story は CSF3 形式で、`satisfies Meta<typeof Component>` を使うこと
- Story は props ベースで状態を再現し、MSW を使わないこと
- 実際に遭遇する画面状態だけを Story 化し、不要な組み合わせを増やさないこと
- callback props に `fn()` を使うこと

## UI 品質
- Figma Slice と component 定義書に対して要素欠落がないこと
- spacing、色、テキスト、variant/state の表現が大きくずれていないこと
- アクセシビリティ上明らかな欠陥（button なのに button でない等）がないこと
