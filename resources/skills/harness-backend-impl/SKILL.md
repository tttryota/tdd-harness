---
name: harness-backend-impl
description: Implementation guidance for backend harness steps. Use during backend code generation and retry steps.
---

# Backend Implementation

- Make the smallest change that turns the current RED state into GREEN for the specified target cases.
- Start from the failing test output and trace the exact contract mismatch before editing code.
- Prefer fixing root-cause logic over patching outputs after the fact.
- Keep parsing, normalization, validation, and rendering responsibilities separated when practical.
- If you add branching, make the branch condition explicit and testable.
- If you touch error handling, preserve existing successful paths and narrow the changed surface area.
