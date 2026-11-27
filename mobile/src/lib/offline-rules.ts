/**
 * What the phone keeps to show offline (owner, 6 Nov 2026), as plain rules (check:pwa holds them): the person's own
 * work — Today, tasks, meetings, visits — and who they are, for three days. Nothing with money or a report in it, and
 * no search: a kept answer sits in the app's private files until sign-out or its three days are up.
 */
export const KEPT_FOR_MS = 3 * 24 * 60 * 60 * 1000;

const KEPT = ["/api/app/me", "/api/app/today", "/api/app/tasks", "/api/app/meetings", "/api/app/visits"];

/** Whether the answer to this GET may be kept: one of those lists, its first page, not a search. */
export function keepsPath(path: string): boolean {
  const [base, query = ""] = path.split("?");
  if (!KEPT.includes(base!)) return false;
  const params = new URLSearchParams(query);
  const page = params.get("page");
  return !params.get("search") && (page === null || page === "1");
}

export type Kept = { savedAt: number; data: unknown; page: unknown };

export function encodeCopy(data: unknown, page: unknown, now: number): string {
  return JSON.stringify({ savedAt: now, data, page });
}

/** A kept answer as read back, or null — unreadable, or past its three days. */
export function decodeCopy(text: string, now: number): Kept | null {
  try {
    const copy = JSON.parse(text) as Partial<Kept>;
    if (typeof copy.savedAt !== "number" || now - copy.savedAt > KEPT_FOR_MS || copy.savedAt > now + 60_000) return null;
    return { savedAt: copy.savedAt, data: copy.data, page: copy.page ?? null };
  } catch {
    return null;
  }
}
