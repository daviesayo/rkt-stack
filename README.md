# rkt-stack

Davies's personal Claude Code plugin for spinning up new projects with a
consistent, opinionated development workflow.

## What this is

`rkt` is a Claude Code plugin that bundles the skills, agents, rules, and
scaffolding tooling that evolved during the Witness project — so future projects
can go from zero to a fully-wired repo (git initialized, Linear project created,
AGENTS.md rendered, agents ready) in one command.

## Why it exists

While building Witness, a lot of personal development tooling accumulated:

- Skills for issue creation, backlog scans, implementation orchestration,
  review resolution
- Domain agents (database, backend, iOS, web, code review) with a
  smart-dispatcher / lean-worker pattern
- Worktree-per-domain workflow with lifecycle scripts
- Linear CLI + GraphQL integration with label conventions
- MemPalace write paths for persistent cross-session memory
- A structured review pipeline (`@claude` GitHub review → `/resolve-reviews`
  dispatches fixes)

All of that is currently locked into the Witness repo. `rkt-stack` is the
productized, project-agnostic version.

## Status

**Design phase.** See `docs/specs/` for the current design document.

## Presets

The plugin ships with four presets that cover the common project shapes:

| Preset     | Scaffolds                                   | Typical deploys              |
| :--------- | :------------------------------------------ | :--------------------------- |
| `full`     | backend + ios + web + database              | Railway + Vercel + Supabase  |
| `web`      | Next.js + Supabase                          | Vercel + Supabase            |
| `backend`  | FastAPI + Supabase                          | Railway + Supabase           |
| `ios`      | SwiftUI client (no backend)                 | —                            |

## Quickstart

### One-time install

```bash
# Add this repo as a Claude Code marketplace
claude marketplace add daviesayo/rkt-stack

# Install the plugin
claude plugin install rkt@daviesayo-marketplace

# You'll be prompted for userConfig values on first enable:
#   - default_linear_team_id
#   - default_github_owner
#   - default_ios_device
#   - default_gh_visibility
```

### Starting a new project

```bash
mkdir my-new-thing && cd my-new-thing
claude
# Then:
/bootstrap full my-new-thing
```

Follow the prompts. You'll end up with a fully-wired repo: Linear project
created, first commit made, optionally pushed to GitHub.

### Adopting an existing project

```bash
cd ~/some/existing/repo
claude
# Then:
/bootstrap
```

The skill detects your stack, suggests a preset, and layers the workflow in
non-destructively.

### Capturing project-specific rules

Once your project has real code and conventions:

```bash
cd ~/my-project
claude
/rkt-tailor
```

Captures business rules (state machine transitions, domain constants, etc.)
into `.claude/rules/project-*.md` and `agents/*.project.md` overlays.
Re-runnable as the project evolves.

### After the plugin updates

```bash
# Update the plugin
claude plugin update rkt@daviesayo-marketplace

# In each existing project, sync templates (preserves your project overlays)
cd ~/my-project
claude
/rkt-sync
```

## Development

This repo is the source for the `rkt` plugin. It is **not** itself a Claude
Code project using the plugin — it is the plugin's development workspace.

### Layout (target)

```
rkt-stack/
├── .claude-plugin/plugin.json       # plugin manifest
├── skills/                          # /bootstrap, /implement, /create-issue, etc.
├── agents/                          # backend, database, ios, web, code-reviewer
├── rules/                           # rule templates copied into projects
├── templates/                       # AGENTS.md, decisions.md, presets/<name>/
├── scripts/                         # worktree lifecycle scripts
├── bin/                             # rkt helper binary (PATH-added by plugin)
├── docs/
│   ├── specs/                       # design documents
│   └── decisions/                   # architectural decisions log
├── README.md
└── LICENSE
```

### Contributing

This is a personal project. Not accepting outside PRs at this time.

## Local development

Until the plugin is published to GitHub, develop against the local repo directly:

```bash
# Load the plugin for the current session only
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack

# Or add the local marketplace and install globally
claude marketplace add /Users/rocket/Documents/Repositories/rkt-stack
claude plugin install rkt@daviesayo-marketplace
```

### Verifying a change

After modifying a skill, agent, or script:

1. Bump `version` in `.claude-plugin/plugin.json` (even for experiments — Claude Code caches plugins by version)
2. Reinstall: `claude plugin update rkt@daviesayo-marketplace`
3. Start a fresh Claude Code session to load the updated plugin

### Running tests

```bash
cd tests/
./test-detect-stack.sh
./test-render-template.sh
./test-new-feature.sh
```

Integration tests (e.g. `test-bootstrap-e2e.sh`) require `gh auth status` to be valid and a real Linear team in `default_linear_team_id` — they create a throwaway GitHub repo and a throwaway Linear project, then delete them.

## License

MIT (once the `LICENSE` file is added — TBD).
