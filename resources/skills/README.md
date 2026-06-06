# Harness Skills

`.harness/resources/skills/` は、このハーネスで直接呼び出す配布用 skill の置き場です。

- ローカル LLM の入口は `harness-pilot` を前提とし、まず `README.md` を読ませる
- runtime に注入する追加指示は、主に `resources/templates/` や `resources/rules/` 側で管理する
- ユーザーが直接呼び出すための `.codex/skills/` / `.claude/skills/` コピーは `./.harness/bin/harness sync-skills` で生成する
- repo 固有 override が必要な場合だけ `.codex/skills/<name>/SKILL.md` を置く

生成コマンド:

```bash
./.harness/bin/harness sync-skills
```
