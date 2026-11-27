/**
 * check:audit-lows-paging — the security audit of 11 Nov 2026 (docs/reports/security-audit-2026-11-11.md), SEC-29's
 * remainder, 13 Nov 2026: no list reader hands back more than its ceiling, whatever a hand-made call asks for.
 *
 *   · The unpaged readers (listCompanies and its siblings) stop at UNPAGED_LIST_CEILING (5,000).
 *   · listTradeDocuments and the hand-rolled pagers (items, leave, short leave, e-way bills, support load) clamp a page
 *     to 1–500 rows through pageSlice / clampPage.
 *
 * Calls the real actions as the workspace's super admin, with sign-in stubbed as check:scope does. Its own fixture —
 * 5,001 customers, 5,001 vendors and 501 items, all named ZZL4 — is removed in `finally`. Lists it can't fill (leave,
 * documents, e-way bills, support load) are asked for a million rows and must answer at most 500 and no fewer than the
 * smaller of 500 and their total; a source check covers every reader's ceiling by name as well.
 *
 *   npx tsx scripts/check-audit-lows-paging.ts
 */
import "dotenv/config";
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";
import { MAX_PAGE_SIZE, UNPAGED_LIST_CEILING } from "../src/lib/pagination";

const probe = directClient();
const TAG = "ZZL4";
const HUGE = 1_000_000;

let actor: { id: string; name: string; email: string; role: string } | null = null;

