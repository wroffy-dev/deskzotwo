import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Taking an import back (src/lib/legacy-import): every record it made is deleted, every record it changed gets back
 * what it held, every record it only used is let go — newest kinds first, so nothing it made is still pointed at by
 * something else it made when it goes. A record somebody has since built on in Deskzo — a company with an invoice
 * made after the import, a contact on a lead typed in by hand — is kept, and said so. In parts, each its own
 * transaction: stopped half way, it carries on from where it got to.
 */

type Tx = Prisma.TransactionClient;

/** The order things go: the reverse of how they came. */
export const UNDO_ORDER = [
  "call_logs",
  "replies",
  "field_visits",
  "anonymous_tickets",
  "product_tickets",
  "customer_product",
  "lead_product",
  "leads",
  "lead-contact",
  "profilings",
  "employees",
  "zoho_vendor_contact_persons",
  "zoho_contact_persons",
  "shipping_addresses",
  "billing_addresses",
  "head-office",
  "prospect-company",
  "vendor",
  "customers",
  "vendors",
  "zoho_vendors",
  "zoho_contacts",
  "products",
  "stand-in-product",
  "zoho_items",
  "brand",
  "item-category",
  "industry",
  "company-type",
  "customer-category",
  "designation",
  "department",
  "users",
  "custom-field",
] as const;

const MODEL: Record<string, string> = {
  call_logs: "callLog",
  replies: "ticketComment",
  field_visits: "visit",
  anonymous_tickets: "ticket",
  product_tickets: "ticket",
  customer_product: "companyProduct",
  lead_product: "leadRequirement",
  leads: "lead",
  "lead-contact": "contact",
  profilings: "contact",
  employees: "contact",
  zoho_contact_persons: "contact",
  zoho_vendor_contact_persons: "contact",
  vendors: "company",
  zoho_vendors: "company",
  zoho_contacts: "company",
  zoho_items: "item",
  shipping_addresses: "companyLocation",
  billing_addresses: "companyLocation",
  "head-office": "companyLocation",
  "prospect-company": "company",
  vendor: "company",
  customers: "company",
  products: "item",
  // A product a row named that never came across, made so the row could (owner, 30 Oct 2026).
  "stand-in-product": "item",
  brand: "brand",
  "item-category": "itemCategory",
  industry: "industry",
  "company-type": "companyTypeOption",
  "customer-category": "customerCategory",
  designation: "designation",
  department: "department",
  users: "user",
  "custom-field": "customFieldDefinition",
};

type Delegate = {
  delete(args: { where: { id: string } }): Promise<unknown>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  findUnique(args: { where: { id: string }; select: { id: true } }): Promise<{ id: string } | null>;
};
const delegate = (tx: Tx, kind: string) => (tx as unknown as Record<string, Delegate>)[MODEL[kind]!]!;

/** Why a record made by the import must stay: what in Deskzo now depends on it that the import didn't make. */
async function keptBecause(tx: Tx, kind: string, id: string): Promise<string | null> {
  const model = MODEL[kind];
  if (model === "company") {
    const [contacts, leads, tickets, visits, calls, orders, locations, documents] = await Promise.all([
      tx.contact.count({ where: { companyId: id } }),
      tx.lead.count({ where: { companyId: id } }),
      tx.ticket.count({ where: { companyId: id } }),
      tx.visit.count({ where: { companyId: id } }),
      tx.callLog.count({ where: { companyId: id } }),
      tx.companyProduct.count({ where: { OR: [{ companyId: id }, { vendorId: id }] } }),
      tx.companyLocation.count({ where: { companyId: id } }),
      tx.tradeDocument.count({ where: { companyId: id } }),
    ]);
    // Its own head office goes with it; anything else was made in Deskzo since.
    const ownOffice = await tx.legacyImportRecord.count({ where: { kind: "head-office", recordId: { in: (await tx.companyLocation.findMany({ where: { companyId: id }, select: { id: true } })).map((l) => l.id) } } });
    const others = contacts + leads + tickets + visits + calls + orders + documents + (locations - ownOffice);
    return others > 0 ? "it has records made in Deskzo since the import" : null;
  }
  if (model === "contact") {
    const [leads, tickets, visits, calls] = await Promise.all([
      tx.lead.count({ where: { contactId: id } }),
      tx.ticket.count({ where: { contactId: id } }),
      tx.visit.count({ where: { contactId: id } }),
      tx.callLog.count({ where: { contactId: id } }),
    ]);
    return leads + tickets + visits + calls > 0 ? "a lead, ticket, visit or call made in Deskzo since points at it" : null;
  }
  if (model === "companyLocation") {
    const orders = await tx.companyProduct.count({ where: { locationId: id } });
    return orders > 0 ? "an order made in Deskzo since is booked to it" : null;
  }
  return null;
}

