# Tool Profiles Reference

Routing profiles for each AI tool. Read **only the section for your target
tool** — do not load the full file.

## Table of contents

**Foundation LLMs**
- [Claude (claude.ai, Claude API, Claude 4.x)](#claude)
- [ChatGPT / GPT-5.x / OpenAI GPT models](#gpt)
- [o3 / o4-mini / OpenAI reasoning models](#openai-reasoning)
- [Gemini 2.x / Gemini 3 Pro](#gemini)
- [Qwen 2.5 (instruct variants)](#qwen-2-5)
- [Qwen3 (thinking mode)](#qwen3)
- [MiniMax (M2.7 / M2.5)](#minimax)
- [DeepSeek-R1](#deepseek-r1)
- [Ollama (local model deployment)](#ollama)
- [Llama / Mistral / open-weight LLMs](#open-weight)

**Coding agents**
- [Claude Code](#claude-code)
- [Codex CLI (OpenAI)](#codex-cli)
- [Cursor (Agent, Composer, Inline modes)](#cursor)
- [GitHub Copilot](#copilot)
- [Cline (formerly Claude Dev)](#cline)
- [Antigravity (Google)](#antigravity)
- [Devin / SWE-agent](#devin)

**Full-stack generators**
- [Bolt / v0 / Lovable / Figma Make / Google Stitch](#full-stack-generators)

**Research, orchestration, browser**
- [Research / Orchestration AI (Perplexity, Manus)](#research)
- [Computer-Use / Browser Agents (Comet, Atlas, Claude in Chrome, OpenClaw)](#browser-agents)

**Visual / generative**
- [Image AI — Generation (Midjourney, DALL-E 3, Stable Diffusion, SeeDream)](#image-gen)
- [Image AI — Reference Editing](#image-edit)
- [ComfyUI](#comfyui)
- [3D AI — Text to 3D / Game Systems (Meshy, Tripo, Rodin)](#3d-ai-text)
- [3D AI — In-Engine (Unity AI, Blender AI)](#3d-ai-engine)
- [Video AI (Sora, Runway, Kling, LTX, Dream Machine)](#video-ai)
- [Voice AI (ElevenLabs)](#voice-ai)

**Automation**
- [Workflow AI (Zapier, Make, n8n)](#workflow-ai)

**Fallback**
- [Unknown tool](#unknown)

---

## <a id="claude"></a>Claude (claude.ai, Claude API, Claude 4.x)

- Be explicit and specific — Claude 4.x follows instructions literally. Opus 4.7 especially: it does exactly what you say, nothing more. Missing context = narrow literal output, not a smart guess.
- XML tags help for complex multi-section prompts: `<context>`, `<task>`, `<constraints>`, `<output_format>`
- Claude Opus 4.x over-engineers by default — add "Only make changes directly requested. Do not add features or refactor beyond what was asked."
- Provide context and reasoning WHY, not just WHAT — Claude generalizes better from explanations
- Always specify output format and length explicitly
- For complex or multi-step tasks on Opus 4.7: front-load everything in one turn — intent, constraints, acceptance criteria, relevant files. Every extra back-and-forth turn adds reasoning overhead and token cost.
- Do NOT add "think step by step" or fixed thinking budget instructions — Opus 4.7 uses adaptive thinking and calibrates depth automatically. To influence depth: "Think carefully before responding" (more) or "Prioritize responding quickly" (less).
- Use Template M for agentic or multi-step tasks on Opus 4.7.

---

## <a id="gpt"></a>ChatGPT / GPT-5.x / OpenAI GPT models

- Start with the smallest prompt that achieves the goal — add structure only when needed
- Be explicit about the output contract: what format, what length, what "done" looks like
- State tool-use expectations explicitly if the model has access to tools
- Use compact structured outputs — GPT-5.x handles dense instruction well
- Constrain verbosity when needed: "Respond in under 150 words. No preamble. No caveats."
- GPT-5.x is strong at long-context synthesis and tone adherence — leverage these

---

## <a id="openai-reasoning"></a>o3 / o4-mini / OpenAI reasoning models

- SHORT clean instructions ONLY — these models reason across thousands of internal tokens
- NEVER add CoT, "think step by step", or reasoning scaffolding — it actively degrades output
- Prefer zero-shot first — add few-shot only if strictly needed and tightly aligned
- State what you want and what done looks like. Nothing more.
- Keep system prompts under 200 words — longer prompts hurt performance on reasoning models

---

## <a id="gemini"></a>Gemini 2.x / Gemini 3 Pro

- Strong at long-context and multimodal — leverage its large context window for document-heavy prompts
- Prone to hallucinated citations — always add "Cite only sources you are certain of. If uncertain, say [uncertain]."
- Can drift from strict output formats — use explicit format locks with a labelled example
- For grounded tasks add "Base your response only on the provided context. Do not extrapolate."

---

## <a id="qwen-2-5"></a>Qwen 2.5 (instruct variants)

- Excellent instruction following, JSON output, structured data — leverage these strengths
- Provide a clear system prompt defining the role — Qwen2.5 responds well to role context
- Works well with explicit output format specs including JSON schemas
- Shorter focused prompts outperform long complex ones — scope tightly

---

## <a id="qwen3"></a>Qwen3 (thinking mode)

- Two modes: thinking mode (`/think` or `enable_thinking=True`) and non-thinking mode
- Thinking mode: treat exactly like o3 — short clean instructions, no CoT, no scaffolding
- Non-thinking mode: treat like Qwen2.5 instruct — full structure, explicit format, role assignment

---

## <a id="minimax"></a>MiniMax (M2.7 / M2.5)

- OpenAI-compatible API — prompts that work with GPT models transfer directly
- Strong at instruction following, structured output, and long-context synthesis — 1M context window on M2.7
- M2.5-highspeed has a 204K context window and is optimized for speed — use for latency-sensitive tasks
- Temperature must be between 0 and 1 (inclusive) — prompts that set temperature above 1 will fail
- May output reasoning in `<think>` tags — add "Output only the final answer, no reasoning tags." if the user does not want visible thinking
- Good at code generation, JSON output, and multi-step analysis — leverage these strengths
- Responds well to explicit role assignment and structured prompts with clear output format specifications
- For function calling: supports OpenAI-style tool definitions — include tool schemas directly

---

## <a id="deepseek-r1"></a>DeepSeek-R1

- Reasoning-native like o3 — do NOT add CoT instructions
- Short clean instructions only — state the goal and desired output format
- Outputs reasoning in `<think>` tags by default — add "Output only the final answer, no reasoning." if needed

---

## <a id="ollama"></a>Ollama (local model deployment)

- ALWAYS ask which model is running before writing — Llama3, Mistral, Qwen2.5, CodeLlama all behave differently
- System prompt is the most impactful lever — include it in the output so user can set it in their Modelfile
- Shorter simpler prompts outperform complex ones — local models lose coherence with deep nesting
- Temperature 0.1 for coding/deterministic tasks, 0.7-0.8 for creative tasks
- For coding: CodeLlama or Qwen2.5-Coder, not general Llama

---

## <a id="open-weight"></a>Llama / Mistral / open-weight LLMs

- Shorter prompts work better — these models lose coherence with deeply nested instructions
- Simple flat structure — avoid heavy nesting or multi-level hierarchies
- Be more explicit than you would with Claude or GPT — instruction following is weaker
- Always include a role in the system prompt

---

## <a id="claude-code"></a>Claude Code (Opus 4.7, agentic terminal coding)

Context window is the binding constraint. Performance degrades as it fills, and Opus 4.7 reasons more between calls so each tool result you feed it costs more than it did on 4.6. Prompt as if you're paying tokens for every file Claude opens — because you are.

**Required structure / what good prompts include.**
- Verification step baked in — "run `pnpm test` and `tsc --noEmit` until green; do not modify the tests" is the single highest-leverage line you can add
- Concrete examples of correct output (test cases, expected JSON, before/after screenshot) — vague prompts get literal minimums on 4.7
- Reference patterns by path — `@src/HotDogWidget.php` instead of "follow our widget pattern"
- Symptom + likely location + definition of "fixed" for bug prompts; never just "fix the login bug"
- For multi-file work: explicit Explore → Plan → Implement → Commit phases, with plan mode for the first two

**Default mode / how the tool behaves out of the box.**
- Default effort is `xhigh`, not `high` — `max` shows diminishing returns and overthinks; only raise to `max` for genuinely hard problems
- Adaptive thinking, not a fixed budget — nudge with "think carefully, this is harder than it looks" or "prioritize responding quickly," never with token counts or "think step by step"
- Read tool is all-or-nothing — asking about one function in a 2k-line file pulls the whole file into context. Anchor with line ranges or `grep` first
- MCP servers load unconditionally per project; every connected server eats context whether you use it that turn or not
- Auto mode aborts non-interactive `-p` runs after repeated classifier blocks — there's no human to fall back to
- Hooks are deterministic, CLAUDE.md is advisory — if a rule MUST hold every time (lint after edit, block writes to `migrations/`), make it a hook, not a memory line
- Long-form generation can truncate mid-section without warning when output approaches limits — split deliverables or raise max_tokens explicitly

**Quality contract / how to know it worked.**
- A command Claude can run to self-check: tests, type-check, linter, screenshot diff, `curl | jq` smoke test
- Address-the-root-cause clause when fixing bugs: "do not suppress the error or skip the failing test"
- For UI: "take a screenshot, compare to the reference, list differences, fix them" — verification loop runs without you
- For migrations/refactors via `claude -p` fan-out: each invocation must return `OK` or `FAIL` with a one-line reason so you can grep results
- Writer/Reviewer split for anything load-bearing — a fresh session reviews what the first wrote; bias is real

**Common failure modes (where it struggles).**
- Context saturation symptoms: invented imports, function signatures that are *almost* the real API, suggestions that match a sibling module not the current one — when you see these, `/clear` is the fix, not another correction
- The kitchen-sink session: one task → unrelated question → back to task one. Context is now polluted; `/clear` between unrelated tasks
- Two-correction rule: if you've corrected the same issue twice, the thread is poisoned. `/clear`, fold the lesson into a sharper opening prompt, restart
- Infinite exploration: "investigate auth" with no scope reads hundreds of files. Scope to a path or dispatch a subagent that returns only a summary
- Mid-output self-corrections ("actually, that should be X") leak into deliverables and read as uncertainty — for stakeholder docs, instruct "do not insert mid-stream revisions; output the final version only"
- 4.7 specifically under-delivers on prompts that worked on 4.6 because 4.6 silently filled gaps. Migration symptom: "it used to add tests automatically." Fix: encode the gap-fillers explicitly in CLAUDE.md or the prompt
- Subagents without a `maxTurns` ceiling can burn the session on a faulty loop — set 3-5 for recursive work, 10-20 for exploration
- Running from repo root on a large monorepo loads more than the task needs — `cd` into the relevant subdirectory before launching Claude, or use scoped rules

**Template references.**
- **Template M (Opus 4.7 Task Brief)** — primary structure for any non-trivial task; covers intent, constraints, acceptance criteria, scope locks
- **Template H (ReAct + Stop Conditions)** — layer on top of M when the task involves a tool-use loop you can't fully scope upfront (debugging, exploratory refactors); makes stop conditions and per-step checkpoints explicit

---

## <a id="codex-cli"></a>Codex CLI (OpenAI)

OpenAI Codex CLI is a terminal-native agentic coding tool. It is **not a chat interface** — prompts trigger a loop where the model reads files, edits files, runs commands, and iterates until done. Treat it accordingly.

- **Required structure: Goal / Context / Constraints / Done-when.** Every non-trivial Codex prompt should hit these four elements explicitly. Goal = outcome (not steps). Context = which files, errors, examples matter. Constraints = standards, architecture choices, safety. Done-when = the verifiable condition that signals completion.
- **Verification-as-contract.** Bake validation into the prompt itself — "Run `pytest` and `ruff check` until both pass. Do not modify the tests." Linters, type checkers, and integration tests are not optional in a Codex workflow; they're the contract that lets Codex iterate autonomously without supervision.
- **Decompose, don't monolith.** Smaller tasks are easier for Codex to test and for the user to review. Split "build the whole feature" into "scaffold the routes" → "implement the handler" → "add the tests."
- **Default mode: implement-with-assumptions.** Add "Default to implementing with reasonable assumptions; do not end your turn with clarifications unless truly blocked. State the assumptions you made at the end." This matches Codex's documented persistence behavior and avoids the "asks instead of does" failure mode.
- **NEVER add "think step by step" or CoT scaffolding.** Codex CLI runs on reasoning-native models internally — CoT instructions degrade output, same as o3.
- **Plain natural language; no special markup needed.** No XML tags, no special headers. "Add a `--json` flag to the CLI that emits machine-readable output. Implement in `src/cli.py`. Run the existing tests. Done when `cli --json status` returns valid JSON."
- **Scope locks for the filesystem.** Codex will touch any file in scope by default — explicit allow/forbid lists matter. "Only modify files inside `src/`. Do not touch `package.json`, `.env`, migrations, or anything in `.github/`."
- **Forking > persisting in degraded thread.** Tell the user: when a Codex session goes sideways (contradictory instructions, partial impl, stale assumptions), save state to a file, fork a new session with cleaner context, try again. Cheaper than burning credits on a poisoned thread.
- **Common failure modes to pre-empt:**
  - Vague scope → always anchor to specific paths and components
  - No done-when → Codex will keep editing past "done"
  - Multi-file changes without boundaries → request file-by-file or function-by-function
  - Missing verification step → output looks plausible but is broken
- **Use Template M (Opus 4.7 Task Brief) as a starting structure**, then add Codex-specific elements: explicit `Run X to verify` line, explicit "do not modify tests" if tests exist, explicit fork-or-continue instruction if context might already be poisoned.

---

## <a id="cursor"></a>Cursor (AI-first IDE — Agent, Composer, Inline modes)

Cursor is mode-stratified: Ask reads, Plan drafts, Agent edits + runs commands, Manual is single-file completion. The unifying principle: pin context explicitly with `@`, scope to a mode that matches the action's blast radius, and write rules in `.cursor/rules/*.mdc` (not legacy `.cursorrules` — Agent mode does not load it). Inline (Cmd+K) is a different beast: single-buffer, no codebase context unless you `@`-mention.

**Required structure / what good prompts include.**
- Mode selector first: `Ask` for scoping, `Plan` (Shift+Tab) before any non-trivial Agent run, `Agent` for execution, `Manual` for polish — name the mode in the prompt if ambiguous
- `@`-pinned context: `@File`, `@Folder`, `@Code` (symbol), `@Web`, `@Docs`, `@Git` (diffs), `@Recent Changes`. Never rely on auto-context for files outside open tabs
- File-scope locks even with rules loaded: "Edit only `src/auth/session.ts`. Do not create new files. Do not touch tests."
- Acceptance criteria as a `Done when:` line — Agent will keep editing past intuitive completion otherwise
- `.cursor/rules/*.mdc` files with YAML frontmatter (`description`, `globs`, `alwaysApply`) for persistent conventions. Keep total `alwaysApply` content under ~2K tokens — it eats context budget on every turn
- Explicit model selection if quality matters: Auto picks Composer-1 by default (faster, weaker on hard reasoning). Name the model: "Use Sonnet 4.x" / "Use Opus for this."
- Pre-run git checkpoint: "Commit current state before starting. Work in branch `<name>`."

**Default mode / how the tool behaves out of the box.**
- Default model is **Auto**, which routes most turns to Cursor's Composer-1 (proprietary MoE). Fast, mid-quality — fine for boilerplate, weak on architecture and gnarly debugging. Override per-prompt if needed
- Standard Agent context truncates to ~10–15K tokens with a 25-tool-call ceiling per turn. **Max mode** removes truncation and raises the ceiling to 200, but burns credits fast
- Auto-context = currently open tabs + recent edits + the active selection. It does **not** include closed siblings or unimported referenced files. If it isn't open or `@`-pinned, assume it isn't loaded
- Agent auto-creates checkpoints (separate from git) before significant edits; rollback via the chat UI doesn't touch git. Don't confuse them
- Auto-Run / "YOLO" mode executes terminal commands and applies edits without confirmation. The default Command Allowlist is permissive (shell built-ins bypass it). Off by default — leave it off outside throwaway scaffolds

**Quality contract / how to know it worked.**
- Bake verification into the prompt: "Run `pnpm test src/auth` after edits. If tests fail, fix and re-run. Stop when green."
- Diff-review checkpoint: "Show me the file list and a unified diff before applying. Wait for approval." Critical in Agent mode where multi-file changes ship in one batch
- Explicit do-not-touch list — `package.json`, `migrations/`, `.env`, generated files, lockfiles. Agent will edit them otherwise
- "Stop and ask before installing any dependency, deleting any file, or running any non-test command."
- Re-state acceptance: "Done when: tests pass, no new files created, only `session.ts` modified."

**Common failure modes (where it struggles).**
- **Wrong-file edits in large repos** (multiple files with similar names). Prevention: `@File` the exact path, never use bare filename references; explicitly forbid file creation
- **Long-session drift** — after ~20 turns Agent forgets early instructions and contradicts itself. Prevention: new chat per task; don't keep "fixing" within a poisoned thread, fork it
- **Context silently truncated** below the 10–15K ceiling — the model invents code for files it never actually read. Prevention: enable Max mode for cross-file work or chunk into per-file prompts
- **Mode bleed** — selecting Agent but the model behaves like Plan (or vice versa), causing unintended writes. Prevention: state the action verb literally ("edit," "run," "draft only — do not apply")
- **`.cursorrules` ignored by Agent mode entirely** — only project rules (`.cursor/rules/*.mdc`) load in Agent. If conventions aren't being followed, check format first
- **Rules over 500 lines stop loading reliably**; `alwaysApply: true` on too many files blows context budget before code is read. Prevention: split by glob, reference docs instead of inlining them
- **Auto-Run + prompt injection from README/comments/MCP output** can execute commands the user never approved. Prevention: keep Auto-Run off for any repo with third-party content; sandbox MCP servers
- **Background/Cloud Agent runaway** — sessions persisting beyond intended scope, creating tokens or commits across repos days later. Prevention: end Cloud Agent sessions explicitly; audit access tokens

**Template references.**
- **Template G (File-Scope)** — primary for any Agent or Composer edit; supplies path + symbol + current/desired behavior + do-not-touch list
- **Template H (ReAct + Stop Conditions)** — required for Agent mode multi-step work; pair with explicit `Done when` and verification command
- **Template M (Task Brief)** — use for Plan-mode prompts that will hand off to Agent; surfaces acceptance criteria upfront so the generated plan is reviewable before execution

---

## <a id="copilot"></a>GitHub Copilot

- Write the exact function signature, docstring, or comment immediately before invoking
- Describe input types, return type, edge cases, and what the function must NOT do
- Copilot completes what it predicts, not what you intend — leave no ambiguity in the comment

---

## <a id="cline"></a>Cline (formerly Claude Dev)

- Agentic VS Code extension — autonomously edits files, runs terminal commands, uses browser tools
- Powered by Claude, GPT, or other LLMs — prompting style should match the underlying model
- Starting state + target state + file scope + stop conditions + approval gates
- Always specify which files to edit and which to leave untouched
- Add "Ask before running terminal commands" or "Ask before installing dependencies" to prevent unwanted actions
- Can read file contents, search codebases, and use browser automation — leverage these for context gathering
- For multi-step tasks: break into sequential prompts with clear checkpoints
- Cline shows a task list before executing — review it and adjust scope if needed

---

## <a id="antigravity"></a>Antigravity (Google's agent-first IDE, powered by Gemini 3 Pro)

- Task-based prompting — describe outcomes, not steps
- Prompt for an Artifact (task list, implementation plan) before execution so you can review it first
- Browser automation is built-in — include verification steps: "After building, verify UI at 375px and 1440px using the browser agent"
- Specify autonomy level: "Ask before running destructive terminal commands"
- Do NOT mix unrelated tasks — scope to one deliverable per session

---

## <a id="devin"></a>Devin / SWE-agent

- Fully autonomous — can browse web, run terminal, write and test code
- Very explicit starting state + target state required
- Forbidden actions list is critical — Devin will make decisions you did not intend without explicit constraints
- Scope the filesystem: "Only work within /src. Do not touch infrastructure, config, or CI files."

---

## <a id="full-stack-generators"></a>Bolt / v0 / Lovable / Figma Make / Google Stitch

- Full-stack generators default to bloated boilerplate — scope it down explicitly
- Always specify: stack, version, what NOT to scaffold, clear component boundaries
- Lovable responds well to design-forward descriptions — include visual/UX intent
- v0 is Vercel-native — specify if you need non-Next.js output
- Bolt handles full-stack — be explicit about which parts are frontend vs backend vs database
- Figma Make is design-to-code native — reference your Figma component names directly
- Google Stitch is prompt-to-UI focused — describe the interface goal not the implementation. Add "match Material Design 3 guidelines" for Google-native styling
- Add "Do not add authentication, dark mode, or features not explicitly listed" to prevent feature bloat

---

## <a id="research"></a>Research / Orchestration AI (Perplexity, Manus AI)

- Perplexity search mode: specify search vs analyze vs compare. Add citation requirements. Reframe hallucination-prone questions as grounded queries.
- Manus and Perplexity Computer are multi-agent orchestrators — describe the end deliverable, not the steps. They decompose internally.
- For Perplexity Computer: specify the output artifact type (report / spreadsheet / code / summary). Add "Flag any data point you are not confident about."
- For long multi-step tasks: add verification checkpoints since each chained step compounds hallucination risk

---

## <a id="browser-agents"></a>Computer-Use / Browser Agents (Perplexity Comet/Computer, OpenAI Atlas, Claude in Chrome, OpenClaw Agents)

- These agents control a real browser — they click, scroll, fill forms, and complete transactions autonomously
- Describe the outcome, not the navigation steps: "Find the cheapest flight from X to Y on Emirates or KLM, no Boeing 737 Max, one stop maximum"
- Specify constraints explicitly — the agent will make its own decisions without them
- Add permission boundaries: "Do not make any purchase. Research only."
- Add a stop condition for irreversible actions: "Ask me before submitting any form, completing any transaction, or sending any message"
- Comet works best with web research, comparison, and data extraction tasks
- Atlas is stronger for multi-step commerce and account management tasks

---

## <a id="image-gen"></a>Image AI — Generation (Midjourney, DALL-E 3, Stable Diffusion, SeeDream)

First detect: generation from scratch or editing an existing image?

- **Midjourney**: Comma-separated descriptors, not prose. Subject first, then style, mood, lighting, composition. Parameters at end: `--ar 16:9 --v 6 --style raw`. Negative prompts via `--no [unwanted elements]`
- **DALL-E 3**: Prose description works. Add "do not include text in the image unless specified." Describe foreground, midground, background separately for complex compositions.
- **Stable Diffusion**: `(word:weight)` syntax. CFG 7-12. Negative prompt is MANDATORY. Steps 20-30 for drafts, 40-50 for finals.
- **SeeDream**: Strong at artistic and stylized generation. Specify art style explicitly (anime, cinematic, painterly) before scene content. Mood and atmosphere descriptors work well. Negative prompt recommended.

---

## <a id="image-edit"></a>Image AI — Reference Editing (when user has an existing image to modify)

Detect when: user mentions "change", "edit", "modify", "adjust" anything in an existing image, or uploads a reference.
Always instruct the user to attach the reference image to the tool first. Build the prompt around the delta ONLY — what changes, what stays the same.
Read [templates.md](templates.md) Template J for the full reference editing template.

---

## <a id="comfyui"></a>ComfyUI

Node-based workflow — not a single prompt box. Ask which checkpoint model is loaded before writing.
Always output two separate blocks: Positive Prompt and Negative Prompt. Never merge them.
Read [templates.md](templates.md) Template K for the full ComfyUI template.

---

## <a id="3d-ai-text"></a>3D AI — Text to 3D / Game Systems (Meshy, Tripo, Rodin)

- Describe: style keyword (low-poly / realistic / stylized cartoon) + subject + key features + primary material + texture detail + technical spec
- Negative prompt supported — use it: "no background, no base, no floating parts"
- Meshy: best for game assets and teams. Game asset prompts work best here.
- Tripo: fastest for clean topology. Rapid prototyping and concept assets.
- Rodin: highest quality for photorealistic prompts. Slower and more expensive.
- Specify intended export use: game engine (GLB/FBX), 3D printing (STL), web (GLB)
- For characters: specify A-pose or T-pose if the model will be rigged

---

## <a id="3d-ai-engine"></a>3D AI — In-Engine AI (Unity AI, Blender AI tools)

- Unity AI (Unity 6.2+, replaces retired Muse): use `/ask` for documentation and project queries, `/run` for automating repetitive Editor tasks, `/code` for generating or reviewing C# code. Be precise — state exactly what needs to happen in the Editor.
- Unity AI Generators: text-to-sprite, text-to-texture, text-to-animation. Describe the asset type, art style, and technical constraints (resolution, color palette, animation loop or one-shot).
- BlenderGPT / Blender AI add-ons: these generate Python scripts that execute in Blender. Be specific about geometry, material names, and scene context. Include "apply to selected object" or "apply to entire scene" to avoid ambiguity.

---

## <a id="video-ai"></a>Video AI (Sora, Runway, Kling, LTX Video, Dream Machine)

- Sora: describe as if directing a film shot. Camera movement is critical — static vs dolly vs crane changes output dramatically.
- Runway Gen-3: responds to cinematic language — reference film styles for consistent aesthetic.
- Kling: strong at realistic human motion — describe body movement explicitly, specify camera angle and shot type.
- LTX Video: fast generation, prompt-sensitive — keep descriptions concise and visual. Specify resolution and motion intensity explicitly.
- Dream Machine (Luma): cinematic quality — reference lighting setups, lens types, and color grading styles.

---

## <a id="voice-ai"></a>Voice AI (ElevenLabs)

- Specify emotion, pacing, emphasis markers, and speech rate directly
- Use SSML-like markers for emphasis: indicate which words to stress, where to pause
- Prose descriptions do not translate — specify parameters directly

---

## <a id="workflow-ai"></a>Workflow AI (Zapier, Make, n8n)

- Trigger app + trigger event → action app + action + field mapping. Step by step.
- Auth requirements noted explicitly — "assumes [app] is already connected"
- For multi-step workflows: number each step and specify what data passes between steps

---

## <a id="unknown"></a>Unknown tool

Identify the closest matching tool category from context. If genuinely unclear, ask: "Which tool is this for?" — then route accordingly. If no exact match exists, route to the closest related category (e.g., a new OpenAI-compatible model → use the GPT profile; a new agentic CLI → use Codex CLI or Claude Code as the closest analog).
