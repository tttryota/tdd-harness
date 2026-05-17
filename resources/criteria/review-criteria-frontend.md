<!-- Phase 3 で詳細化 -->

## React固有
- コンポーネントは関数コンポーネントのみ
- Props は type 定義必須
- useEffect の依存配列は省略禁止
- children の暗黙的バケツリレー禁止

## shadcn/ui固有
- コンポーネントカスタマイズは cn() ユーティリティで
- Radix UIのプリミティブを直接使わない（shadcn/uiのラッパーを通す）

## Tailwind固有
- インラインstyle禁止（Tailwindクラスを使う）
- マジックカラー禁止（テーマトークンを使う）
- 長いクラス列は clsx/cn で整理
- @apply は原則使わない

## Jotai固有
- atom定義はfeature単位のファイルにまとめる
- 派生atomで計算ロジックを表現（コンポーネント内で計算しない）
