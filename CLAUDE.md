# octmux — Project Rules for Claude Code

## After every code change

After any change to `src/`, you MUST:

1. **Rebuild the binary:**
   ```
   /home/florian/.bun/bin/bun build src/index.tsx --compile --target bun-linux-x64 --outfile dist/octmux
   ```
   The binary at `dist/octmux` is what the user actually runs. Never report a change as complete without rebuilding.

2. **Update docs and memory:**
   - Add an implementation log entry to the relevant `docs/PhaseN.md`. Each entry must include two metadata lines immediately after the `### YYYY-MM-DD--HH-MM — Title` heading:
     ```
     **Implemented by:** <agent name (model)> — YYYY-MM-DD--HH-MM
     **Commit(s):** `hash1`, `hash2`   ← all hashes comma-separated on one line
     ```
   - Refresh `updated_by` / `updated_at` frontmatter in every doc you touched
   - Update `/home/florian/.claude/projects/-mnt-nfs-Florian-Gin-AI-projects-octmux/memory/project-octmux.md` with phases shipped, architecture changes, and the new commit hash

3. **Commit** — stage `src/` and updated docs (`dist/` is gitignored — the binary is not committed):
   ```
   git add src/ docs/ CLAUDE.md
   git commit -m "feat(octmux): Phase N.x — <title>"
   ```

---

## Project overview

octmux is a text-only TUI REPL for OpenCode. It runs inside tmux and communicates with an OpenCode HTTP server via `@opencode-ai/sdk`.

**Binary:** `dist/octmux` (compiled with `bun build --compile`)
**Dev run:** `/home/florian/.bun/bin/bun run src/index.tsx`
**Always use full bun path:** `/home/florian/.bun/bin/bun` — never bare `bun`

**Default startup (as of Phase 4.1c):** `octmux` with no args attaches to port 4096. The systemd service (`scripts/opencode-server.service`) must be running. Use `--auto-spawn` only as an explicit opt-in (risk: SQLite locking + MCP/LSP bloat from multiple instances).

**Docs:** `docs/Phase4.md` is the active implementation log. `docs/Implementation-plan.md` is the phase-level design reference.
