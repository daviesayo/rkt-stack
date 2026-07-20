# Changelog

## [Unreleased]

Hardening pass driven by the first real run against a live site (AlayaCare).
Every fix below is a defect that run exposed.

### Fixed

- **Multi-origin recordings no longer fail.** Derivation used to abort when a
  recording spanned more than one origin, and advised recording "a narrower
  section" — impossible advice, since an asset CDN, vendor telemetry, an
  embedded chat widget and an identity provider fire on every page of a modern
  SPA. The primary API origin is now selected by JSON-response volume, with
  third-party and identity origins excluded and every dropped origin reported.
  The AlayaCare recording spanned 10 origins and now derives 31 endpoints.
- **Credentials are captured as a bundle.** Only the single highest-coverage
  credential was kept, producing clients that authenticate partially and 401.
  AlayaCare needs a session cookie, an access-token cookie and an
  `x-csrf-token` header simultaneously; all three are now captured and applied,
  with cookies merged into one header.
- **Credential coverage is scored against API calls, not the whole recording.**
  An app origin also serves its own HTML and JS, which sank real credentials
  below any threshold: the AlayaCare session cookie scored 20% despite riding
  essentially every API call.
- **Build-artifact JSON is no longer mistaken for API endpoints.** Micro-frontend
  and webpack manifests under `/shell/`, `/webapp/` and similar are dropped.
- **The recorder no longer hangs on start.** Commands arrive via an append-only
  file instead of a named pipe. Opening a FIFO for read blocks until a writer
  appears, and since each agent bash call is a separate shell the writer never
  persisted; the recorder sat with an empty log until a throwaway holder process
  was improvised by hand.
- **`snapshot` does something.** It was `case "snapshot": break;`, which made
  the documented "map the site" step impossible and forced the user to paste
  URLs manually. It now returns page headings and deduplicated links.

### Added

- **Credential renewal.** Access tokens on real SPAs live minutes: AlayaCare's
  is 300 seconds, so a statically captured credential is dead long before any
  cron fires. Recordings are scanned for an OAuth token exchange (detected by
  response shape, so it works for any standards-compliant provider rather than
  one vendor), and `call` performs the `refresh_token` grant and retries once on
  a 401, persisting rotated refresh tokens. Where no token exchange exists, the
  manifest records a browser re-auth fallback using the recorded Chrome profile.
- Manifests record `authBundle` and `refresh`; **`schemaVersion` is now 2**, and
  version 1 manifests are rejected rather than replayed with a dead credential.

## 0.5.0 — 2026-07-20

Adds authentication analysis and a `call` subcommand to `/derive-client`.

### Added

- **Auth analysis** — detects the session credential (cookie, bearer, or CSRF)
  from recorded traffic, traces where it was minted, and reads its expiry from
  a JWT `exp` claim or cookie attributes. The manifest records where the
  credential lives; the value goes to `<rkt-root>/secrets/<site>.json` at 0600.
- **`call` subcommand** — invokes a derived read endpoint by id with path and
  query params, applying the stored credential and the pinned User-Agent and
  client hints. `--dry-run` prints the built request with the credential
  redacted.
- **Rate limiter** — serializes requests and spaces them 400 to 1300 ms. It
  becomes load-bearing when generated clients issue requests in a loop.

### Fixed

- **Read mode now derives GET and HEAD only.** Previously any recorded write
  that returned 2xx JSON became an endpoint in `client.json`. Harmless while
  nothing could execute a manifest, but not once `call` shipped. `call` refuses
  non-read methods as a second line of defence.
- **TypeScript is now actually typechecked.** `tsconfig.json` referenced a
  `bun-types` package that is not installed, so `tsc --noEmit` had always
  failed. The test wrapper now runs it.

### Changed

- `rktRoot()` honors `RKT_CLIENTS_ROOT` under `NODE_ENV=test` only, so tests
  redirect to a temp directory instead of writing to the user's real home.
  Production behavior is unchanged, and the path-confinement boundary cannot
  be moved by the environment.

### Security

- Credentials are written atomically (temp file at 0600, then rename) so an
  overwrite never leaves the file world-readable, live in a 0700 directory,
  are never placed in a manifest, and are redacted before any output
  truncation.

## 0.4.0 — 2026-07-20

