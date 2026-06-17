import { describe, test, expect, beforeEach } from "bun:test";
import { mintUserMessageID, resetMintCounter } from "./message-id.ts";

describe("mintUserMessageID", () => {
  beforeEach(() => {
    resetMintCounter();
  });

  test("prefix is 'msg_' and total length is 30", () => {
    const id = mintUserMessageID();
    expect(id.startsWith("msg_")).toBe(true);
    expect(id.length).toBe(30);
  });

  test("12 chars after 'msg_' are lowercase hex [0-9a-f]", () => {
    const id = mintUserMessageID();
    const hexPart = id.slice(4, 16);
    expect(hexPart.length).toBe(12);
    for (let i = 0; i < 12; i++) {
      const char = hexPart[i];
      const isDigit = /[0-9]/.test(char);
      const isLowerHex = /[a-f]/.test(char);
      expect(isDigit || isLowerHex).toBe(true);
    }
  });

  test("14-char suffix are all from [0-9A-Za-z]", () => {
    const id = mintUserMessageID();
    const suffix = id.slice(16);
    expect(suffix.length).toBe(14);
    for (let i = 0; i < 14; i++) {
      const char = suffix[i];
      const isDigit = /[0-9]/.test(char);
      const isUpper = /[A-Z]/.test(char);
      const isLower = /[a-z]/.test(char);
      expect(isDigit || isUpper || isLower).toBe(true);
    }
  });

  test("strictly ascending across rapid same-ms mints", () => {
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const id = mintUserMessageID();
      ids.push(id);
    }

    // Lexically ascending (string comparison)
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }

    // BigInt timestamp+counter ascending
    let prevBigInt = BigInt("0x" + ids[0].slice(4, 16));
    for (let i = 1; i < ids.length; i++) {
      expect(BigInt("0x" + ids[i].slice(4, 16)) >= prevBigInt).toBe(true);
      prevBigInt = BigInt("0x" + ids[i].slice(4, 16));
    }
  });

  test("hex-temporal ordering: sorts less than future, greater than past", () => {
    resetMintCounter();
    const now = Date.now();
    // Mint an ID at current time
    const currentId = mintUserMessageID();
    const currentHex = currentId.slice(4, 16);

    // Future timestamp: 0xee000000000000000000000000
    const futureId = "msg_ee000000000000000000000000a";
    expect(currentId < futureId).toBe(true);

    // Past timestamp: 0x0a000000000000000000000000
    const pastId = "msg_0a000000000000000000000000a";
    expect(currentId > pastId).toBe(true);
  });
});
