// Single process-wide auth state: set once at startup from the resolved
// config password, read everywhere a request is made. octmux is a
// single-user CLI process, so a module-level singleton (not prop-drilling
// through every component/function signature) is the simplest correct
// design — see RESEARCH.md / Stage14 rationale.
//
// SECURITY: the password value must never be logged, printed, or included in
// an error message. Only the derived header is ever handed to a request.
let authHeader: Record<string, string> = {};

/**
 * Stores the server password and derives the HTTP Basic auth header from it.
 * Passing undefined or an empty string clears the header, so requests are
 * sent without auth.
 */
export function setAuthPassword(password: string | undefined): void {
  authHeader = password
    ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
    : {};
}

/**
 * Returns the headers to merge into every request to the OpenCode server.
 * Returns an empty object when no password has been set.
 */
export function getAuthHeaders(): Record<string, string> {
  return authHeader;
}
