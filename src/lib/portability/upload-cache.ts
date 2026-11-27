import { randomUUID } from "node:crypto";

/**
 * A file being imported a window at a time (src/lib/portability/import.ts `RowWindow`), read once and kept here, so
 * the screen sends the file with its first request and only a token after — not 14,000 rows of leads seventy times
 * over a slow connection. Kept for an hour, for the person, area and file it was read for; on globalThis, as the
 * proxy and the routes are separate bundles of one process. Gone (a restart, a second server) the screen sends the
 * file again, so nothing depends on it.
 */
type Entry = { userId: string; area: string; filename: string; rows: Record<string, string>[]; at: number };

const TTL = 60 * 60_000;
const MAX = 20;
const KEY = Symbol.for("deskzo.import-uploads");

function store(): Map<string, Entry> {
  const g = globalThis as { [key: symbol]: Map<string, Entry> | undefined };
  return (g[KEY] ??= new Map());
}

function sweep(now = Date.now()) {
  const map = store();
  for (const [token, entry] of map) if (now - entry.at > TTL) map.delete(token);
  // Oldest out first when it is full: Maps keep insertion order.
  while (map.size >= MAX) map.delete(map.keys().next().value!);
}

export function keepUpload(userId: string, area: string, filename: string, rows: Record<string, string>[]): string {
  sweep();
  const token = randomUUID();
  store().set(token, { userId, area, filename, rows, at: Date.now() });
  return token;
}

/** The rows kept under this token — only for whoever, and whichever area, it was kept for. */
export function keptUpload(token: string, userId: string, area: string): { filename: string; rows: Record<string, string>[] } | null {
  sweep();
  const entry = store().get(token);
  if (!entry || entry.userId !== userId || entry.area !== area) return null;
  entry.at = Date.now();
  return { filename: entry.filename, rows: entry.rows };
}
