# AGENTS.md — {{PROJECT}}

<!-- H1 names the project. One line stating this file is the binding contract for any agent (human or AI) working in this repo, and that it overrides habit/memory on conflict. -->

This file is the source of truth for how we build in this repo. Humans and AI agents both follow it. If a rule here conflicts with habit or memory, **this file wins**. The locked architecture lives in {{`docs/...BRIEF.md`}} — do not contradict it without an explicit human STOP.

---

## How to use this template

<!-- Not part of the generated AGENTS.md — delete this block once you've filled the file in. -->

- Copy this into a new repo as `AGENTS.md`; add a root `CLAUDE.md` that just contains `@AGENTS.md`.
- Fill every `{{PLACEHOLDER}}`; delete sections that don't apply to this project.
- Keep the voice terse and imperative — each line is a mandate, a prohibition, or a format spec.
- Sections marked `(optional)` appeared in only some repos; keep them only if they earn their place.
- Lead every rule bullet with a **bold keyword**; wrap every path, command, env var, and identifier in backticks.

---

## What this project is

<!-- One-paragraph elevator pitch: type, runtime/stack-in-a-phrase, core domain, the one defining architectural fact. Then an explicit "what it is NOT" clause to kill wrong assumptions. Point to the README/spec for the full breakdown. -->

**{{PROJECT}}** — {{one-line product thesis}}. {{Runtime/language in a phrase}}, integrating {{external system}}.

**This is NOT** {{anti-definition: e.g. a startup / a consumer of the package / a SaaS}}. See [`README.md`](README.md) for the full breakdown.

---

## Scope note (optional)

<!-- Only if a known collision exists (e.g. a conflicting parent CLAUDE.md elsewhere on disk). State in bold what does NOT apply here and why. Delete otherwise. -->

> **Scope note:** {{a parent file at `path` describes something unrelated}}. **It does not apply here.**

---

## Tech Stack

<!-- Pin every technology choice so agents never improvise tooling. Table form. State the constraint attached to each (version floor, abstraction boundary, license), not just the name. -->

| Layer | Choice | Notes / constraint |
|-------|--------|--------------------|
| Language / runtime | {{lang + version floor}} | {{build file only, never <forbidden alt>}} |
| Framework | {{framework}} | {{}} |
| Validation / schemas | {{lib + version}} | {{}} |
| Storage | {{db or "no database — in-memory"}} | {{}} |
| Testing | {{runner + plugins}} | {{}} |
| Hosting / deploy | {{platform}} | {{}} |

---

## Architecture

<!-- The high-level runtime shape: entry point, the routes/surfaces it exposes, the cross-cutting data-flow/auth mechanism, and the single load-bearing pattern most guarantees hinge on. Inline arrow diagrams welcome. Add a File Layout tree if useful. -->

{{Single app serving `/route-a` and `/route-b`. Data flow: `Source → Core → strip → Module`.}}