Adds `derive-client`: record a logged-in browser session and derive a typed
client manifest for a site's internal API.

### Added

- **`/derive-client` skill** — records a HAR from the user's real Chrome via a
  persistent profile, then derives a validated `client.json` endpoint manifest.
  Read-only in this release: auth analysis, code generation, repair, and write
  mode follow in later releases.
- **Bun/TypeScript workspace** at `skills/derive-client/scripts/` with a pinned
  Playwright dependency. First non-bash runtime in the plugin, scoped to this
  skill; `tests/test-derive-client.sh` skips rather than fails when bun is absent.

### Notes

- Recording requires a fresh sign-in the first time any site is recorded: the
  Playwright profile is separate from the user's day-to-day Chrome profile,
  which Chrome 136+ blocks from automation.
- Sites that route API traffic through a Service Worker will record empty.
  The recorder sets `serviceWorkers: 'block'` to prevent this where possible.

## 0.3.8 — 2026-07-02

Bakes spawn discipline and Linear PR-title hygiene into the agent definitions.

### Changed

- **All five agents** (`backend-implementer`, `web-implementer`, `ios-implementer`,
  `database-implementer`, `code-reviewer`) gain a **Spawn discipline** section:
  `Agent` is disallowed by design; instead of working around it, implementers end
  their report with a structured fan-out request to the orchestrator (what, why,
  estimated agent count), and the reviewer returns NEEDS_DISCUSSION rather than
  delegating judgment.
- **All four implementers**: PR titles covering multiple Linear issues must list
  every ID in full, comma-separated (`RKT-133, RKT-134`), never slash-shorthand
  (`RKT-133/134`) — Linear only links and auto-closes IDs written in full.

## 0.3.7 — 2026-06-28

Adds `/scaffold` skill with shared memory pattern setup.

### Added

- **`/scaffold` skill** (moved from `~/.claude/commands/scaffold.md` into the rkt plugin). Scaffolds `AGENTS.md` + `CLAUDE.md` from the reusable template, fills in project-specific facts, and now also wires the shared memory pattern: creates the per-project memory dir under `~/.claude/projects/<encoded-path>/memory/`, symlinks it as `.memory/` at the repo root, adds `.memory` to `.gitignore`, and copies `memory-read.mdc` + `memory-write.mdc` from the canonical rkt-stack templates into `.cursor/rules/`. All memory steps are idempotent — skipped silently if already present.

## 0.3.6 — 2026-06-27

Adds `/office-hours` — a YC-style product diagnostic and design session skill.

### Added

- **`/office-hours` skill.** Two-mode product thinking session: Startup mode
  runs six forcing questions (demand reality, status quo, desperate specificity,
  narrowest wedge, observation, future-fit) with anti-sycophancy rules and
  concrete pushback patterns; Builder mode is a generative design partner for
  side projects and hacks. Produces a design doc in `docs/design/`, runs an
  adversarial spec review loop before presenting for approval, and closes with
  signal reflection and a concrete assignment. Cross-model second opinion routes
  to Codex CLI, OpenRouter MCP, or a Claude subagent in priority order.

## 0.3.5 — 2026-05-17

Fixes Codex skill discovery for the visual identity DESIGN.md skill.

### Fixed

- **`visual-identity-to-design-md` now has loader-safe skill metadata.**
  Shortens the frontmatter description to a single triggering-condition string
  so Codex does not skip the skill during discovery.
- **Manifest tests now validate skill frontmatter shape.** The packaging test
  checks every bundled `SKILL.md` has scalar `name` and `description` fields.

## 0.3.4 — 2026-05-16

Fixes cross-tool plugin packaging so Claude Code and Codex install the same
canonical rkt package.

### Fixed

- **`plugins/rkt` is now the real plugin root.** Replaces the symlink-only
  wrapper with tracked manifests, skills, scripts, templates, rules, agents,
  README, and LICENSE under `plugins/rkt/`, avoiding Codex's empty cache
  install failure for `rkt@daviesayo-marketplace`.
- **Claude and Codex marketplaces both target `./plugins/rkt`.** The root
  marketplace catalogs stay at `.claude-plugin/marketplace.json` and
  `.agents/plugins/marketplace.json`; the actual plugin package lives in one
  place.
