/**
 * check:audit-round3-operations — the security audit's round three (docs/reports/security-audit-2026-11-11.md §12), the
 * stock, orders and operations-approval fixes, each shown to hold the way it was broken: by calling the server's own
 * code, as a hand-made request would.
 *
 *   R3-15  a rejected (or waiting) order counts toward no target, scorecard or top performer; cancelling a counted
 *          order holds the incentives it fed for review
 *   R3-16  stock leaves only with four eyes: the item page, a purchase return, a posted receipt cancelled; a goods
 *          receipt is held to its purchase order's lines, quantities and price; stock can't move in a closed period
 *   R3-17  an order with a live invoice isn't cancelled (its own drafts go with it); a quote is never billed past 100%
 *          by a double click or through a proforma; project stages are capped; a billed cycle stays; a vendor credit
 *          settles only its own rebates
 *   R3-18  no operations approval while viewing as somebody else; no self-award, own target or self-activated reseller;
 *          repeating tasks don't farm XP
 *
 * A fixture of its own in the local database, tagged ZZR3O, removed in a finally; the two workspace settings it turns
 * (adjustment approval, the books' closing date) are put back as they were. Assertions are about the fixture only.
 *
 *   npx tsx scripts/check-audit-round3-operations.ts
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";

const TAG = "ZZR3O";
const RUN = Date.now().toString(36);
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "" : (r.error ?? ""));
/** Runs one part; a part that throws is a failure, and the rest still run. */
async function part(title: string, fn: () => Promise<void>) {
  section(title);
  try {
    await fn();
  } catch (err) {
    ok(`${title} ran to the end`, false, err instanceof Error ? `${err.message}`.slice(0, 400) : String(err));
  }
}

const VIEW_AS = "ZZR3O: you're viewing as someone else.";
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
let actorId = "";
let viewingAs = false;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return {
      requireUser: user,
      currentUser: user,
      viewAsContext: async () => (viewingAs ? { realUserId: actorId, viewedUserId: actorId } : null),
      refuseWhileViewingAs: async () => (viewingAs ? VIEW_AS : null),
    };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

