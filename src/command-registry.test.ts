import { describe, expect, test } from "bun:test";
import { expandCommands, setServerCommands } from "./command-registry.ts";

// Server commands come from the server's command list (Backend.listCommands), not from files.
describe("setServerCommands", () => {
  test("server command names join the completion list with a leading slash", () => {
    setServerCommands(["brain", "review"]);
    const all = expandCommands();
    expect(all).toContain("/brain");
    expect(all).toContain("/review");
    setServerCommands([]);
  });

  test("a server name that equals a built-in is not listed twice", () => {
    setServerCommands(["help"]);
    expect(expandCommands().filter(c => c === "/help")).toHaveLength(1);
    setServerCommands([]);
  });

  test("a later call replaces the earlier list", () => {
    setServerCommands(["brain"]);
    setServerCommands(["rag"]);
    const all = expandCommands();
    expect(all).toContain("/rag");
    expect(all).not.toContain("/brain");
    setServerCommands([]);
  });
});