- **Skills use host-neutral runtime wording.** Bundled-file snippets now use
  `RKT_PLUGIN_ROOT` with `CLAUDE_PLUGIN_ROOT` as the Claude fallback, and
  interactive prompts reference the host's native structured question tool.

### Tests

- `tests/test-plugin-manifests.sh` now asserts real packaged manifests and
  skill files under `plugins/rkt`, verifies both marketplace paths, and copies
  the package to a temp dir as a cache-shape smoke test.

## 0.3.3 — 2026-05-16

Adds visual identity analysis and DESIGN.md generation skills to the rkt plugin.

### Added

- **`visual-identity-folder-analysis` skill.** Analyzes folders of visual
  references into contact sheets, palette samples, image-by-image audits, and
  a cohesive visual identity report.
- **`visual-identity-to-design-md` skill.** Extends visual identity analysis
  into a stack-aware `DESIGN.md`/`design.md` contract for component-based
  product work, with Google DESIGN.md linting guidance.

## 0.3.2 — 2026-05-09

Fixes Codex marketplace discovery for the Git-backed marketplace install.

### Fixed

- **Codex marketplace path now uses `./plugins/rkt`.** Codex rejects an empty
  normalized plugin path from `./`, so the marketplace entry now points at a
  non-empty plugin wrapper path.
- **`plugins/rkt` wrapper keeps one source of truth.** The wrapper is made of
  symlinks back to the repo-root plugin manifest, skills, scripts, templates,
  rules, and agents, so Git-backed upgrades still update the canonical repo
  contents rather than a copied plugin tree.

## 0.3.1 — 2026-05-09

Codex support release. This adds a Codex-native plugin manifest and marketplace
entry while keeping the existing Claude Code plugin layout intact.

### Added

- **Codex plugin manifest at `.codex-plugin/plugin.json`.** Loads the existing
  `skills/` tree from the repo root, includes Codex interface metadata, and is
  version-locked with the Claude plugin manifest.
- **Codex marketplace entry at `.agents/plugins/marketplace.json`.** Points the
  `rkt` plugin at `./` so a Git-backed Codex marketplace can install the plugin
  from the same repository root instead of a copied nested plugin directory.
- **Manifest sync test.** `tests/test-plugin-manifests.sh` validates both
  plugin manifests and asserts that Claude and Codex versions stay in sync.

## 0.3.0 — 2026-05-08

Three rough edges from the wdyd-platform `/rkt:implement` run, all addressed.
Driven from a structured feedback brief. Pre-release verification: full test
suite + plugin validate.

### Fixed

- **Bootstrap derives `linear.issue_prefix` from the Linear team key, not the
  project name.** A project named `wdyd` under team `RKT` was bootstrapping
  with prefix `WDYD`, and every `gh pr create --title "[WDYD-42] ..."` was
  silently failing to attach to the matching `RKT-42` Linear issue. NEW mode
  now prompts for the team before the prefix and defaults the prefix to
  `team.key`. ADOPT-create-new uses the same source. ADOPT-link-existing was
  already correct.- **`/rkt:implement` Step 0b verifies prefix-vs-team-key on every invocation.**
  Fails loudly with an actionable error pointing at `/rkt:rkt-tailor` if the
  prefix in `rkt.json` disagrees with what Linear actually uses for the
  project's team. ~200ms cost (one Linear API call); chosen always-on over
  cached because the failure mode it guards against is silent.- **`/rkt:rkt-tailor` adds a Step 1b prefix-repair action.** Detects drift,
  rewrites `rkt.json:linear.issue_prefix`, re-renders `CLAUDE.md`, commits.
  Does not rewrite existing branches/PRs — only fixes the source so future
  work picks up the correct prefix.
### Added