/** `keptBecause` for a part at a time: each record that must stay, and why — the same counts, grouped. */
async function keptBecauseAll(kind: string, ids: string[]): Promise<Map<string, string>> {
  const model = MODEL[kind];
  const why = new Map<string, string>();
  if (ids.length === 0) return why;
  // How many rows point at each id, read as just that column.
  const tally = (rows: { key: string | null }[], into: Map<string, number>) => {
    for (const r of rows) if (r.key) into.set(r.key, (into.get(r.key) ?? 0) + 1);
  };
  const keyed = <T extends Record<string, string | null>>(rows: T[], column: keyof T) => rows.map((r) => ({ key: r[column] ?? null }));
  if (model === "company") {
    const n = new Map<string, number>();
    const by = { companyId: { in: ids } };
    const select = { companyId: true } as const;
    tally(keyed(await db.contact.findMany({ where: by, select }), "companyId"), n);
    tally(keyed(await db.lead.findMany({ where: by, select }), "companyId"), n);
    tally(keyed(await db.ticket.findMany({ where: by, select }), "companyId"), n);
    tally(keyed(await db.visit.findMany({ where: by, select }), "companyId"), n);
    tally(keyed(await db.callLog.findMany({ where: by, select }), "companyId"), n);
    tally(keyed(await db.tradeDocument.findMany({ where: by, select }), "companyId"), n);
    // An order counts once, as the company's or the vendor's.
    const orders = await db.companyProduct.findMany({ where: { OR: [{ companyId: { in: ids } }, { vendorId: { in: ids } }] }, select: { companyId: true, vendorId: true } });
    const set = new Set(ids);
    for (const o of orders) for (const k of new Set([o.companyId, o.vendorId].filter((x): x is string => !!x && set.has(x)))) n.set(k, (n.get(k) ?? 0) + 1);
    // Its own head office goes with it; any other location was made in Deskzo since.
    const locations = await db.companyLocation.findMany({ where: by, select: { id: true, companyId: true } });
    const own = new Set((await db.legacyImportRecord.findMany({ where: { kind: "head-office", recordId: { in: locations.map((l) => l.id) } }, select: { recordId: true } })).map((r) => r.recordId));
    for (const l of locations) if (!own.has(l.id)) n.set(l.companyId, (n.get(l.companyId) ?? 0) + 1);
    for (const [id, count] of n) if (count > 0) why.set(id, "it has records made in Deskzo since the import");
  } else if (model === "contact") {
    const n = new Map<string, number>();
    const by = { contactId: { in: ids } };
    const select = { contactId: true } as const;
    tally(keyed(await db.lead.findMany({ where: by, select }), "contactId"), n);
    tally(keyed(await db.ticket.findMany({ where: by, select }), "contactId"), n);
    tally(keyed(await db.visit.findMany({ where: by, select }), "contactId"), n);
    tally(keyed(await db.callLog.findMany({ where: by, select }), "contactId"), n);
    for (const [id, count] of n) if (count > 0) why.set(id, "a lead, ticket, visit or call made in Deskzo since points at it");
  } else if (model === "companyLocation") {
    for (const r of await db.companyProduct.findMany({ where: { locationId: { in: ids } }, select: { locationId: true } })) {
      if (r.locationId) why.set(r.locationId, "an order made in Deskzo since is booked to it");
    }
  }
  return why;
}

type UndoRecord = { id: string; oldId: string; recordId: string; action: string; before: unknown };

/**
 * The part of `undoPart`'s records that can go together, gone: LINKED ones let go, CREATED ones whose record is gone
 * forgotten, those something now depends on kept (and said), the rest deleted in one transaction. Returns the
 * records still to do one at a time — the UPDATED ones, and the whole part when the one delete was refused.
 */
async function undoTogether(kind: string, records: UndoRecord[], progress: UndoProgress): Promise<UndoRecord[]> {
  const linked = records.filter((r) => r.action === "LINKED");
  if (linked.length) {
    await db.legacyImportRecord.deleteMany({ where: { id: { in: linked.map((r) => r.id) } } });
    progress.released += linked.length;
  }
  const made = records.filter((r) => r.action !== "LINKED" && r.action !== "UPDATED");
  const rest = records.filter((r) => r.action === "UPDATED");
  if (made.length === 0) return rest;

  const model = MODEL[kind]!;
  const table = (db as unknown as Record<string, { findMany(a: unknown): Promise<{ id: string }[]> }>)[model]!;
  const there = new Set((await table.findMany({ where: { id: { in: made.map((r) => r.recordId) } }, select: { id: true } })).map((r) => r.id));
  const gone = made.filter((r) => !there.has(r.recordId));
  if (gone.length) await db.legacyImportRecord.deleteMany({ where: { id: { in: gone.map((r) => r.id) } } });
  const present = made.filter((r) => there.has(r.recordId));
  const why = await keptBecauseAll(kind, present.map((r) => r.recordId));
  const kept = present.filter((r) => why.has(r.recordId));
  if (kept.length) {
    await db.legacyImportRecord.updateMany({ where: { id: { in: kept.map((r) => r.id) } }, data: { action: "KEPT" } });
    for (const r of kept) progress.kept.push({ kind, recordId: r.recordId, why: why.get(r.recordId)! });
  }
  const doomed = present.filter((r) => !why.has(r.recordId));
  if (doomed.length === 0) return rest;
  const ids = doomed.map((r) => r.recordId);
  try {
    await db.$transaction(
      async (tx) => {
        if (kind === "custom-field") {
          // Retired, not deleted: records made in Deskzo since may hold values in it.
          await tx.customFieldDefinition.updateMany({ where: { id: { in: ids } }, data: { archivedAt: new Date() } });
        } else {
          if (kind === "customer_product") await tx.companyProduct.updateMany({ where: { OR: [{ parentId: { in: ids } }, { renewedFromId: { in: ids } }] }, data: { parentId: null, renewedFromId: null } });
          await (tx as unknown as Record<string, { deleteMany(a: unknown): Promise<unknown> }>)[model]!.deleteMany({ where: { id: { in: ids } } });
        }
        await tx.legacyImportRecord.deleteMany({ where: { id: { in: doomed.map((r) => r.id) } } });
      },
      { timeout: 120_000 },
    );
    progress.taken += doomed.length;
    return rest;
  } catch {
    // Something the checks didn't think of points at one of them: one at a time, so only that one is kept.
    return [...rest, ...doomed];
  }
}

