# rkt-stack — Claude Code Instructions

This is the **development workspace for the `rkt` Claude Code plugin**. It is
not a project that consumes the plugin — it is the plugin's source.

For plugin users' docs see `README.md`. This file is for Claude sessions
working *on* the plugin itself.

---

## Session Start Protocol

Every session, in this order:

1. Read `docs/specs/` (latest-dated file) — the architectural design doc
2. Read `decisions.md` — reverse-chronological decision log. Skim the top
   10 or so for recent context; go deeper if your task touches something
   with a recent decision.
3. Read `CHANGELOG.md` top entries — what shipped in the last releases
4. Run `git log --oneline -10` — recent commits
5. Run all tests to confirm clean baseline: `for t in tests/test-*.sh; do bash "$t" | tail -1; done`

Do not skip. The conversation history that produced this plugin is long and
dense; the files above are the distilled context.

---

## What this plugin is

`rkt` is a Claude Code plugin for Davies's personal project-bootstrapping
workflow. It scaffolds new projects (or adopts existing ones) with skills,
agents, rules, and conventions that evolved during Witness.

**Installed as:** `rkt@daviesayo-marketplace` (from `daviesayo/rkt-stack` on
GitHub). Users install via `claude plugin marketplace add daviesayo/rkt-stack`
then `claude plugin install rkt@daviesayo-marketplace`.

**Presets:** `full`, `web`, `backend`, `ios` (see `README.md` for the matrix).

**Shipping components:** 7 skills, 5 agents, 5 rules, 7 templates, 4 preset
folder scaffolds, 5 scripts, 7 tests.

---

## Architecture — read before making changes

### Generic vs. project-specific (load-bearing)

Plugin agents and rules contain **only generic stack conventions**. Anything
project-specific (business rules, domain constants, specific module paths,
named features like "cool-off mechanics") lives in **project-owned overlays**
written by `/rkt-tailor`:

- `.claude/rules/project-backend.md`, `project-database.md`, `project-ios.md`,
  `project-web.md`
- `agents/<agent>.project.md` — agent-level overlays

If you find yourself adding something named or domain-specific to a plugin
agent or rule, stop. That belongs in `/rkt-tailor`'s output space, not here.

### CLAUDE.md is primary; AGENTS.md is optional proxy

Bootstrap renders `CLAUDE.md` into new/adopted projects. Claude reads it
natively — no indirection. Users who also use Codex or Cursor can create
`AGENTS.md` with `@CLAUDE.md` inside it as a cross-tool proxy. The plugin
template is `templates/CLAUDE.md.tmpl`.

Detection treats `has_claude_md` as the primary signal for ADOPT mode;
`has_agents_md` is kept for backwards compatibility with pre-0.1.1 projects.

### Scripts always resolve via `${CLAUDE_PLUGIN_ROOT}/scripts/`

Scripts live in the plugin, not in bootstrapped projects. **Never** reference
`./scripts/` in any skill, agent, rule, or template — that path doesn't exist
inside projects. Always use `${CLAUDE_PLUGIN_ROOT}/scripts/<name>.sh`.

Tests (`tests/test-*.sh`) can use `$HERE/../scripts/` because they run from
the plugin dev workspace.

### Lean workers, smart orchestrator

Agents don't read `CLAUDE.md`, `decisions.md`, `agent_learnings.md`, or query
MemPalace themselves. The `/implement` skill (orchestrator) gathers all
context once and injects the relevant pieces into each agent's spawn prompt.
Critical for token efficiency.

### Worktree safety

Any script that mutates `.worktrees/` must source `scripts/lib/common.sh` and
call `ensure_out_of_worktrees` first. This auto-returns the caller to the
main repo if invoked from inside a worktree — preventing the
"delete-the-directory-I'm-standing-in" class of bug.

Same applies to `/implement` Step 11: always `cd` to main repo root before
running cleanup. The script guards this too, but be explicit.

### Sync before branching

`new-feature.sh` pushes unpushed commits up and pulls remote commits down
(`sync_main_with_origin` in `common.sh`) before creating worktree branches.
If sync fails, the script surfaces the error and asks the caller to decide
rather than silently branching from out-of-sync main.

---

## Repo layout