- **Canonical GitHub label manifest at `templates/github-labels.json`.** Used
  by `scripts/sync-github-labels.sh`, surfaced in `/rkt:create-issue`,
  `/rkt:implement`, and the four domain agents. The set covers types
  (`Feature`, `Bug`, `Improvement`, `Ops`, `Docs`), domains (`Backend`,
  `Database`, `iOS`, `Web`), and the special `Blocked` label — exactly what
  the skills reference, with stable colour assignments.- **`scripts/sync-github-labels.sh`** — idempotently syncs the manifest onto
  the current repo's `origin` remote (`gh label create --force`). No-op when
  no remote / no `gh` CLI; hard error only on missing or malformed manifest.
  Wired into bootstrap NEW Step N7 and ADOPT Step A7 so labels exist on the
  repo before any agent runs `gh pr create`.- **Label-recovery hook in domain agents.** When `gh pr create --label` fails
  with "could not add label", the agent runs `sync-github-labels.sh` and
  retries once. Covers older bootstraps and label resets that drop the
  canonical set.- **`docs` domain in `/rkt:implement`** — orchestrator-owned, no subagent
  spawn. Owns root meta files (`PROGRESS.md`, `decisions.md`, `OPS.md`,
  `dev-log.md`/`DEVLOG.md`, `README.md`, `CLAUDE.md`, `AGENTS.md`),
  `docs/**`, ADRs. Pure-bookkeeping issues (e.g. backfilling `decisions.md`,
  reflecting shipped phases in `PROGRESS.md`) now have a first-class home
  instead of forcing an awkward `Web` label. Worktree+PR is still the
  default (consistent with other domains, gets auto-review).- **`new-feature.sh` accepts `docs` as a domain.** Default invocation
  (no domain args) still creates only the four code domains — `docs` is
  opt-in to avoid empty worktrees on every implement run.

### Tests

- `tests/test-sync-github-labels.sh` — manifest well-formedness, no-remote
  no-op path, missing-manifest hard-error path, missing-`gh` graceful skip,
  `--quiet` suppression.
- `tests/test-prefix-from-team-key.sh` — regression catch on the
  team-key-as-prefix contract across `bootstrap`, `implement`, and
  `rkt-tailor` SKILL.md files; end-to-end render assertion that
  `TMPVARS.LINEAR_PREFIX` flows correctly into `rkt.json` and that no
  `WDYD`-style hardcoded prefix can leak into the rendered `CLAUDE.md`
  when the team key is `RKT`.
- `tests/test-new-feature.sh` extended — `docs` accepted as a domain,
  branch follows `[ISSUE-ID]/docs/[description]` convention, default
  invocation skips `docs` (opt-in), invalid domain still rejected, usage
  text mentions `docs`.

## 0.2.0 — 2026-05-08

Adds the `/promptsmith` skill — a prompt-engineering tool forked from
`nidhinjs/prompt-master`, refined through post-implementation verification
testing (`/writing-skills` methodology) before this release shipped.
Verification surfaced four refinement candidates; all were grilled on
before any implementation, and all are folded into this release.

### Added

- **New skill: `/promptsmith`.** A prompt-engineering skill for crafting
  production-ready prompts for AI tools (Claude, Claude Code, Codex CLI,
  GPT, Cursor, Gemini, image/video/voice AI). Auto-activates on
  prompt-engineering requests; also explicitly invocable as `/promptsmith`.
  - **Two-stage flow.** Stage 1 auto-expands the user's rough idea into
    a draft using the appropriate output schema. Stage 2 asks targeted
    clarifying questions only when critical dimensions are genuinely
    missing — never always-3 like upstream prompt-master.
  - **Default behavior is interactive.** When critical dimensions are
    missing, questions go through `AskUserQuestion` and wait for
    response. Ship-with-flags fallback fires only on explicit user skip
    ("just produce it," "don't ask me") or detected async/batch use.
    "I don't know" on a single question skips that question only, not
    the whole batch.
  - **`--explain` opt-in mode.** Triggered by the token `--explain` OR
    natural-language phrases like "explain your reasoning," "show your
    work," "why this prompt," "how did you get there." Appends a
    structured `Reasoning` block after the standard output showing
    schema picked + why, profile loaded + sections applied, intent
    dimensions extracted, questions asked, assumptions flagged. Default
    off — the existing hard rule against padding output with unrequested
    explanations remains authoritative for normal invocations.

