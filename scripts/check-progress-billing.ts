/**
 * check:progress-billing — a quote billed in stages (owner, 3 Nov 2026 — src/lib/documents/progress-billing.ts,
 * src/actions/progress-billing.ts).
 *
 *   1. Stages set on a sent quote: 30 / 50 / 20; more than 100% refused; a draft quote refused.
 *   2. A stage invoiced: every line at its share, the GST worked out on that, linked back to the quote; billed 30%.
 *   3. No double billing: the whole quote isn't converted again; a share past what's left is refused.
 *   4. A stage's invoice cancelled frees it; invoiced again; "what's left" bills the rest, then nothing is left.
 *   5. A one-off amount turned into its share.
 *
 * Its own company, item and documents, removed in a finally.
 *
 *   npm run check:progress-billing
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";

const TAG = "ZZPROBE_PROGRESS";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;
  const { createTradeDocument, convertTradeDocument } = await import("../src/actions/trade-document");
  const pb = await import("../src/actions/progress-billing");
  const { billingProgress } = await import("../src/lib/documents/progress-billing");

  const created = { documents: [] as string[], companies: [] as string[], items: [] as string[] };
  try {
    const item = await db.item.create({ data: { name: `${TAG} Fit-out`, sku: `${TAG}-FIT`, type: "SERVICE", sellingPrice: 100000, createdById: actorId } as never, select: { id: true } });
    created.items.push(item.id);
    const company = await db.company.create({
      data: {
        name: `${TAG} Meridian`,
        normalizedName: `${TAG.toLowerCase()} meridian`,
        createdById: actorId,
        ownerUserId: actorId,
        locations: { create: { label: "Works", address: "Plot 9, MIDC", city: "Pune", state: "Maharashtra", pincode: "411018", gstNumber: "27AABCU9603R1ZX", gstTreatment: "REGISTERED_REGULAR", isPrimary: true } },
      },
      select: { id: true, locations: { select: { id: true } } },
    });
    created.companies.push(company.id);
    const address = { attention: "", line1: "Plot 9, MIDC", line2: "", city: "Pune", state: "Maharashtra", stateCode: "27", pincode: "411018", country: "India", phone: "" };
    const quote = await createTradeDocument({
      docType: "PROPOSAL", companyId: company.id, locationId: company.locations[0]!.id, docNumber: "",
      placeOfSupplyCode: "27", gstTreatment: "REGISTERED_REGULAR", buyerGstin: "27AABCU9603R1ZX", reverseCharge: false, currency: "INR", exchangeRate: 1,
      issueDate: new Date().toISOString().slice(0, 10), dueDate: "", validUntil: "", reference: "", salespersonId: "", notes: "", terms: "", dispatchFromAddress: "",
      billing: address, shippingSameAsBilling: true, shipping: address, shippingGstin: "", shippingCharge: 0, shippingTaxRatePercent: 0,
      withholdingMode: "NONE", withholdingSection: "", withholdingRatePercent: 0, adjustmentLabel: "", adjustment: 0, sourceDocumentId: "", leadId: "", againstDocumentId: "",
      lines: [
        { itemId: item.id, companyProductId: "", name: "Office fit-out", description: "", hsnCode: "995411", unit: "Job", quantity: 1, unitPrice: 300000, discountMode: "PERCENT", discountValue: 0, taxRatePercent: 18 },
        { itemId: "", companyProductId: "", name: "Workstations", description: "", hsnCode: "940330", unit: "Nos", quantity: 10, unitPrice: 10000, discountMode: "PERCENT", discountValue: 0, taxRatePercent: 18 },
      ],
    });
    if (!quote.ok) throw new Error(`quote: ${quote.error}`);
    created.documents.push(quote.data.id);
    const qid = quote.data.id;
    const qTotal = Number((await db.tradeDocument.findUniqueOrThrow({ where: { id: qid }, select: { total: true } })).total);

    section("1. Stages");
    const draftRefused = await pb.saveBillingStages(qid, [{ label: "Advance", percent: 30 }]);
    ok("a draft quote isn't billed in stages", !draftRefused.ok, draftRefused.ok ? "" : draftRefused.error);
    await db.tradeDocument.update({ where: { id: qid }, data: { status: "ISSUED" } });
    const tooMuch = await pb.saveBillingStages(qid, [{ label: "Advance", percent: 60 }, { label: "On delivery", percent: 50 }]);
    ok("stages past 100% refused", !tooMuch.ok, tooMuch.ok ? "" : tooMuch.error);
    const set = await pb.saveBillingStages(qid, [{ label: "Advance", percent: 30 }, { label: "On delivery", percent: 50 }, { label: "On sign-off", percent: 20 }]);
    let progress = await billingProgress(qid);
    ok("30 / 50 / 20 set on a sent quote", set.ok && progress?.stages.map((s) => `${s.label} ${s.percent}`).join(", ") === "Advance 30, On delivery 50, On sign-off 20", progress?.stages);

    section("2. A stage invoiced");
    const advance = progress!.stages[0]!;
    const inv = await pb.invoiceBillingStage(advance.id);
    ok("the Advance stage makes an invoice", inv.ok, inv.ok ? "" : inv.error);
    if (!inv.ok) return;
    created.documents.unshift(inv.data.id);
    const invoice = await db.tradeDocument.findUniqueOrThrow({ where: { id: inv.data.id }, select: { docType: true, status: true, total: true, cgstAmount: true, sgstAmount: true, sourceDocumentId: true, origin: true, lines: { select: { quantity: true, unitPrice: true, description: true } } } });
    ok("  a draft tax invoice, converted from the quote", invoice.docType === "INVOICE" && invoice.status === "DRAFT" && invoice.sourceDocumentId === qid && invoice.origin === "CONVERSION");
    ok("  its total is 30% of the quote, GST included", Math.abs(Number(invoice.total) - qTotal * 0.3) <= 1, { invoice: Number(invoice.total), quote: qTotal });
    ok("  every line at 30% of its price, the quantity as quoted, the stage named", invoice.lines.length === 2 && invoice.lines.some((l) => Number(l.quantity) === 10 && Number(l.unitPrice) === 3000) && invoice.lines.every((l) => l.description?.includes("Advance — 30%")), invoice.lines);
    ok("  GST worked out on that share", Number(invoice.cgstAmount) > 0 && Math.abs(Number(invoice.cgstAmount) - Number(invoice.sgstAmount)) < 0.01);
    progress = await billingProgress(qid);
    ok("the quote shows 30% billed, the stage a draft invoice, the next stage On delivery", progress?.billedPercent === 30 && progress.stages[0]!.status === "DRAFT" && progress.next?.label === "On delivery", progress && { billed: progress.billedPercent, next: progress.next?.label });
    const again = await pb.invoiceBillingStage(advance.id);
    ok("  the same stage isn't invoiced twice", !again.ok);

    section("3. No double billing");
    const whole = await convertTradeDocument({ id: qid, target: "INVOICE" });
    ok("the whole quote isn't converted to an invoice again", !whole.ok && /billed already/.test(whole.ok ? "" : whole.error), whole.ok ? "converted!" : whole.error);
    const past = await pb.invoiceQuoteShare(qid, { percent: 80 });
    ok("a share past what's left (70%) is refused", !past.ok && /70%/.test(past.ok ? "" : past.error), past.ok ? "" : past.error);
    const changed = await pb.saveBillingStages(qid, [{ id: advance.id, label: "Advance", percent: 40 }, { label: "Rest", percent: 60 }]);
    ok("an invoiced stage's share can't be changed", !changed.ok);

    section("4. Cancelled, again, and what's left");
    await db.tradeDocument.update({ where: { id: inv.data.id }, data: { status: "CANCELLED" } });
    progress = await billingProgress(qid);
    ok("its invoice cancelled, the stage is unbilled and nothing counts as billed", progress?.billedPercent === 0 && progress.stages[0]!.status === "NOT_BILLED");
    const inv2 = await pb.invoiceBillingStage(advance.id);
    if (inv2.ok) created.documents.unshift(inv2.data.id);
    ok("  invoiced again", inv2.ok && (await billingProgress(qid))?.billedPercent === 30);
    const rest = await pb.invoiceQuoteRemainder(qid);
    if (rest.ok) created.documents.unshift(rest.data.id);
    progress = await billingProgress(qid);
    ok("what's left bills the other 70%, and then nothing is left", rest.ok && Math.abs(progress!.billedPercent - 100) <= 0.01 && progress!.leftPercent <= 0.01, progress && { billed: progress.billedPercent, left: progress.leftPercent });
    const nothing = await pb.invoiceQuoteRemainder(qid);
    ok("  billing more is refused", !nothing.ok);

    section("5. A one-off amount");
    await db.tradeDocument.update({ where: { id: rest.ok ? rest.data.id : "" }, data: { status: "CANCELLED" } }).catch(() => {});
    const amount = Math.round(qTotal * 0.25);
    const byAmount = await pb.invoiceQuoteShare(qid, { amount });
    if (byAmount.ok) created.documents.unshift(byAmount.data.id);
    const amountTotal = byAmount.ok ? Number((await db.tradeDocument.findUniqueOrThrow({ where: { id: byAmount.data.id }, select: { total: true } })).total) : 0;
    ok("an amount is billed as its share of the quote", byAmount.ok && Math.abs(amountTotal - amount) <= 2, { asked: amount, got: amountTotal });
  } finally {
    await db.quoteBillingStage.deleteMany({ where: { documentId: { in: created.documents } } }).catch(() => {});
    for (const id of created.documents) await db.tradeDocument.delete({ where: { id } }).catch(() => {});
    for (const id of created.companies) await db.company.delete({ where: { id } }).catch(() => {});
    for (const id of created.items) await db.item.delete({ where: { id } }).catch(() => {});
    await db.auditLog.deleteMany({ where: { entityLabel: { contains: TAG } } }).catch(() => {});
    ok("the fixture cleaned up after itself", (await db.company.count({ where: { name: { startsWith: TAG } } })) === 0);
  }
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? `\nAll ${passes} progress billing checks passed.` : `\n${failures} failed (${passes} passed).`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
