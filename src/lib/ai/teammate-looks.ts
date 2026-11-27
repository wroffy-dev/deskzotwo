import { controlDb } from "@/lib/platform/control-db";
import { notMigratedYet } from "@/lib/not-migrated";
import { DEFAULT_TEAMMATE_PHOTOS } from "@/lib/ai/teammate-default-photos";
import { TEAMMATE_KEYS, isTeammateKey, isTeammatePhoto, type TeammateKey } from "@/lib/ai/teammates";

/**
 * The AI teammates' names and photos, decided by Deskzo — country by country — in the console (owner, 23 Nov 2026:
 * "remove ai team mate photo upload feature, naming from each workspace and prompt.. lets console admin decided this
 * country wise.. use these as default"). A workspace no longer names them or gives them photos.
 *
 *   · For a workspace in a country: that country's row, field by field, then the every-country row ("*"), then the
 *     built-in default — the name in src/lib/ai/teammates.ts and the photo in src/lib/ai/teammate-default-photos.ts.
 *   · Kept in the control plane (platform_teammate_looks); read by every workspace through a minute's cache, cleared in
 *     the console's own process when staff save (src/actions/platform/console-ai-teammates.ts).
 *   · Before the control plane's migration, or if it can't be reached: the defaults — the teammates never go missing.
 *
 * Server only.
 */

export const EVERY_COUNTRY = "*";

type Row = { country: string; key: string; name: string | null; photo: string | null; updatedAt: Date };

/** What a workspace in a country shows for one teammate: its name (null: the default) and which photo, by version. */
export type Look = { name: string | null; photoVersion: string; photoFrom: "country" | "every" | "default" };

const TTL_MS = 60_000;
let cache = new Map<string, { at: number; rows: Row[] }>();

export function forgetLooks(): void {
  cache = new Map();
}

const countryCode = (country: string | null | undefined) => (country && /^[A-Z]{2}$/.test(country.trim().toUpperCase()) ? country.trim().toUpperCase() : "IN");

async function rowsFor(country: string): Promise<Row[]> {
  const kept = cache.get(country);
  if (kept && Date.now() - kept.at < TTL_MS) return kept.rows;
  let rows: Row[] = [];
  try {
    rows = await controlDb().platformTeammateLook.findMany({ where: { country: { in: [country, EVERY_COUNTRY] } }, select: { country: true, key: true, name: true, photo: true, updatedAt: true } });
  } catch (err) {
    if (!(notMigratedYet(err) || (err instanceof Error && /platform_teammate_looks/.test(err.message)))) console.error("[teammates] couldn't read the console's looks", err instanceof Error ? err.message : err);
    rows = [];
  }
  cache.set(country, { at: Date.now(), rows });
  return rows;
}

/** Every teammate's look for a workspace in this country. */
export async function looksFor(countryRaw: string | null | undefined): Promise<Record<TeammateKey, Look>> {
  const country = countryCode(countryRaw);
  const rows = await rowsFor(country);
  const out = {} as Record<TeammateKey, Look>;
  for (const key of TEAMMATE_KEYS) {
    const own = rows.find((r) => r.key === key && r.country === country);
    const every = rows.find((r) => r.key === key && r.country === EVERY_COUNTRY);
    const name = own?.name ?? every?.name ?? null;
    const photoRow = own?.photo ? own : every?.photo ? every : null;
    out[key] = photoRow
      ? { name, photoVersion: `${photoRow.country === EVERY_COUNTRY ? "a" : "c"}${photoRow.updatedAt.getTime()}`, photoFrom: photoRow.country === EVERY_COUNTRY ? "every" : "country" }
      : { name, photoVersion: "d1", photoFrom: "default" };
  }
  return out;
}

/** A teammate's photo as bytes, for a workspace in this country — the console's, else the built-in one. Null for Deskzo AI itself. */
export async function lookPhoto(countryRaw: string | null | undefined, key: string): Promise<{ type: string; bytes: Buffer } | null> {
  if (!isTeammateKey(key) || key === "deskzo") return null;
  const country = countryCode(countryRaw);
  const rows = await rowsFor(country);
  const chosen = rows.find((r) => r.key === key && r.country === country && r.photo)?.photo ?? rows.find((r) => r.key === key && r.country === EVERY_COUNTRY && r.photo)?.photo ?? DEFAULT_TEAMMATE_PHOTOS[key];
  if (!isTeammatePhoto(chosen)) return null;
  return { type: chosen.slice(5, chosen.indexOf(";")), bytes: Buffer.from(chosen.slice(chosen.indexOf(",") + 1), "base64") };
}

// ─── The console ──────────────────────────────────────────────────────────────────────────────────────────────────

export type LookRow = { country: string; key: TeammateKey; name: string | null; photo: string | null; updatedAt: string };

/** Every row the console has set, for its page. */
export async function allLookRows(): Promise<LookRow[]> {
  const rows = await controlDb().platformTeammateLook.findMany({ orderBy: [{ country: "asc" }, { key: "asc" }], select: { country: true, key: true, name: true, photo: true, updatedAt: true } });
  return rows.filter((r) => isTeammateKey(r.key)).map((r) => ({ country: r.country, key: r.key as TeammateKey, name: r.name, photo: r.photo, updatedAt: r.updatedAt.toISOString() }));
}

/** Sets one field or both for a country (or "*"); a row left with nothing in it is removed — back to what's under it. */
export async function saveLook(country: string, key: TeammateKey, change: { name?: string | null; photo?: string | null }, staffId: string): Promise<void> {
  const db = controlDb();
  const row = await db.platformTeammateLook.findUnique({ where: { country_key: { country, key } }, select: { name: true, photo: true } });
  const next = { name: change.name !== undefined ? change.name : (row?.name ?? null), photo: change.photo !== undefined ? change.photo : (row?.photo ?? null) };
  if (!next.name && !next.photo) await db.platformTeammateLook.deleteMany({ where: { country, key } });
  else await db.platformTeammateLook.upsert({ where: { country_key: { country, key } }, create: { country, key, ...next, updatedById: staffId }, update: { ...next, updatedById: staffId } });
  forgetLooks();
}
