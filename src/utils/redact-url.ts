// Credential-safe rendering of a server URL for console output.
//
// A URL may carry credentials in its userinfo part (http://user:pass@host).
// Any message that prints an endpoint must go through redactUrl() so the
// secret never reaches the terminal or a log.

/**
 * Returns `url` with any username and password removed, and without a
 * trailing slash. Used at every print site that shows the server endpoint.
 *
 * If `url` cannot be parsed, it is returned unchanged. Callers must not pass
 * a raw, unparseable user-supplied string to a message when it could contain
 * a secret; in index.tsx that case is handled by not echoing the value at all.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Blanking the fields removes the userinfo part from the serialised URL.
    // Setting an empty string is a no-op when the field was already absent.
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}
