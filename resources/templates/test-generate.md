以下のテストケースに対して、既存の{{frameworkName}}テストコードが十分かを確認し、不足がある場合のみテストコードを更新してください。

## テストケース
{{testCases}}

## 仕様書
{{spec}}

## 根拠の制約
- 現在の対象コード、現在の仕様書、現在のテストケース文書だけを根拠に判断する
- `.harness/logs/` 配下、および repo 直下 `logs/` 配下の review / usage / transcript / checkpoint を根拠にしない
- `.harness/` 配下の現在タスクと無関係な補助ファイルを根拠にしない
- 過去 run の review / usage / transcript を根拠にしない

## テスト配置先
- テストは必ず `{{testPath}}` 配下に配置する
- `{{testPath}}` の外にテストファイルを新規作成・移動しない
- ソースディレクトリ直下や代替パスに `test_*.py` / `*.test.*` / `*.spec.*` を置かない

## 進め方
- まず既存テストを確認し、対象テストケースをすでに満たしているか判定する
- 対象テストケースを満たしている場合はテストコードを変更しない
- 対象テストケースを満たしていない場合のみ、必要最小限のテスト追加・修正を行う

## テストコード品質の要件
- テストコードに過度なアルゴリズムを持ち込まない
- 行数が増えてもよいので、愚直で読みやすい形を優先する
- 準備 / 実行 / 検証 の各フェーズがブロックとして明確に判別できるようにする
- 1テスト1関心事を守る
- モックは外部依存のみに限定する
- テスト対象モジュールは静的 import（`from ... import ...`）を使う
- `importlib` による動的 import や `getattr` での遅延解決は使わない
- テスト対象の公開 API（関数名、クラス名、例外型）は仕様書の定義をそのまま使う
- 仕様書のエラー契約に具体的な例外型が定義されている場合は、その型を使う
- `except Exception` や bare except のような broad exception 捕捉は使わない
- 仕様書のエラー契約だけでは具体的な例外型を決められない場合は、テスト側で勝手に一般化せず仕様不足として扱う

## 依存契約とテストダブル
- テストダブルは、仕様書に書かれた公開契約・依存 Protocol・既存の import 可能な公開 API を根拠に、できるだけ具体的なメソッドシグネチャで定義する
- `*args, **kwargs` は最終手段ではなく、原則として使わない
- 引数 shape を推測する helper（属性探索、文字列解析、ネスト探索など）で契約を吸収しない
- 実装が存在しない場合も、もっとも根拠の強い狭い仮説で named 引数のシグネチャを書く
- 想定外の呼ばれ方は吸収せず、fail-fast するテストダブルにする
- テストダブル自体に実装並みの複雑さや推測ロジックを持ち込まない
- 依存契約の根拠が足りず、具体シグネチャを決めるとハルシネーションになる場合は、汎化して進めず `contract_revision_required` を返す

## 検証厳密性の原則
- 対象 test case の検証焦点を満たすのに必要な観測点をすべてアサートする
- 正しいものが含まれることだけでなく、重要なら誤ったものが含まれないことも確認する
- count だけでは誤実装を見逃すなら、中身も確認する
- 順序が重要なら順序も確認する
- 主要フィールドが結果契約に含まれるなら、その主要フィールドを省略しない
- 壊れていても通る余地が残るなら、その抜けを埋める追加アサートを書く

## good / bad examples
```python
# bad: 件数だけ見ていて、中身が壊れていても通る
assert len(result.headings) == 2

# good: 件数に加えて中身を確認する
assert len(result.headings) == 2
assert [heading.text for heading in result.headings] == ["Overview", "Detail"]
```

```python
# bad: 含まれることしか見ておらず、除外漏れを見逃す
assert "H2" in texts
assert "H3" in texts

# good: 含まれるべきものと、含まれないべきものの両方を見る
assert texts == ["H2", "H3"]
assert "H4" not in texts
```

```python
# bad: 主要フィールドの一部しか見ていない
assert heading.text == "Hello World"

# good: 契約上重要なフィールドをまとめて確認する
assert heading.text == "Hello World"
assert heading.level == 1
assert heading.anchor == "hello-world"
```

```python
# bad: 順序が意味を持つのに集合比較だけしている
assert set(texts) == {"Overview", "Detail"}

# good: 順序まで確認する
assert texts == ["Overview", "Detail"]
```

## 判定基準
- `decision = "noop"`:
  - 対象テストケースを既存テストが満たしている
  - テストファイルを一切変更しない
- `decision = "updated"`:
  - 対象テストケースを満たすために、テストファイルの追加または修正を行った
- `decision = "contract_revision_required"`:
  - 依存 Protocol や公開 API の契約が不足しており、具体的なテストダブルのシグネチャを根拠付きで定義できない
  - `*args, **kwargs` や推測 helper でごまかすと偽陰性リスクが高い
  - この場合、テストファイルは変更しない

## 出力形式
必ず以下の JSON のみを返してください。説明文や Markdown は不要です。

```json
{
  "decision": "noop",
  "why": [
    "対象テストケース X, Y, Z は既存テストで満たされている"
  ],
  "covered_test_cases": [
    "テストケース名"
  ],
  "updated_test_cases": [],
  "notes": []
}
```

## 出力ルール
- `why` は 1-3 件の配列にする
- `covered_test_cases` には今回の対象テストケース名を列挙する
- `updated_test_cases` には今回追加・修正したテストケース名のみを入れる
- `decision = "noop"` の場合、`updated_test_cases` は空配列にする
- `decision = "contract_revision_required"` の場合、`updated_test_cases` は空配列にし、`notes` に未確定の依存契約や不足しているシグネチャ情報を具体的に書く
- 対応表、長文レビュー、表形式の説明は書かない

{{mswInstructions}}
