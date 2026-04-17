---
description: Path-scoped rules for FastAPI backend files
appliesTo:
  - "backend/app/**/*.py"
  - "backend/tests/**/*.py"
  - "app/main.py"
  - "app/**/*.py"
  - "tests/**/*.py"
---

# Backend (FastAPI + Python 3.12+)

- Async-first: `async def` for all route handlers
- Pydantic models for all request/response validation
- Type hints on every function signature
- All endpoints under `/v1/` prefix
- Tests alongside implementation, not after: `uv run pytest tests/ -v`
- First test run is slow (~60s) due to bytecode compilation — this is normal
- Mock at routes module level: `patch("app.<module>.routes.<function>")`
- `maybe_single().execute()` can return `None` — always check `if _resp is not None`
- Supabase `admin.rpc()` passes params dict as positional arg, not kwargs
- `if x is None` not `x or default` when empty list is valid
- Audit events: write inline with business operations in same RPC/transaction
- Never hardcode secrets — use `Settings` from the project's config module

## Project-specific rules

Business rules specific to this project live in `.claude/rules/project-backend.md`
(written by `/rkt-tailor`). Check there for domain conventions beyond the generic
patterns above.
