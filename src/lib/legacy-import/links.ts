import { db } from "@/lib/db";

/**
 * The Deskzo record an old system's id became (LegacyImportRecord) — how a migrated year finds a document's
 * customer, vendor or item by the id Zoho Books gave it before trusting a name, which a rename or a branch
 * spelt differently would miss. Phase 2 of the Zoho plan (owner, 26 Oct 2026).
 */

export const ZOHO_PARTY_KINDS = ["zoho_contacts", "zoho_vendors"] as const;
export const ZOHO_ITEM_KINDS = ["zoho_items"] as const;

/** Excel rounds an 18-digit id to "8.80908E+17", which names no one. */
const rounded = (id: string) => /^\d(\.\d+)?E\+\d+$/i.test(id);

/** The record id the old id became, or null — none logged, blank, or rounded past use. */
export async function recordForOldId(kinds: readonly string[], oldId: string | null | undefined): Promise<string | null> {
  const id = (oldId ?? "").trim();
  if (!id || rounded(id)) return null;
  const found = await db.legacyImportRecord.findFirst({ where: { kind: { in: [...kinds] }, oldId: id }, select: { recordId: true } });
  return found?.recordId ?? null;
}
