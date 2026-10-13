import { OUTPUT_KEYS } from "./renderer/output-keys.ts";

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
    name: "/resync",
    usage: "/resync",
    description: "force a full re-fetch of session state (Ctrl-R)",
  },
  {
    name: "/help",
    usage: "/help",
    description: "list all known slash commands",
  },
];

// ─── Server command list ──────────────────────────────────────────────────────
//
// OpenCode commands (built-ins such as /review and /init, and the server's custom
// commands such as /brain) come from the server's own command list, the same list
// app.tsx uses to decide what to forward (`Backend.listCommands`). app.tsx stores the
// names here once the list arrives, shortly after startup, so PromptInput
// highlighting and the slash completion overlay cover them. octmux is an OpenCode
// client and does not read the server's command files.
let _server: string[] = [];

// Record the server's command names (without the leading "/"). Names already present
// in the built-in COMMANDS registry are skipped, so a server command never shadows a
// built-in in the overlay.
export function setServerCommands(names: string[]): void {
  const builtinNames = new Set(
    COMMANDS.flatMap(c => c.dynamic ? c.dynamic() : [c.name])
  );
  _server = names.map(n => "/" + n).filter(n => !builtinNames.has(n));
}

// Resolves dynamic entries to concrete completion candidates,
// replaces static entries with their `name` field directly.
// Appends the server commands recorded by setServerCommands().
// extraCandidates are appended last, deduped against everything already in
// the result.
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
  result.push(..._server);
  if (extraCandidates && extraCandidates.length > 0) {
    // Deduplicate: extras may repeat the server names. Skip extras already
    // present so the overlay and /help output show no duplicates.
    const existing = new Set(result);
    for (const c of extraCandidates) {
      if (!existing.has(c)) result.push(c);
    }
  }
  return result;
}
