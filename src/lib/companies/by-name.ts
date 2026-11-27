import { db } from "@/lib/db";
import { legalNameKey, normalizeCompanyName } from "@/lib/company-name";
import { notMigratedYet } from "@/lib/not-migrated";
import { formerNameIndex } from "@/lib/companies/former-names";

/**
 * The companies whose name is this one in another legal form — "Pvt. Ltd." for "Private Limited" — by the key the
 * database keeps on each (`Company.legalNameKey`, migration 20261129100000): one indexed lookup (owner, 29 Oct 2026).
 * A workspace not migrated yet looks as before, through the names holding its first word — slower, and stopping at
 * 500, which could miss among many names starting "Shree" or "Sri".
 */
async function sameLegalName(typed: string): Promise<{ id: string; name: string }[]> {
  const key = legalNameKey(typed);
  if (!key) return [];
  try {
    return await db.$queryRaw<{ id: string; name: string }[]>`select "id", "name" from "companies" where "legalNameKey" = ${key} limit 20`;
  } catch (err) {
    // The column, or the function that makes it, not there yet.
    if (!notMigratedYet(err) && !/42883|function company_legal_name_key/.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  const first = key.split(" ")[0] ?? "";
  if (first.length < 2) return [];
  const candidates = await db.company.findMany({ where: { name: { contains: first, mode: "insensitive" } }, select: { id: true, name: true }, take: 500 });
  return candidates.filter((c) => legalNameKey(c.name) === key);
}

/**
 * The company a file names, for the importers (owner, 27 Oct 2026): its exact name first, as before; then the same
 * name in another legal form — "Pvt. Ltd." for "Private Limited" (`legalNameKey`) — when exactly one company has it.
 * Two that match that loosely are left to the file to tell apart, as an unknown name is.
 */
export async function companyIdByName(name: string): Promise<string | null> {
  const typed = name.trim();
  if (!typed) return null;
  const exact = await db.company.findUnique({ where: { normalizedName: normalizeCompanyName(typed) }, select: { id: true } });
  if (exact) return exact.id;
  const same = await sameLegalName(typed);
  if (same.length) return same.length === 1 ? same[0]!.id : null;
  // A name it went by before — "ABC Pvt Ltd" in a file after it became "ABC Ltd" (owner, 18 Nov 2026) — when one alone did.
  return (await formerNameIndex())(typed)?.id ?? null;
}

/**
 * The company a new name would duplicate (owner, 27 Oct 2026): the same name, or the same in another legal form —
 * "ABC Pvt Ltd" when "ABC Private Limited" is there. Unlike `companyIdByName` it doesn't need the match to be the only
 * one: any is reason enough not to make another. `exceptId` is the company being renamed.
 */
export async function companyNamedLike(name: string, exceptId?: string): Promise<{ id: string; name: string } | null> {
  const typed = name.trim();
  if (!typed) return null;
  const exact = await db.company.findUnique({ where: { normalizedName: normalizeCompanyName(typed) }, select: { id: true, name: true } });
  if (exact && exact.id !== exceptId) return exact;
  const same = (await sameLegalName(typed)).find((c) => c.id !== exceptId);
  if (same) return same;
  // Or a company that went by it before (owner, 18 Nov 2026).
  const former = (await formerNameIndex())(typed);
  return former && former.id !== exceptId ? former : null;
}
