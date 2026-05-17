---
name: harness-backend-failure-modes
description: Common backend failure modes for the harness to surface before external review.
---

# Backend Failure Modes

- Output contract drift:
  - escaping, quoting, delimiters, or path formatting no longer match the expected output contract
- Boundary drift:
  - empty input, single-item input, duplicate markers, trailing whitespace, or mixed newline styles behave differently than intended
- Parser drift:
  - opening/closing markers are matched too loosely
  - state is not reset correctly after nested or repeated constructs
- Validation drift:
  - invalid input is silently accepted
  - valid edge input is rejected by an overly broad guard
- Fix-pattern warning:
  - do not hardcode around one failing example if the underlying rule is broader
