---
description: Path-scoped rules for iOS SwiftUI projects
appliesTo:
  - "ios/**/*.swift"
  - "**/*.swift"
---

# iOS Design System

Read `DESIGN.md` before any visual/UI decisions. Key constraints:

- SF Symbols only. `.continuous` corner curves. 44pt min touch targets. Dynamic Type.
- Spring-based animations. Respect `accessibilityReduceMotion`.

## Design Tokens

Use the project's design tokens file (typically
`ios/{{project}}/{{PascalCaseProject}}DesignSystem.swift` — consult the
project's scaffold for the exact path). Never hardcode colors, fonts, spacing,
or corner radii directly in views.

## SwiftUI Patterns

- `@State` is always `private`
- `foregroundStyle()` not `foregroundColor()`
- `.animation(_:value:)` with explicit value — never bare `.animation()`
- `.compositingGroup()` before `.clipShape()` on layered views
- `Button` for all tappable elements — never `onTapGesture`
- `.accessibilityLabel()` on all icon-only elements
- `Sendable` on value types used across concurrency boundaries

## iOS Project Structure

- Target: iOS 26+. Build target: physical device — never simulator.
- No third-party dependencies unless explicitly approved by the project lead.

## Project-specific rules

Business rules specific to this project live in `.claude/rules/project-ios.md`
(written by `/rkt-tailor`). Check there for domain conventions beyond the generic
patterns above.
