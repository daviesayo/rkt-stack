# Changelog

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
