---
name: harness-backend-review-criteria
description: Review-only criteria for backend harness checks focused on contract and rule violations.
---

# Backend Review Criteria

- Review only for concrete rule violations or contract mismatches.
- Treat these as major unless impact is clearly smaller:
  - behavior disagrees with the spec or target test cases
  - boundary handling contradicts documented input assumptions
  - error handling swallows failures or returns the wrong contract
  - file scope or dependency constraints are violated
- Do not ask for speculative refactors.
- List all concrete violations in one pass.
