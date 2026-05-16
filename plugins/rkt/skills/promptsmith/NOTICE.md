# promptsmith

This skill is a fork of [nidhinjs/prompt-master](https://github.com/nidhinjs/prompt-master),
licensed under the MIT License (see `LICENSE`). © Nidhin J S and contributors.

## Source

Forked from `nidhinjs/prompt-master` at commit `7a02ddd31bad3056cc3ccf0af2b23d7b30d4abc2`
(upstream version `1.6.0`).

## Delta from upstream

This fork is **not tracking upstream**. It diverges intentionally on the following
axes:

1. **Progressive disclosure** — applies the spirit of upstream
   [PR #13](https://github.com/nidhinjs/prompt-master/pull/13) (still open as of
   the fork): tool-routing profiles moved out of `SKILL.md` into
   `references/tool-profiles.md`, loaded on demand.
2. **Three structural fixes** from upstream
   [issue #32](https://github.com/nidhinjs/prompt-master/issues/32):
   data-sensitivity hard rule, verification checklist exit conditions, and the
   3-question-limit precedence note.
3. **Codex CLI profile** — new entry covering OpenAI Codex CLI's agentic loop,
   Goal/Context/Constraints/Done-when structure, and verification-as-contract
   discipline.
4. **Two-stage flow** inspired by [Prompt Cowboy](https://promptcowboy.ai/):
   auto-expand a draft, then ask up-to-3 clarifying questions only when
   critical dimensions are genuinely missing.
5. **SKKO output schema** for generative/creative outputs, routed alongside the
   existing 9-dimension intent extraction (used for analytical/coding outputs).

## Why "promptsmith"?

Renamed from "prompt-master" to differentiate this fork from upstream's
ongoing work. No reflection on the quality of the original — just clean
separation between the two.