- **Five-section tool profile template.** All deepened tool profiles
  follow: framing / required structure / default mode / quality contract /
  common failure modes / template references. Three profiles use the new
  template in this release:
  - **Codex CLI** (new): agentic loop framing, Goal/Context/Constraints/
    Done-when required structure, verification-as-contract discipline,
    fork-instead-of-persist recovery pattern.
  - **Claude Code** (rebuilt): Opus-4.7-specific behaviors not in the
    upstream profile — context window as binding constraint, Read tool's
    all-or-nothing nature, hooks vs CLAUDE.md determinism, kitchen-sink
    session anti-pattern, two-correction rule, 4.7-vs-4.6 gap-filler
    regression, monorepo subdirectory trick, MCP server context cost.
  - **Cursor** (rebuilt; renamed from `cursor-windsurf` since Windsurf
    has diverged): Cursor 1.x specifics — Ask/Plan/Agent/Manual mode
    stratification, `@`-pinning mechanics, `.cursor/rules/*.mdc`
    displacing legacy `.cursorrules`, Auto-mode's Composer-1 routing,
    Max mode's 200-tool ceiling, Auto-Run permissive allowlist + prompt
    injection risk.

- **SKKO output schema** (Situation/Task/Objective/Knowledge/Examples) —
  Template N in `references/templates.md`. Routed automatically by task
  type: SKKO for generative/creative outputs (writing, marketing, image,
  video, voice); existing templates (G, H, M, E, F, A) for code,
  agentic, analytical, pattern, simple tasks. **Structure rule:**
  Situation, Task, Objective, and Examples are fixed top-level sections;
  Knowledge may decompose into named peer headers (Brand voice,
  Constraints, Success criteria, Audience nuances) when substantial.
  Bounded flexibility, not free-form.

### Changed

- **CLAUDE.md and `plugin.json` description broadened.** rkt is now framed
  as "personal AI toolbox" rather than "project-bootstrapping workflow" —
  reflects that the plugin's scope grew beyond bootstrapping and now
  includes prompt engineering and other ongoing-work skills.

### Deferred

- **GPT-5.5 and Gemini 3 profile rebuilds (T2)** are queued for a future
  release. The five-section template established here is the standard
  shape; T2 will follow it.

### Provenance

- `skills/promptsmith/` is forked from
  [nidhinjs/prompt-master](https://github.com/nidhinjs/prompt-master) at
  commit `7a02ddd31bad3056cc3ccf0af2b23d7b30d4abc2` (upstream version 1.6.0),
  MIT-licensed. The fork applies the spirit of upstream
  [PR #13](https://github.com/nidhinjs/prompt-master/pull/13) (progressive
  disclosure — tool-routing profiles moved from `SKILL.md` into
  `references/tool-profiles.md`) and fixes the three structural gaps from
  upstream [issue #32](https://github.com/nidhinjs/prompt-master/issues/32):
  data-sensitivity hard rule, verification checklist exit conditions, and
  the 3-question-limit precedence note. Two-stage flow inspired by
  [Prompt Cowboy](https://promptcowboy.ai/). The fork is **not tracking
  upstream** — see `skills/promptsmith/NOTICE.md` for full attribution.

## 0.1.4 — 2026-05-08

### Fixed

- **`rkt-sync`: replaced nonexistent preset names with the canonical four.**
  `PRESET_RULES` was keyed by `web-next`, `fullstack`, and `fullstack-next`
  — none of which are real presets. Result: `/rkt:rkt-sync` was a silent
  no-op for `full`, `backend`, and `ios` projects (no rules synced) and
  applied `web-vite` to `web` projects that actually use Next.js. The map
  now mirrors bootstrap's Step N4/A5 mapping exactly. (RKT-109)

### Added

- **`require_linear` guard for Linear-dependent skills.** Bootstrap supports
  a `[Skip Linear]` path that leaves `linear.project_id` empty. Previously,
  `/rkt:implement`, `/rkt:create-issue`, and `/rkt:scan` would pass
  `--project-id ""` to the linear CLI and either error opaquely or operate
  on the wrong scope (`/scan` would list issues across the entire workspace
  instead of just the project). The new guard in `scripts/lib/common.sh`
  fails fast with an actionable error pointing to `/rkt:bootstrap`. Wired
  into Step 0 of all three skills. (RKT-110)

### Tests

- `tests/test-rkt-sync.sh` asserts all 4 presets resolve to the bootstrap-
  canonical rule set, every rule file referenced exists, and the stale
  preset names are gone from rkt-sync.
- `tests/test-common.sh` covers `require_linear` across 6 cases (missing
  rkt.json, empty/null/absent linear, valid project_id, error message
  shape).

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
