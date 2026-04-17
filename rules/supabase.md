---
description: Path-scoped rules for Supabase migrations and database work
appliesTo:
  - "backend/supabase/**"
  - "supabase/**"
---

# Supabase Workflow

Three-tier model: **Local → Cloud Dev → Cloud Prod**. Never skip Cloud Dev.

| Environment | Access |
|---|---|
| Local | `supabase start`, Studio at `localhost:54323` |
| Cloud Dev | Supabase MCP tools — validate all changes here first |
| Cloud Prod | Supabase MCP tools — only after Cloud Dev validated and project lead confirms |

## Migration Flow

1. Write locally: `supabase migration new <name>` from the project root or `backend/`
2. Validate: `supabase db push --local --include-all` + run the test suite
3. Apply to Cloud Dev: MCP `apply_migration` (Cloud Dev project ref)
4. Apply to Cloud Prod: MCP `apply_migration` (Cloud Prod project ref) — only after Cloud Dev validated and confirmed

## Cloud Interactions

All cloud interactions via Supabase MCP tools — never CLI against cloud.
Available: `apply_migration`, `execute_sql`, `list_tables`, `list_migrations`, `get_logs`, `list_branches`.

**IMPORTANT:** Before calling `apply_migration`, confirm which project ref you are targeting. Default to Cloud Dev. The wrong ref means schema changes hit production — there is no undo.

## Project-specific rules

Business rules specific to this project live in `.claude/rules/project-database.md`
(written by `/rkt-tailor`). Check there for domain conventions beyond the generic
patterns above.
