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
    name: "/rag",
    usage: "/rag <search <query> | on | off | only>",
    description: "RAG retrieval from SoHoAI knowledge base (modes: search, on, off, only)",
    dynamic: () => ["/rag search", "/rag on", "/rag off", "/rag only"],
  },
  {
    name: "/<key>-output",
    usage: "/<key>-output [on|off]",
    description: "toggle or query the output gate for a block type (e.g. thinking, tools)",
    dynamic: () => OUTPUT_KEYS.map(k => "/" + k + "-output"),
  },
  {
    name: "/help",
    usage: "/help",
    description: "list all known slash commands",
  },
];

// Resolves dynamic entries to concrete completion candidates,
// replaces static entries with their `name` field directly.
// Result: flat string[] of all completable slash-tokens.
export function expandCommands(): string[] {
  const result: string[] = [];
  for (const cmd of COMMANDS) {
    if (cmd.dynamic) {
      result.push(...cmd.dynamic());
    } else {
      result.push(cmd.name);
    }
  }
  return result;
}
