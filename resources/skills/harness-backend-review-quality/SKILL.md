---
name: harness-backend-review-quality
description: Quality review guidance for backend harness checks focused on correctness, boundary handling, and regression risk.
---

# Backend Review Quality

- Check boundary conditions before style concerns.
- Prefer findings tied to a concrete input, state transition, or output contract.
- Look for:
  - off-by-one or empty-input handling
  - normalization mistakes around whitespace, casing, escaping, or separators
  - parser state transitions that can close early, skip content, or leak state
  - incorrect fallback behavior that hides failures
  - regressions where a fix for one format breaks another valid format
- Minor issues should stay minor unless they plausibly affect correctness or maintenance safety.
