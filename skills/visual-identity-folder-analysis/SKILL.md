---
name: visual-identity-folder-analysis
description: Analyze folders of visual reference images into a cohesive brand/design language and visual identity system. Use when the user provides or mentions a folder of images, moodboard assets, screenshots, posters, logos, art references, or visual inspiration and asks for deep visual analysis, design DNA extraction, brand identity definition, color/typography/layout synthesis, contact sheets, image-by-image audits, or a reusable visual identity report.
---

# Visual Identity Folder Analysis

Use this skill to turn a folder of reference images into a complete visual identity analysis. Always inspect every supported image, generate contact sheets and palette samples, then synthesize a design system grounded in direct evidence from the images.

## Quick Start

1. Resolve the source folder path from the user's request.
2. Create an output directory in the current workspace, unless the user specifies one.
3. Run the bundled prep script:

```bash
python3 <skill-dir>/scripts/prepare_visual_references.py "<source-folder>" --out "<output-dir>"
```

4. Open the generated contact sheets with `view_image`, especially:
   - `<output-dir>/contact-sheet.png`
   - `<output-dir>/rows/row-*.png`
5. Read:
   - `<output-dir>/manifest.tsv`
   - `<output-dir>/palette-samples.tsv`
   - `<output-dir>/inventory.tsv`
6. Inspect individual originals with `view_image` when typography, texture, or details are unclear.
7. Produce the final analysis report in Markdown and link it in the response.

## Script Behavior

`scripts/prepare_visual_references.py` uses FFmpeg, not Pillow/ImageMagick, because FFmpeg is commonly available and reliably handles JPG, PNG, GIF first frames, and WebP. The script creates:

- `manifest.tsv`: stable numbering mapped to filenames
- `inventory.tsv`: dimensions, format, and aspect ratio
- `palette-samples.tsv`: sampled dominant colors per image
- `contact-sheet.html`: browser-friendly sheet referencing original files
- `contact-sheet.png`: numbered overview sheet
- `rows/row-*.png`: smaller numbered row sheets for visual inspection
- `thumbs/*.png`: generated numbered thumbnails

If the script fails because FFmpeg is missing, use `sips` or another local image tool as a fallback, but preserve the same output contract where possible.

## Analysis Workflow

### 1. Inventory

Count every supported image in the folder. Ignore `.DS_Store` and non-image files unless the user explicitly asks to analyze them. Use the manifest numbers consistently in notes and citations.

Supported extensions by default: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, `.tif`, `.tiff`, `.avif`.

### 2. Contact Sheet Inspection

Use the generated overview sheet to identify:

- recurring motifs and symbols
- dominant color families
- typography categories
- layout/composition archetypes
- texture/material patterns
- imagery types
- outliers and secondary themes

Use row sheets for close inspection. Open originals for any image where the thumbnail hides text, surface quality, or layout details.

### 3. Image-By-Image Audit

For every image, document:

- color palette: dominant, secondary, accent tones, with hex values when determinable
- typography: serif/sans/graffiti/display/handwritten, weight, spacing, mood
- layout: grid, centering, hierarchy, whitespace, density, framing
- texture/material: paper, print, xerox, halftone, grain, tape, marker, digital gloss, etc.
- imagery style: photography, illustration, collage, abstraction, realism, object still life
- mood/tone: emotional and cultural register
- motifs: recurring shapes, marks, symbols, graphic devices

Use concise rows or compact bullets for large sets. The goal is complete coverage without burying the synthesis.

### 4. Pattern Synthesis

Separate:

- **Defining DNA:** patterns that recur across many references and should become identity principles.
- **Secondary themes:** useful but not core.
- **Noise/outliers:** one-off content, brand names, subjects, or accidental artifacts.

Ground every synthesis point in manifest numbers or filenames.

### 5. Identity Definition

Define:

- brand color palette: primary, secondary, accent, neutral/material colors with hex codes and rationale
- typography system: display, logo/custom, utility, body, and hierarchy recommendations
- graphic language: shapes, patterns, composition rules, outlines, effects, surface treatments
- imagery direction: photography/illustration/object/collage treatment
- tone/personality: emotional and cultural associations
- usage principles: rules for combining elements consistently

Do not recommend generic branding conventions that are unsupported by the references. Cite source images for each meaningful design decision.

## Output Format

Create a Markdown report named descriptively, for example:

```text
<output-dir>/visual-identity-analysis.md
```

Use this structure:

```markdown
# <Project/Folder Name>: Visual Identity Analysis

Source folder: `<path>`
Generated assets: `<output-dir>`

## Executive Summary
## Image-By-Image Audit
## Pattern Synthesis
## Visual Identity System
### Brand Color Palette
### Typography System
### Graphic Language
### Imagery Direction
### Tone and Personality
### Usage Principles
## Recommended Starter Toolkit
```

In the final chat response, summarize only the strongest identity takeaways and link to:

- the Markdown report
- `contact-sheet.html`
- `contact-sheet.png`

## Quality Bar

- Every supported image in the folder must be represented in the audit.
- Contact sheets must be generated before synthesis.
- Palette recommendations must be derived from sampled colors plus visual judgment.
- Typography recommendations must describe visible type behavior, not just font names.
- The final identity must have opinionated non-negotiables, not a moodboard paraphrase.
