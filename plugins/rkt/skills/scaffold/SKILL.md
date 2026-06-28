---
name: scaffold
description: Scaffold an AGENTS.md (+ CLAUDE.md) and shared memory pattern for this repo from the reusable template and fill it in from the codebase. Triggers on "scaffold this project", "set up agents.md", "scaffold agent instructions".
---

Scaffold this project's agent instructions so the user never re-teaches conventions from scratch.

Steps:

1. Resolve the plugin root, then run the helper to drop the files (it never overwrites existing ones):

   ```bash
   RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
   bash "${RKT_PLUGIN_ROOT}/skills/scaffold/scaffold-agents.sh"
   ```

2. Set up the shared memory pattern (idempotent — skip silently if already present):

   ```bash
   PROJECT_ABS_PATH="$(pwd)"
   ENCODED=$(echo "$PROJECT_ABS_PATH" | sed 's|/|-|g')
   MEMORY_DIR="/Users/rocket/.claude/projects/${ENCODED}/memory"

   # Create memory dir and empty index if absent
   mkdir -p "$MEMORY_DIR"
   [ -f "$MEMORY_DIR/MEMORY.md" ] || printf '# Memory index\n' > "$MEMORY_DIR/MEMORY.md"

   # Symlink into project root (skip if already exists)
   if [ ! -e "$PROJECT_ABS_PATH/.memory" ]; then
     ln -s "$MEMORY_DIR" "$PROJECT_ABS_PATH/.memory"
   fi

   # Add .memory to .gitignore if not already present
   GITIGNORE="$PROJECT_ABS_PATH/.gitignore"
   if [ -f "$GITIGNORE" ]; then
     if ! grep -qxF '.memory' "$GITIGNORE"; then
       printf '\n# Shared agent memory — machine-local symlink, not portable\n.memory\n' >> "$GITIGNORE"
     fi
   else
     printf '# Shared agent memory — machine-local symlink, not portable\n.memory\n' > "$GITIGNORE"
   fi

   # Copy Cursor memory rules if not already present
   CURSOR_RULES_SRC="/Users/rocket/Documents/Repositories/rkt-stack/.cursor/rules"
   mkdir -p "$PROJECT_ABS_PATH/.cursor/rules"
   if [ ! -f "$PROJECT_ABS_PATH/.cursor/rules/memory-read.mdc" ]; then
     cp "$CURSOR_RULES_SRC/memory-read.mdc" "$PROJECT_ABS_PATH/.cursor/rules/"
   fi
   if [ ! -f "$PROJECT_ABS_PATH/.cursor/rules/memory-write.mdc" ]; then
     cp "$CURSOR_RULES_SRC/memory-write.mdc" "$PROJECT_ABS_PATH/.cursor/rules/"
   fi
   ```

3. If `AGENTS.md` was newly created, fill it in from THIS repo — do not leave `{{PLACEHOLDER}}` tokens:
   - Detect the stack from `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` / `*.xcodeproj` etc. and fill the **Tech Stack** table and **Commands** block with the project's real install/test/lint/typecheck/build commands.
   - Write **What this project is** (+ a "this is NOT" line) from the README and source.
   - Infer **Architecture** (entry point, surfaces, key pattern) by reading the entry file and top-level dirs.
   - Keep the **Non-negotiable rules**, **Testing/TDD**, **Commit convention**, and **Conventions** sections — adjust their specifics to this repo's actual tooling.
   - DELETE the `## How to use this template` block and the `## Section frequency` table (they are template scaffolding, not project docs).
   - Delete any `(optional)` section that doesn't apply here.

4. The user's global working-style rules live in `~/.claude/CLAUDE.md` — do NOT duplicate them into AGENTS.md. AGENTS.md is for project-specific facts (stack, commands, architecture, domain invariants) only.

5. Show the user the filled AGENTS.md and ask them to review before committing. Do not commit unless asked.
