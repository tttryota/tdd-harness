# Harness Skills

`.harness/resources/skills/` は、このハーネスの配布用 skill 正本です。

- runtime でハーネスが参照する skill はここを canonical source とする
- ユーザーが直接呼び出すための `.codex/skills/` / `.claude/skills/` コピーは `./.harness/bin/harness sync-skills` で生成する
- repo 固有 override が必要な場合だけ `.codex/skills/<name>/SKILL.md` を置く

生成コマンド:

```bash
./.harness/bin/harness sync-skills
```
