## 回答形式
JSON のみを返してください。JSON の外にテキストを一切含めないでください。
`checklist` と `issues` の両方を必ず返してください。
`checklist` は、上で指定されたレビュー観点を実際に確認した証跡です。
問題がない場合でも `checklist` は省略せず、確認した項目ごとに `pass` / `n/a` と根拠を埋めてください。

指摘あり:
{"checklist":[{"item":"確認項目","verdict":"fail","evidence":"何を見てどう判断したか。対象テスト名・関数名・式・行や値など具体的に書く"}],"issues":[{"file":"src/foo.py","line":87,"severity":"major","description":"何が問題か、なぜ問題か、影響、修正方針を簡潔に含める"}]}

指摘なし:
{"checklist":[{"item":"確認項目","verdict":"pass","evidence":"何を見て問題なしと判断したかを具体的に書く"}],"issues":[]}
