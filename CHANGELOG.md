# Changelog

## 0.1.3 — 2026-05-08

### Fixed

- **Bootstrap: skip preset `app/` and `lib/` when target Next.js project uses
  the `src/` directory layout.** Detection now reports
  `signals.nextjs_layout: "src" | "root" | "none"`. ADOPT mode's additive
  scaffold (Step A4) reads it and skips the preset's root-level `app/*` and
  `lib/*` paths when `nextjs_layout == "src"` so they don't fight an
  existing `src/app/` route tree. Previously the preset wrote a parallel
  route tree at the project root and broke the Next.js build. (RKT-103)
- **Bootstrap: render JSON null / number / boolean values in `rkt.json` as
  the correct JSON type instead of strings.** `render-template.sh` now
  detects the value type and consumes the template's surrounding quotes
  for non-string types, so `"backend": "{{DEPLOY_BACKEND}}"` with a JSON
  null value renders as `"backend": null` (not the string `"null"`).
  Affected `deploy.backend` for the `web` preset and any other typed
  values that flow through TMPVARS. (RKT-103)
- **Bootstrap: stage only bootstrap-introduced paths instead of `git add .`.**
  Step A4/A5 record every created path to `$STAGED_PATHS`; Step A7 stages
  only those. Pre-existing modifications to tracked files now stay
  unstaged with a visible warning at the start of A7, so an in-flight
  feature won't get swept into the `[rkt] Add workflow tooling` commit
  with the wrong attribution. (RKT-103)

### Tests

- New fixture `tests/fixtures/nextjs-src-layout/` exercising the `src/`
  directory regression.
- `tests/test-render-template.sh` covers JSON null, number, boolean, and
  string type preservation through template substitution.
- `tests/test-bootstrap-adopt.sh` adds Test 2 (src/-layout skip) and
  Test 3 (surgical staging preserves pre-existing dirty work).

## 0.1.2 — 2026-04-18

### Fixed

- **Worktree cleanup no longer deletes the directory the shell is standing in.**
  `cleanup-feature.sh` and `cleanup-merged-worktrees.sh` now auto-return to
  the main repo before touching worktrees, via a new
  `ensure_out_of_worktrees` helper in `scripts/lib/common.sh`. Prevents the
  class of bug where an orchestrator `cd`s into a worktree for manual work,
  then asks cleanup to run and ends up with a broken shell.
- **Sync failures during branch creation are now loud.** `new-feature.sh`
  surfaces `git push` / `git pull` errors instead of silently swallowing
  them with `|| true`. If sync fails, you see exactly why and can decide
  whether to proceed.
- `/implement` Step 11 (cleanup) now explicitly instructs the orchestrator
  to `cd` to the main repo root before running cleanup, for defense in
  depth even with the script-level guard.

## 0.1.1 — 2026-04-18

### Changed

- **CLAUDE.md is now the primary agent instructions file** (was `AGENTS.md`).
  If you also use Codex or other cross-tool agent frameworks, create
  `AGENTS.md` with just `@CLAUDE.md` inside it as a proxy. Claude reads
  CLAUDE.md natively — no indirection hop.
- Scripts are now referenced via `${CLAUDE_PLUGIN_ROOT}/scripts/` in all
  skills and templates. Scripts live in the plugin, not in bootstrapped
  projects. Fixes `/implement` failing to find `./scripts/new-feature.sh`
  in projects that don't have a `scripts/` folder.

### Fixed

- `ios-implementer` description no longer claims to own `ios/witness/` —
  now correctly generic.
- Agent descriptions for backend/database/web now cover both preset layouts
  (e.g., `backend/app/` in `full` preset vs. `app/` at root in `backend`
  preset).
- `AGENTS.md.tmpl` no longer mentions "Witness-specific" — template is
  now truly project-agnostic.
- Example comments in agents changed from `# e.g. "witness"` to
  `# e.g. "myapp"`.
- `detect-stack.sh` now reports `has_claude_md` as a primary signal (and
  keeps `has_agents_md` for backwards compat).

All notable changes to the rkt plugin are documented here.

## 0.1.0 — 2026-04-18

### Added

- Initial release with 4 presets: `full`, `web`, `backend`, `ios`.
- `/bootstrap` skill (NEW + ADOPT modes) with state detection, preset
  auto-suggestion, non-destructive file handling, and Linear project
  creation/linking.
- `/rkt-sync` skill for updating plugin-managed templates after plugin
  updates, preserving project-owned overlays and user-edited sections.
- `/rkt-tailor` skill for capturing project-specific business rules
  into `.claude/rules/project-*.md` and `agents/*.project.md` overlays
  after bootstrap.
- 5 domain agents ported from Witness (generic stack conventions only):
  backend, database, iOS, web, code-reviewer.
- 4 skills ported: `/implement`, `/create-issue`, `/scan`, `/resolve-reviews`.
- Rules for FastAPI, Supabase, Vite+React, Next.js, SwiftUI.
- Worktree lifecycle scripts: `new-feature`, `cleanup-feature`,
  `cleanup-merged-worktrees`.
- Marketplace manifest for `daviesayo-marketplace`.
