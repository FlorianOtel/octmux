import { describe, test, expect } from "bun:test";
import { pickPostSummaryAssistantTokenUsage } from "./backend/v1-queries.ts";

type MessageForUsageScan = {
  info: {
    role?: string;
    summary?: boolean | unknown;
    providerID?: string;
    modelID?: string;
    tokens?: {
      input: number;
      cache?: { read?: number; write?: number };
    };
  };
};

describe("pickPostSummaryAssistantTokenUsage", () => {
  test("no-summary session returns latest non-summary assistant tokens", () => {
    const messages = [
      { info: { role: "assistant", tokens: { input: 1, cache: { read: 100000, write: 1000 } } } },
      { info: { role: "assistant", tokens: { input: 2, cache: { read: 50000, write: 500 } } } },
    ];
    const result = pickPostSummaryAssistantTokenUsage(messages);
    // Latest non-summary: input:2 + read:50000 + write:500 = 50502
    expect(result).toEqual({ used: 50502, providerID: undefined, modelID: undefined });
  });

  test("summary exists, post-summary assistant with non-zero tokens returns post-summary tokens", () => {
    const messages = [
      { info: { role: "assistant", tokens: { input: 1, cache: { read: 100000, write: 1000 } } } },
      { info: { role: "assistant", summary: true, tokens: { input: 6, cache: { read: 0, write: 315911 } } } },
      { info: { role: "assistant", tokens: { input: 6, cache: { read: 0, write: 43082 } } } },
    ];
    const result = pickPostSummaryAssistantTokenUsage(messages);
    // Post-summary: input:6 + read:0 + write:43082 = 43088
    expect(result).toEqual({ used: 43088, providerID: undefined, modelID: undefined });
  });

  test("summary exists, only zero-token post-summary assistant — falls to most recent non-zero post-summary", () => {
    const messages = [
      { info: { role: "assistant", tokens: { input: 1, cache: { read: 100000, write: 1000 } } } },
      { info: { role: "assistant", summary: true, tokens: { input: 6, cache: { read: 0, write: 315911 } } } },
      { info: { role: "assistant", tokens: { input: 0, cache: { read: 0, write: 0 } } } },
      { info: { role: "assistant", tokens: { input: 5, cache: { read: 0, write: 5000 } } } },
    ];
    const result = pickPostSummaryAssistantTokenUsage(messages);
    // Most recent non-zero post-summary: input:5 + read:0 + write:5000 = 5005
    expect(result).toEqual({ used: 5005, providerID: undefined, modelID: undefined });
  });

  test("summary exists, no post-summary assistant — returns null", () => {
    const messages = [
      { info: { role: "assistant", tokens: { input: 1, cache: { read: 100000, write: 1000 } } } },
      { info: { role: "assistant", summary: true, tokens: { input: 6, cache: { read: 0, write: 315911 } } } },
    ];
    const result = pickPostSummaryAssistantTokenUsage(messages);
    expect(result).toBeNull();
  });

  test("multiple summaries uses last summary as boundary, ignores messages between first and last", () => {
    const messages = [
      { info: { role: "assistant", tokens: { input: 1, cache: { read: 100000, write: 1000 } } } },
      { info: { role: "assistant", summary: true, tokens: { input: 6, cache: { read: 0, write: 10000 } } } },
      { info: { role: "assistant", tokens: { input: 10, cache: { read: 5000, write: 500 } } } },
      { info: { role: "assistant", summary: true, tokens: { input: 6, cache: { read: 0, write: 200000 } } } },
      { info: { role: "assistant", tokens: { input: 5, cache: { read: 0, write: 5000 } } } },
    ];
    const result = pickPostSummaryAssistantTokenUsage(messages);
    // Post-second-summary: input:5 + read:0 + write:5000 = 5005
    expect(result).toEqual({ used: 5005, providerID: undefined, modelID: undefined });
  });

  test("summary:true on non-assistant message ignored, boundary anchored to last assistant-summary", () => {
    const messages = [
      { info: { role: "assistant", tokens: { input: 1, cache: { read: 100000, write: 1000 } } } },
      { info: { role: "user", summary: { diffs: [] } } },
      { info: { role: "assistant", tokens: { input: 2, cache: { read: 0, write: 10000 } } } },
      { info: { role: "assistant", summary: true, tokens: { input: 6, cache: { read: 0, write: 100000 } } } },
      { info: { role: "assistant", tokens: { input: 3, cache: { read: 0, write: 5000 } } } },
    ];
    const result = pickPostSummaryAssistantTokenUsage(messages);
    // Post-summary: input:3 + read:0 + write:5000 = 5003
    expect(result).toEqual({ used: 5003, providerID: undefined, modelID: undefined });
  });

  test("no-summary backward-walk skips summary messages correctly", () => {
    const messages = [
      { info: { role: "assistant", summary: true, tokens: { input: 1, cache: { read: 1000000, write: 100000 } } } },
      { info: { role: "assistant", tokens: { input: 2, cache: { read: 50000, write: 5000 } } } },
      { info: { role: "assistant", summary: true, tokens: { input: 1, cache: { read: 0, write: 0 } } } },
      { info: { role: "assistant", tokens: { input: 3, cache: { read: 10000, write: 1000 } } } },
    ];
    const result = pickPostSummaryAssistantTokenUsage(messages);
    // Latest non-summary: input:3 + read:10000 + write:1000 = 11003
    expect(result).toEqual({ used: 11003, providerID: undefined, modelID: undefined });
  });

  test("foreign model from mobile app does not hijack token usage computation", () => {
    // Regression test for: octmux and mobile app share one OpenCode session.
    // When mobile app submits a prompt with model "requesty/google/gemini-3-pro-preview",
    // that assistant message becomes the latest in the shared session. The next
    // refreshTokenUsage call should still compute token usage correctly from the
    // latest post-summary assistant, but NOT overwrite octmux's activeModel.
    // This test verifies the token math is unchanged.
    const messages = [
      // Octmux's own assistant messages with octmux's model
      { info: { role: "assistant", summary: true, tokens: { input: 1, cache: { read: 0, write: 1000 } } } },
      { info: { role: "assistant", tokens: { input: 5, cache: { read: 0, write: 5000 } } } },
      // Foreign turn from mobile app with different model (should be ignored for token usage)
      { info: { role: "assistant", providerID: "requesty", modelID: "google/gemini-3-pro-preview", tokens: { input: 10, cache: { read: 0, write: 10000 } } } },
      // Latest non-summary assistant after foreign turn
      { info: { role: "assistant", tokens: { input: 3, cache: { read: 0, write: 5000 } } } },
    ];
    const result = pickPostSummaryAssistantTokenUsage(messages);
    // Token usage should be from latest non-summary assistant: input:3 + read:0 + write:5000 = 5003
    // The foreign model's tokens are ignored for the token bar computation
    expect(result).toEqual({ used: 5003, providerID: undefined, modelID: undefined });
    // Note: The helper returns undefined for providerID/modelID when summary exists.
    // In a real scenario, the providerID/modelID would come from the latest non-summary
    // assistant's info field. This test focuses on the token math being correct.
  });
});
