---
name: harness-plan-fe
description: フロントエンド仕様書から Component / Logic / Page plan 群を生成する配布用 skill。トリガー: "/harness-plan-fe"
---

# Harness Plan FE

この skill は ready の仕様書から `component` / `impl` / `page` plan を作る。
まず `/.harness/README.md` を読み、必要なら `/.harness/docs/architecture.md` を読むこと。

## 入力前提

以下を順に確認する。

| 入力 | 条件 |
|---|---|
| 仕様書 | ready |
| コンポーネント定義書 | ready |
| Figma キャッシュ | 存在する |
| テストケース | Logic / Page に必要なら ready |

不足があれば plan を作らず、何が欠けているかを明示する。

## 生成方針

1. 仕様書から画面責務、状態責務、API 連携を抽出
2. コンポーネント定義書から新規 component と既存 component を分離
3. 新規 component は `component` plan、hooks / atoms / API は `impl` plan、接続とレイアウトは `page` plan に分割
4. API 呼び出しがある `impl` / `page` plan だけ `msw: true`
5. plan は依存順に並べる

## 出力原則

- `profile: frontend`
- `scope` は責務境界が一目で分かる値にする
- `Dependencies` は import と名前を具体的に書く
- `Figma Slice` は該当部分だけ抜粋する
- `Browser Scenarios` は page plan に必須
- `やらないこと` と `完了条件` は曖昧にしない

## type ごとの責務

### component
- 新規コンポーネント定義
- Story を含める
- API / atom / hooks を実装対象に含めない
- MSW を使わない

### impl
- hooks / atoms / API クライアント
- JSX を含めない
- 必要なら `msw: true`

### page
- component と logic の接続
- レイアウト、画面遷移、browser verification の対象整理
- 新規コンポーネントやロジック本体をここで増やさない

## plan に必ず入れること

- frontmatter の必須フィールド
- `今回やること`
- `Dependencies`
- `完了条件`
- `設計判断`
- type に応じた `Targets` / `対象テストケース` / `Browser Scenarios` / `Figma Slice`

## 迷った時の判断

- 迷ったら責務を細かく割って `impl` plan を増やす
- ただし page plan は 1 画面単位を基本にする
- 新規 component が複数あっても、同一 feature のまとまりなら 1 つの component plan に束ねてよい