```
rkt-stack/
├── .claude-plugin/
│   ├── plugin.json                  # manifest; bump version on every release
│   └── marketplace.json             # registers rkt in daviesayo-marketplace
├── skills/                          # 7 skills: bootstrap, rkt-sync, rkt-tailor,
│   │                                  implement, create-issue, scan, resolve-reviews
├── agents/                          # 5 agents (generic stack conventions)
├── rules/                           # 5 path-scoped rules
├── templates/                       # 7 tokenized files + 4 preset folder scaffolds
├── scripts/
│   ├── lib/common.sh                # shared helpers (derive_prefix, slugify,
│   │                                  json_get, ensure_out_of_worktrees,
│   │                                  sync_main_with_origin)
│   ├── new-feature.sh
│   ├── cleanup-feature.sh
│   ├── cleanup-merged-worktrees.sh
│   ├── detect-stack.sh              # emits JSON for bootstrap state detection
│   └── render-template.sh           # {{TOKEN}} substitution with unresolved-token guard
├── tests/                           # 7 bash integration tests
│   └── fixtures/                    # sample projects for adopt detection tests
├── docs/
│   ├── specs/2026-04-17-rkt-plugin-design.md
│   └── plans/2026-04-18-rkt-plugin-implementation.md
├── CHANGELOG.md
├── CLAUDE.md                        # this file
├── decisions.md                     # decision log
├── LICENSE
└── README.md                        # user-facing plugin docs
```

---

## Development workflow

### Making a change

1. Edit the relevant skill/agent/rule/template/script
2. **Bump `version` in `.claude-plugin/plugin.json`** (Claude Code caches by
   version — if you don't bump, users won't pick up the change)
3. Prepend an entry to `CHANGELOG.md` describing the change
4. Run all tests: `for t in tests/test-*.sh; do bash "$t" | tail -1; done`
5. Validate: `claude plugin validate .`
6. Commit with a descriptive message (imperative mood, "Fix X" / "Add Y")
7. Tag `vX.Y.Z` if shipping: `git tag -a v0.1.3 -m "summary"`
8. Push: `git push origin main <tag>`
9. In each project using rkt, the user runs `claude plugin marketplace update
   daviesayo-marketplace && claude plugin update rkt@daviesayo-marketplace`

### Testing locally before push

```bash
# Use the local dir directly (bypasses marketplace cache)
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack
```

In that session, the plugin is loaded live — skill edits show up on next
Claude restart. Version bumps aren't required for `--plugin-dir` mode.

### Adding a new skill or agent

- Skills: add `skills/<name>/SKILL.md` with YAML frontmatter (`name`,
  `description`). Use `AskUserQuestion` for prompts, never bash `read`.
- Agents: add `agents/<name>.md` with `name`, `description`,
  `disallowedTools`, `model` frontmatter. Keep generic; put business logic
  hooks to `.claude/rules/project-*.md` at the bottom.
- Validate: `claude plugin validate .`
- Update `templates/CLAUDE.md.tmpl` if users' projects need to know about it.

### Adding a new preset

- `templates/presets/<name>/` — folder scaffold
- Update rule selection in `skills/bootstrap/SKILL.md` Step N4 and Step A5
- Update preset menu in `skills/bootstrap/SKILL.md` Step N2
- Update `README.md` preset table
- Add a fixture under `tests/fixtures/` for ADOPT detection if the stack is
  autodetectable
- Update `scripts/detect-stack.sh` with any new signals
- Add tests

---

## Testing conventions

All tests are bash (`tests/test-*.sh`), idempotent, use `mktemp -d` for temp
state with a `trap` cleanup. Each test prints exactly one line: `PASS: <name>`
or `FAIL: <reason>`. Run order doesn't matter.

- **Unit-ish** (`test-common.sh`, `test-render-template.sh`,
  `test-detect-stack.sh`, `test-new-feature.sh`): exercise a specific script
  or helper function
- **Integration** (`test-bootstrap-new.sh`, `test-bootstrap-adopt.sh`,
  `test-rkt-sync.sh`): simulate the full flow of a skill without calling
  external APIs (Linear/GitHub skipped; stubbed with placeholder strings)

If you add a script with real logic, add a test. If you change behavior,
update the corresponding test first (TDD).

---

## Conventions

- **Commits:** imperative mood. Descriptive body when the change is non-trivial.
- **Versioning:** semver. PATCH for fixes, MINOR for new features, MAJOR for
  breaking changes to bootstrapped projects' expectations.
- **No placeholders in plan/spec docs** — concrete content or nothing.
- **UX principle:** every interactive prompt in a skill uses `AskUserQuestion`.
- **Token efficiency:** prefer inline edits over dispatching subagents for
  small polish. Use cheaper models (haiku/sonnet) for mechanical tasks; reserve
  opus for genuine reasoning.

---

## References

- `docs/specs/2026-04-17-rkt-plugin-design.md` — the full architectural spec
- `docs/plans/2026-04-18-rkt-plugin-implementation.md` — the 52-task plan
- `decisions.md` — what was decided and why
- `CHANGELOG.md` — what shipped in each release
- Claude Code plugin reference:
  https://code.claude.com/docs/en/plugins-reference

---

## Working with Davies

Davies is the author. Flag architectural trade-offs before implementing.
Don't leak business logic into the plugin — this was a real bug that shipped
in 0.1.0 and got remediated. When in doubt about what's generic vs.
project-specific, err on the side of "move to `/rkt-tailor`'s overlay."
