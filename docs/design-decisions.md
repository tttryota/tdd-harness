# 設計判断メモ

この文書は、現行のフロー仕様やディレクトリ構成を説明するための文書ではありません。
現在の使い方や backend 主導線の仕様は、以下を正本として参照してください。

- [README.md](/Users/tsuryoryo/Desktop/repo/tdd-harness/README.md)
- [docs/backend-flow/README.md](/Users/tsuryoryo/Desktop/repo/tdd-harness/docs/backend-flow/README.md)
- [config/README.md](/Users/tsuryoryo/Desktop/repo/tdd-harness/config/README.md)

この文書には、陳腐化しにくい設計判断だけを残します。

## Claude Agent SDK を使わない理由

Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）は `ANTHROPIC_API_KEY` を前提にした使い方が中心で、subscription の OAuth 運用とは噛み合いません。
このハーネスでは、個人ツールとして Claude Code CLI をそのまま呼び出せることを優先し、`claude -p` を subprocess で呼ぶ方式を採用しています。

## Codex SDK を使わない理由

Codex SDK は高水準 API としては便利ですが、このハーネスが制御したい粒度とは合いませんでした。
ハーネス側では、次を runner の責務として明示的に扱いたい設計です。

- 生の通知や応答を transcript に残すこと
- review 用の実行を通常の生成実行と分けて扱うこと
- request 単位の timeout、close、pending request cleanup を自前で制御すること
- protocol 変化を transport 層で直接吸収すること

そのため、SDK 抽象には乗らず、CLI / app-server を直接扱う構成を採用しています。

## Node.js type stripping を使う理由

`tsx` などの追加ランタイムに依存せず、Node.js 22.18+ のネイティブ type stripping で `.ts` を直接実行しています。
その結果、実装では次の制約を受け入れています。

- `enum` は使わず、`as const` と union 型で表現する
- パラメータプロパティは使わない
- 型だけの import は `import type` を明示する
- `tsconfig.json` では `erasableSyntaxOnly: true` を前提にする

## コード品質保証の役割分担

コード品質のチェックは、機械チェックと LLM レビューで責務を分けています。

### 機械チェック

リンターや型検査が担当するのは、確定的に検出できる違反です。

- 命名規則
- broad exception の禁止
- 複雑度や引数数の上限
- セキュリティルール
- 型不整合

### LLM レビュー

LLM レビューが担当するのは、機械では判断しづらい意味的な違反です。

- 仕様書との整合
- 責務分離の妥当性
- マジックナンバーや省略名のような読みやすさの問題
- エラー処理の意味的な不備
- 重要条件の取りこぼし

### なぜ分けるか

- 機械チェックで確定的に弾けるものを LLM に渡すと、トークンコストだけが増える
- LLM レビューの責務を絞ると、レビューの観点が安定しやすい
- 小さな規約違反を先に除去したほうが、レビューの収束が速くなる

## 迷走検知を入れている理由

自動実装は、同じ失敗を繰り返したり、対象範囲を超えて変更を広げたりしやすい性質があります。
このハーネスでは、それを「頑張れば直るかもしれない」とは扱わず、一定条件で安全側に止める設計を採っています。

代表的な監視対象は次です。

- 同じテスト失敗の反復
- 同じエラーの反復
- diff の広がりすぎ
- rollback の繰り返し
- 長時間の停滞

これは自動化率を上げるためではなく、人間に戻すべき地点を早く見つけるための仕組みです。

## レビューを段階分けしている理由

レビューは一度に全部を見るより、観点を分けたほうが安定します。
このハーネスでは、テストレビューと実装レビューを分け、さらに実装レビューも複数段に分割しています。

意図は次です。

- 仕様違反と実装品質の議論を混ぜない
- 外部レビューを別段にして、自己点検の見落としを拾いやすくする
- minor 指摘だけで無限に回り続けるのを防ぐ

## この文書に書かないもの

以下は変化しやすいため、この文書には持たせません。

- 現在のフロー仕様
- 現在のディレクトリ構成
- frontend / backend の成熟度
- 実行手順
- 設定ファイルの詳細

それらは README と `docs/backend-flow/`、各 README 群を参照してください。
