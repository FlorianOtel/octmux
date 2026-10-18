# octmux — Project Rules for Claude Code

## After every code change

After any change to `src/`, you MUST:

1. **Rebuild the binary:**
   ```
   bash scripts/build.sh
   ```
   This injects the current git branch, short commit hash, and build timestamp into the binary via `bun --define`. The binary at `dist/octmux` is what the user actually runs. Never report a change as complete without rebuilding.

   **Building on Linux and macOS (shared NFS tree).** The same working tree, `node_modules/` included, is built on both the Linux server and the Mac. `scripts/build.sh` needs no per-platform change:
   - `@opencode/client` is pinned to a published npm version (`"^2.0.28"` in `package.json`, resolved in `bun.lock` with an integrity hash). `node_modules/@opencode/client` therefore holds real files that both hosts read identically.
   - Do **not** go back to a `file:` path for any OpenCode client package: it makes `bun install` write symlinks to an absolute, host-specific path. A build on one host then leaves `node_modules` pointing at paths the other host does not have, and the next build there fails.
   - To bump the client, for example with an OpenCode upgrade, change the pin, then run `$HOME/.bun/bin/bun install` once on either host. It updates `bun.lock` and the shared `node_modules` for both.
   - Build on one host at a time, because both write the same `dist/octmux`. After each build, copy the binary to that host's `~/.local/bin/octmux`, and check the platform first (`file dist/octmux`: Mach-O arm64 on the Mac, ELF x86-64 on Linux). Copying the other platform's binary breaks octmux on that host.
   - `scripts/build.sh` uses `${BUN:-$HOME/.bun/bin/bun}`, so the bun path resolves per host.

2. **Update docs and memory:**
   - Add an implementation log entry to the relevant `docs/StageN.md`. Work can continue in parallel on different stages — new commits do _not_ necessarily go in the "latest stage", but should be filed against the most appropriate stage. Each entry must include two metadata lines immediately after the `### YYYY-MM-DD--HH-MM — Title` heading:
     ```
     **Implemented by:** <agent name (model)> — YYYY-MM-DD--HH-MM
     **Commit(s):** `hash1`, `hash2`   ← all hashes comma-separated on one line
     ```
   - Refresh `updated_by` / `updated_at` frontmatter in every doc you touched
   - Update `/home/florian/.claude/projects/-mnt-nfs-Florian-Gin-AI-projects-octmux/memory/project-octmux.md` with stages shipped, architecture changes, and the new commit hash

3. **Commit** — stage `src/`, updated docs, and any changed config files (`dist/` is gitignored — the binary is not committed):
   ```
   git add src/ docs/ CLAUDE.md config/
   git commit -m "feat(octmux): Stage N.x — <title>"
   ```

4. **Deploy `config/` files** — if the commit touches any file under `config/`, copy it to its runtime location immediately after committing:
   - `config/toggle-keybindings.json` → `~/.config/octmux/toggle-keybindings.json`
   ```
   mkdir -p ~/.config/octmux
   cp config/toggle-keybindings.json ~/.config/octmux/toggle-keybindings.json
   ```
   The app reads `~/.config/octmux/toggle-keybindings.json` at startup. Without this deploy step, the committed change has no effect until the file is manually copied.

---

## Project overview

octmux is a text-only TUI REPL for OpenCode. It runs inside tmux and communicates with an OpenCode v2 HTTP server via `@opencode/client`.

**Binary:** `dist/octmux` (compiled with `bun build --compile`)
**Dev run:** `/home/florian/.bun/bin/bun run src/index.tsx`
**Always use full bun path:** `/home/florian/.bun/bin/bun` — never bare `bun`

**Default startup (as of Stage 4.1c):** `octmux` with no args attaches to port 4096. The systemd service (`scripts/opencode-server.service`) must be running.

**Startup flags:** `--single`/`--multi-window` (display mode, required), `--endpoint <url>`, `--no-tmux-guard`, `--resume <id>`, `--resume-last`, `--fork <id>`, `-w`/`--worktree [<name>]` (Stage 5.9).

**Docs:** `docs/Stage7.md` is the latest implementation log (work can continue in parallel on different stages). `docs/Implementation-plan.md` is the stage-level design reference.
