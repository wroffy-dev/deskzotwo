import { zohoGet, type ZohoReply } from "./client";
import { MODULES } from "./pull";

/**
 * What Zoho holds, counted before (or while) pulling it (owner, 26 Oct 2026): how many of each kind, this year's
 * and earlier years' apart for the money documents, and about how many of Zoho's calls the pull will take — so
 * a big organisation knows it is a few days' work before it starts. One call a kind, two for those split by
 * year: Zoho's lists answer with only the count when asked (`response_option=2`).
 */

/** The kinds a pull reads in full for this year, and leaves to the list (or the opening balances) for earlier ones. */
const BY_YEAR = new Set(["invoices", "creditnotes", "customerpayments", "bills", "vendorcredits", "vendorpayments", "expenses", "journals", "estimates"]);
/** Earlier years' documents Zoho keeps a PDF of, fetched a call each. */
const WITH_PDF = new Set(["invoices", "creditnotes"]);
/** Counted as many as Zoho lists them: transfers and refunds are a few of a long banking list. */
const NOT_COUNTED = new Set(["banking", "refunds"]);

/** The count in a reply, wherever Zoho puts it; null when it gives none. */
function countIn(reply: ZohoReply, listKey: string): number | null {
  const ctx = (reply.page_context ?? {}) as Record<string, unknown>;
  for (const v of [ctx.total, ctx.total_count, ctx.count, reply.total_count, reply.count, reply[`${listKey}_count`]]) {
    const n = Number(v);
    if (v !== undefined && v !== null && v !== "" && Number.isFinite(n)) return n;
  }
  // No count given: a list that fits in one page is its own count.
  const list = reply[listKey];
  return Array.isArray(list) && !ctx.has_more_page ? list.length : null;
}

export type ZohoCount = { key: string; label: string; total: number | null; thisYear: number | null };
export type ZohoCounts = { kinds: ZohoCount[]; calls: number; allowance: number; days: number; counted: string };

export async function countZoho(yearStart: string, allowance: number): Promise<ZohoCounts> {
  const kinds: ZohoCount[] = [];
  for (const mod of MODULES) {
    if (NOT_COUNTED.has(mod.key)) continue;
    const ask = async (extra: Record<string, string>) => countIn((await zohoGet(mod.path, { ...(mod.query ?? {}), ...extra, response_option: 2, per_page: 200 })) as ZohoReply, mod.listKey);
    const total = await ask({});
    const thisYear = BY_YEAR.has(mod.key) ? await ask({ date_start: yearStart }) : null;
    kinds.push({ key: mod.key, label: mod.label, total, thisYear });
  }
  return { kinds, calls: estimateCalls(kinds), allowance, days: Math.max(1, Math.ceil(estimateCalls(kinds) / allowance)), counted: new Date().toISOString() };
}

/**
 * About how many calls the pull takes: a list call for every 200 of a kind; one more for each record read in full
 * — every customer and vendor, this year's documents and quotes, the orders (all of them, as the open ones can't
 * be counted apart); and one for each earlier invoice's and credit note's PDF.
 */
export function estimateCalls(kinds: ZohoCount[]): number {
  let calls = 30;
  for (const k of kinds) {
    const total = k.total ?? 0;
    calls += Math.max(1, Math.ceil(total / 200));
    if (k.key === "customers" || k.key === "vendors" || k.key === "salesorders" || k.key === "purchaseorders") calls += total;
    else if (BY_YEAR.has(k.key)) calls += k.thisYear ?? total;
    if (WITH_PDF.has(k.key)) calls += Math.max(0, total - (k.thisYear ?? 0));
  }
  return calls;
}
