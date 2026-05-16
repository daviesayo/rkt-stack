# DESIGN.md Linting And References

Use this reference when writing or validating a DESIGN.md/design.md file.

## Current Sources To Check

Browse these when the user asks for the latest spec, when lint behavior seems surprising, or when creating/updating this skill's DESIGN.md guidance:

- Google announcement: https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-design-md/
- Official repository: https://github.com/google-labs-code/design.md
- Official spec path: https://github.com/google-labs-code/design.md/blob/main/docs/spec.md
- npm package/CLI: `@google/design.md`

Community references can help with examples, but prefer the Google repo/spec for rules:

- https://www.design-extractor.com/docs/design-md
- https://agentskills.co.il/en/guides/using-design-md

## Lint Command

Run this from the folder containing the candidate file, or pass an absolute path:

```bash
npx @google/design.md lint DESIGN.md
```

Expected output is JSON with `findings` and `summary`.

Aim for:

- `errors: 0`
- `warnings: 0`

Accept warnings only when there is a documented reason and the final response calls them out.

## Common Fixes

- Missing `primary`: add a `colors.primary` token and a matching `on-primary` token.
- Invalid dimensions: use simple values like `16px`, `1rem`, or `0px`; move `clamp()`, `min()`, `calc()`, and multi-value CSS to the markdown body.
- Invalid rounded token: use one value like `6px`; describe irregular sticker radii in prose or CSS examples.
- Contrast warnings: adjust component `backgroundColor`/`textColor` pairs to meet WCAG AA, or ensure the component is not used for text.
- Orphaned color tokens: either remove unused colors from front matter or reference them from component tokens.
- Section order warning: use Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts.

## Practical Pattern

Keep front matter boring and parseable. Put expressive implementation examples in the markdown body.

Good front matter:

```yaml
colors:
  primary: "#F8E808"
typography:
  title:
    fontFamily: "Arial Black, Impact, sans-serif"
    fontSize: "32px"
    lineHeight: "0.96"
rounded:
  sm: "4px"
```

Good markdown body:

```css
.display {
  font-size: clamp(3rem, 7vw, 8rem);
  border-radius: 18px 10px 22px 8px;
}
```
