# 仕様書・テストケース整合性レビュー

以下の仕様書とテストケース文書について、**仕様の曖昧さ・整合性不足** だけを検出する。
impl のしやすさや一般的なテスト設計論ではなく、spec と TC の間で解釈がぶれそうな点に限定する。

## 対象ファイル

- 仕様書: {{specPath}}
- テストケース: {{testCasesPath}}

## requirements

{{requirements}}

## 仕様書

{{spec}}

## テストケース

{{testCases}}

## 参考表示

{{fileContents}}

## チェック観点

1. DTO / 入出力フィールドの振る舞いが spec に明記されているか
   - strip, trim, sort, normalize, dedupe, case 変換など
   - TC の期待結果が具体値を前提にしているのに、spec 側で変換ルールが未定義なら fail
2. TC の「前提」欄の境界が明確か
   - 単なる依存設定なのか
   - 呼び出し回数 / 引数 / 呼び出し有無の検証まで含むのか
   - 判別できない場合は fail
3. TC の「期待結果」の検証スコープが明確か
   - 戻り値検証
   - 依存オブジェクト呼び出し検証
   - ログ検証
   - どれを含むか曖昧なら fail
4. spec の具体例を参照している TC の入力値・期待値が一致しているか
   - 具体例と異なる具体値を TC が置いているなら fail
5. spec 未記載の振る舞いを TC が勝手に期待していないか
   - TC 側だけが具体的で、spec 側に契約がないなら fail
6. requirements でスコープ外 / 不要と明示された機能を spec / TC が勝手に対象化していないか
   - 未定義だからといって scope 外機能を spec/TC に追加していたら fail

## fail にしないもの

- 実装スタイルの好み
- test helper の書き方
- impl レビューで扱うコード品質論
- spec と TC が既に明確な場合の言い換え提案

## issue の書き方

- 1 issue = 1 曖昧さ / 不整合
- spec を直すべきか、TC を直すべきか、両方かが分かる説明にする
- `file` は必ず `{{specPath}}` または `{{testCasesPath}}` のどちらかを指す
- `description` には、何が未定義 / 不一致 / 曖昧なのかを具体的に書く
- critical はパース失敗など review 自体が成立しないときだけ使う
- それ以外は major または minor を使う

## 出力形式

{{responseFormat}}
