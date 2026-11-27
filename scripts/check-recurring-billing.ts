/**
 * check:recurring-billing — subscriptions that renew themselves, and terms invoiced in parts.
 *
 * The arithmetic first, by hand-worked cases (src/lib/recurring-billing/periods.ts): where each part
 * starts and ends, how a price splits to the paisa, the day a renewal is due. Then the daily job
 * (src/lib/recurring-billing/run.ts) against a fixture of its own — run as chosen days in 2001, told
 * to look at the fixture's orders only and to notify nobody — and the switch on the order page
 * (src/actions/recurring-billing.ts). Then what keeps anything from being missed (owner, 30 Oct 2026): the rules
 * of src/lib/recurring-billing/check-rules.ts, the drafts Monday's reminder counts, and Renewals › Billing check.
 * Everything is named ZZPROBE_RB and removed in a finally.
 *
 *   npm run check:recurring-billing
 */
import "dotenv/config";
import { replacedBy } from "../src/lib/documents/permission-keys";
const ISSUE = replacedBy("documents.issue");
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzprobe Rep", email: `rep${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "next/navigation") {
    return { useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }), usePathname: () => "/orders", useSearchParams: () => new URLSearchParams() };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_RB";
const MAIL = "@zzprobe-rb.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);

async function cleanup() {
  const userIds = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companyIds = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const orderIds = (await db.companyProduct.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } })).map((o) => o.id);
  const docIds = (await db.tradeDocument.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } })).map((x) => x.id);
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: [...orderIds, ...docIds] } }] } });
  await db.recurringBillingPeriod.deleteMany({ where: { companyProductId: { in: orderIds } } });
  await db.recurringBilling.deleteMany({ where: { companyProductId: { in: orderIds } } });
  await db.tradeDocument.deleteMany({ where: { id: { in: docIds } } });
  // Renewals point at what they renew; the newest first.
  await db.companyProduct.deleteMany({ where: { id: { in: orderIds }, renewedFromId: { not: null } } });
  await db.companyProduct.deleteMany({ where: { id: { in: orderIds } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const periods = require("../src/lib/recurring-billing/periods") as typeof import("../src/lib/recurring-billing/periods");
  const { runRecurringBilling } = require("../src/lib/recurring-billing/run") as typeof import("../src/lib/recurring-billing/run");
  const actions = require("../src/actions/recurring-billing") as typeof import("../src/actions/recurring-billing");
  const { RecurringBillingCard } = require("../src/components/orders/recurring-billing-card") as typeof import("../src/components/orders/recurring-billing-card");
  const rules = require("../src/lib/recurring-billing/check-rules") as typeof import("../src/lib/recurring-billing/check-rules");
  const { waitingDraftsWhere } = require("../src/lib/recurring-billing/run") as typeof import("../src/lib/recurring-billing/run");
  const { billingCheck } = require("../src/actions/billing-check") as typeof import("../src/actions/billing-check");
  const { listRenewalsPaged } = require("../src/actions/renewal") as typeof import("../src/actions/renewal");
  const { default: BillingCheckPage } = require("../src/app/(dashboard)/renewals/billing/page") as typeof import("../src/app/(dashboard)/renewals/billing/page");
  const { createElement } = require("react") as typeof import("react");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("Parts of a term");
  const year = periods.instalmentPeriods(d("2026-01-15"), d("2027-01-14"), "MONTHLY");
  ok("a year from 15 January is twelve monthly parts", year.length === 12, year.length);
  ok("...the first 15 January to 14 February", iso(year[0]!.start) === "2026-01-15" && iso(year[0]!.end) === "2026-02-14", `${iso(year[0]!.start)} to ${iso(year[0]!.end)}`);
  ok("...the last 15 December to 14 January", iso(year[11]!.start) === "2026-12-15" && iso(year[11]!.end) === "2027-01-14");
  const lastDay = periods.instalmentPeriods(d("2026-01-31"), d("2027-01-30"), "MONTHLY");
  ok("from 31 January, the next parts start 28 February and 31 March", iso(lastDay[1]!.start) === "2026-02-28" && iso(lastDay[2]!.start) === "2026-03-31", `${iso(lastDay[1]!.start)}, ${iso(lastDay[2]!.start)}`);
  ok("...and no day falls between two parts", lastDay.every((p, i) => i === 0 || p.start.getTime() === lastDay[i - 1]!.end.getTime() + 86_400_000));
  ok("a year is four quarterly parts", periods.instalmentPeriods(d("2026-04-01"), d("2027-03-31"), "QUARTERLY").length === 4);
  const short = periods.instalmentPeriods(d("2026-01-01"), d("2026-03-15"), "MONTHLY");
  ok("a term ending mid-month: its last part is cut short", short.length === 3 && iso(short[2]!.end) === "2026-03-15", short.map((p) => iso(p.end)).join(", "));

  // Billing plans (owner, 16 Nov 2026): an annual commitment paid every six months.
  const halves = periods.instalmentPeriods(d("2026-04-01"), d("2027-03-31"), "HALF_YEARLY");
  ok("a year is two half-yearly parts: April to September, October to March", halves.length === 2 && iso(halves[0]!.end) === "2026-09-30" && iso(halves[1]!.start) === "2026-10-01", halves.map((h) => `${iso(h.start)}–${iso(h.end)}`).join(", "));
  const claimedApr = new Set(["2026-01-15", "2026-02-15"]);
  const missedNow = periods.missedParts(year, claimedApr, d("2026-04-20"), null);
  ok("missed: March and April's parts passed with nothing raised (January, February raised)", missedNow.map((p) => iso(p.start)).join(", ") === "2026-03-15, 2026-04-15", missedNow.map((p) => iso(p.start)).join(", "));
  ok("...not a part only a day old — the job runs each morning", periods.missedParts(year, claimedApr, d("2026-03-16"), null).length === 0);
  ok("...nor one before billing began", periods.missedParts(year, new Set(), d("2026-04-20"), d("2026-04-01")).map((p) => iso(p.start)).join() === "2026-04-15");

  section("Splitting a price");
  const thirds = periods.instalmentAmounts(1000, 3);
  ok("1,000 in three: 333.33, 333.33, 333.34", JSON.stringify(thirds) === JSON.stringify([333.33, 333.33, 333.34]), thirds.join(", "));
  const twelfths = periods.instalmentAmounts(100, 12);
  ok("100 in twelve adds up to 100 exactly", Math.round(twelfths.reduce((t, x) => t + x, 0) * 100) === 10000, twelfths.join(", "));
  ok("...eleven of 8.33 and the last 8.37", twelfths.slice(0, 11).every((x) => x === 8.33) && twelfths[11] === 8.37);

  section("When things fall due");
  const due = periods.instalmentsDue(year, d("2026-06-20"), d("2026-04-15"));
  ok("on 20 June, switched on from 15 April: April, May and June", due.map((p) => iso(p.start)).join(", ") === "2026-04-15, 2026-05-15, 2026-06-15", due.map((p) => iso(p.start)).join(", "));
  ok("a term ending 31 March renews on 1 April, not on the 31st", periods.renewalDue(d("2026-03-31"), d("2026-04-01")) && !periods.renewalDue(d("2026-03-31"), d("2026-03-31")));

  section("What stands in the way, and the next bill");
  const parts12 = { mode: "INSTALMENTS" as const, cycle: "MONTHLY" as const, billFrom: null, startDate: d("2026-01-15"), endDate: d("2027-01-14"), unitPrice: 1200, locationId: "site", renewalStage: null, renewed: false };
  const renews12 = { ...parts12, mode: "AUTO_RENEW" as const, cycle: null, startDate: d("2025-04-01"), endDate: d("2026-03-31") };
  ok("in parts with no cycle: held up", rules.billingBlocker({ ...parts12, cycle: null }) === "instalments need a monthly, quarterly, half-yearly or yearly cycle");
  ok("...with no price", rules.billingBlocker({ ...parts12, unitPrice: 0 }) === "no price");
  ok("renewing with no expiry, or no site", rules.billingBlocker({ ...renews12, endDate: null })?.startsWith("no expiry") === true && rules.billingBlocker({ ...renews12, locationId: null }) === "no site to renew to");
  ok("...and nothing in the way of a whole one", rules.billingBlocker(parts12) === null && rules.billingBlocker(renews12) === null);
  const next = (o: Parameters<typeof rules.nextBill>[0], today: string) => {
    const n = rules.nextBill(o, d(today));
    return `${n.day ? iso(n.day) : "-"} ${n.what}`;
  };
  ok("monthly parts on 20 March: next is 15 April, part 4 of 12", next(parts12, "2026-03-20") === "2026-04-15 Part 4 of 12", next(parts12, "2026-03-20"));
  ok("...switched on from 1 June: 15 June, part 6", next({ ...parts12, billFrom: d("2026-06-01") }, "2026-03-20") === "2026-06-15 Part 6 of 12");
  ok("...after the last part: all raised", next(parts12, "2026-12-20") === "- All parts raised");
  ok("...unless it keeps renewing: then the day after the term", next({ ...parts12, keepRenewing: true }, "2026-12-20") === "2027-01-15 Renews itself", next({ ...parts12, keepRenewing: true }, "2026-12-20"));
  ok("half-yearly parts on a year: the second, on its half", next({ ...parts12, cycle: "HALF_YEARLY" }, "2026-03-20") === "2026-07-15 Part 2 of 2", next({ ...parts12, cycle: "HALF_YEARLY" }, "2026-03-20"));
  ok("quarterly parts on a year: four, the next on its quarter", next({ ...parts12, cycle: "QUARTERLY" }, "2026-03-20") === "2026-04-15 Part 2 of 4", next({ ...parts12, cycle: "QUARTERLY" }, "2026-03-20"));
  ok("renewing itself: the day after the term ends", next(renews12, "2026-03-20") === "2026-04-01 Renews itself");
  ok("...past that day and not renewed: tomorrow, when the job tries again", next(renews12, "2026-04-05") === "2026-04-06 Renews itself");
  ok("...renewed, lost, on hold say so", next({ ...renews12, renewed: true }, "2026-03-20") === "- Renewed" && next({ ...renews12, renewalStage: "LOST" }, "2026-03-20").includes("Lost") && next({ ...renews12, renewalStage: "ON_HOLD" }, "2026-03-20") === "- On hold");
  ok("nothing switched on: not set; a gap: held up", next(null, "2026-03-20") === "- Not set" && next({ ...renews12, locationId: null }, "2026-03-20") === "- Held up");
  ok("a month's term is short; a year isn't", rules.shortTerm(d("2026-04-01"), d("2026-04-30")) && !rules.shortTerm(d("2026-04-01"), d("2027-03-31")));

  await cleanup();
  try {
    section("The fixture");
    const rep = await db.user.create({ data: { name: "Zzprobe Rep", email: `rep${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    for (const permission of ["documents.view", ...ISSUE, "orders.view", "products.edit"]) {
      await db.userPermission.create({ data: { userId: rep.id, permission, allowed: true, reason: TAG } });
    }
    const company = await db.company.create({
      data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
    });
    const site = await db.companyLocation.create({
      data: { companyId: company.id, label: "Head Office", isPrimary: true, address: "1 MG Road", city: "Bengaluru", state: "Karnataka", pincode: "560001", country: "India" },
    });
    const item = await db.item.create({
      data: { name: `${TAG} Licence`, sku: `${TAG}-1`, type: "SUBSCRIPTION", billingCycle: "ANNUAL", sellingPrice: 1200, taxRatePercent: 18, hsnCode: "997331", createdById: rep.id },
    });
    const goods = await db.item.create({ data: { name: `${TAG} Laptop`, sku: `${TAG}-2`, type: "GOOD", sellingPrice: 50000, createdById: rep.id } });
    const order = (o: { start: string; end: string; price: number; quantity: number; status?: "FULFILLED" | "PENDING_APPROVAL"; itemId?: string }) =>
      db.companyProduct.create({
        data: {
          companyId: company.id,
          locationId: site.id,
          itemId: o.itemId ?? item.id,
          addedByUserId: rep.id,
          quantity: o.quantity,
          unitPrice: o.price,
          fullTermUnitPrice: o.price,
          startDate: d(o.start),
          endDate: d(o.end),
          orderStatus: o.status ?? "FULFILLED",
        },
      });
    const parts = await order({ start: "2001-04-01", end: "2002-03-31", price: 1200, quantity: 2 });
    const renews = await order({ start: "2000-04-01", end: "2001-03-31", price: 1000, quantity: 3 });
    const waiting = await order({ start: "2000-04-01", end: "2001-03-31", price: 1000, quantity: 1, status: "PENDING_APPROVAL" });
    const handRenewed = await order({ start: "2000-04-01", end: "2001-03-31", price: 1000, quantity: 1 });
    await order({ start: "2001-04-01", end: "2002-03-31", price: 1000, quantity: 1 }).then((r) =>
      db.companyProduct.update({ where: { id: r.id }, data: { renewedFromId: handRenewed.id, businessType: "RENEWAL" } }),
    );
    const setting = (companyProductId: string, mode: "AUTO_RENEW" | "INSTALMENTS", extra: { cycle?: "MONTHLY" | "QUARTERLY" | "HALF_YEARLY"; billFrom?: string; keepRenewing?: boolean } = {}) =>
      db.recurringBilling.create({ data: { companyProductId, mode, cycle: extra.cycle ?? null, billFrom: extra.billFrom ? d(extra.billFrom) : null, keepRenewing: extra.keepRenewing ?? false, setById: rep.id } });
    await setting(parts.id, "INSTALMENTS", { cycle: "MONTHLY", billFrom: "2001-06-01" });
    await setting(renews.id, "AUTO_RENEW");
    await setting(waiting.id, "AUTO_RENEW");
    await setting(handRenewed.id, "AUTO_RENEW");
    // The customer said no, or not yet (owner, 26 Oct 2026): switched on, but never renewed.
    const lost = await order({ start: "2000-04-01", end: "2001-03-31", price: 1000, quantity: 1 });
    const held = await order({ start: "2000-04-01", end: "2001-03-31", price: 1000, quantity: 1 });
    await db.companyProduct.update({ where: { id: lost.id }, data: { renewalStage: "LOST" } });
    await db.companyProduct.update({ where: { id: held.id }, data: { renewalStage: "ON_HOLD" } });
    await setting(lost.id, "AUTO_RENEW");
    await setting(held.id, "AUTO_RENEW");
    const only = [parts.id, renews.id, waiting.id, handRenewed.id, lost.id, held.id];
    const run = (today: string) => runRecurringBilling({ today: d(today), only, claim: false, notify: false });
    ok("a customer, a site, a subscription item, and four orders switched on", true);

    section("Renewing itself");
    const before = await run("2001-03-31");
    ok("on the term's last day, nothing renews", before.renewals === 0, before.renewals);
    const renewDay = await run("2001-04-01");
    const renewal = await db.companyProduct.findFirst({ where: { renewedFromId: renews.id }, include: { recurringBilling: true } });
    ok("on 1 April the next term's order is punched", renewal !== null && renewDay.renewals >= 1, renewDay.errors.join(" | ") || renewDay.renewals);
    ok("...for approval, as a renewal", renewal?.orderStatus === "PENDING_APPROVAL" && renewal.businessType === "RENEWAL");
    ok("...1 April 2001 to 31 March 2002, 3 seats at 1,000", renewal !== null && iso(renewal.startDate!) === "2001-04-01" && iso(renewal.endDate!) === "2002-03-31" && renewal.quantity === 3 && Number(renewal.unitPrice) === 1000);
    ok("...and starts with the switch off — it renews again only if somebody chooses", renewal !== null && renewal.recurringBilling === null);
    const renewalRow = await db.recurringBillingPeriod.findFirst({ where: { companyProductId: renews.id }, include: { document: { include: { lines: true } } } });
    ok("its invoice is a draft for the new order", renewalRow?.document?.status === "DRAFT" && renewalRow.document.lines[0]?.companyProductId === renewal?.id && renewalRow.renewalOrderId === renewal?.id);
    const twice = await run("2001-04-02");
    ok("the next day renews nothing again", (await db.companyProduct.count({ where: { renewedFromId: renews.id } })) === 1 && twice.errors.length === 0, twice.errors.join(" | "));
    ok("an order still waiting for approval doesn't renew", (await db.companyProduct.count({ where: { renewedFromId: waiting.id } })) === 0);
    ok("one renewed by hand isn't renewed again", (await db.companyProduct.count({ where: { renewedFromId: handRenewed.id } })) === 1);
    ok("a renewal marked Lost: no order, no invoice, whatever the switch says", (await db.companyProduct.count({ where: { renewedFromId: lost.id } })) === 0 && (await db.recurringBillingPeriod.count({ where: { companyProductId: lost.id } })) === 0 && renewDay.passed.some((p) => p.includes("Lost")));
    ok("  nor one On hold", (await db.companyProduct.count({ where: { renewedFromId: held.id } })) === 0 && renewDay.passed.some((p) => p.includes("on hold")));

    section("Instalments");
    const july = await run("2001-07-15");
    ok("on 15 July, switched on from 1 June: June and July are raised", july.errors.length === 0 && (await db.recurringBillingPeriod.count({ where: { companyProductId: parts.id } })) === 2, july.errors.join(" | ") || "");
    const raised = await db.recurringBillingPeriod.findMany({ where: { companyProductId: parts.id }, orderBy: { periodStart: "asc" }, include: { document: { include: { lines: true } } } });
    ok("...not April or May, invoiced before it was switched on", raised.map((r) => iso(r.periodStart)).join(", ") === "2001-06-01, 2001-07-01", raised.map((r) => iso(r.periodStart)).join(", "));
    const juneDoc = raised[0]?.document;
    ok("June's is a draft tax invoice from recurring billing", juneDoc?.docType === "INVOICE" && juneDoc.status === "DRAFT" && juneDoc.origin === "RECURRING_BILLING", `${juneDoc?.docType} ${juneDoc?.status} ${juneDoc?.origin}`);
    const juneLine = juneDoc?.lines[0];
    ok("...for both seats, at a twelfth of 1,200 each", Number(juneLine?.quantity) === 2 && Number(juneLine?.unitPrice) === 100, `${Number(juneLine?.quantity)} × ${Number(juneLine?.unitPrice)}`);
    ok("...its service period June", !!juneLine?.servicePeriodFrom && iso(juneLine.servicePeriodFrom) === "2001-06-01" && !!juneLine.servicePeriodTo && iso(juneLine.servicePeriodTo) === "2001-06-30");
    ok("...tied to the order", juneLine?.companyProductId === parts.id);
    ok("...written by the Automation account, the rep its salesperson", juneDoc?.salespersonId === rep.id && juneDoc.createdById !== rep.id);

    const again = await run("2001-07-15");
    ok("running the same day again raises nothing", again.drafts === 0 && (await db.recurringBillingPeriod.count({ where: { companyProductId: parts.id } })) === 2, again.drafts);
    await db.tradeDocument.delete({ where: { id: raised[1]!.documentId! } });
    const afterDelete = await run("2001-07-20");
    const julyRow = await db.recurringBillingPeriod.findUnique({ where: { companyProductId_periodStart: { companyProductId: parts.id, periodStart: d("2001-07-01") } } });
    ok("a deleted draft is a skipped part: it stays raised, with no invoice", julyRow !== null && julyRow.documentId === null && afterDelete.drafts === 0);
    const august = await run("2001-08-01");
    ok("on 1 August, August's part is raised", august.drafts === 1, august.drafts);

    section("Keep renewing on this plan");
    // Monthly on an annual commitment, renewing on the same plan: the twelfth part, then the renewal with its own parts.
    const yearly = await order({ start: "2002-04-01", end: "2003-03-31", price: 1200, quantity: 1 });
    await setting(yearly.id, "INSTALMENTS", { cycle: "MONTHLY", billFrom: "2002-04-01", keepRenewing: true });
    // Month to month: a month's term that renews into the next, its invoice drafted each time.
    const rolling = await order({ start: "2002-04-01", end: "2002-04-30", price: 500, quantity: 1 });
    await setting(rolling.id, "AUTO_RENEW", { keepRenewing: true });
    const plan = (today: string) => runRecurringBilling({ today: d(today), only: [yearly.id, rolling.id], claim: false, notify: false });
    const may1 = await plan("2002-05-01");
    const nextMonth = await db.companyProduct.findFirst({ where: { renewedFromId: rolling.id }, include: { recurringBilling: true } });
    ok("month to month: on 1 May the next month is punched, for approval", nextMonth?.orderStatus === "PENDING_APPROVAL" && iso(nextMonth.startDate!) === "2002-05-01" && iso(nextMonth.endDate!) === "2002-05-31", may1.errors.join(" | ") || (nextMonth && iso(nextMonth.endDate!)));
    ok("...carrying its plan, so it renews again", nextMonth?.recurringBilling?.mode === "AUTO_RENEW" && nextMonth.recurringBilling.keepRenewing === true);
    const mayInvoice = await db.recurringBillingPeriod.findFirst({ where: { companyProductId: rolling.id }, include: { document: { include: { lines: true } } } });
    ok("...and the month's invoice drafted for the new order", mayInvoice?.document?.status === "DRAFT" && mayInvoice.document.lines[0]?.companyProductId === nextMonth?.id);
    await plan("2003-03-15");
    ok("annual commitment, paid monthly: twelve parts raised by March", (await db.recurringBillingPeriod.count({ where: { companyProductId: yearly.id } })) === 12);
    const april = await plan("2003-04-01");
    const nextYear = await db.companyProduct.findFirst({ where: { renewedFromId: yearly.id }, include: { recurringBilling: true } });
    ok("on 1 April the next year is punched, for approval", nextYear?.orderStatus === "PENDING_APPROVAL" && iso(nextYear.startDate!) === "2003-04-01" && iso(nextYear.endDate!) === "2004-03-31", april.errors.join(" | ") || april.passed.join(" | ") || JSON.stringify(april));
    ok("...carrying monthly parts from its first day, still renewing", nextYear?.recurringBilling?.mode === "INSTALMENTS" && nextYear.recurringBilling.cycle === "MONTHLY" && iso(nextYear.recurringBilling.billFrom!) === "2003-04-01" && nextYear.recurringBilling.keepRenewing === true);
    const renewalClaim = await db.recurringBillingPeriod.findFirst({ where: { companyProductId: yearly.id, renewalOrderId: nextYear?.id } });
    ok("...and no whole-year invoice: it is billed in its parts", !!renewalClaim && renewalClaim.documentId === null);
    // Approved, the new year's parts come as they fall due.
    await db.companyProduct.update({ where: { id: nextYear!.id }, data: { orderStatus: "APPROVED" } });
    await runRecurringBilling({ today: d("2003-04-02"), only: [nextYear!.id], claim: false, notify: false });
    const firstOfNew = await db.recurringBillingPeriod.findFirst({ where: { companyProductId: nextYear!.id }, include: { document: { include: { lines: true } } } });
    ok("once approved, its April part is raised: a twelfth of the year", iso(firstOfNew!.periodStart) === "2003-04-01" && Number(firstOfNew!.document?.lines[0]?.unitPrice) === 100, firstOfNew ? `${iso(firstOfNew.periodStart)} ${Number(firstOfNew.document?.lines[0]?.unitPrice)}` : "none");

    section("Drafts left waiting");
    const now = Date.now();
    const DAYMS = 86_400_000;
    ok("the fixture's drafts not issued: June and August (July's was deleted)", (await db.tradeDocument.count({ where: waitingDraftsWhere(new Date(now + DAYMS), [parts.id]) })) === 2);
    await db.tradeDocument.update({ where: { id: raised[0]!.documentId! }, data: { createdAt: new Date(now - 5 * DAYMS) } });
    ok("Monday's reminder counts the one raised five days ago, not the one raised today", (await db.tradeDocument.count({ where: waitingDraftsWhere(new Date(now - 2 * DAYMS), [parts.id]) })) === 1);
    const augustDoc = await db.recurringBillingPeriod.findFirst({ where: { companyProductId: parts.id, periodStart: d("2001-08-01") }, select: { documentId: true } });
    await db.tradeDocument.update({ where: { id: augustDoc!.documentId! }, data: { status: "ISSUED" } });
    ok("...and an issued one isn't waiting", (await db.tradeDocument.count({ where: waitingDraftsWhere(new Date(now + DAYMS), [parts.id]) })) === 1);

    section("Renewals › Billing check");
    actorId = rep.id;
    const realToday = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const later = (days: number) => iso(new Date(realToday.getTime() + days * DAYMS));
    const unbilled = await order({ start: later(-30), end: later(335), price: 1200, quantity: 1 });
    const noPrice = await order({ start: later(-30), end: later(335), price: 0, quantity: 1 });
    await setting(noPrice.id, "INSTALMENTS", { cycle: "MONTHLY" });
    const fine = await order({ start: later(-30), end: later(335), price: 1200, quantity: 1 });
    await setting(fine.id, "INSTALMENTS", { cycle: "MONTHLY" });
    // A part whose day has gone by with nothing raised: billed from three months back, never run.
    const missedOrder = await order({ start: later(-100), end: later(265), price: 1200, quantity: 1 });
    await setting(missedOrder.id, "INSTALMENTS", { cycle: "MONTHLY", billFrom: later(-100) });
    const check = await billingCheck();
    ok("Billing check lists the parts missed, oldest first", (check?.missed.find((o) => o.id === missedOrder.id)?.parts.length ?? 0) >= 3, check?.missed.find((o) => o.id === missedOrder.id)?.parts.map((p) => p.start).join(", "));
    ok("a running order with nothing switched on and nothing invoiced is listed", check?.notSet.some((o) => o.id === unbilled.id && o.why === "not-invoiced") === true);
    ok("...one in parts with no price is held up, and says why", check?.heldUp.some((o) => o.id === noPrice.id && o.why === "no price") === true);
    ok("...one in parts with all it needs is in neither", !check?.notSet.some((o) => o.id === fine.id) && !check?.heldUp.some((o) => o.id === fine.id));
    ok("...ended ones aren't checked", !check?.notSet.some((o) => o.id === parts.id) && !check?.heldUp.some((o) => o.id === parts.id));
    const juneWaiting = check?.waiting?.find((w) => w.id === raised[0]!.documentId);
    ok("the June draft is waiting, five days old", juneWaiting?.days === 5, juneWaiting?.days);
    const listed = await listRenewalsPaged({ search: TAG, page: 1, pageSize: 100 });
    const billOf = (id: string) => listed.rows.find((r) => r.id === id)?.nextBill?.what;
    ok("on the renewals list, Next bill: a part for one in parts", billOf(fine.id)?.startsWith("Part ") === true, billOf(fine.id));
    ok("...Not set for one switched off, Held up for one with a gap", billOf(unbilled.id) === "Not set" && billOf(noPrice.id) === "Held up", `${billOf(unbilled.id)}, ${billOf(noPrice.id)}`);
    const page = renderToStaticMarkup(await BillingCheckPage());
    ok("the page names its lists", page.includes("Nothing set to bill") && page.includes("Held up") && page.includes("Missed parts") && page.includes("Drafts waiting to be issued"), page.slice(0, 120));
    ok("...and the order held up for want of a price", page.includes("No price"));

    section("The switch on the order page");
    actorId = rep.id;
    const view = await actions.recurringBillingFor(parts.id);
    ok("the order shows its setting and the parts raised", view?.setting?.mode === "INSTALMENTS" && view.raised.length === 3, view?.raised.length);
    ok("...the deleted one as skipped", view?.raised.find((r) => r.start === "2001-07-01")?.documentId === null);
    ok("...and the rep may change it", view?.canManage === true);
    // The card as the order page draws it — nobody signs in to look, so the HTML is the proof.
    const html = view ? renderToStaticMarkup(createElement(RecurringBillingCard, { view })) : "";
    ok("the card says how it bills", html.includes("Billed monthly from 2001-06-01"), html.slice(0, 120));
    ok("...offers the choice to whoever may change it, keeping on renewing among it", html.includes("The term in parts") && html.includes("The whole term, when it renews") && html.includes("Keep renewing on this plan"));
    ok("...links each part's draft, and marks the skipped one", html.includes("/documents/") && html.includes("skipped — its draft was deleted"));
    const offTerm = await actions.setRecurringBilling(parts.id, { mode: "INSTALMENTS", cycle: "MONTHLY", billFrom: "2003-01-01" });
    ok("starting outside the term is refused", !offTerm.ok && offTerm.error.includes("inside the term"), offTerm.ok ? "it saved" : offTerm.error);
    const quarterly = await actions.setRecurringBilling(parts.id, { mode: "INSTALMENTS", cycle: "QUARTERLY", billFrom: "2001-10-01" });
    ok("switching to quarterly from 1 October saves", quarterly.ok, quarterly.ok ? "" : quarterly.error);
    const halfYear = await actions.setRecurringBilling(parts.id, { mode: "INSTALMENTS", cycle: "HALF_YEARLY", billFrom: "2001-10-01", keepRenewing: true });
    const halfRow = await db.recurringBilling.findUnique({ where: { companyProductId: parts.id } });
    ok("half-yearly, keeping on renewing, saves", halfYear.ok && halfRow?.cycle === "HALF_YEARLY" && halfRow.keepRenewing === true, halfYear.ok ? "" : halfYear.error);
    const off = await actions.setRecurringBilling(parts.id, null);
    ok("switching it off removes the setting, and keeps what it raised", off.ok && (await db.recurringBilling.count({ where: { companyProductId: parts.id } })) === 0 && (await db.recurringBillingPeriod.count({ where: { companyProductId: parts.id } })) === 3);
    const laptop = await order({ start: "2001-04-01", end: "2002-03-31", price: 50000, quantity: 1, itemId: goods.id });
    ok("a laptop doesn't recur: no card", (await actions.recurringBillingFor(laptop.id)) === null);
    const refused = await actions.setRecurringBilling(laptop.id, { mode: "AUTO_RENEW" });
    ok("...and can't be switched on", !refused.ok);
    await db.userPermission.updateMany({ where: { userId: rep.id, permission: { in: ISSUE } }, data: { allowed: false } });
    const noIssue = await actions.setRecurringBilling(renews.id, null);
    ok("without \"Create tax invoices\", nobody changes it", !noIssue.ok && noIssue.error.includes("Create tax invoices"), noIssue.ok ? "it saved" : noIssue.error);
  } finally {
    await cleanup();
    const left = (await db.user.count({ where: { email: { endsWith: MAIL } } })) + (await db.company.count({ where: { name: { startsWith: TAG } } }));
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll recurring-billing checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
