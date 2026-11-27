/**
 * A refusal a page can meet while it loads — a module not open to this person, one outside the plan, a permission not
 * held — told apart from a real failure by the error page (owner, 26 Nov 2026: "if error page comes because of no
 * permission then show you have no permission to view instead"; src/components/layout/page-error.tsx).
 *
 * Next sends the browser only an error's `digest`, never its message, so the kind travels there: an error that already
 * has a digest keeps it (next/dist/server/app-render/create-error-handler.js). Each still ends in its own id, so the
 * reference the page shows matches one line of the server's log, as any other error's does.
 *
 * Shared by the server, which throws these, and the error page, which reads them — so nothing here imports the server.
 */

export type NoAccessKind = "permission" | "plan";

const PREFIX: Record<NoAccessKind, string> = { permission: "DESKZO_NO_ACCESS", plan: "DESKZO_NOT_IN_PLAN" };

const id = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replaceAll("-", "").slice(0, 12);

export class NoAccessError extends Error {
  readonly digest: string;
  constructor(message: string, kind: NoAccessKind = "permission") {
    super(message);
    this.name = "NoAccessError";
    this.digest = `${PREFIX[kind]}:${id()}`;
  }
}

/** What an error page was handed: a refusal of either kind, or null for anything else. */
export function noAccessKind(digest: string | undefined): NoAccessKind | null {
  if (!digest) return null;
  if (digest.startsWith(`${PREFIX.permission}:`)) return "permission";
  if (digest.startsWith(`${PREFIX.plan}:`)) return "plan";
  return null;
}
