# Stack Targeting

Use this reference to choose what kind of DESIGN.md to write after visual analysis.

## Decision Rule

If a stack or platform is explicitly provided, target it. If not, inspect the repo. If still unclear, ask one question:

"What stack should this DESIGN.md target? My recommendation is stack-agnostic unless you already know the implementation target."

## Stack-Agnostic

Use when the user wants a portable design contract for multiple tools or platforms.

Include:

- Universal tokens: color roles, typography roles, spacing, shape, elevation.
- Component roles: button, card, input, badge, navigation, modal, media frame.
- Platform notes for web/mobile/design tools.

Avoid:

- Framework-specific file paths as the main source of truth.
- CSS-only implementation as the only token expression.

## Next.js / React Web With Vanilla CSS

Include:

- `app/globals.css` or `src/app/globals.css` token guidance.
- CSS custom properties.
- React component hierarchy: primitives -> composed components -> page sections.
- CSS Modules vs global CSS guidance.
- Responsive behavior and browser accessibility.

Avoid:

- Tailwind-specific token names unless Tailwind exists.
- shadcn or component-library defaults unless already installed.

## Tailwind Web

Include:

- Tailwind theme token mapping or Tailwind v4 `@theme` notes.
- Component class conventions and anti-drift rules.
- Guidance for where raw CSS is still appropriate.

Still lint DESIGN.md normally; Tailwind export can be a follow-up.

## SwiftUI / iOS / macOS

Include:

- Color assets or `Color` extension names.
- Typography as text styles and custom font roles.
- Shape, material, spacing, and motion guidance.
- Component architecture as SwiftUI views: tokens -> modifiers -> primitive views -> composed screens.
- Accessibility: Dynamic Type, contrast, reduce motion, touch/click targets.

Avoid:

- CSS variables as the primary implementation contract.

## Android Compose

Include:

- Material theme mapping only if it helps; do not force generic Material styling.
- ColorScheme roles, typography, shapes, spacing constants.
- Composables hierarchy and state/style separation.
- Accessibility and touch target guidance.

## Flutter

Include:

- `ThemeData`, `ColorScheme`, text styles, shape themes, spacing constants.
- Widget hierarchy and reusable decoration patterns.
- Platform-adaptive notes when relevant.

## Figma / Google Stitch

Include:

- Strict DESIGN.md format.
- Clear tokens and component descriptions.
- Do/don't constraints and visual rationale.
- Minimal implementation-specific code unless requested.

## File Naming

Prefer `DESIGN.md` for convention and tool compatibility. Use lowercase `design.md` only when requested or when matching an existing repo convention.
