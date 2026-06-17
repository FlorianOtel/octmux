/**
 * Message ID minting - faithful port of OpenCode server's Identifier.ascending("message").
 * 
 * The server uses hex-timestamp ULID format to ensure lexical sortability.
 * Base-36 was rejected because it breaks lexical ordering of timestamps.
 * This implementation uses: 4 bytes timestamp (12 hex chars) + 14 char base62 suffix.
 * 
 * Total ID length = 30 chars ("msg_" + 12 hex + 14 base62).
 * 
 * Reference: opencode packages/opencode/src/id/id.ts:60-69
 */

// Module-level mutable state for counter-based timestamp within same millisecond
let lastTimestamp: number = 0;
let counter: number = 0;

/**
 * Generate a fresh user message ID matching the server's ULID-based scheme.
 * 
 * Format: "msg_" + 12-char hex timestamp + 14-char base62 random suffix
 * 
 * @returns 30-character message ID
 */
export function mintUserMessageID(): string {
  // Get current timestamp
  const now = Date.now();
  
  // Update timestamp with counter if same millisecond
  if (now === lastTimestamp) {
    counter++;
  } else {
    counter = 0;
    lastTimestamp = now;
  }
  
  // Compute ULID value: timestamp * 0x1000 + counter
  const v = BigInt(now) * BigInt(0x1000) + BigInt(counter);
  
  // Encode timestamp as 6 bytes (12 hex chars)
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((v >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  
  // Generate 14-char base62 suffix for collision avoidance
  const randomSuffix = randomBase62(14);
  
  return "msg_" + timeBytes.toString("hex") + randomSuffix;
}

/**
 * Generate a random string using base62 alphabet.
 * Uses Math.random() (sufficient for uniqueness goal).
 * 
 * @param n Number of characters to generate
 * @returns Random base62 string of length n
 */
function randomBase62(n: number): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let result = "";
  for (let i = 0; i < n; i++) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

/**
 * Reset the minting counter to zero for deterministic testing.
 * Sets lastTimestamp to 0 and counter to 0.
 */
export function resetMintCounter(): void {
  lastTimestamp = 0;
  counter = 0;
}
