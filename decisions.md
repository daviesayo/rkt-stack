# rkt-stack Decisions Log

> Append-only log of architectural decisions. Reverse chronological —
> prepend new entries to the top. **Never** edit or remove entries.
>
> Format: `[YYYY-MM-DD HH:mm] | [decision] | [rationale] | [actor]`

## Entries

[2026-04-18 15:00] | Cleanup scripts auto-return to main repo if called from inside a worktree (`ensure_out_of_worktrees` in `lib/common.sh`) | Orchestrators occasionally `cd` into worktrees for manual work; without the guard, cleanup deletes the shell's cwd and breaks the Claude session. Script-level guard is defense in depth alongside skill-level "cd to main" instruction in /implement Step 11 | davies+claude (0.1.2)

[2026-04-18 15:00] | `new-feature.sh` surfaces `git push`/`git pull` errors loudly instead of swallowing with `|| true` | Silent sync failures caused PRs to include unrelated pre-existing local commits. New `sync_main_with_origin` helper prints the actual git error, explains consequences, and returns non-zero so callers decide whether to proceed | davies+claude (0.1.2)

[2026-04-18 14:00] | `CLAUDE.md` is the primary agent-instructions file; `AGENTS.md` is an optional cross-tool proxy | Davies primarily uses Claude Code, which reads CLAUDE.md natively. Rendering AGENTS.md (as Witness did) added an indirection hop (`@AGENTS.md` inside CLAUDE.md) with no benefit. Users wanting Codex compat can write `AGENTS.md` with `@CLAUDE.md` inside it | davies+claude (0.1.1)

[2026-04-18 14:00] | Scripts always referenced via `${CLAUDE_PLUGIN_ROOT}/scripts/` from skills, agents, and templates | Ported /implement skill from Witness used `./scripts/new-feature.sh` which assumed a project-local scripts/ folder. In bootstrapped projects, scripts live only in the plugin, so the relative path fails. Explicit plugin root makes it work regardless of pwd | davies+claude (0.1.1)

[2026-04-18 14:00] | Agent descriptions must describe domain ownership across all applicable preset layouts | ios-implementer originally said "Owns ios/witness/ and ios/witnessTests/" — Witness-specific path that doesn't exist in any other project. backend/database/web had similar issues. Descriptions now enumerate the paths for each preset that uses the agent | davies+claude (0.1.1)

[2026-04-17 22:00] | Added `/rkt-tailor` skill as MVP-scope (mid-implementation) | Discovered during execution that ported agents were leaking Witness-specific business logic (cool-off mechanics, SPLIT_UNUSUALLY_LOW, specific module paths). Confirmed the need for a project-specific rules overlay that the plugin can't ship. `/rkt-tailor` scans a bootstrapped project and writes `.claude/rules/project-*.md` + `agents/*.project.md` overlays | davies+claude (brainstorm amendment)

[2026-04-17 22:00] | `/rkt-sync` never touches `.claude/rules/project-*.md` or `agents/*.project.md`; preserves user-edited sections inside sentinel-marked blocks within plugin-managed files | Sync must be safe to run after /rkt-tailor has captured project-specific rules. Explicit skip list + `<!-- rkt-managed:start -->` markers let users take over any section without fear of being overwritten | davies+claude (brainstorm amendment)

[2026-04-17 22:00] | Plugin agents and rules contain only generic stack conventions; project-specific business logic goes into overlays | The most important architectural principle. Named business features, business constants, module-specific mock paths, and company-specific conventions are NOT plugin content. Code-reviewer, for example, gates stack-specific checks on `rkt.json:deploy.db == "supabase"` but doesn't encode "audit events must fire before release.created" — that's project-specific | davies+claude (brainstorm)

[2026-04-17 21:00] | `/bootstrap` unified (one skill) with state detection routing into NEW, ADOPT, or `/rkt-sync` redirect — rather than separate `/adopt` skill | Running `/bootstrap` is always the right starting gesture; the skill figures out what state the directory is in. State: empty → NEW, existing code → ADOPT (non-destructive layering), has rkt.json → redirect to /rkt-sync. Prevents users from having to pick the right command | davies+claude (brainstorm)

