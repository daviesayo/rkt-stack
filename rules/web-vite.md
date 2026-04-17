---
description: Path-scoped rules for Vite + React web projects (used by `full` preset)
appliesTo:
  - "web/src/**/*.ts"
  - "web/src/**/*.tsx"
  - "web/src/**/*.css"
---

# Web (Vite + React 19 + TypeScript)

- Read `DESIGN.md` before any UI work
- Invoke `/frontend-design` skill before writing UI code
- `react-router-dom` for routing
- `@supabase/supabase-js` for auth (magic link + OAuth)
- CSS design tokens defined in the project's tokens file (e.g. `web/src/styles/tokens.css`)
- API calls through a central api module (e.g. `web/src/lib/api.ts`)
- Supabase client from a central client module (e.g. `web/src/lib/supabase.ts`)
- No secrets in client-side code — only `import.meta.env.VITE_*`
- No business logic — web is an API consumer only
- Always handle loading, error, and empty states

## Project-specific rules

Business rules specific to this project live in `.claude/rules/project-web.md`
(written by `/rkt-tailor`). Check there for domain conventions beyond the generic
patterns above.
