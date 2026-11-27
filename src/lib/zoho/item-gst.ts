import { db } from "@/lib/db";
import { zohoGet, type ZohoReply } from "@/lib/zoho/client";
import { gstOfZohoItem, type ZohoTaxRates } from "@/lib/zoho/rows";

/**
 * Items without a GST rate, filled in from Zoho (owner, 21 Nov 2026: "gst rate not set on items" — "can you fetch this
 * from zoho?"). The pull read an item's rate from Zoho's list as `tax_percentage`; an India organisation keeps it in the
 * item's own intra- and inter-state tax preferences, often as a tax id alone, and an item matched by SKU to one already in
 * Deskzo was never given it at all. So this asks Zoho for each item's own record:
 *
 *   · Items with no GST rate, or no HSN/SAC — matched to Zoho by the import's own note of the Zoho item id
 *     (LegacyImportRecord "zoho_items"), else by SKU, else by name, from Zoho's item list read once a press.
 *   · The rate from the item's intra-state preference (CGST + SGST together — the same number as IGST), else the
 *     inter-state one, else the item's own tax; a tax given only by id is read from Zoho's tax list (GET /settings/taxes).
 *   · Only what's empty is filled: a rate or a code someone set in Deskzo is never replaced.
 *   · Each item asked once (MigrationRecord "gst-asked", when a switch exists); ~40 seconds a press, carrying on.
 */

type J = Record<string, unknown>;
const ASKED = "gst-asked";
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const key = (v: unknown) => s(v).toLowerCase();

const needsWhere = { OR: [{ taxRatePercent: null }, { hsnCode: null }] };

async function latestMigrationId(): Promise<string | null> {
  return (await db.migration.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } }).catch(() => null))?.id ?? null;
}

async function askedIds(migrationId: string | null): Promise<Set<string>> {
  if (!migrationId) return new Set();
  return new Set((await db.migrationRecord.findMany({ where: { migrationId, kind: ASKED }, select: { recordId: true } })).map((r) => r.recordId));
}

/** How many items have no GST rate or no HSN/SAC and haven't been asked of Zoho yet. */
export async function itemsWithoutGst(): Promise<number> {
  const asked = await askedIds(await latestMigrationId());
  const ids = (await db.item.findMany({ where: needsWhere, select: { id: true } })).map((i) => i.id);
  return ids.filter((id) => !asked.has(id)).length;
}

/** Zoho's taxes and tax groups by id, as percentages — for a preference that names its tax by id alone. */
async function taxRates(): Promise<ZohoTaxRates> {
  const out: ZohoTaxRates = new Map();
  const reply = (await zohoGet("/settings/taxes").catch(() => null)) as ZohoReply | null;
  for (const t of ((reply?.taxes ?? []) as J[])) {
    const pct = Number(t.tax_percentage);
    if (s(t.tax_id) && Number.isFinite(pct)) out.set(s(t.tax_id), pct);
  }
  return out;
}

/** Zoho's whole item list — id, SKU and name — read a page of 200 at a time. */
async function zohoItems(budgetEnds: number): Promise<{ id: string; sku: string; name: string }[]> {
  const out: { id: string; sku: string; name: string }[] = [];
  for (let page = 1; page <= 100 && Date.now() < budgetEnds; page++) {
    const reply = (await zohoGet("/items", { page, per_page: 200 })) as ZohoReply;
    for (const i of ((reply.items ?? []) as J[])) out.push({ id: s(i.item_id), sku: key(i.sku), name: key(i.name ?? i.item_name) });
    if (!reply.page_context?.has_more_page) break;
  }
  return out;
}

export type GstFill = { rates: number; codes: number; noRateInZoho: number; notInZoho: number; left: number };

export async function fillGstFromZoho(input: { budgetMs: number }): Promise<GstFill> {
  const ends = Date.now() + input.budgetMs;
  const migrationId = await latestMigrationId();
  const asked = await askedIds(migrationId);
  const todo = (await db.item.findMany({ where: needsWhere, orderBy: { name: "asc" }, select: { id: true, name: true, sku: true, taxRatePercent: true, hsnCode: true } })).filter((i) => !asked.has(i.id));
  const out: GstFill = { rates: 0, codes: 0, noRateInZoho: 0, notInZoho: 0, left: 0 };
  if (todo.length === 0) return out;

  // The import's own note of which Zoho item each one is.
  const noted = new Map((await db.legacyImportRecord.findMany({ where: { kind: "zoho_items", recordId: { in: todo.map((t) => t.id) } }, select: { oldId: true, recordId: true } })).map((r) => [r.recordId, r.oldId]));
  // The rest by SKU, then by name — from Zoho's list, read only when some aren't noted.
  const list = todo.some((t) => !noted.has(t.id)) ? await zohoItems(ends) : [];
  const bySku = new Map(list.filter((z) => z.sku).map((z) => [z.sku, z.id]));
  const byName = new Map(list.filter((z) => z.name).map((z) => [z.name, z.id]));
  const rates = await taxRates();

  let i = 0;
  for (; i < todo.length; i++) {
    if (Date.now() > ends) break;
    const item = todo[i]!;
    const zohoId = noted.get(item.id) ?? (item.sku ? bySku.get(key(item.sku)) : undefined) ?? byName.get(key(item.name));
    if (!zohoId) out.notInZoho += 1;
    else {
      const full = ((await zohoGet(`/items/${zohoId}`)) as ZohoReply).item as J | undefined;
      const gst = gstOfZohoItem(full, rates);
      const data: { taxRatePercent?: number; hsnCode?: string } = {};
      if (item.taxRatePercent === null && gst.rate !== null) data.taxRatePercent = gst.rate;
      if (!item.hsnCode && /^\d{4,8}$/.test(gst.hsn)) data.hsnCode = gst.hsn;
      if (Object.keys(data).length) {
        await db.item.update({ where: { id: item.id }, data });
        if (data.taxRatePercent !== undefined) out.rates += 1;
        if (data.hsnCode) out.codes += 1;
      }
      if (item.taxRatePercent === null && gst.rate === null) out.noRateInZoho += 1;
    }
    if (migrationId) await db.migrationRecord.create({ data: { migrationId, kind: ASKED, recordId: item.id, key: `${ASKED}:${item.id}` } });
  }
  out.left = todo.length - i;
  return out;
}
