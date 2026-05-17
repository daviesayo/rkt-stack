---
name: visual-identity-to-design-md
description: Use when turning moodboards, screenshots, posters, brand references, or visual inspiration into an AI-readable DESIGN.md/design.md file with visual analysis, design tokens, component architecture, stack-specific guidance, and linter validation.
---

# Visual Identity To DESIGN.md

Use this skill after or instead of `visual-identity-folder-analysis` when the deliverable is both analysis and a reusable `DESIGN.md`/`design.md` file. The analysis skill stops at visual synthesis; this skill continues into a stack-aware design contract and validates it with the Google DESIGN.md linter.

## Quick Start

1. Resolve the visual reference source folder and output directory.
2. If no recent visual identity analysis exists for this source, run the `visual-identity-folder-analysis` workflow first and create `visual-identity-analysis.md`.
3. Determine the target for the design contract:
   - Ask one question at a time only when the answer cannot be inferred.
   - If unspecified, first ask what stack/platform the DESIGN.md is for.
   - Recommended default question: "What stack should this DESIGN.md target: web, Next.js, vanilla React, mobile/iOS, mobile/Android, Flutter, or stack-agnostic?"
4. Read `references/stack-targeting.md` for platform-specific output guidance.
5. Read `references/design-md-linting.md` before writing or validating the file.
6. Create the design contract, usually named `DESIGN.md` in a project root. Use `design.md` only if the user requests lowercase or the existing repo convention uses it.
7. Run the Google linter until there are no errors. Prefer zero warnings; document any intentional residual warnings.
8. Final response: link the analysis report, the DESIGN.md file, contact sheet assets if generated, and summarize validation.

## Grilling Rules

Use the `grill-me` pattern only for decisions that materially affect the output. Ask one question at a time and include your recommended answer.

Do ask when unknown:

- Target platform/stack: web, Next.js, vanilla CSS, Tailwind, SwiftUI, UIKit, Android Compose, Flutter, React Native, Figma/Stitch, or stack-agnostic.
- Output location: project root vs analysis output folder.
- Whether to create uppercase `DESIGN.md` or lowercase `design.md`.
- Whether the file should be strict Google DESIGN.md format or a richer project design brief that includes non-standard sections.
- Whether the design contract should optimize for coding agents, design agents, designers, or a specific implementation team.

Do not ask when local context answers it. Inspect the repo for framework files, style system, package manager, existing docs, and naming conventions.

## Output Contract

The DESIGN.md should include:

- YAML front matter with machine-readable tokens: colors, typography, spacing, radii, and component tokens.
- Markdown body with rationale: overview, colors, typography, layout, elevation/depth, shapes, components, do's and don'ts.
- Stack or platform implementation guidance.
- Component architecture rules that convert the visual identity into reusable primitives and composed components.
- Accessibility rules, especially contrast, focus states, text overlap, touch targets, and motion preferences.
- Agent implementation prompt/checklist.
- Evidence from the visual analysis: cite manifest numbers, filenames, or report sections for major design decisions.

Keep the front matter compatible with the current Google linter:

- Use simple dimensions in tokens (`16px`, `1rem`), not CSS functions such as `clamp()`.
- Put richer responsive CSS examples in the markdown body.
- Use single-value radii in front matter; explain irregular radii in prose or CSS examples.
- Define `primary` when colors are present.
- Reference important color tokens from component tokens to avoid orphan-token warnings.

## Workflow Detail

### 1. Analyze References

If no analysis exists, run:

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
python3 "$RKT_PLUGIN_ROOT/skills/visual-identity-folder-analysis/scripts/prepare_visual_references.py" "<source-folder>" --out "<output-dir>"
```

In Claude Code plugin contexts, `${CLAUDE_PLUGIN_ROOT}` normally supplies this
path. In Codex or local development contexts, resolve
`<installed-rkt-plugin-root>` to the real rkt plugin package root before running
the command.

Then inspect:

- `<output-dir>/contact-sheet.png`
- `<output-dir>/rows/row-*.png`
- `<output-dir>/manifest.tsv`
- `<output-dir>/palette-samples.tsv`
- `<output-dir>/inventory.tsv`

Write `<output-dir>/visual-identity-analysis.md` using the visual analysis skill's structure.

### 2. Select Target

Infer from repo files when possible:

- `next.config.*`, `app/`, `pages/`, React dependencies: Next.js or React web.
- `tailwind.config.*`: web with Tailwind.
- `.xcodeproj`, `.xcworkspace`, `Package.swift` with SwiftUI: Apple app.
- `build.gradle`, `android/`: Android.
- `pubspec.yaml`: Flutter.
- No repo or unknown target: ask.

If the user wants stack-agnostic output, include generic tokens and multiple short implementation notes, not framework-specific CSS variables as the only source of truth.

### 3. Draft DESIGN.md

Use the visual analysis as the source of taste. Translate it into enforceable decisions:

- Token roles, not just sampled colors.
- Typography behavior, not just font names.
- Component patterns, not only mood words.
- Explicit do/don't constraints that block generic UI drift.
- Architecture hierarchy: tokens -> primitives -> composed components -> page/screen sections.

### 4. Lint And Iterate

Run:

```bash
npx @google/design.md lint "<path-to-DESIGN.md>"
```

If `npx` cannot reach the package, browse the current Google repo/spec and still validate manually against its schema. If the linter reports errors, fix the file and rerun. If it reports contrast warnings, either adjust the token pair or document why that component must not be used for text.

For current linter behavior and source links, use `references/design-md-linting.md`.

## Final Response

Keep the final response concise:

- Link the visual analysis report if created or used.
- Link `DESIGN.md`/`design.md`.
- Link contact sheet HTML/PNG when newly generated.
- State the target stack/platform.
- State linter result: command and error/warning count.
- Mention any unresolved decisions or intentionally deferred questions.

Do not paste the whole DESIGN.md into chat unless the user asks.
