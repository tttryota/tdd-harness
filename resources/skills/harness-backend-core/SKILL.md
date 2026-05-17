---
name: harness-backend-core
description: Core rules for backend harness tasks. Use when generating backend specs, tests, implementations, or reviews under the harness flow.
---

# Backend Core

- Stay inside the spec, target test cases, and allowed file scope.
- Do not add features, fallback behavior, or refactors that the spec does not require.
- Preserve public contracts exactly: function names, return shapes, exception behavior, output formatting, and file paths.
- Prefer small, typed helpers over ad hoc dict mutation or hidden global state.
- Keep behavior deterministic. Avoid randomness, time dependence, or environment-dependent branches unless the spec requires them.
- When the implementation is ambiguous, choose the option that minimizes behavior change and keeps tests/spec aligned.
