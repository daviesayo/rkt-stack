#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../plugins/rkt" && pwd)"

ANALYSIS_SKILL="$ROOT/skills/visual-identity-folder-analysis"
DESIGN_SKILL="$ROOT/skills/visual-identity-to-design-md"

for path in \
  "$ANALYSIS_SKILL/SKILL.md" \
  "$ANALYSIS_SKILL/scripts/prepare_visual_references.py" \
  "$DESIGN_SKILL/SKILL.md" \
  "$DESIGN_SKILL/references/design-md-linting.md" \
  "$DESIGN_SKILL/references/stack-targeting.md"; do
  if [[ ! -f "$path" ]]; then
    echo "Missing visual identity skill artifact: ${path#$ROOT/}" >&2
    exit 1
  fi
done

HOME_PATH_PATTERN="/Users""/rocket"

if grep -R "$HOME_PATH_PATTERN" "$ANALYSIS_SKILL" "$DESIGN_SKILL" >/dev/null; then
  echo "Visual identity skills must not hardcode machine-local home paths" >&2
  exit 1
fi

STANDALONE_SKILL_PATTERN="~/.codex/skills/""visual-identity-folder-analysis"

if grep -R "$STANDALONE_SKILL_PATTERN" "$DESIGN_SKILL" >/dev/null; then
  echo "visual-identity-to-design-md must use the bundled rkt skill, not ~/.codex/skills" >&2
  exit 1
fi

grep -q 'CLAUDE_PLUGIN_ROOT' "$DESIGN_SKILL/SKILL.md" || {
  echo "visual-identity-to-design-md should document plugin-root resolution" >&2
  exit 1
}

grep -q '@google/design.md lint' "$DESIGN_SKILL/SKILL.md" || {
  echo "visual-identity-to-design-md should include Google DESIGN.md linting" >&2
  exit 1
}

if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  TMPDIR="$(mktemp -d /tmp/rkt-visual-skill-test.XXXXXX)"
  trap 'rm -rf "$TMPDIR"' EXIT

  ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=yellow:s=64x64 -frames:v 1 "$TMPDIR/ref1.png"
  python3 "$ANALYSIS_SKILL/scripts/prepare_visual_references.py" "$TMPDIR" --out "$TMPDIR/out-one" >/dev/null
  [[ -f "$TMPDIR/out-one/contact-sheet.png" ]] || {
    echo "one-image visual prep smoke test did not create contact-sheet.png" >&2
    exit 1
  }

  ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=blue:s=64x64 -frames:v 1 "$TMPDIR/ref2.png"
  python3 "$ANALYSIS_SKILL/scripts/prepare_visual_references.py" "$TMPDIR" --out "$TMPDIR/out-two" >/dev/null
  [[ -f "$TMPDIR/out-two/rows/row-01-02.png" ]] || {
    echo "two-image visual prep smoke test did not create expected row sheet" >&2
    exit 1
  }
else
  echo "Skipping visual prep smoke test: ffmpeg/ffprobe not available."
fi

echo "Visual identity skills are packaged for rkt."
