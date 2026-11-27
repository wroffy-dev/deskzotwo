/**
 * check:quote-to-order — a quote's lines to sales orders, and a quote that's gone further being accepted (owner, 6 Nov
 * 2026 — src/lib/orders/from-quote.ts).
 *
 *   1. A sent quote lists its lines: quantity, the price after discount, its service period; a draft isn't ordered from.
 *   2. An order from a line is tied to it, the quote accepted, the next line next; the same line is refused twice.
 *   3. A cancelled order frees its line. A line from another customer is refused.
 *   4. A sent quote converted is accepted; a draft or a rejected one is refused, and left as it was.
 *   5. An issued proforma punches orders as a quote does.
 *   6. The order and its proforma name each other; the proforma isn't converted to an invoice as well, and the order's
 *      invoice is converted from it (owner, 17 Nov 2026).
 *   7. An advance against the proforma waits on account and goes onto that invoice when it is issued; one recorded
 *      after goes on at once; more than the proforma is refused (owner, 17 Nov 2026).
 *
 * Its own company, item and documents, removed in a finally.
 *
 *   npm run check:quote-to-order
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";

const TAG = "ZZPROBE_QTO";
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
  const { createTradeDocument, convertTradeDocument, issueTradeDocument } = await import("../src/actions/trade-document");
  const { recordProformaAdvance } = await import("../src/actions/proforma-advance");
  const { proformaAdvances } = await import("../src/lib/receivables/proforma-advance");
  const { createOrder } = await import("../src/actions/order");
  const { quoteForOrder, sourceOfOrder, ordersOfQuote } = await import("../src/lib/orders/from-quote");
  const { loadOrders, createOrderInvoiceDraft } = await import("../src/lib/orders/invoice-draft");

  const made = { documents: [] as string[], orders: [] as string[], companies: [] as string[], items: [] as string[], payments: [] as string[] };
  const address = { attention: "", line1: "Plot 9, MIDC", line2: "", city: "Pune", state: "Maharashtra", stateCode: "27", pincode: "411018", country: "India", phone: "" };
  try {
    const item = await db.item.create({ data: { name: `${TAG} Revit`, sku: `${TAG}-A`, type: "SERVICE", sellingPrice: 900, createdById: actorId } as never, select: { id: true } });
    made.items.push(item.id);
    const mk = (name: string) =>
      db.company.create({
        data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: actorId, ownerUserId: actorId, relationshipType: "CLIENT", stage: "CUSTOMER", locations: { create: { label: "Works", address: "Plot 9", city: "Pune", state: "Maharashtra", pincode: "411018", gstNumber: "27AABCU9603R1ZX", gstTreatment: "REGISTERED_REGULAR", isPrimary: true } } },
        select: { id: true, locations: { select: { id: true } } },
      });
    const company = await mk("Meridian");
    const other = await mk("Other");
    made.companies.push(company.id, other.id);
    const line = { itemId: item.id, companyProductId: "", description: "", hsnCode: "997331", unit: "Nos", taxRatePercent: 18 };
    const newQuote = async () => {
      const q = await createTradeDocument({
        docType: "PROPOSAL", companyId: company.id, locationId: company.locations[0]!.id, docNumber: "",
        placeOfSupplyCode: "27", gstTreatment: "REGISTERED_REGULAR", buyerGstin: "27AABCU9603R1ZX", reverseCharge: false, currency: "INR", exchangeRate: 1,
        issueDate: new Date().toISOString().slice(0, 10), dueDate: "", validUntil: "", reference: "", salespersonId: "", notes: "", terms: "", dispatchFromAddress: "",
        billing: address, shippingSameAsBilling: true, shipping: address, shippingGstin: "", shippingCharge: 0, shippingTaxRatePercent: 0,
        withholdingMode: "NONE", withholdingSection: "", withholdingRatePercent: 0, adjustmentLabel: "", adjustment: 0, sourceDocumentId: "", leadId: "", againstDocumentId: "",
        lines: [
          { ...line, name: "Ten seats", quantity: 10, unitPrice: 1000, discountMode: "PERCENT", discountValue: 10 },
          { ...line, itemId: "", name: "Set-up, not a product", quantity: 1, unitPrice: 5000, discountMode: "PERCENT", discountValue: 0 },
        ],
      });
      if (!q.ok) throw new Error(`quote: ${q.error}`);
      made.documents.push(q.data.id);
      return q.data.id;
    };
    const statusOf = async (id: string) => (await db.tradeDocument.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

    section("1. The lines");
    const qid = await newQuote();
    ok("a draft quote isn't ordered from", (await quoteForOrder(qid, actorId)) === null);
    await db.tradeDocument.update({ where: { id: qid }, data: { status: "ISSUED" } });
    const quote = (await quoteForOrder(qid, actorId))!;
    const first = quote.lines[0]!;
    ok("a sent quote lists its lines, the next first", quote.lines.length === 2 && quote.next?.id === first.id);
    ok("  a line's quantity and its price after the discount", first.quantity === 10 && first.unitPrice === 900 && first.itemId === item.id, first);
    ok("  a line that isn't a product says so", quote.lines[1]!.itemId === null);

    section("2. An order from a line");
    const order = () => createOrder({ companyId: company.id, locationId: company.locations[0]!.id, itemId: item.id, quantity: first.quantity, unitPrice: first.unitPrice, fromQuoteLineId: first.id } as never);
    const placed = await order();
    ok("the order is made", placed.ok, placed.ok ? "" : placed.error);
    if (!placed.ok) return;
    made.orders.push(placed.data.id);
    const after = (await quoteForOrder(qid, actorId))!;
    ok("  tied to its line, and the next line is next", !!after.lines[0]!.ordered && after.next?.id === after.lines[1]!.id, after.lines[0]!.ordered);
    ok("  a sent quote ordered from is accepted", (await statusOf(qid)) === "ACCEPTED");
    const twice = await order();
    ok("the same line isn't ordered twice", !twice.ok && /has its order already/.test(twice.ok ? "" : twice.error), twice.ok ? "made" : twice.error);

    section("3. Freed, and refused");
    await db.companyProduct.update({ where: { id: placed.data.id }, data: { orderStatus: "CANCELLED" } });
    ok("its order cancelled, the line is free again", (await quoteForOrder(qid, actorId))!.lines[0]!.ordered === null);
    const again = await order();
    if (again.ok) made.orders.push(again.data.id);
    ok("  and can be ordered again", again.ok && !!(await quoteForOrder(qid, actorId))!.lines[0]!.ordered, again.ok ? "" : again.error);
    const wrong = await createOrder({ companyId: other.id, locationId: other.locations[0]!.id, itemId: item.id, quantity: 1, fromQuoteLineId: quote.lines[1]!.id } as never);
    ok("a line for another customer is refused", !wrong.ok && /isn't this customer's/.test(wrong.ok ? "" : wrong.error), wrong.ok ? "made" : wrong.error);

    section("4. Converting a quote");
    const sent = await newQuote();
    await db.tradeDocument.update({ where: { id: sent }, data: { status: "ISSUED" } });
    const proforma = await convertTradeDocument({ id: sent, target: "PROFORMA" });
    if (proforma.ok) made.documents.unshift(proforma.data.id);
    ok("a sent quote converted to a proforma is accepted", proforma.ok && (await statusOf(sent)) === "ACCEPTED", proforma.ok ? "" : proforma.error);
    const draft = await newQuote();
    const fromDraft = await convertTradeDocument({ id: draft, target: "PROFORMA" });
    if (fromDraft.ok) made.documents.unshift(fromDraft.data.id);
    ok("  a draft is refused, and stays a draft", !fromDraft.ok && /Issue this quote first/.test(fromDraft.error) && (await statusOf(draft)) === "DRAFT", fromDraft.ok ? "converted" : fromDraft.error);
    const rejected = await newQuote();
    await db.tradeDocument.update({ where: { id: rejected }, data: { status: "REJECTED" } });
    const fromRejected = await convertTradeDocument({ id: rejected, target: "INVOICE" });
    if (fromRejected.ok) made.documents.unshift(fromRejected.data.id);
    ok("  a rejected one is refused, and stays rejected", !fromRejected.ok && (await statusOf(rejected)) === "REJECTED", fromRejected.ok ? "converted" : fromRejected.error);

    // An issued proforma invoice punches orders as a quote does (owner, 16 Nov 2026: "order punching option from issued
    // proforma invoice"), and keeps its own status.
    section("5. Orders from an issued proforma");
    if (!proforma.ok) return;
    const pid = proforma.data.id;
    await db.tradeDocument.update({ where: { id: pid }, data: { status: "DRAFT" } });
    ok("a draft proforma isn't ordered from", (await quoteForOrder(pid, actorId)) === null);
    await db.tradeDocument.update({ where: { id: pid }, data: { status: "ISSUED" } });
    const pf = await quoteForOrder(pid, actorId);
    ok("an issued one lists its lines, called a proforma", pf?.kind === "proforma" && pf.lines.length === 2 && !!pf.next, pf);
    const fromProforma = await createOrder({ companyId: company.id, locationId: company.locations[0]!.id, itemId: item.id, quantity: pf!.lines[0]!.quantity, unitPrice: pf!.lines[0]!.unitPrice, fromQuoteLineId: pf!.lines[0]!.id } as never);
    if (fromProforma.ok) made.orders.push(fromProforma.data.id);
    ok("  an order punched from its line, tied to it", fromProforma.ok && !!(await quoteForOrder(pid, actorId))!.lines[0]!.ordered, fromProforma.ok ? "" : fromProforma.error);
    ok("  and the proforma keeps its status", (await statusOf(pid)) === "ISSUED");

    section("6. The proforma and its order, in step");
    if (!fromProforma.ok) return;
    const source = await sourceOfOrder(fromProforma.data.id, actorId);
    ok("the order names the proforma it was punched from", source?.id === pid && source.kind === "proforma", source);
    const listed = await ordersOfQuote(pid);
    ok("  and the proforma lists the order, with its line", listed.length === 1 && listed[0]!.line === pf!.lines[0]!.name && listed[0]!.status === "PENDING_APPROVAL", listed);
    const wholeInvoice = await convertTradeDocument({ id: pid, target: "INVOICE" });
    if (wholeInvoice.ok) made.documents.unshift(wholeInvoice.data.id);
    ok("  converting the proforma to an invoice as well is refused, naming the order", !wholeInvoice.ok && /punched from this proforma/.test(wholeInvoice.error), wholeInvoice.ok ? "converted" : wholeInvoice.error);
    const plain = again.ok ? await sourceOfOrder(again.data.id, actorId) : null;
    ok("  an order from a quote names the quote", plain?.id === qid && plain.kind === "quote", plain);
    await db.companyProduct.update({ where: { id: fromProforma.data.id }, data: { orderStatus: "CANCELLED" } });
    const afterCancel = await convertTradeDocument({ id: pid, target: "INVOICE" });
    if (afterCancel.ok) made.documents.unshift(afterCancel.data.id);
    ok("  its order cancelled, the proforma converts again", afterCancel.ok, afterCancel.ok ? "" : afterCancel.error);
    // Called off again, so it bills nothing and the order's own invoice below is the only one.
    if (afterCancel.ok) await db.tradeDocument.update({ where: { id: afterCancel.data.id }, data: { status: "CANCELLED" } });
    await db.companyProduct.update({ where: { id: fromProforma.data.id }, data: { orderStatus: "PENDING_APPROVAL" } });
    const invoice = await createOrderInvoiceDraft((await loadOrders([fromProforma.data.id]))!, actorId);
    if (invoice.ok) made.documents.unshift(invoice.data.id);
    const invoiceSource = invoice.ok ? (await db.tradeDocument.findUniqueOrThrow({ where: { id: invoice.data.id }, select: { sourceDocumentId: true } })).sourceDocumentId : null;
    ok("  the order's tax invoice is converted from the proforma", invoice.ok && invoiceSource === pid, invoice.ok ? invoiceSource : invoice.error);

    section("7. The proforma's advance, onto the order's invoice");
    if (!invoice.ok) return;
    const today = new Date().toISOString().slice(0, 10);
    const advance = await recordProformaAdvance({ proformaId: pid, amount: 3000, paidOn: today, method: "BANK_TRANSFER", reference: "UTR-ADV-1", requestId: crypto.randomUUID() });
    ok("an advance recorded against the issued proforma", advance.ok && advance.data.applied === 0, advance.ok ? advance.data : advance.error);
    const waiting = await proformaAdvances(pid);
    ok("  it waits on account, unapplied, listed on the proforma", waiting.length === 1 && waiting[0]!.unapplied === 3000 && waiting[0]!.applied.length === 0, waiting);
    const tooMuch = await recordProformaAdvance({ proformaId: pid, amount: 20000, paidOn: today, method: "BANK_TRANSFER", requestId: crypto.randomUUID() });
    ok("  more than the proforma has left to receive is refused", !tooMuch.ok && /still to receive/.test(tooMuch.error), tooMuch.ok ? "recorded" : tooMuch.error);
    const issued = await issueTradeDocument({ id: invoice.data.id });
    ok("the order's invoice issued", issued.ok, issued.ok ? "" : issued.error);
    const settledBy = async () => (await db.paymentAllocation.findMany({ where: { documentId: invoice.data.id }, select: { amount: true } })).reduce((t, a) => t + Number(a.amount), 0);
    ok("  and the advance went onto it", (await settledBy()) === 3000 && (await statusOf(invoice.data.id)) === "PARTIALLY_PAID", { settled: await settledBy(), status: await statusOf(invoice.data.id) });
    const spent = await proformaAdvances(pid);
    ok("  the proforma says where it went", spent[0]!.unapplied === 0 && spent[0]!.applied[0]?.documentId === invoice.data.id && spent[0]!.applied[0]?.amount === 3000, spent);
    const later = await recordProformaAdvance({ proformaId: pid, amount: 2000, paidOn: today, method: "UPI", requestId: crypto.randomUUID() });
    ok("an advance recorded after the invoice is issued goes onto it at once", later.ok && later.data.applied === 2000 && (await settledBy()) === 5000, later.ok ? later.data : later.error);
    made.payments.push(...(await proformaAdvances(pid)).map((a) => a.paymentId));
    await db.tradeDocument.update({ where: { id: invoice.data.id }, data: { status: "CANCELLED" } });

    await db.tradeDocument.update({ where: { id: pid }, data: { status: "PAID" } });
    ok("one paid against already is still ordered from", (await quoteForOrder(pid, actorId))?.next?.id === pf!.lines[1]!.id);
    await db.tradeDocument.update({ where: { id: pid }, data: { status: "CANCELLED" } });
    ok("a cancelled one isn't", (await quoteForOrder(pid, actorId)) === null);
  } finally {
    await db.proformaAdvance.deleteMany({ where: { paymentId: { in: made.payments } } }).catch(() => {});
    await db.paymentAllocation.deleteMany({ where: { paymentId: { in: made.payments } } }).catch(() => {});
    await db.journalLine.deleteMany({ where: { entry: { OR: [{ paymentId: { in: made.payments } }, { documentId: { in: made.documents } }] } } }).catch(() => {});
    await db.journalEntry.deleteMany({ where: { OR: [{ paymentId: { in: made.payments } }, { documentId: { in: made.documents } }] } }).catch(() => {});
    await db.payment.deleteMany({ where: { id: { in: made.payments } } }).catch(() => {});
    await db.quoteOrderLink.deleteMany({ where: { quoteId: { in: made.documents } } }).catch(() => {});
    await db.tradeDocument.deleteMany({ where: { sourceDocumentId: { in: made.documents } } }).catch(() => {});
    for (const id of made.documents) await db.tradeDocument.delete({ where: { id } }).catch(() => {});
    for (const id of made.orders) await db.companyProduct.delete({ where: { id } }).catch(() => {});
    for (const id of made.companies) await db.company.delete({ where: { id } }).catch(() => {});
    for (const id of made.items) await db.item.delete({ where: { id } }).catch(() => {});
    ok("the fixture cleaned up after itself", (await db.company.count({ where: { name: { startsWith: TAG } } })) === 0);
  }
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? `\nAll ${passes} quote-to-order checks passed.` : `\n${failures} failed (${passes} passed).`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
