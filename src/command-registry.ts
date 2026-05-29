import { OUTPUT_KEYS } from "./renderer/output-keys.ts";
import { readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type CommandSpec = {
  name: string;
  usage: string;
  description: string;
  dynamic?: () => string[];
};

// Registry of all shipped commands. Order determines /help display order.
export const COMMANDS: CommandSpec[] = [
  {
    name: "/exit",
    usage: "/exit",
    description: "exit octmux cleanly (alias: /quit)",
  },
  {
    name: "/rename",
    usage: "/rename <name>",
    description: "rename the current session",
  },
  {
    name: "/model",
    usage: "/model [<provider>/<model>]",
    description: "list providers/models (no arg) or set the active model",
  },
  {
    name: "/show",
    usage: "/show",
    description: "show output gate status for thinking/tools",
  },
  {
    name: "/<key>-output",
    usage: "/<key>-output [on|off]",
    description: "toggle or query the output gate for a block type (e.g. thinking, tools)",
    dynamic: () => OUTPUT_KEYS.map(k => "/" + k + "-output"),
  },
  {
    name: "/new",
    usage: "/new",
    description: "create a new session and clear the view (alias: /clear)",
  },
  {
    name: "/compact",
    usage: "/compact",
    description: "compact the current session (alias: /summarize)",
  },
  {
    name: "/sessions",
    usage: "/sessions",
    description: "pick a past session to resume (alias: /resume)",
  },
  {
    name: "/fork",
    usage: "/fork",
    description: "fork the current session into a child",
  },
  {
    name: "/help",
    usage: "/help",
    description: "list all known slash commands",
  },
];

// ─── External command discovery ───────────────────────────────────────────────
//
// Commands defined as *.md files under ~/.config/opencode/commands/ are
// discovered synchronously at startup by loadExternalCommands() and stored
// here. Populated once before render(); read-only after that (no hot-reload).
//
// Only ~/.config/opencode/commands/ is scanned — NOT per-project
// .opencode/commands/ dirs. This matches the user's deliberate choice to keep
// orchestra and RAG commands in the global config directory.
//
// Future-proof: adding a new *.md file to ~/.config/opencode/commands/ is
// automatically picked up on the next octmux start — no registry edit needed.
let _external: string[] = [];

// Scan ~/.config/opencode/commands/ and record each *.md basename as a
// slash-command name (e.g. "brain.md" → "/brain"). Called synchronously in
// index.tsx before render() so PromptInput highlighting is correct from the
// very first frame. Skips names already present in the built-in COMMANDS
// registry. Silent on any FS error (dir absent, unreadable, etc.).
export function loadExternalCommands(): void {
  const dir = join(homedir(), ".config", "opencode", "commands");
  // Build set of all built-in names (including dynamic expansions) to avoid
  // surfacing duplicates when an external command shadows a built-in.
  const builtinNames = new Set(
    COMMANDS.flatMap(c => c.dynamic ? c.dynamic() : [c.name])
  );
  const found: string[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const name = "/" + f.slice(0, -3);
      if (!builtinNames.has(name)) found.push(name);
    }
  } catch {
    // Directory absent or unreadable — octmux works fine without external commands.
  }
  _external = found;
}

// Resolves dynamic entries to concrete completion candidates,
// replaces static entries with their `name` field directly.
// Appends external commands discovered by loadExternalCommands().
// extraCandidates (e.g. from the async client.command.list() fetch) are
// appended last, deduped against everything already in the result.
// Result: flat string[] of all completable slash-tokens.
export function expandCommands(extraCandidates?: string[]): string[] {
  const result: string[] = [];
  for (const cmd of COMMANDS) {
    if (cmd.dynamic) {
      result.push(...cmd.dynamic());
    } else {
      result.push(cmd.name);
    }
  }
  result.push(..._external);
  if (extraCandidates && extraCandidates.length > 0) {
    // Deduplicate: client.command.list() may return the same names as the
    // filesystem scan. Skip extras already present so the overlay and
    // /help output show no duplicates.
    const existing = new Set(result);
    for (const c of extraCandidates) {
      if (!existing.has(c)) result.push(c);
    }
  }
  return result;
}
