# Changelog

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