[2026-04-17 21:00] | ADOPT mode uses per-file conflict resolution via `AskUserQuestion` with options [Keep mine] [Replace] [Merge] [Skip] | Non-destructive by default — no file gets overwritten silently. Coarser "replace all / keep all" would force wrong choices; per-file gives surgical control without being onerous (most files either don't exist or are identical, auto-handled) | davies+claude (brainstorm)

[2026-04-17 21:00] | 4 presets: `full`, `web`, `backend`, `ios`. Agents and rules shared across presets (modular) | Covers Davies's recurring project shapes without proliferation. Full = Witness-like (backend+ios+web+db). Web = Next.js+Supabase on Vercel. Backend = FastAPI on Railway. iOS = SwiftUI standalone. Agents (backend, database, ios, web, code-reviewer) are modular — each preset picks the subset it uses | davies+claude (brainstorm)

[2026-04-17 21:00] | iOS scaffolding is a README pointer only (Option A) — no xcodegen in MVP | No official Xcode CLI creates new iOS app projects from scratch. Templating `.xcodeproj` (pbxproj format) by hand is fragile. Option A (empty `ios/` with manual "Xcode → New Project" instructions) is honest about the limitation and zero-dependency. xcodegen integration can come later as an opt-in flag if manual Xcode steps become a real bottleneck | davies+claude (brainstorm)

[2026-04-17 21:00] | Config split: `userConfig` (plugin-level, prompted once at install) vs. `rkt.json` (per-project) | `userConfig` for stable cross-project values (Linear team ID, GitHub owner, iOS device name, default GH visibility). `rkt.json` for project-specific values (project name, Linear project ID, issue prefix, mempalace prefix, preset, deploy targets, bootstrap version). Mirrors git's `.gitconfig` (user-level) / `.git/config` (repo-level) split | davies+claude (brainstorm)

[2026-04-17 20:00] | Distribution via Claude Code plugin + marketplace (Option A from brainstorm) | Davies already uses Claude Code plugins heavily. Plugin system is designed for this exact pattern (skills + agents + rules + hooks as a versioned unit). Free evolution via `/plugin update`. Alternative shell-CLI or template-repo options would require translation layers and independent versioning | davies+claude (brainstorm)

[2026-04-17 19:30] | Stack menu approach (3-4 presets) rather than fully generic or single-stack | Davies cycles through a small set of stack combinations (iOS+FastAPI+Supabase, Next.js+Supabase, FastAPI service). Three well-tuned presets beats seven half-baked ones or a generic framework detector. Can add presets later without disrupting existing ones | davies+claude (brainstorm)

[2026-04-17 19:00] | Scope: personal-only productivity system (Option A from brainstorm) | Not a public product. Opinionated toward Davies's taste, stack preferences, and conventions. Simplifies everything: no public docs, no stack abstraction for strangers, no contribution flow. If the plugin ever warrants publishing, the personal-first choices can be relaxed later | davies+claude (brainstorm)

[2026-04-17 19:00] | All interactive prompts in skills use `AskUserQuestion` tool | This is a Claude-invoked workflow and should feel native inside Claude Code. Text-menu-style prompts (`[Accept]/[Cancel]`) with free-text interpretation are worse UX than structured choice widgets. Applies across /bootstrap, /implement, /create-issue, /scan, /resolve-reviews, /rkt-sync, /rkt-tailor | davies+claude (brainstorm)

[2026-04-17 19:00] | Agents are lean workers; skills inject context | Agents do NOT read CLAUDE.md, decisions.md, agent_learnings.md, or query MemPalace themselves. The orchestrator (`/implement`) gathers all context once and passes relevant pieces into each spawn prompt. Cuts token usage significantly; context stays consistent across parallel agents | davies+claude (carried forward from Witness)