const load = Module.createRequire(__filename);
const moduleInternals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const substitutes = new Map<string, unknown>([
  [
    load.resolve("../src/lib/session"),
    {
      requireUser: async () => {
        if (!actor) throw new Error("The check called an action without saying who was calling it.");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    },
  ],
  [load.resolve("next/cache"), { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }],
]);
const realLoad = moduleInternals._load;
moduleInternals._load = function (request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = moduleInternals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && substitutes.has(resolved)) return substitutes.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** The body of one exported function, from its signature to the next top-level `export`. */
function bodyOf(file: string, name: string): string {
  const source = read(file);
  const start = source.indexOf(`export async function ${name}(`);
  if (start < 0) return "";
  const next = source.indexOf("\nexport ", start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

/** At most the ceiling, and no fewer than the smaller of the ceiling and what there is. */
const bounded = (got: number, total: number, ceiling: number) => got <= ceiling && got >= Math.min(ceiling, total);

async function main() {
  section("The source: every reader has its ceiling");
  const unpaged: [string, string][] = [
    ["src/actions/company.ts", "listCompanies"],
    ["src/actions/company.ts", "listCustomers"],
    ["src/actions/company.ts", "listVendors"],
    ["src/actions/order.ts", "listOrders"],
    ["src/actions/ticket.ts", "listTickets"],
    ["src/actions/contact.ts", "listAllContacts"],
    ["src/actions/renewal.ts", "listRenewals"],
    ["src/actions/payment.ts", "listPayments"],
  ];
  for (const [file, name] of unpaged) ok(`${name} stops at UNPAGED_LIST_CEILING`, bodyOf(file, name).includes("take: UNPAGED_LIST_CEILING"));
  // Each pager goes through the clamp, and no longer does its own arithmetic on the size as sent.
  const RAW = /\(\s*(params\.|filters\?\.)?page\s*-\s*1\s*\)\s*\*/;
  const pagers: [string, string, string, RegExp][] = [
    ["src/actions/trade-document.ts", "listTradeDocuments", "pageSlice(", RAW],
    ["src/actions/item.ts", "listItems", "clampPage(", /params\?\.pageSize \?\? DEFAULT_PAGE_SIZE/],
    ["src/actions/leave.ts", "allLeaveRequests", "pageSlice(", RAW],
    ["src/actions/short-leave.ts", "allShortLeaves", "pageSlice(", RAW],
    ["src/actions/eway.ts", "ewayDocuments", "pageSlice(", RAW],
    ["src/actions/support-load.ts", "listSupportLoad", "pageSlice(", RAW],
  ];
  for (const [file, name, through, raw] of pagers) {
    const body = bodyOf(file, name);
    ok(`${name} pages through ${through.slice(0, -1)}`, body.includes(through) && !raw.test(body));
  }
  // Already bounded before this round, each its own way — kept so.
  ok("recentLetters keeps its fixed 50", /const pageSize = 50;/.test(bodyOf("src/actions/employee-docs.ts", "recentLetters")));
  ok("listVouchers keeps its 10–100", bodyOf("src/actions/vouchers.ts", "listVouchers").includes("Math.min(100,"));
  ok("listReports keeps its schema's 50", /pageSize: z\.number\(\)\.int\(\)\.min\(1\)\.max\(50\)/.test(read("src/actions/reporting.ts")));
  ok("the accounts and stock reports keep resolvePageSize", ["accounts-reports", "stock-reports"].every((f) => read(`src/actions/${f}.ts`).includes("resolvePageSize(")));

  const admin = await probe.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true, role: true } });
  if (!admin) {
    ok("the check has a super admin to act as", false);
    return;
  }
  actor = admin;

  const companies = load("../src/actions/company") as typeof import("../src/actions/company");
  const items = load("../src/actions/item") as typeof import("../src/actions/item");
  const docs = load("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const leave = load("../src/actions/leave") as typeof import("../src/actions/leave");
  const shortLeave = load("../src/actions/short-leave") as typeof import("../src/actions/short-leave");
  const eway = load("../src/actions/eway") as typeof import("../src/actions/eway");
  const support = load("../src/actions/support-load") as typeof import("../src/actions/support-load");

  try {
    section("Unpaged readers stop at 5,000");
    const stamp = Date.now();
    const over = UNPAGED_LIST_CEILING + 1;
    for (const [kind, prefix] of [["CLIENT", "C"], ["VENDOR", "V"]] as const) {
      for (let at = 0; at < over; at += 1000) {
        const data = Array.from({ length: Math.min(1000, over - at) }, (_, i) => {
          const name = `${TAG} ${prefix} ${stamp} ${at + i}`;
          return { name, normalizedName: name.toLowerCase(), relationshipType: kind, createdById: admin.id, ownerUserId: admin.id };
        });
        await probe.company.createMany({ data });
      }
    }
    const listed = await companies.listCompanies({ search: `${TAG} C ${stamp}` });
    ok(`listCompanies over ${over} matching answers ${UNPAGED_LIST_CEILING}`, listed.length === UNPAGED_LIST_CEILING, listed.length);
    const vendors = await companies.listVendors({ search: `${TAG} V ${stamp}` });
    ok(`listVendors over ${over} matching answers ${UNPAGED_LIST_CEILING}`, vendors.length === UNPAGED_LIST_CEILING, vendors.length);

    section("Pagers answer at most 500 a page");
    await probe.item.createMany({
      data: Array.from({ length: MAX_PAGE_SIZE + 1 }, (_, i) => ({ name: `${TAG} item ${stamp} ${i}`, sku: `${TAG}-${stamp}-${i}`, type: "GOOD" as const,sellingPrice: 1, createdById: admin.id })),
    });
    const itemPage = await items.listItems({ search: `${TAG} item ${stamp}`, page: 1, pageSize: HUGE });
    ok(`listItems asked for a million of ${MAX_PAGE_SIZE + 1} answers ${MAX_PAGE_SIZE}`, itemPage.items.length === MAX_PAGE_SIZE && itemPage.pageSize === MAX_PAGE_SIZE && itemPage.total === MAX_PAGE_SIZE + 1, { rows: itemPage.items.length, total: itemPage.total });
    const itemPage2 = await items.listItems({ search: `${TAG} item ${stamp}`, page: 2, pageSize: HUGE });
    ok("  and its page 2 holds the one left", itemPage2.items.length === 1 && itemPage2.page === 2, itemPage2.items.length);
    const itemOdd = await items.listItems({ search: `${TAG} item ${stamp}`, page: -3, pageSize: -1 });
    ok("  a negative page and size are page 1 of the usual size", itemOdd.page === 1 && itemOdd.items.length === 50, { page: itemOdd.page, rows: itemOdd.items.length });

    const invoices = await docs.listTradeDocuments({ docType: "INVOICE", page: 1, pageSize: HUGE });
    ok("listTradeDocuments asked for a million answers at most 500", bounded(invoices.rows.length, invoices.total, MAX_PAGE_SIZE), { rows: invoices.rows.length, total: invoices.total });
    const invoicesOdd = await docs.listTradeDocuments({ docType: "INVOICE", page: -2, pageSize: Number.NaN });
    ok("  and a negative page is page 1, not an error", bounded(invoicesOdd.rows.length, invoicesOdd.total, 50), invoicesOdd.rows.length);

    const leaves = await leave.allLeaveRequests({ page: 1, pageSize: HUGE });
    ok("allLeaveRequests asked for a million answers at most 500", bounded(leaves.rows.length, leaves.total, MAX_PAGE_SIZE), { rows: leaves.rows.length, total: leaves.total });

    const shorts = await shortLeave.allShortLeaves({ page: 1, pageSize: HUGE });
    if (shorts) ok("allShortLeaves asked for a million answers at most 500", bounded(shorts.rows.length, shorts.total, MAX_PAGE_SIZE), { rows: shorts.rows.length, total: shorts.total });
    else console.log("  (short leave is off in this workspace — the source check above covers it)");

    const bills = await eway.ewayDocuments({ status: "all", page: 1, pageSize: HUGE });
    if (bills.ok) ok("ewayDocuments asked for a million answers at most 500", bounded(bills.data.rows.length, bills.data.total, MAX_PAGE_SIZE), { rows: bills.data.rows.length, total: bills.data.total });
    else console.log(`  (e-way bills answer "${bills.error}" here — the source check above covers it)`);

    const load_ = await support.listSupportLoad({ months: 24, sort: "tickets", page: 1, pageSize: HUGE });
    ok("listSupportLoad asked for a million answers at most 500", bounded(load_.rows.length, load_.total, MAX_PAGE_SIZE), { rows: load_.rows.length, total: load_.total });
  } finally {
    await probe.item.deleteMany({ where: { sku: { startsWith: `${TAG}-` } } });
    await probe.company.deleteMany({ where: { name: { startsWith: `${TAG} ` } } });
    const left = (await probe.item.count({ where: { sku: { startsWith: `${TAG}-` } } })) + (await probe.company.count({ where: { name: { startsWith: `${TAG} ` } } }));
    ok("the check leaves nothing behind", left === 0, `${left} leftover(s)`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    failures++;
  })
  .finally(async () => {
    console.log(failures === 0 ? `\nAll ${passes} paging checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
    await probe.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