async function cleanup() {
  const users = (await db.user.findMany({ where: { email: { endsWith: "@zzr3o.invalid" } }, select: { id: true } })).map((u) => u.id);
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const items = (await db.item.findMany({ where: { sku: { startsWith: TAG } }, select: { id: true } })).map((i) => i.id);
  const orders = (await db.companyProduct.findMany({ where: { OR: [{ itemId: { in: items } }, { companyId: { in: companies } }] }, select: { id: true } })).map((o) => o.id);
  const docs = (await db.tradeDocument.findMany({ where: { OR: [{ companyId: { in: companies } }, { docNumber: { startsWith: `${TAG}/` } }] }, select: { id: true } })).map((d) => d.id);
  const stockDocs = (await db.stockDocument.findMany({ where: { OR: [{ number: { startsWith: TAG } }, { companyId: { in: companies } }] }, select: { id: true } })).map((d) => d.id);
  const tasks = (await db.task.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((t) => t.id);
  const projects = (await db.project.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } })).map((p) => p.id);
  const earnings = (await db.incentiveEarning.findMany({ where: { OR: [{ label: { startsWith: TAG } }, { userId: { in: users } }] }, select: { id: true } })).map((e) => e.id);
  const targets = (await db.target.findMany({ where: { label: { startsWith: TAG } }, select: { id: true } })).map((t) => t.id);
  const credits = (await db.vendorCredit.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const profiles = (await db.resellerProfile.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((p) => p.id);
  const records = [...users, ...companies, ...items, ...orders, ...docs, ...stockDocs, ...tasks, ...projects, ...earnings, ...targets, ...credits, ...profiles];

  await db.automationEvent.deleteMany({ where: { recordId: { in: records } } });
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: records } }, { userId: { in: users } }] } });
  await db.approvalEvent.deleteMany({ where: { OR: [{ recordId: { in: records } }, { requestedById: { in: users } }] } });
  await db.notification.deleteMany({ where: { userId: { in: users } } });
  await db.rebateAllocation.deleteMany({ where: { vendorCreditId: { in: credits } } });
  await db.vendorCredit.deleteMany({ where: { id: { in: credits } } });
  await db.incentiveEarning.deleteMany({ where: { id: { in: earnings } } });
  await db.target.deleteMany({ where: { id: { in: targets } } });
  await db.task.updateMany({ where: { id: { in: tasks } }, data: { repeatedFromId: null } });
  await db.task.deleteMany({ where: { id: { in: tasks } } });
  await db.project.deleteMany({ where: { id: { in: projects } } });
  await db.stockMovement.deleteMany({ where: { stockDocumentId: { in: stockDocs } } });
  await db.stockDocument.deleteMany({ where: { id: { in: stockDocs } } });
  await db.warehouse.deleteMany({ where: { code: { startsWith: TAG } } });
  await db.quoteBillingStage.deleteMany({ where: { documentId: { in: docs } } });
  await db.recurringBillingPeriod.deleteMany({ where: { companyProductId: { in: orders } } });
  await db.recurringBilling.deleteMany({ where: { companyProductId: { in: orders } } });
  await db.journalEntry.deleteMany({ where: { reversesId: { not: null }, documentId: { in: docs } } });
  await db.journalEntry.deleteMany({ where: { documentId: { in: docs } } });
  await db.tradeDocumentLine.updateMany({ where: { companyProductId: { in: orders } }, data: { companyProductId: null } });
  await db.tradeDocument.updateMany({ where: { id: { in: docs } }, data: { sourceDocumentId: null, againstDocumentId: null } });
  await db.tradeDocument.deleteMany({ where: { id: { in: docs } } });
  await db.companyProduct.deleteMany({ where: { id: { in: orders } } });
  await db.item.deleteMany({ where: { id: { in: items } } });
  await db.resellerProfile.deleteMany({ where: { id: { in: profiles } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.userPermission.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
}

async function main() {
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;

  const orderActions = await import("../src/actions/order");
  const inventory = await import("../src/actions/inventory");
  const itemActions = await import("../src/actions/item");
  const incentive = await import("../src/actions/incentive");
  const targetActions = await import("../src/actions/target");
  const progress = await import("../src/actions/progress-billing");
  const trade = await import("../src/actions/trade-document");
  const projectActions = await import("../src/actions/project");
  const recurring = await import("../src/actions/recurring-billing");
  const reseller = await import("../src/actions/reseller");
  const vendorCredit = await import("../src/actions/vendor-credit");
  const { ordersByType } = await import("../src/lib/targets/measure");
  const { bookingsByPerson } = await import("../src/lib/wins/detect");
  const { billingProgress } = await import("../src/lib/documents/progress-billing");
  const { needsApproval } = await import("../src/lib/inventory/stock-documents");
  const { moveStock } = await import("../src/lib/inventory/engine");
  const { accountsSettings } = await import("../src/lib/accounts/settings");
  const { earnsXp } = await import("../src/lib/tasks/rules");
  const { moveTask } = await import("../src/lib/tasks/server");
  const { workspaceClock } = await import("../src/lib/time/workspace");

  await cleanup();
  const settingsRow = await db.accountsSettings.findUnique({ where: { id: "global" }, select: { adjustmentApprovalRequired: true } });
  const lockRow = await db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  try {
    const clock = await workspaceClock();
    const today = clock.today();
    const todayDay = new Date(`${today}T00:00:00.000Z`);
    const now = new Date();
    const rep = await db.user.create({ data: { name: "ZZ R3O Rep", email: `rep-${RUN}@zzr3o.invalid`, passwordHash: "!", role: "SALES" }, select: { id: true } });
    const customer = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, createdById: admin.id }, select: { id: true } });
    const site = await db.companyLocation.create({ data: { companyId: customer.id, label: "HO", isPrimary: true }, select: { id: true } });
    const vendorA = await db.company.create({ data: { name: `${TAG} Vendor A`, normalizedName: `${TAG.toLowerCase()} vendor a`, relationshipType: "VENDOR", createdById: admin.id }, select: { id: true } });
    const vendorB = await db.company.create({ data: { name: `${TAG} Vendor B`, normalizedName: `${TAG.toLowerCase()} vendor b`, relationshipType: "VENDOR", createdById: admin.id }, select: { id: true } });
    const service = await db.item.create({ data: { name: `${TAG} Service`, sku: `${TAG}-${RUN}-SVC`, type: "SERVICE", sellingPrice: 1000, taxRatePercent: 18, createdById: admin.id }, select: { id: true } });
    const good = await db.item.create({ data: { name: `${TAG} Widget`, sku: `${TAG}-${RUN}-GOOD`, type: "GOOD", sellingPrice: 150, taxRatePercent: 18, trackInventory: true, createdById: admin.id }, select: { id: true } });
    const branchId = (await db.branch.findFirst({ where: { isHeadOffice: true }, select: { id: true } }))?.id ?? null;
    const order = (data: Record<string, unknown>) =>
      db.companyProduct.create({
        data: { companyId: customer.id, locationId: site.id, itemId: service.id, addedByUserId: rep.id, quantity: 1, ...data } as Parameters<typeof db.companyProduct.create>[0]["data"],
        select: { id: true },
      });
    const doc = (n: string, data: Record<string, unknown>) =>
      db.tradeDocument.create({
        data: { docNumber: `${TAG}/${RUN}/${n}`, direction: "SALES", status: "ISSUED", companyId: customer.id, createdById: admin.id, issueDate: todayDay, branchId, ...data } as Parameters<typeof db.tradeDocument.create>[0]["data"],
        select: { id: true },
      });
    const line = (extra: Record<string, unknown> = {}) => ({ name: "Line", quantity: 1, unitPrice: 1000, taxableValue: 1000, lineTotal: 1000, ...extra });
    // Adjustment approval on, for the four-eyes parts.
    await db.accountsSettings.update({ where: { id: "global" }, data: { adjustmentApprovalRequired: true } }).catch(() => null);

    // ── R3-15 ──
    await part("R3-15: rejected orders in targets and wins", async () => {
      await order({ unitPrice: 1000, orderStatus: "APPROVED", bookedAt: now });
      await order({ unitPrice: 5000, orderStatus: "REJECTED", bookedAt: now });
      await order({ unitPrice: 7000, orderStatus: "PENDING_APPROVAL", bookedAt: now });
      const split = (await ordersByType(db, { from: todayDay, to: todayDay, userIds: [rep.id] })).get(rep.id);
      ok("a rejected order adds nothing to the scorecard's new business (only the approved 1,000)", split?.new.value === 1000, split);
      const people = await bookingsByPerson(clock.startOfDay(today)!, clock.endOfDay(today)!);
      ok("  nor to the top performer's bookings", people.find((p) => p.userId === rep.id)?.value === 1000, people.find((p) => p.userId === rep.id));
    });

    // ── R3-17 / R3-15: cancelling an order ──
    await part("R3-17: cancelling an order with invoices", async () => {
      const billed = await order({ unitPrice: 2000, orderStatus: "APPROVED", bookedAt: now });
      const invoice = await doc("INV-1", { docType: "INVOICE", total: 2000, taxableValue: 2000, lines: { create: [line({ companyProductId: billed.id })] } });
      const earning = await db.incentiveEarning.create({
        data: { userId: rep.id, metric: "ORDER_VALUE", fromDate: todayDay, toDate: todayDay, label: `${TAG} month`, amount: 500, workings: TAG, status: "APPROVED", createdById: admin.id },
        select: { id: true },
      });
      const refused = await orderActions.cancelOrder(billed.id, `${TAG} customer backed out`);
      ok("an order its issued invoice bills can't be cancelled — credit note or cancel the invoice first", /credit note/.test(errorOf(refused)), refused);
      ok("  it stays approved", (await db.companyProduct.findUnique({ where: { id: billed.id }, select: { orderStatus: true } }))?.orderStatus === "APPROVED");
      await db.tradeDocument.update({ where: { id: invoice.id }, data: { status: "CANCELLED" } });
      const allowed = await orderActions.cancelOrder(billed.id, `${TAG} customer backed out`);
      ok("  once the invoice is cancelled, it can be", allowed.ok, allowed);
      const held = await db.incentiveEarning.findUnique({ where: { id: earning.id }, select: { status: true, heldReason: true } });
      ok("R3-15: the approved incentive it counted toward is held for review, with the reason", held?.status === "HELD" && /cancelled/.test(held.heldReason ?? ""), held);

      const drafted = await order({ unitPrice: 3000, orderStatus: "APPROVED", bookedAt: now });
      const draft = await doc("INV-2", { docType: "INVOICE", status: "DRAFT", total: 3000, taxableValue: 3000, lines: { create: [line({ companyProductId: drafted.id })] } });
      const withDraft = await orderActions.cancelOrder(drafted.id, `${TAG} not needed`);
      const draftAfter = await db.tradeDocument.findUnique({ where: { id: draft.id }, select: { status: true } });
      ok("an order whose only invoice is its own draft is cancelled, and the draft with it", withDraft.ok && draftAfter?.status === "CANCELLED", { withDraft, draftAfter });

      const shared = await order({ unitPrice: 100, orderStatus: "APPROVED", bookedAt: now });
      const other = await order({ unitPrice: 100, orderStatus: "APPROVED", bookedAt: now });
      await doc("INV-3", { docType: "INVOICE", status: "DRAFT", total: 200, lines: { create: [line({ companyProductId: shared.id }), line({ companyProductId: other.id })] } });
      const sharedRefused = await orderActions.cancelOrder(shared.id, `${TAG} not needed`);
      ok("  a draft that also bills another order stops the cancel instead of taking that order's line", /also bills other orders/.test(errorOf(sharedRefused)), sharedRefused);
    });

    // ── R3-17: progress billing ──
    await part("R3-17: billing a quote in stages", async () => {
      const quote = await doc("QT-1", { docType: "PROPOSAL", total: 1000, taxableValue: 1000, lines: { create: [line({ itemId: service.id })] } });
      const proforma = await doc("PF-1", { docType: "PROFORMA", total: 1000, taxableValue: 1000, sourceDocumentId: quote.id, lines: { create: [line()] } });
      await doc("INV-PF", { docType: "INVOICE", total: 1000, taxableValue: 1000, sourceDocumentId: proforma.id, lines: { create: [line()] } });
      const seen = await billingProgress(quote.id);
      ok("an invoice reached through a proforma counts as the quote's billing", seen?.billedPercent === 100, seen);

      const staged = await doc("QT-2", { docType: "PROPOSAL", total: 1000, taxableValue: 1000, lines: { create: [line({ itemId: service.id })] } });
      await db.quoteBillingStage.create({ data: { documentId: staged.id, label: "Advance", percent: 30 } });
      const toProforma = await trade.convertTradeDocument({ id: staged.id, target: "PROFORMA" });
      ok("a quote billed in stages isn't made a proforma (the way round its stages)", /billed in stages/.test(errorOf(toProforma)), toProforma);
      const stagedProforma = await doc("PF-2", { docType: "PROFORMA", total: 1000, taxableValue: 1000, sourceDocumentId: staged.id, lines: { create: [line()] } });
      const toInvoice = await trade.convertTradeDocument({ id: stagedProforma.id, target: "INVOICE" });
      ok("  nor a proforma made from one an invoice", /billed in stages|billed already/.test(errorOf(toInvoice)), toInvoice);

      const raced = await doc("QT-3", { docType: "PROPOSAL", total: 1180, taxableValue: 1000, locationId: site.id, placeOfSupplyCode: "07", gstTreatment: "UNREGISTERED", lines: { create: [line({ itemId: service.id, taxRatePercent: 18 })] } });
      const stage = await db.quoteBillingStage.create({ data: { documentId: raced.id, label: "Advance", percent: 60 }, select: { id: true } });
      const [a, b] = await Promise.all([progress.invoiceBillingStage(stage.id), progress.invoiceBillingStage(stage.id)]);
      const live = await db.tradeDocument.count({ where: { sourceDocumentId: raced.id, docType: "INVOICE", status: { not: "CANCELLED" } } });
      if (!a.ok && !b.ok) {
        ok("a stage invoiced (the fixture could raise an invoice here)", false, { a, b });
      } else {
        ok("one stage double-clicked raises one live invoice", [a, b].filter((r) => r.ok).length === 1 && live === 1, { a: errorOf(a), b: errorOf(b), live });
        const [c, d] = await Promise.all([
          progress.invoiceQuoteShare(raced.id, { percent: 30 }),
          progress.invoiceQuoteShare(raced.id, { percent: 30 }),
        ]);
        const after = await billingProgress(raced.id);
        ok("  two shares at once never take the quote past 100%", [c, d].filter((r) => r.ok).length === 1 && (after?.billedPercent ?? 999) <= 100.01, { c: errorOf(c), d: errorOf(d), billed: after?.billedPercent });
      }
    });

    // ── R3-18: view-as ──
    await part("R3-18: operations approvals while viewing as somebody else", async () => {
      const pending = await order({ unitPrice: 900, orderStatus: "PENDING_APPROVAL" });
      const raised = await order({ unitPrice: 900, orderStatus: "APPROVED", bookedAt: now, pendingPurchasePrice: 950, priceIncreaseReason: "vendor raised it", priceReviewRequestedAt: now, priceReviewRequestedById: rep.id, pendingVendorId: vendorA.id });
      const wh = await db.warehouse.create({ data: { code: `${TAG}-WH0`, name: `${TAG} Store 0` }, select: { id: true } });
      const waiting = await db.stockDocument.create({
        data: { type: "ADJUSTMENT", number: `${TAG}/${RUN}/ADJ`, date: todayDay, warehouseId: wh.id, reason: TAG, status: "PENDING_APPROVAL", createdById: rep.id, submittedById: rep.id },
        select: { id: true },
      });
      const due = await db.incentiveEarning.create({
        data: { userId: rep.id, fromDate: todayDay, toDate: todayDay, label: `${TAG} due`, amount: 100, workings: TAG, status: "DUE", createdById: admin.id },
        select: { id: true },
      });
      viewingAs = true;
      try {
        const results = {
          approveOrder: await orderActions.approveOrder({ orderId: pending.id, approved: true }),
          approveOrderLoss: await orderActions.approveOrderLoss({ orderId: raised.id, note: "ok" }),
          acceptPriceIncrease: await orderActions.acceptPriceIncrease(raised.id),
          sendBackPriceIncrease: await orderActions.sendBackPriceIncrease(raised.id, "cheaper elsewhere"),
          approveStockDocument: await inventory.approveStockDocument(waiting.id),
          returnStockDocument: await inventory.returnStockDocument(waiting.id, "no"),
          decideEarning: await incentive.decideEarning({ id: due.id, decision: "APPROVE" }),
          awardOneOff: await incentive.awardOneOff({ userId: rep.id, amount: 100, label: `${TAG} spot`, reason: "help" }),
          saveTarget: await targetActions.saveTarget({ metric: "ORDER_VALUE", period: "MONTH", fromDate: today, toDate: today, label: `${TAG} t`, scope: "USER", userId: rep.id, value: 100 }),
        };
        for (const [name, r] of Object.entries(results)) ok(`${name} is refused while viewing as`, errorOf(r) === VIEW_AS, r);
      } finally {
        viewingAs = false;
      }
      ok("  and nothing was decided", (await db.companyProduct.findUnique({ where: { id: pending.id }, select: { orderStatus: true } }))?.orderStatus === "PENDING_APPROVAL" &&
        (await db.stockDocument.findUnique({ where: { id: waiting.id }, select: { status: true } }))?.status === "PENDING_APPROVAL" &&
        (await db.incentiveEarning.findUnique({ where: { id: due.id }, select: { status: true } }))?.status === "DUE");
    });

    await part("R3-18: awards and targets of your own", async () => {
      const self = await incentive.awardOneOff({ userId: admin.id, amount: 100, label: `${TAG} me`, reason: "me" });
      ok("you can't award yourself an incentive", /award yourself/.test(errorOf(self)), self);
      const award = await incentive.awardOneOff({ userId: rep.id, amount: 100, label: `${TAG} spot`, reason: "help" });
      ok("  you can award somebody else", award.ok, award);
      if (award.ok) {
        const approve = await incentive.decideEarning({ id: award.data.id, decision: "APPROVE" });
        ok("  but not approve the award you made", /You awarded this/.test(errorOf(approve)), approve);
      }
      const own = await targetActions.saveTarget({ metric: "ORDER_VALUE", period: "MONTH", fromDate: today, toDate: today, label: `${TAG} mine`, scope: "USER", userId: admin.id, value: 1 });
      ok("you can't set your own target", /your own target/.test(errorOf(own)), own);
      const mine = await db.target.create({ data: { metric: "ORDER_VALUE", period: "MONTH", fromDate: todayDay, toDate: todayDay, label: `${TAG} set for me`, scope: "USER", userId: admin.id, value: 1000000, createdById: rep.id }, select: { id: true } });
      const lowered = await targetActions.saveTarget({ id: mine.id, metric: "ORDER_VALUE", period: "MONTH", fromDate: today, toDate: today, label: `${TAG} set for me`, scope: "USER", userId: rep.id, value: 1 });
      ok("  nor change one set for you (handing it to somebody else included)", /your own target/.test(errorOf(lowered)), lowered);
      const withdrawn = await targetActions.retireTarget(mine.id);
      ok("  nor withdraw it", /your own target/.test(errorOf(withdrawn)), withdrawn);
      const theirs = await targetActions.saveTarget({ metric: "ORDER_VALUE", period: "MONTH", fromDate: today, toDate: today, label: `${TAG} rep`, scope: "USER", userId: rep.id, value: 100 });
      ok("  a colleague's target still saves", theirs.ok, theirs);
    });

    // ── R3-16: stock ──
    await part("R3-16: stock out without four eyes", async () => {
      const settings = await accountsSettings();
      if (!settings.migrated || !settings.adjustmentApprovalRequired) {
        ok("this workspace's inventory is set up with adjustment approval on", false, { migrated: settings.migrated, approval: settings.adjustmentApprovalRequired });
        return;
      }
      const damaged = await itemActions.adjustStock({ itemId: good.id, type: "DAMAGED", quantity: 1, reason: TAG, requestId: `${TAG}-${RUN}-1` });
      ok("the item page can't write stock off while adjustments need approval", /Stock › Adjustments/.test(errorOf(damaged)), damaged);
      const corrected = await itemActions.adjustStock({ itemId: good.id, type: "ADJUSTMENT", direction: "IN", quantity: 1, reason: TAG, requestId: `${TAG}-${RUN}-2` });
      ok("  nor correct it either way", /Stock › Adjustments/.test(errorOf(corrected)), corrected);
      ok("a purchase return waits for approval like an adjustment", needsApproval("PURCHASE_RETURN", { adjustmentApprovalRequired: true }) && !needsApproval("PURCHASE_RETURN", { adjustmentApprovalRequired: false }));

      const wh = await db.warehouse.create({ data: { code: `${TAG}-WH1`, name: `${TAG} Store 1` }, select: { id: true } });
      const ret = await db.stockDocument.create({
        data: { type: "PURCHASE_RETURN", number: `${TAG}/${RUN}/PR`, date: todayDay, warehouseId: wh.id, companyId: vendorA.id, reason: TAG, createdById: rep.id, lines: { create: [{ itemId: good.id, quantity: 1 }] } },
        select: { id: true },
      });
      const posted = await inventory.postStockDocument(ret.id);
      ok("  posting one straight away is refused", /needs approving/.test(errorOf(posted)), posted);

      const grn = await db.stockDocument.create({
        data: { type: "GRN", number: `${TAG}/${RUN}/GRN`, date: todayDay, warehouseId: wh.id, companyId: vendorA.id, status: "POSTED", createdById: admin.id, postedById: admin.id, postedAt: now },
        select: { id: true },
      });
      const cancelOwn = await inventory.cancelStockDocument(grn.id, "wrong vendor");
      ok("cancelling a posted receipt you raised is refused — somebody else reverses it", /somebody else has to reverse it/.test(errorOf(cancelOwn)), cancelOwn);
      ok("  and it stays posted", (await db.stockDocument.findUnique({ where: { id: grn.id }, select: { status: true } }))?.status === "POSTED");
      viewingAs = true;
      const cancelViewing = await inventory.cancelStockDocument(grn.id, "wrong vendor");
      viewingAs = false;
      ok("  nor while viewing as somebody else", errorOf(cancelViewing) === VIEW_AS, cancelViewing);
    });

    await part("R3-16: a goods receipt against its purchase order", async () => {
      const settings = await accountsSettings();
      if (!settings.migrated) return ok("inventory is set up here", false);
      const wh = await db.warehouse.create({ data: { code: `${TAG}-WH2`, name: `${TAG} Store 2` }, select: { id: true } });
      const po = await db.tradeDocument.create({
        data: {
          docNumber: `${TAG}/${RUN}/PO`, docType: "PURCHASE_ORDER", direction: "PURCHASE", status: "ISSUED", companyId: vendorA.id, createdById: admin.id, issueDate: todayDay, branchId,
          lines: { create: [{ itemId: good.id, name: "Widget", quantity: 5, unitPrice: 100, taxableValue: 500, lineTotal: 590 }] },
        },
        select: { id: true, lines: { select: { id: true } } },
      });
      const poLineId = po.lines[0].id;
      const otherPo = await db.tradeDocument.create({
        data: { docNumber: `${TAG}/${RUN}/PO2`, docType: "PURCHASE_ORDER", direction: "PURCHASE", status: "ISSUED", companyId: vendorA.id, createdById: admin.id, issueDate: todayDay, branchId, lines: { create: [{ itemId: good.id, name: "Widget", quantity: 50, unitPrice: 1, taxableValue: 50, lineTotal: 59 }] } },
        select: { lines: { select: { id: true } } },
      });
      const receipt = (lines: Record<string, unknown>[]) =>
        inventory.saveStockDocument({ type: "GRN", date: today, warehouseId: wh.id, purchaseOrderId: po.id, lines } as Parameters<typeof inventory.saveStockDocument>[0]);
      const foreign = await receipt([{ itemId: good.id, quantity: 1, poLineId: otherPo.lines[0].id }]);
      ok("a line from another purchase order is refused", /only that order's lines/.test(errorOf(foreign)), foreign);
      const loose = await receipt([{ itemId: good.id, quantity: 1 }]);
      ok("  as is a line not on the order at all", /only that order's lines/.test(errorOf(loose)), loose);
      const swapped = await receipt([{ itemId: service.id, quantity: 1, poLineId }]);
      ok("  and a different item on the order's line", !swapped.ok, swapped);
      const over = await receipt([{ itemId: good.id, quantity: 6, poLineId }]);
      ok("more than was ordered is refused", /at most 5 more/.test(errorOf(over)), over);
      await db.stockDocument.create({
        data: { type: "GRN", number: `${TAG}/${RUN}/GRN-EARLIER`, date: todayDay, warehouseId: wh.id, companyId: vendorA.id, purchaseOrderId: po.id, status: "POSTED", createdById: rep.id, lines: { create: [{ itemId: good.id, quantity: 4, poLineId, unitCost: 100 }] } },
      });
      const rest = await receipt([{ itemId: good.id, quantity: 2, poLineId }]);
      ok("  counting what earlier receipts accepted (4 of 5 in, 2 more refused)", /at most 1 more/.test(errorOf(rest)), rest);
      const fits = await receipt([{ itemId: good.id, quantity: 1, poLineId }]);
      const saved = fits.ok ? await db.stockDocumentLine.findFirst({ where: { stockDocumentId: fits.data.id }, select: { unitCost: true } }) : null;
      ok("what's left is accepted, at the order's price when no cost is given", fits.ok && Number(saved?.unitCost) === 100, { fits, saved });
    });

    await part("R3-16: stock in a closed period", async () => {
      const settings = await accountsSettings();
      if (!settings.migrated) return ok("inventory is set up here", false);
      const wh = await db.warehouse.create({ data: { code: `${TAG}-WH3`, name: `${TAG} Store 3` }, select: { id: true } });
      const closedUntil = new Date("2000-12-31T00:00:00.000Z");
      if (!lockRow) await db.ledgerLock.create({ data: { id: "global", lockedUntil: closedUntil } });
      else if (!lockRow.lockedUntil || lockRow.lockedUntil < closedUntil) await db.ledgerLock.update({ where: { id: "global" }, data: { lockedUntil: closedUntil } });
      let thrown = "";
      try {
        await db.$transaction((tx) =>
          moveStock(tx, { itemId: good.id, warehouseId: wh.id, quantity: 5, type: "RECEIVED", sourceType: "MANUAL", date: new Date("2000-06-01T00:00:00.000Z"), userId: admin.id, reason: TAG, idempotencyKey: `${TAG}:${RUN}:closed`, settings }),
        );
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      ok("a movement dated in a closed period is refused, under periodic and perpetual alike", /books are closed/.test(thrown), thrown);
      ok("  and nothing moved", (await db.stockMovement.count({ where: { idempotencyKey: `${TAG}:${RUN}:closed` } })) === 0);
    });

    // ── R3-18 (low): tasks ──
    await part("R3-18: repeating tasks and XP", async () => {
      const tomorrow = new Date(Date.UTC(todayDay.getUTCFullYear(), todayDay.getUTCMonth(), todayDay.getUTCDate() + 1)).toISOString().slice(0, 10);
      ok("a daily occurrence due tomorrow earns nothing today", !earnsXp({ xp: 10, assignedToUserId: "u", dueDate: tomorrow, repeat: "DAILY", repeatedFromId: "t" }, today));
      ok("  one due today does", earnsXp({ xp: 10, assignedToUserId: "u", dueDate: today, repeat: "DAILY", repeatedFromId: "t" }, today));
      ok("  a weekly one finished early in its own week still does", earnsXp({ xp: 10, assignedToUserId: "u", dueDate: "2026-11-20", repeat: "WEEKLY" }, "2026-11-16"));
      ok("  a one-off task due next week, finished early, still does", earnsXp({ xp: 10, assignedToUserId: "u", dueDate: "2026-11-20" }, "2026-11-16"));
      const first = await db.task.create({ data: { title: `${TAG} daily`, createdByUserId: admin.id, assignedToUserId: rep.id, xp: 10, xpSetById: admin.id, repeat: "DAILY", dueDate: todayDay }, select: { id: true } });
      const done = await moveTask(first.id, "DONE");
      const firstRow = await db.task.findUnique({ where: { id: first.id }, select: { xpEarned: true } });
      ok("today's occurrence earns its XP", firstRow?.xpEarned === 10, firstRow);
      if (done?.nextTaskId) {
        await moveTask(done.nextTaskId, "DONE");
        const next = await db.task.findUnique({ where: { id: done.nextTaskId }, select: { xpEarned: true, done: true } });
        ok("  ticking off tomorrow's at once earns nothing (the farm)", next?.done === true && next.xpEarned === null, next);
      } else ok("  the next occurrence was made", false, done);
      const sibling = await db.task.create({ data: { title: `${TAG} daily again`, createdByUserId: admin.id, assignedToUserId: rep.id, xp: 10, xpSetById: admin.id, repeat: "DAILY", startDate: todayDay, repeatedFromId: first.id }, select: { id: true } });
      await moveTask(sibling.id, "DONE");
      ok("  and a chain earns once a day — another occurrence open today, after one earned, earns nothing", (await db.task.findUnique({ where: { id: sibling.id }, select: { xpEarned: true } }))?.xpEarned === null);
    });

    // ── R3-17 (low): project stages ──
    await part("R3-17: project billing stages", async () => {
      const project = await db.project.create({ data: { code: `${TAG}-${RUN}`, name: `${TAG} rollout`, companyId: customer.id, createdById: admin.id, value: 1000 }, select: { id: true } });
      const first = await projectActions.saveBillingMilestone({ projectId: project.id, label: "Advance", amount: "600" });
      ok("a stage within the project's value saves", first.ok, first);
      const over = await projectActions.saveBillingMilestone({ projectId: project.id, label: "Balance", amount: "600" });
      ok("stages together can't pass the project's value", /more than the project's value/.test(errorOf(over)), over);
      const rest = await projectActions.saveBillingMilestone({ projectId: project.id, label: "Balance", amount: "400" });
      ok("  the rest of it can", rest.ok, rest);
      const stage = await db.projectBillingMilestone.findFirst({ where: { projectId: project.id, label: "Advance" }, select: { id: true } });
      const unrelated = await doc("INV-PRJ", { docType: "INVOICE", total: 600, lines: { create: [line()] } });
      const linked = await projectActions.saveBillingMilestone({ id: stage!.id, projectId: project.id, label: "Advance", amount: "600", documentId: unrelated.id });
      ok("a stage can't be pointed at an invoice that wasn't raised from it", /raised from it/.test(errorOf(linked)), linked);
    });

    // ── R3-17 (low): recurring billing ──
    await part("R3-17: recurring billing once a period is billed", async () => {
      const sub = await db.item.create({ data: { name: `${TAG} Subscription`, sku: `${TAG}-${RUN}-SUB`, type: "SUBSCRIPTION", sellingPrice: 12000, taxRatePercent: 18, createdById: admin.id }, select: { id: true } });
      const start = new Date(Date.UTC(todayDay.getUTCFullYear(), todayDay.getUTCMonth(), 1));
      const end = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), 0));
      const o = await order({ itemId: sub.id, unitPrice: 12000, orderStatus: "APPROVED", bookedAt: now, startDate: start, endDate: end });
      const startKey = start.toISOString().slice(0, 10);
      await db.recurringBilling.create({ data: { companyProductId: o.id, mode: "INSTALMENTS", cycle: "MONTHLY", billFrom: start, setById: admin.id } });
      await db.recurringBillingPeriod.create({ data: { companyProductId: o.id, periodStart: start, periodEnd: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)) } });
      const changed = await recurring.setRecurringBilling(o.id, { mode: "INSTALMENTS", cycle: "QUARTERLY", billFrom: startKey });
      ok("a new cycle can't start inside a period already billed (it would bill it again)", /billed up to/.test(errorOf(changed)), changed);
      const nextMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
      const after = await recurring.setRecurringBilling(o.id, { mode: "INSTALMENTS", cycle: "QUARTERLY", billFrom: nextMonth });
      ok("  one starting after it can", after.ok, after);
      const same = await recurring.setRecurringBilling(o.id, { mode: "INSTALMENTS", cycle: "QUARTERLY", billFrom: nextMonth });
      ok("  saving it as it is still works", same.ok, same);
    });

    // ── R3-18 (low): resellers ──
    await part("R3-18: a reseller's approval and activation", async () => {
      const r = await db.company.create({ data: { name: `${TAG} Reseller`, normalizedName: `${TAG.toLowerCase()} reseller`, relationshipType: "RESELLER", panNumber: "AAAPZ1234Z", createdById: admin.id }, select: { id: true } });
      await db.companyLocation.create({ data: { companyId: r.id, label: "HO", isPrimary: true, gstNumber: "07AAAPZ1234Z1Z5" } });
      const profile = await db.resellerProfile.create({ data: { companyId: r.id, agreementSignedOn: todayDay, tier: "GOLD", creditLimit: 100000 }, select: { id: true } });
      const named = await reseller.updateResellerProfile(r.id, { agreementSignedOn: today, agreementApprovedByUserId: rep.id, tier: "GOLD", creditLimit: 100000 });
      if (/isn't open to you/.test(errorOf(named))) return ok("Resellers is switched on here", false, named);
      ok("the agreement's approver can't be typed in as somebody else", /recorded by the approver/.test(errorOf(named)), named);
      await db.auditLog.create({ data: { userId: admin.id, action: "UPDATE", entityType: "ResellerProfile", entityId: profile.id, entityLabel: "Reseller onboarding" } });
      const self = await reseller.setResellerStatus(r.id, "ACTIVE");
      ok("whoever last changed onboarding can't activate the reseller", /somebody else has to activate it/.test(errorOf(self)), self);
      await db.auditLog.updateMany({ where: { entityId: profile.id }, data: { userId: rep.id } });
      const other = await reseller.setResellerStatus(r.id, "ACTIVE");
      ok("  somebody else, holding “Manage settings”, can", other.ok, other);
    });

    // ── R3-17 (low): vendor credits ──
    await part("R3-17: a vendor credit and another payer's rebate", async () => {
      const o = await order({ unitPrice: 1000, orderStatus: "APPROVED", bookedAt: now, vendorId: vendorB.id, purchasePrice: 800 });
      const rebate = await db.orderRebate.create({ data: { companyProductId: o.id, basis: "PURCHASE_VALUE", rate: 10, payer: "DISTRIBUTOR", payerCompanyId: vendorB.id, settlement: "CREDIT_NOTE" }, select: { id: true } });
      const credit = await db.vendorCredit.create({ data: { vendorId: vendorA.id, form: "CREDIT_NOTE", reference: `${TAG}-${RUN}-CN`, date: todayDay, taxableAmount: 100, total: 118, createdById: admin.id }, select: { id: true } });
      const settled = await vendorCredit.settleVendorCredit({ vendorCreditId: credit.id, allocations: [{ orderRebateId: rebate.id, amount: 50 }] });
      if (/can't settle vendor credits/.test(errorOf(settled))) return ok("rebates are open here", false, settled);
      ok("vendor A's credit can't settle a rebate vendor B pays", /paid by another company/.test(errorOf(settled)), settled);
      ok("  nothing was allocated", (await db.rebateAllocation.count({ where: { vendorCreditId: credit.id } })) === 0);
    });
  } finally {
    viewingAs = false;
    actorId = admin.id;
    await cleanup().catch((err) => console.error("cleanup:", err));
    if (settingsRow) await db.accountsSettings.update({ where: { id: "global" }, data: { adjustmentApprovalRequired: settingsRow.adjustmentApprovalRequired } }).catch(() => {});
    if (!lockRow) await db.ledgerLock.deleteMany({ where: { id: "global" } }).catch(() => {});
    else await db.ledgerLock.update({ where: { id: "global" }, data: { lockedUntil: lockRow.lockedUntil } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} round-three operations checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
