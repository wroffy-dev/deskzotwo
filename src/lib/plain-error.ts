/**
 * The message a failed action shows (security audit, 11 Nov 2026 — SEC-56).
 *
 * Some twenty-five actions answered a failure with whatever the caught error said. Our own refusals ("the books are
 * closed to …", "row 14 has no amount") are written for people and belong on the screen; a database or library error
 * names tables, columns, queries and file paths, which is a map of the inside handed to whoever provoked it. So the
 * first kind passes through, and the second is logged on the server and replaced by the sentence the action gives.
 *
 * The rule first lived in src/actions/ledger.ts, which still keeps its own copy.
 */

/** Errors the language or the runtime raises: never written for the person at the screen. */
const RUNTIME_NAMES = new Set(["TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError", "AggregateError"]);

/** Prisma's `P2002`, Node's `ECONNREFUSED`, PostgreSQL's `23505`. */
const INTERNAL_CODE = /^(P\d{4}|E[A-Z]{3,}|(?=[0-9A-Z]*\d)[0-9A-Z]{5})$/;

const INTERNAL_WORDS = /prisma|invocation|violates|constraint|ECONN|ETIMEDOUT|ENOTFOUND|node_modules/i;

/** Whether an error came from the database, a library or the runtime rather than from a refusal of ours. */
export function isInternalError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const name = error.name || "";
  if (name.startsWith("Prisma") || name.startsWith("DriverAdapter") || RUNTIME_NAMES.has(name)) return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && INTERNAL_CODE.test(code)) return true;
  const message = error.message ?? "";
  return !message.trim() || message.length > 500 || message.includes("\n") || INTERNAL_WORDS.test(message);
}

/** The error's own words when they are ours; otherwise the fallback, with the real error logged. */
export function plainError(error: unknown, fallback: string): string {
  if (isInternalError(error)) {
    console.error(fallback, error);
    return fallback;
  }
  return (error as Error).message;
}