**Key pattern — {{named pattern}}:** {{why it's architectural, not aspirational}}.

```
{{src/}}
  {{server.ext}}        # entry / app assembly
  {{client.ext}}        # external API client
  {{tools/}}            # one file per domain
```

---

## Commands

<!-- The canonical build/test/lint/typecheck/run commands as ONE copy-pasteable bash block with right-aligned # comments. Keep the package manager consistent. Include both bulk and single-test invocations. -->

```bash
{{pnpm install}}
{{pnpm test}}                 # full suite
{{pnpm test path/to/one.test}} # a single test file
{{pnpm typecheck}}            # tsc --noEmit
{{pnpm lint}}                 # eslint
{{pnpm build}}                # production build
```

---

## Session Start (optional)

<!-- Ordered read-first checklist so agents never operate on stale context. Each step is a path/command + why. Close with an emphatic "do not skip". -->

1. Read the latest {{`docs/specs/YYYY-MM-DD-*.md`}} — current architecture.
2. Read top entries of {{`DECISIONS.md`}} and {{`CHANGELOG.md`}}.
3. Run `git log --oneline -10`.
4. Baseline the tests: {{`for t in tests/test-*.sh; do bash "$t" | tail -1; done`}}.

Do not skip. Do not assume context from a previous session.

---

## Conventions

<!-- The mechanical, recurring style/process norms. Each bullet leads with a bold label. Cover module system / code-style mandates, file organization, import aliases, single-sources-of-truth, and anti-patterns. -->

- **Code style:** {{ESM + NodeNext → `.js` on relative imports, `import type` for type-only}}; {{type hints everywhere}}; {{async-first I/O}}.
- **Files:** one responsibility per file; co-locate things that change together; split by responsibility, not layer.
- **Imports:** {{`@/*` alias}}.
- **Single sources of truth:** {{money fmt, design tokens, nav items}} — never duplicated.
- **No dead code, no unrelated refactors** in a feature commit.

### Commit convention

<!-- The commit-message standard, verbatim. Allowed type vocabulary, scope/subject rules, breaking-change marking, co-author trailer if used. -->

> Conventional Commits 1.0.0. One logical change per commit.

Format: `<type>(<scope>): <description>` — types: `feat` `fix` `docs` `refactor` `test` `chore` `build` `ci` `perf`. Imperative, lower-case, ≤72 chars. Breaking: `!` + `BREAKING CHANGE:` footer. {{AI-assisted commits add the co-author trailer.}}

---

## Non-negotiable rules / Do-not

<!-- The hard invariants — the NEVER/ALWAYS list, framed as "violating any of these is a bug, not a preference." When a rule blocks you, STOP and raise with a human — never work around it. Include secrets handling, scope guardrails, and any allow-listed dependency set. -->

> These are invariants, not guidelines. A change that violates one is wrong by definition. **STOP and raise it with a human** — no "it was the only way", no "just for now".

- **NEVER add a runtime dependency** outside the approved set ({{list}}) without explicit approval.
- **NEVER commit, echo, print, or read secrets.** {{`.env.local`}} is gitignored and holds real credentials; error messages list field names only, never values.
- **NEVER hardcode** {{values that must be derived — account list, version}}.
- **ALWAYS verify external APIs against Context7 / official docs before coding — never from memory.** Propagate this into subagent prompts.
- **Don't** {{implement excluded tools / build ahead of the current phase / stage unrelated files}}.

---

## Testing / TDD

<!-- The mandatory testing methodology and taxonomy. RED→GREEN→REFACTOR, failing test first, no commit leaves a test failing. Name the runner, the mocking boundary, and any first-class "mandatory" test category. Separate workflows for adding a feature vs fixing a bug. -->

- **Test-first, no exceptions.** RED → GREEN → REFACTOR. No commit may leave a test failing.
- **Mock only at boundaries** ({{HTTP, FS, external API}}); no network in unit tests; in-memory fakes.
- **Test names are sentences** describing behaviour, not implementation.
- **Mandatory:** {{signature test type, e.g. privacy/HMAC tests}} required for every {{module}}.
- **Bug fix:** write a failing repro test first, fix, commit test + fix together.

---

## Changelog (optional)

<!-- Changelog discipline. Keep a Changelog format, edited in the SAME commit as the change, under [Unreleased]. Do not bump the package version (release-time only). -->

Any user-facing change adds an entry under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog: Added/Changed/Removed/Fixed/Security). Same commit as the change. Do not bump `version` — that's release-time only.

---

## Release / Deploy (optional)

<!-- The versioning + commit + tag + push (or auto-deploy) runbook, including the human-approval gate and post-deploy verification. Separate "work done" from "released". -->

1. Ensure `main` is green: {{`<test>` `<build>`}}.
2. Roll `[Unreleased]` → `[X.Y.Z] - YYYY-MM-DD`; bump `version` (SemVer: {{patch/minor/major rubric}}).
3. Commit `chore(release): vX.Y.Z`; annotated tag `git tag -a vX.Y.Z -m "vX.Y.Z"`.
4. **Seek approval before pushing.** Never push unverified or unapproved work.
5. {{Push triggers auto-deploy to <platform> / run `<deploy cmd>`}}; verify production.

---

## Mandatory Session Updates (optional)

<!-- End-of-session bookkeeping ritual so status docs never go stale. Bold, no-exceptions framing. Delegate the entry format to an external rules file. -->

**Required after every implementation session. No exceptions. Do them before declaring a task done.**

1. **Dev log → {{`dev-log.md`}}** — append-only, reverse-chronological, list real file paths, log failures too. Template: {{`.claude/rules/dev-log-rules.md`}}.
2. **Status doc** — update {{Current State / `PLAN.md` markers}} ({{✅ done · 🔄 in-progress · ⛔ blocked}}).

---

## Definition of Done (optional)

<!-- A per-task self-check that mirrors the rules above one-to-one. -->

- [ ] External APIs docs-verified
- [ ] Failing test written first; suite green
- [ ] Secrets / do-not rules upheld
- [ ] CHANGELOG updated under [Unreleased]
- [ ] Small, conventional commit

---

## References (optional)

<!-- Flat index of the canonical companion docs, gathering paths scattered above. -->

- {{`docs/specs/...`}} — architecture source of truth
- {{`DECISIONS.md`}} · {{`CHANGELOG.md`}} · {{`DESIGN.md`}}

---

## Working with {{HUMAN OWNER}} (optional)

<!-- Calibrate collaboration style toward the decision-maker: communication depth, escalation behaviour, ask-don't-assume on ambiguous specs. -->

{{Name + role.}} Be direct; don't over-explain their own decisions; surface architectural trade-offs before implementing; ask rather than assume on ambiguous specs; ship over endless planning.

---

## Section frequency

<!-- How many of the 7 analyzed AGENTS.md files contained each section. Core = keep always; optional = keep when it earns its place. -->

| Section | Files (of 7) | Core? |
|---------|:---:|:---:|
| Title + Preamble (authority statement) | 7 | core |
| What this project is (+ what it's NOT) | 7 | core |
| Conventions (code style) | 7 | core |
| Non-negotiable rules / Do-not / Forbidden | 7 | core |
| Commit convention | 6 | core |
| Tech Stack | 5 | core |
| Commands (build/test/lint) | 5 | core |
| Testing / TDD | 5 | core |
| Architecture / Key Patterns | 4 | core |
| Changelog discipline | 4 | optional |
| Release / Deploy | 4 | optional |
| References / companion docs | 4 | optional |
| Session Start (read-first) | 3 | optional |
| Mandatory Session Updates (end) | 3 | optional |
| Verify external APIs (Context7) | 3 | folded into Do-not |
| Working with the human owner | 2 | optional |
| File Layout tree | 2 | folded into Architecture |
| Definition of Done checklist | 2 | optional |
| Scope note / disambiguation | 1 | optional |
| Environment Variables table | 1 | optional |
| Gotchas / domain landmines | 1 | optional |