export type UndoProgress ={ done: boolean; taken: number; restored: number; released: number; kept: { kind: string; recordId: string; why: string }[] };

const PART = 200;

/**
 * Takes back the next part of an import: up to `budgetMs` of work. Returns whether it has finished. The records it
 * keeps stay logged against the import, so a later import still knows them and makes no second copy.
 */
export async function undoPart(importId: string, budgetMs = 8000): Promise<UndoProgress> {
  const startedAt = Date.now();
  const progress: UndoProgress = { done: false, taken: 0, restored: 0, released: 0, kept: [] };
  for (const kind of UNDO_ORDER) {
    for (;;) {
      if (Date.now() - startedAt > budgetMs) return progress;
      const records = await db.legacyImportRecord.findMany({ where: { importId, kind, action: { not: "KEPT" } }, select: { id: true, oldId: true, recordId: true, action: true, before: true }, take: PART });
      if (records.length === 0) break;
      // A part at once where it can be: what was only used let go, what's gone forgotten, and what nothing in
      // Deskzo has come to depend on deleted in one go. What's left — changed records, and a part one delete
      // couldn't take — goes a record at a time below.
      const oneByOne = await undoTogether(kind, records, progress);
      for (const record of oneByOne) {
        await db.$transaction(
          async (tx) => {
            if (record.action === "LINKED") {
              await tx.legacyImportRecord.delete({ where: { id: record.id } });
              progress.released += 1;
              return;
            }
            if (record.action === "UPDATED") {
              const before = (record.before ?? {}) as { values?: Record<string, unknown> | null; fromImport?: string; fromAction?: string };
              const exists = await delegate(tx, kind).findUnique({ where: { id: record.recordId }, select: { id: true } });
              if (exists && before.values) await delegate(tx, kind).update({ where: { id: record.recordId }, data: before.values });
              await tx.legacyImportRecord.update({ where: { id: record.id }, data: { importId: before.fromImport ?? importId, action: before.fromAction ?? "CREATED", before: Prisma.DbNull } });
              progress.restored += 1;
              return;
            }
            // Made by the import.
            const exists = await delegate(tx, kind).findUnique({ where: { id: record.recordId }, select: { id: true } });
            if (!exists) {
              await tx.legacyImportRecord.delete({ where: { id: record.id } });
              return;
            }
            const why = await keptBecause(tx, kind, record.recordId);
            if (why) {
              await tx.legacyImportRecord.update({ where: { id: record.id }, data: { action: "KEPT" } });
              progress.kept.push({ kind, recordId: record.recordId, why });
              return;
            }
            if (kind === "custom-field") {
              // Retired, not deleted: records made in Deskzo since may hold values in it.
              await tx.customFieldDefinition.update({ where: { id: record.recordId }, data: { archivedAt: new Date() } });
            } else if (kind === "customer_product") {
              await tx.companyProduct.updateMany({ where: { OR: [{ parentId: record.recordId }, { renewedFromId: record.recordId }] }, data: { parentId: null, renewedFromId: null } });
              await tx.companyProduct.delete({ where: { id: record.recordId } });
            } else {
              await delegate(tx, kind).delete({ where: { id: record.recordId } });
            }
            await tx.legacyImportRecord.delete({ where: { id: record.id } });
            progress.taken += 1;
          },
          { timeout: 60_000 },
        ).catch(async (err: unknown) => {
          // Something in Deskzo the checks didn't think of still points at it: kept, and said so.
          const why = err instanceof Error ? (err.message.split("\n").filter(Boolean).slice(-1)[0] ?? "it's still in use") : "it's still in use";
          await db.legacyImportRecord.update({ where: { id: record.id }, data: { action: "KEPT" } }).catch(() => undefined);
          progress.kept.push({ kind, recordId: record.recordId, why: `it's still in use (${why.slice(0, 160)})` });
        });
      }
    }
  }
  progress.done = true;
  return progress;
}
