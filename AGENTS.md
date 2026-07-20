# rkt-stack Agent Instructions

This is the development workspace for the `rkt` Claude Code and Codex plugin.
It is not a project that consumes the plugin; it is the plugin source.

For plugin users' docs see `plugins/rkt/README.md`.

## Session Start

At the start of non-trivial work, read:

1. `docs/specs/` latest-dated file for the architecture.
2. `decisions.md` top entries for recent decisions.
3. `plugins/rkt/CHANGELOG.md` top entries for recent releases.
4. `git log --oneline -10` for recent commits.
5. Run a baseline when useful: `for t in tests/test-*.sh; do bash "$t" | tail -1; done`.

## Package Shape

`plugins/rkt/` is the canonical plugin package root for both Claude Code and
Codex. Do not recreate root-level duplicate `skills/`, `scripts/`, `templates/`,
`rules/`, or `agents/` directories.

Root-level marketplace catalogs stay at:

- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`

Both should point to `./plugins/rkt`.

The plugin manifests live at:

- `plugins/rkt/.claude-plugin/plugin.json`
- `plugins/rkt/.codex-plugin/plugin.json`

Keep their versions in sync.

## Runtime Paths

Scripts live in the plugin package, not in bootstrapped projects. Skills should
use `${RKT_PLUGIN_ROOT}/scripts/<name>.sh` after setting:

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
```

Tests should resolve the plugin package via `tests/../plugins/rkt`.

## Guardrails

- Keep plugin agents and rules generic. Project-specific business rules belong
  in `/rkt-tailor` output, such as `.claude/rules/project-*.md` and
  `agents/*.project.md`.
- Never reference `./scripts/` from skills, agents, rules, or templates.
- Do not use bash `read` for skill prompts. Use the host's native structured
  question tool when available; otherwise ask a concise direct question.
- Any script that mutates `.worktrees/` must source
  `plugins/rkt/scripts/lib/common.sh` and call `ensure_out_of_worktrees`.
- `new-feature.sh` intentionally syncs with origin before branching. If sync
  fails, surface the issue instead of silently branching from stale main.
- Keep tests idempotent. Use temp directories and cleanup traps.

## Making Changes

1. Edit files under `plugins/rkt/` unless the work is explicitly repo-level
   scaffolding, tests, or marketplace metadata.
2. Prepend a concise entry under `## [Unreleased]` in
   `plugins/rkt/CHANGELOG.md`. Do not bump the manifest versions here; that
   happens once at release time (see Release Flow).
3. Run tests: `for t in tests/test-*.sh; do bash "$t"; done`.
4. Validate the Claude package: `claude plugin validate plugins/rkt`.
5. Review `git status --short` and do not stage unrelated user files.

## Release Flow

After work is done and verified:

**Bump versions at release time, not per change.** A version number tells whoever
installs the plugin what they received, so it changes when a usable capability
ships, not every time a branch merges. Multi-part work (a feature delivered
across several plans or PRs) accumulates under `## [Unreleased]` in
`plugins/rkt/CHANGELOG.md` and spends a single version when the capability is
actually usable end to end. A bump that never gets tagged was not a release.

1. Choose the version bump by impact:
   - Patch: packaging fixes, docs, small behavior fixes.
   - Minor: new skills, new presets, new user-visible capabilities.
   - Major: breaking changes to bootstrapped project expectations.
2. Rename the `## [Unreleased]` heading to the chosen version with today's
   date, consolidating its entries. Bump both plugin manifests in lockstep.
3. Commit with an imperative message.
4. Create an annotated tag matching the plugin version, for example:
   `git tag -a v0.3.4 -m "v0.3.4"`.
5. Seek explicit approval before pushing to `main` or pushing tags.
6. After approval, push both branch and tag: `git push origin main vX.Y.Z`.

Do not push unverified work. Do not push without approval unless the user has
explicitly asked for that push in the current task.

## References

- `docs/specs/2026-04-17-rkt-plugin-design.md`
- `docs/plans/2026-04-18-rkt-plugin-implementation.md`
- `decisions.md`
- `plugins/rkt/CHANGELOG.md`
