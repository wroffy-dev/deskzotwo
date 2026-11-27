import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspacePack } from "@/lib/country-pack";

/**
 * Each line's VAT category, by line id (src/lib/vat/rules.ts) — read by name, as `taxCategory` is in
 * NOT_YET_EVERYWHERE (src/lib/tenancy/clients.ts). Empty in India, whose lines carry none, and in a workspace not
 * migrated yet, where every line then reads from its rate.
 */
export async function lineTaxCategories(documentIds: string[]): Promise<Map<string, string>> {
  if (workspacePack().india || documentIds.length === 0) return new Map();
  try {
    const rows = await db.tradeDocumentLine.findMany({ where: { documentId: { in: documentIds } }, select: { id: true, taxCategory: true } });
    return new Map(rows.filter((r) => r.taxCategory).map((r) => [r.id, r.taxCategory as string]));
  } catch (err) {
    if (notMigratedYet(err)) return new Map();
    throw err;
  }
}

/** Each item's VAT category, by item id — what a new line of it starts as. Read by name, as above. */
export async function itemTaxCategories(itemIds: string[]): Promise<Map<string, string>> {
  if (workspacePack().india || itemIds.length === 0) return new Map();
  try {
    const rows = await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, taxCategory: true } });
    return new Map(rows.filter((r) => r.taxCategory).map((r) => [r.id, r.taxCategory as string]));
  } catch (err) {
    if (notMigratedYet(err)) return new Map();
    throw err;
  }
}
