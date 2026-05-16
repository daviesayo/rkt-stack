---
description: Path-scoped rules for Next.js 16 App Router projects (used by `web` preset)
appliesTo:
  - "app/**/*.tsx"
  - "app/**/*.ts"
  - "components/**/*.tsx"
  - "lib/**/*.ts"
---

# Next.js + Supabase Rules

## App Router conventions

- **Server Components by default.** Mark `"use client"` only when you need
  client-side interactivity, browser APIs, or React state.
- **Server Actions for mutations.** Prefer Server Actions over dedicated API
  routes for internal form submissions.
- **Route handlers for public APIs.** Use `app/api/*/route.ts` only for
  externally-consumed endpoints.

## Supabase integration

- **Use `@supabase/ssr`** with `createBrowserClient` (Client Components) and
  `createServerClient` (Server Components, Server Actions, route handlers).
- **Never leak the service role key** to client-side code. Only use it in
  Server Actions or route handlers that verify the caller's permissions.
- **RLS is mandatory** on all user-facing tables. Do not disable for
  "convenience" — use the service role in a trusted handler instead.

## Auth

- Middleware at `middleware.ts` handles session refresh.
- Protected routes: check `const { data: { user } } = await supabase.auth.getUser()`
  in the Server Component and `redirect('/login')` if null.

## Styling

- **Tailwind + shadcn** is the default. Do not introduce additional CSS
  frameworks.
- Use design tokens from `tailwind.config.ts` theme, not hardcoded hex
  values in components.

## Forbidden patterns

- `dangerouslySetInnerHTML` without sanitisation.
- Fetching data via `useEffect` in Server Components (use the async function).
- Business logic in Client Components — web consumes APIs, it doesn't own them.
- Secrets in `NEXT_PUBLIC_*` env vars — those are exposed to the browser.

## Testing

- Unit tests with Vitest for lib functions.
- Component tests with Testing Library.
- Critical user flows: Playwright E2E.

## Project-specific rules

Business rules specific to this project live in `.claude/rules/project-web.md`
(written by `/rkt-tailor`). Check there for domain conventions beyond the generic
patterns above.
