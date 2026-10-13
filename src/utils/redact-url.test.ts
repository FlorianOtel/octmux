import { describe, expect, test } from "bun:test";
import { redactUrl } from "./redact-url";

describe("redactUrl", () => {
  test("removes username and password from userinfo", () => {
    expect(redactUrl("https://opencode:s3cret@example.test:49374")).toBe(
      "https://example.test:49374",
    );
  });

  test("strips the trailing slash and leaves a plain URL otherwise unchanged", () => {
    expect(redactUrl("http://127.0.0.1:4096/")).toBe("http://127.0.0.1:4096");
    expect(redactUrl("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096");
  });

  test("returns the input unchanged when it cannot be parsed", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });
});
