import type { TradeDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { leftBehind } from "@/lib/migration/documents";
import { legalNameKey } from "@/lib/company-name";
import { zohoGet, type ZohoReply } from "./client";
import { MODULES, MODULE_STEPS } from "./pull";

/**
 * "Is everything in?" (owner, 20 Nov 2026 — "how do I make sure all data which Zoho has now is in Deskzo"): for each kind
 * the switch brings, Zoho's count beside Deskzo's, side by side, with what to do where they differ.
 *
 *   · Zoho's side is counted when asked — one call a kind — for the year from its start to today, as the sections
 *     import it: nothing stops at the switch day, and the nightly top-up brings what Zoho dates after it. The invoices,
 *     credit notes, bills and vendor credits are read a page at a time and counted from their rows — Zoho's own count
 *     came out short (owner, 21 Nov 2026: 1,998 invoices beside Deskzo's 2,393, though every one of those is in Zoho
 *     by number and none is one Zoho leaves out) — and every status the import leaves behind, a draft, a void, a
 *     rejected one, one waiting for approval (src/lib/migration/documents.ts), is left out of it. A year bigger than
 *     READ_UP_TO is Zoho's count instead, less the drafts and voids its own filters find.
 *   · Deskzo's side is the invoices, credit notes and bills the switch brought that are still here, so one taken back
 *     ("Find documents Zoho doesn't count") or deleted no longer counts (owner, 21 Nov 2026: 389 more invoices here
 *     than in Zoho, a number that never went down) — and an earlier year's opened to be collected isn't one of the
 *     year's. The other sections, what each says it imported (Migration.counts); customers, vendors and items, what
 *     the old-CRM import brought across by Zoho's id; with each section's rows still waiting or failed.
 *   · Quotes, sales orders and purchase orders (owner, 26 Nov 2026 — "make the check count the archive"): only the open
 *     ones come into the books, the finished and the earlier years' go to Earlier years, so Deskzo's side is both
 *     together, set against Zoho's count of every one — 29,000 earlier quotes never pulled showed as "Open only".
 *
 * Nothing here changes anything.
 */

export type CompletenessRow = {
  key: string;
  label: string;
  /** In Zoho, as the switch counts it — null when Zoho gave no count. */
  zoho: number | null;
  /** Of Zoho's count, the drafts and voids left out (they aren't brought across). */
  leftOut: number;
  deskzo: number;
  /** Of Deskzo's count, those kept in Earlier years (quotes and orders: the finished and the earlier years'). */
  archived?: number;
  /** Rows of its section waiting for something (a customer, an invoice) and rows that failed. */
  waiting: number;
  failed: number;
  state: "match" | "behind" | "ahead" | "missing" | "open-only" | "unknown";
  /** What it means, and what to do, in a sentence. */
  note: string;
  /** Customers, vendors or items in Zoho not found in Deskzo, by name — the first MISSING_SHOWN. */
  missing?: string[];
};

export type Completeness = { rows: CompletenessRow[]; calls: number; checkedAt: string; behind: number };

/** The money documents counted for the year so far. */
const BY_YEAR = ["invoices", "creditnotes", "customerpayments", "bills", "vendorcredits", "vendorpayments", "expenses", "journals"];
/** Counted from their own rows, page by page, each one's status beside what the import leaves behind. */
const BY_STATUS = new Set(["invoices", "creditnotes", "bills", "vendorcredits"]);
/** A list read a page at a time up to this many, 25 of Zoho's calls; past it, Zoho's count and its filters below. */
export const READ_UP_TO = 5_000;
/** A list too big to read: only its drafts and voids are left out, counted by Zoho's filters. */
const LEAVE_OUT: Record<string, string[]> = {
  invoices: ["Status.Draft", "Status.Void"],
  creditnotes: ["Status.Draft", "Status.Void"],
  bills: ["Status.Draft", "Status.Void"],
  vendorcredits: ["Status.Draft", "Status.Void"],
};
/**
 * Only the open ones come into the books — quotes, sales orders, purchase orders — the rest to Earlier years, by the
 * archive's kind: the two together are set against Zoho's count of all.
 */
const OPEN_ONLY: Record<string, string> = { estimates: "QUOTE", salesorders: "SALES_ORDER", purchaseorders: "PURCHASE_ORDER" };
/** The master lists, by the old-CRM import's record of Zoho's ids (src/lib/legacy-import/apply.ts). */
const MASTERS: Record<string, string> = { customers: "zoho_contacts", vendors: "zoho_vendors", items: "zoho_items" };
/** The sections whose records are documents, counted as they are now rather than as they were imported. */
const DOCUMENT_STEPS: Record<string, TradeDocumentType> = { invoices: "INVOICE", "credit-notes": "CREDIT_NOTE", bills: "BILL" };

/** The section each kind fills, for its button's words. */
const PULL_WORDS: Record<string, string> = {
  invoices: "Invoices",
  creditnotes: "Credit notes",
  customerpayments: "Customer receipts",
  bills: "Bills",
  vendorcredits: "Vendor credits",
  vendorpayments: "Vendor payments",
  expenses: "Expenses",
  journals: "Manual journals",
};

function countIn(reply: ZohoReply, listKey: string): number | null {
  const ctx = (reply.page_context ?? {}) as Record<string, unknown>;
  for (const v of [ctx.total, ctx.total_count, ctx.count, reply.total_count, reply.count, reply[`${listKey}_count`]]) {
    const n = Number(v);
    if (v !== undefined && v !== null && v !== "" && Number.isFinite(n)) return n;
  }
  const list = reply[listKey];
  return Array.isArray(list) && !ctx.has_more_page ? list.length : null;
}

/** Zoho's side: each kind's count — the year's, from its start to today — and of it, what the import leaves behind. */
export async function zohoSide(yearStart: string): Promise<{ counts: Map<string, { total: number | null; leftOut: number }>; calls: number }> {
  const counts = new Map<string, { total: number | null; leftOut: number }>();
  let calls = 0;
  const from = yearStart.slice(0, 10);
  const range = { date_start: from };
  for (const mod of MODULES) {
    if (mod.key === "chart" || mod.key === "banking" || mod.key === "refunds" || mod.key === "deliverychallans") continue;
    const ask = async (extra: Record<string, string>) => {
      calls += 1;
      return countIn((await zohoGet(mod.path, { ...(mod.query ?? {}), ...extra, response_option: 2, per_page: 200 })) as ZohoReply, mod.listKey);
    };
    // The year's list read page by page, up to READ_UP_TO: its rows counted, and of them each one the import leaves behind.
    const read = async (): Promise<{ total: number; behind: number } | null> => {
      let listed = 0;
      let behind = 0;
      for (let page = 1; page <= READ_UP_TO / 200; page++) {
        calls += 1;
        const reply = (await zohoGet(mod.path, { ...(mod.query ?? {}), ...range, page, per_page: 200 })) as ZohoReply;
        if (typeof reply.code === "number" && reply.code !== 0) return null;
        for (const r of (reply[mod.listKey] as Record<string, unknown>[] | undefined) ?? []) {
          // Zoho keeps to date_start; a row dated earlier all the same isn't the year's.
          if (String(r.date ?? from).slice(0, 10) < from) continue;
          listed += 1;
          if (leftBehind(String(r.status ?? ""))) behind += 1;
        }
        if (!reply.page_context?.has_more_page) return { total: listed, behind };
      }
      return null;
    };
    const fromRows = BY_STATUS.has(mod.key) ? await read().catch(() => null) : null;
    if (fromRows) {
      counts.set(mod.key, { total: fromRows.total, leftOut: fromRows.behind });
      continue;
    }
    // Too many to read, or not one of those: Zoho's count, and its filters for the drafts and voids.
    const total = await ask(BY_YEAR.includes(mod.key) ? range : {});
    let leftOut = 0;
    if (total) {
      for (const filter of LEAVE_OUT[mod.key] ?? []) {
        const n = await ask({ ...range, filter_by: filter }).catch(() => null);
        // A filter Zoho doesn't know answers with everything: that count says nothing about drafts or voids.
        if (n !== null && n < total) leftOut += n;
      }
    }
    counts.set(mod.key, { total, leftOut: total === null ? leftOut : Math.min(leftOut, total) });
  }
  return { counts, calls };
}

/** Deskzo's side: each section's imported count, its waiting and failed rows, and the master lists brought across. */
export async function deskzoSide(migrationId: string): Promise<{ imported: Record<string, number>; waiting: Record<string, number>; failed: Record<string, number>; masters: Record<string, number>; archived: Record<string, number> }> {
  const m = await db.migration.findUniqueOrThrow({ where: { id: migrationId }, select: { counts: true } });
  const imported = { ...((m.counts && typeof m.counts === "object" ? m.counts : {}) as Record<string, number>) };
  // The documents as they are now: brought by their section (not an earlier year's opened to be collected), still
  // here, and neither a draft nor cancelled since.
  const records = await db.migrationRecord.findMany({ where: { migrationId, kind: "document", NOT: { key: { startsWith: "OPENED:" } } }, select: { recordId: true } });
  const ids = records.map((r) => r.recordId);
  const present = new Map<TradeDocumentType, number>();
  for (let i = 0; i < ids.length; i += 5_000) {
    const groups = await db.tradeDocument.groupBy({
      by: ["docType"],
      where: { id: { in: ids.slice(i, i + 5_000) }, docType: { in: Object.values(DOCUMENT_STEPS) }, status: { notIn: ["DRAFT", "CANCELLED"] } },
      _count: { _all: true },
    });
    for (const g of groups) present.set(g.docType, (present.get(g.docType) ?? 0) + g._count._all);
  }
  for (const [step, type] of Object.entries(DOCUMENT_STEPS)) imported[step] = present.get(type) ?? 0;
  const files = await db.migrationFile.findMany({ where: { migrationId }, select: { step: true, failures: true } });
  const waiting: Record<string, number> = {};
  const failed: Record<string, number> = {};
  for (const f of files) {
    for (const x of (Array.isArray(f.failures) ? f.failures : []) as { waitFor?: string }[]) {
      if (x?.waitFor) waiting[f.step] = (waiting[f.step] ?? 0) + 1;
      else failed[f.step] = (failed[f.step] ?? 0) + 1;
    }
  }
  const masters: Record<string, number> = {};
  for (const [key, kind] of Object.entries(MASTERS)) {
    masters[key] = await db.legacyImportRecord.count({ where: { kind } }).catch((err) => {
      if (notMigratedYet(err)) return 0;
      throw err;
    });
  }
  // Quotes and orders kept in Earlier years, by the kind Zoho calls them.
  const kept = await db.archivedDocument.groupBy({ by: ["kind"], where: { migrationId, kind: { in: Object.values(OPEN_ONLY) } }, _count: { _all: true } });
  const archived: Record<string, number> = {};
  for (const [key, kind] of Object.entries(OPEN_ONLY)) archived[key] = kept.find((k) => k.kind === kind)?._count._all ?? 0;
  return { imported, waiting, failed, masters, archived };
}

// ─── Customers, vendors and items, found by what they are ───────────────────────────────────────

/**
 * Of Zoho's customers, vendors and items, which are in Deskzo (owner, 23 Nov 2026: "Vendors 262 · 0 Not in yet" with 270
 * in Deskzo's Vendors list — "fix the check"). Counted only by the old-CRM import's record of Zoho's ids, anything that
 * came across another way — the WroffyCRM import, typed in, an earlier backup — was "not in yet". Now Zoho's list is
 * read (200 a call) and each record is found here by Zoho's id, else an item by its SKU, else by its name: a company's
 * with the legal form evened out ("Pvt Ltd" is "Private Limited" — src/lib/company-name.ts), an item's as written. A
 * vendor counts only as a vendor here (its own kind, or a customer also ticked as a vendor); one here by name that
 * isn't one is said so. What isn't found is listed by name, and how many of those Zoho itself has as inactive.
 */
export type MasterMatch = { listed: number; found: number; missing: string[]; missingCount: number; inactiveMissing: number; notVendor: number };

/** The names listed of what isn't found. */
export const MISSING_SHOWN = 30;
/** A list longer than this isn't read (a call each 200): its Zoho count and the id record stand instead. */
const MASTER_READ_UP_TO = 30_000;

const nameKey = (s: unknown) => legalNameKey(String(s ?? ""));
const itemKey = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export async function masterMatches(): Promise<{ byKey: Record<string, MasterMatch>; calls: number }> {
  const byKey: Record<string, MasterMatch> = {};
  let calls = 0;
  const companies = await db.company.findMany({ select: { name: true, relationshipType: true, alsoVendor: true } });
  const companyByName = new Map<string, { vendor: boolean }>();
  for (const c of companies) {
    const k = nameKey(c.name);
    const vendor = c.relationshipType === "VENDOR" || c.alsoVendor;
    const was = companyByName.get(k);
    companyByName.set(k, { vendor: vendor || !!was?.vendor });
  }
  const items = await db.item.findMany({ select: { name: true, sku: true } });
  const itemSkus = new Set(items.map((i) => itemKey(i.sku)).filter(Boolean));
  const itemNames = new Set(items.map((i) => itemKey(i.name)).filter(Boolean));

  for (const [key, kind] of Object.entries(MASTERS)) {
    const mod = MODULES.find((x) => x.key === key);
    if (!mod) continue;
    const rows: Record<string, unknown>[] = [];
    let complete = false;
    // A list Zoho won't give in full (out of calls, refused) is left to its count and the id record, as before.
    try {
      for (let page = 1; page <= MASTER_READ_UP_TO / 200; page++) {
        calls += 1;
        const reply = (await zohoGet(mod.path, { ...(mod.query ?? {}), page, per_page: 200 })) as ZohoReply;
        if (typeof reply.code === "number" && reply.code !== 0) break;
        rows.push(...((reply[mod.listKey] as Record<string, unknown>[] | undefined) ?? []));
        if (!reply.page_context?.has_more_page) {
          complete = true;
          break;
        }
      }
    } catch {
      complete = false;
    }
    if (!complete) continue;
    const ids = rows.map((r) => String(r[mod.idField] ?? "")).filter(Boolean);
    const brought = new Set<string>();
    for (let i = 0; i < ids.length; i += 5_000) {
      const got = await db.legacyImportRecord.findMany({ where: { kind, oldId: { in: ids.slice(i, i + 5_000) } }, select: { oldId: true } }).catch(() => []);
      for (const g of got) brought.add(g.oldId);
    }
    const out: MasterMatch = { listed: rows.length, found: 0, missing: [], missingCount: 0, inactiveMissing: 0, notVendor: 0 };
    for (const r of rows) {
      const id = String(r[mod.idField] ?? "");
      let found = brought.has(id);
      let name = "";
      if (!found && key === "items") {
        name = String(r.name ?? "");
        found = (!!itemKey(r.sku) && itemSkus.has(itemKey(r.sku))) || itemNames.has(itemKey(r.name));
      } else if (!found) {
        name = String(r.company_name || r.contact_name || "");
        const byName = (v: unknown) => (nameKey(v) ? companyByName.get(nameKey(v)) : undefined);
        const here = byName(r.company_name) ?? byName(r.contact_name);
        if (here && key === "vendors" && !here.vendor) {
          out.notVendor += 1;
          name = `${name} (here, not marked a vendor)`;
        } else found = !!here;
      }
      if (found) {
        out.found += 1;
        continue;
      }
      out.missingCount += 1;
      const inactive = String(r.status ?? "").toLowerCase() === "inactive";
      if (inactive) out.inactiveMissing += 1;
      if (out.missing.length < MISSING_SHOWN) out.missing.push(`${name || id}${inactive ? " (inactive in Zoho)" : ""}`);
    }
    byKey[key] = out;
  }
  return { byKey, calls };
}

/** The two sides set beside each other, with what each difference means. */
export function compareSides(
  zoho: Map<string, { total: number | null; leftOut: number }>,
  deskzo: Awaited<ReturnType<typeof deskzoSide>>,
  masters: Record<string, MasterMatch> = {},
): CompletenessRow[] {
  const rows: CompletenessRow[] = [];
  for (const mod of MODULES) {
    const z = zoho.get(mod.key);
    if (!z) continue;
    const master = MASTERS[mod.key];
    // Read and found by what they are (`masterMatches`): Zoho's list as it is, beside what of it is here.
    const matched = master ? masters[mod.key] : undefined;
    if (matched) {
      const missing = matched.missingCount;
      const inactive = matched.inactiveMissing;
      const what = mod.key === "items" ? "items" : mod.key === "vendors" ? "vendors" : "customers";
      rows.push({
        key: mod.key,
        label: mod.label,
        zoho: matched.listed,
        leftOut: 0,
        deskzo: matched.found,
        waiting: 0,
        failed: 0,
        state: missing === 0 ? "match" : matched.found === 0 ? "missing" : "behind",
        note:
          missing === 0
            ? `Every one is here — found by Zoho's id, ${mod.key === "items" ? "SKU" : "name"} or name.`
            : `${missing.toLocaleString("en-IN")} of Zoho's ${what} not found here${inactive ? ` — ${inactive.toLocaleString("en-IN")} of them inactive in Zoho` : ""}${matched.notVendor ? `; ${matched.notVendor.toLocaleString("en-IN")} here by name but not marked a vendor` : ""}. ${mod.key === "customers" ? "The newest wait in Old CRM migration's draft." : "Bring them from Old CRM migration, or Import & export."}`,
        missing: matched.missing,
      });
      continue;
    }
    const step = MODULE_STEPS[mod.key]?.[0];
    const have = master ? (deskzo.masters[mod.key] ?? 0) : step ? (deskzo.imported[step] ?? 0) : 0;
    const waiting = step ? (deskzo.waiting[step] ?? 0) : 0;
    const failed = step ? (deskzo.failed[step] ?? 0) : 0;
    const target = z.total === null ? null : Math.max(0, z.total - z.leftOut);
    let state: CompletenessRow["state"];
    let note: string;
    if (OPEN_ONLY[mod.key]) {
      // The open ones in the books, the rest in Earlier years: both against Zoho's count of every one.
      const archived = deskzo.archived?.[mod.key] ?? 0;
      const all = have + archived;
      const n = (v: number) => v.toLocaleString("en-IN");
      const where = `${n(have)} open in the books, ${n(archived)} in Earlier years`;
      const total = z.total;
      if (total === null) {
        state = "unknown";
        note = `Zoho didn't give a count for this — ${where}.`;
      } else if (all >= total) {
        state = "match";
        note = `All in — ${where}.`;
      } else {
        state = "behind";
        note =
          mod.key === "estimates"
            ? `${n(total - all)} not in Deskzo — ${where}. “Pull the earlier years' quotes from Zoho” in Earlier years brings the earlier ones (a call per 200); “Top up since the backup” the newest.`
            : `${n(total - all)} not in Deskzo — ${where}. “Top up since the backup” brings them, or the nightly top-up.`;
      }
      rows.push({ key: mod.key, label: mod.label, zoho: total, leftOut: 0, deskzo: all, archived, waiting, failed, state, note });
      continue;
    } else if (target === null) {
      state = "unknown";
      note = "Zoho didn't give a count for this.";
    } else if (have === 0 && target > 0) {
      state = "missing";
      note = master
        ? "None brought across yet — check them in Old CRM migration and import."
        : `Nothing imported yet — use “Pull ${PULL_WORDS[mod.key]?.toLowerCase() ?? mod.label.toLowerCase()} from Zoho” on its section, then import it.`;
    } else if (have < target) {
      state = "behind";
      note = master
        ? `${(target - have).toLocaleString("en-IN")} not brought across — the newest wait in Old CRM migration's draft.`
        : `${(target - have).toLocaleString("en-IN")} short${waiting ? ` — ${waiting.toLocaleString("en-IN")} waiting for something on file first` : ""}${failed ? `, ${failed.toLocaleString("en-IN")} failed` : ""}. Hand over what's fetched and import; the nightly top-up brings what's new.`;
    } else if (have > target) {
      state = "ahead";
      note =
        mod.key === "journals"
          ? "More here than Zoho's manual journals: transfers, deposits and refunds come in as journals too."
          : mod.key === "customerpayments"
            ? "More here: payments made this year against earlier invoices count too."
            : master
              ? "More here than in Zoho now — some were brought across and later deleted or merged in Zoho."
              : `${(have - target).toLocaleString("en-IN")} more here than Zoho counts — “Find documents Zoho doesn't count” shows which.`;
    } else {
      state = "match";
      note = z.leftOut ? `Matches — ${z.leftOut.toLocaleString("en-IN")} in Zoho left behind on purpose: drafts, voids, rejected or awaiting approval.` : "Matches.";
    }
    rows.push({ key: mod.key, label: mod.label, zoho: target, leftOut: z.leftOut, deskzo: have, waiting, failed, state, note });
  }
  return rows;
}
