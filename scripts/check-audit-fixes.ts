/**
 * check:audit-fixes — the security audit of 11 Nov 2026 (docs/reports/security-audit-2026-11-11.md), each fix shown to
 * hold the way it was broken: by calling the server's own code, as a hand-made request would.
 *
 *   SEC-03/09  invoice discounts and the adjustment can't make a line or a document negative
 *   SEC-04/10  credit notes: a cancelled one settles nothing and undoes what it settled; one can't outgrow its invoice
 *   SEC-05     an approved order's missing price is filled by an approver, never its own author
 *   SEC-39/70  a vendor bill isn't marked paid by hand; the same vendor bill can't be booked twice by its case
 *   SEC-67/68  payment and expense dates are real days; an expense's tax isn't more than the expense
 *   SEC-27     a request body is read with a ceiling a chunked sender can't slip past
 *   SEC-02     single sign-on names who signed in, not just an address
 *
 * Pure rules by hand, then a fixture of its own in the local database, named ZZAUDIT, removed in a finally.
 *
 *   npm run check:audit-fixes
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";
import { tradeDocumentSchema } from "../src/lib/validation/trade-document";
import { recordInvoicePaymentSchema } from "../src/lib/validation/receivable";
import { recordPaymentSchema } from "../src/lib/validation/payment";
import { createExpenseSchema } from "../src/lib/validation/expense";
import { happenedOnProblem } from "../src/lib/validation/day";
import { manualStatuses } from "../src/lib/trade-documents";
import { readTextWithin } from "../src/lib/http/body";
import { ssoSubject } from "../src/lib/workplace/sign-in";

const TAG = "ZZAUDIT";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

const issues = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? [] : (r.error?.issues ?? []).map((i) => i.message));

const document = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  docType: "INVOICE",
  companyId: "c1",
  currency: "INR",
  exchangeRate: 1,
  gstTreatment: "UNREGISTERED",
  placeOfSupplyCode: "07",
  issueDate: "2026-11-11",
  billing: { line1: "", city: "", state: "", stateCode: "", pincode: "", country: "India" },
  shipping: { line1: "", city: "", state: "", stateCode: "", pincode: "", country: "India" },
  lines: lines.map((l) => ({ name: "Line", quantity: 1, unitPrice: 1000, discountMode: "PERCENT", discountValue: 0, taxRatePercent: 18, ...l })),
  ...extra,
});

async function cleanup() {
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const docs = (await db.tradeDocument.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((d) => d.id);
  await db.creditNoteApplication.deleteMany({ where: { OR: [{ invoiceId: { in: docs } }, { creditNoteId: { in: docs } }] } });
  await db.auditLog.deleteMany({ where: { entityId: { in: docs } } });
  await db.tradeDocument.updateMany({ where: { id: { in: docs } }, data: { againstDocumentId: null } });
  await db.tradeDocument.deleteMany({ where: { id: { in: docs } } });
  const items = (await db.item.findMany({ where: { sku: { startsWith: TAG } }, select: { id: true } })).map((i) => i.id);
  const orders = (await db.companyProduct.findMany({ where: { itemId: { in: items } }, select: { id: true } })).map((o) => o.id);
  await db.auditLog.deleteMany({ where: { entityId: { in: orders } } });
  await db.companyProduct.deleteMany({ where: { id: { in: orders } } });
  await db.item.deleteMany({ where: { id: { in: items } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.user.deleteMany({ where: { email: { endsWith: "@zzaudit.invalid" } } });
}

async function main() {
  section("SEC-03/09: invoice lines and totals");
  ok("a 250% discount is refused, naming the line", issues(tradeDocumentSchema.safeParse(document([{ discountValue: 250 }]))).some((m) => /Line 1: a discount can't be more than 100%/.test(m)));
  ok("  100% is still allowed", tradeDocumentSchema.safeParse(document([{ discountValue: 100 }])).success);
  ok("a flat discount larger than the line is refused", issues(tradeDocumentSchema.safeParse(document([{ discountMode: "AMOUNT", discountValue: 5000 }]))).some((m) => /more than the line itself/.test(m)));
  ok("an adjustment taking the total below zero is refused", issues(tradeDocumentSchema.safeParse(document([{}], { adjustment: -50000 }))).some((m) => /below zero/.test(m)));
  ok("  a small one, or one down to exactly zero, is fine", tradeDocumentSchema.safeParse(document([{}], { adjustment: -0.4 })).success && tradeDocumentSchema.safeParse(document([{}], { adjustment: -1000 })).success);
  const { computeLine } = await import("../src/lib/gst-engine");
  const raw = computeLine({ quantity: 1, unitPrice: 1000, discountMode: "PERCENT", discountValue: 250, taxRatePercent: 18 } as Parameters<typeof computeLine>[0], "INTER_STATE");
  ok("  the tax engine itself never makes a line negative, whatever reaches it", raw.taxableValue === 0 && raw.igstAmount === 0 && raw.lineTotal === 0, { taxable: raw.taxableValue, igst: raw.igstAmount, total: raw.lineTotal });

  section("SEC-67/68: dates and amounts typed by people");
  const today = new Date().toISOString().slice(0, 10);
  ok("1 January 1900 isn't a payment date", /too far in the past/.test(happenedOnProblem("1900-01-01") ?? ""));
  ok("  nor next year, nor 31 February, nor words", [happenedOnProblem("2099-01-01"), happenedOnProblem("2026-02-31"), happenedOnProblem("soon")].every(Boolean));
  ok("  today is", happenedOnProblem(today) === null);
  ok("an invoice payment dated 1900 is refused", !recordInvoicePaymentSchema.safeParse({ invoiceId: "x", amount: 1, paidOn: "1900-01-01" }).success);
  ok("  a payment on account too", !recordPaymentSchema.safeParse({ companyId: "x", amount: 1, paidOn: "1900-01-01" }).success);
  ok("  more than two decimals, or a hundred crore and more, aren't amounts", !recordPaymentSchema.safeParse({ companyId: "x", amount: 1.005, paidOn: today }).success && !recordPaymentSchema.safeParse({ companyId: "x", amount: 2_000_000_000, paidOn: today }).success);
  const expense = (extra: Record<string, unknown>) => createExpenseSchema.safeParse({ amount: 100, spentOn: today, description: "Taxi", ...extra });
  ok("an expense whose tax is more than the expense is refused", issues(expense({ taxAmount: 5000 })).some((m) => /tax can't be more/.test(m)));
  ok("  tax within it, fine", expense({ taxAmount: 18 }).success);
  ok("  a 20,000-character description isn't", !expense({ description: "x".repeat(20_000) }).success);

  section("SEC-39: a vendor bill is paid by recording the payment");
  ok("Paid is no longer a status set on a bill by hand", !(manualStatuses.BILL as readonly string[]).includes("PAID"));

  section("SEC-27: bodies read with a ceiling");
  const chunked = (bytes: number) =>
    new Request("http://localhost/x", {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          for (let sent = 0; sent < bytes; sent += 1024) c.enqueue(new Uint8Array(1024));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
  ok("a chunked body past the ceiling is refused, with no length declared", (await readTextWithin(chunked(64 * 1024), 16 * 1024)) === null);
  ok("  one within it is read whole", (await readTextWithin(chunked(8 * 1024), 16 * 1024))?.length === 8 * 1024);

  section("SEC-02: who signed in, not just an address");
  ok("Microsoft: its directory and object ids", ssoSubject("MICROSOFT", { tid: "AAA", oid: "BBB" }) === "aaa:bbb");
  ok("  neither — nothing to hold to", ssoSubject("MICROSOFT", { email: "x@y" }) === null);
  ok("Google and Zoho: the subject", ssoSubject("GOOGLE", { sub: "123" }) === "123" && ssoSubject("ZOHO", {}, "zuid-9") === "zuid-9");

  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;
  const { duplicateVendorBillRefusal, creditRoomOn } = await import("../src/lib/documents/create-draft");
  const { fillMissingPrices } = await import("../src/actions/order-prices");
  const { setTradeDocumentStatus } = await import("../src/actions/trade-document");
  const { applyCreditNote } = await import("../src/actions/receivable");

  await cleanup();
  try {
    const vendor = await db.company.create({ data: { name: `${TAG} Vendor`, normalizedName: `${TAG.toLowerCase()} vendor`, createdById: admin.id }, select: { id: true } });
    const other = await db.company.create({ data: { name: `${TAG} Other`, normalizedName: `${TAG.toLowerCase()} other`, createdById: admin.id }, select: { id: true } });
    const customer = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, createdById: admin.id }, select: { id: true } });

    section("SEC-70: the same vendor bill twice");
    await db.tradeDocument.create({ data: { docNumber: `${TAG}/BILL/0095`, docType: "BILL", direction: "PURCHASE", status: "ISSUED", companyId: vendor.id, createdById: admin.id, total: 12192 } });
    ok("the same number in other case and spacing, same vendor — refused", /already entered/.test((await duplicateVendorBillRefusal(vendor.id, `${TAG.toLowerCase()} / bill / 0095`.replace(/ /g, ""))) ?? ""));
    ok("  another vendor's bill with that number — fine", (await duplicateVendorBillRefusal(other.id, `${TAG.toLowerCase()}/bill/0095`)) === null);

    section("SEC-04/10: credit notes");
    const invoice = await db.tradeDocument.create({ data: { docNumber: `${TAG}/INV/1`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: customer.id, createdById: admin.id, total: 1180, taxableValue: 1000 } });
    const note = await db.tradeDocument.create({ data: { docNumber: `${TAG}/CN/1`, docType: "CREDIT_NOTE", direction: "SALES", status: "ISSUED", companyId: customer.id, createdById: admin.id, total: 1180, againstDocumentId: invoice.id } });
    const room = await creditRoomOn(invoice.id, "none");
    ok("an invoice's room for credit is what's left after its other credit notes", room?.room === 0 && room.credited === 1180, room);
    ok("  and for the note itself, all of it", (await creditRoomOn(invoice.id, note.id))?.room === 1180);
    await db.creditNoteApplication.create({ data: { creditNoteId: note.id, invoiceId: invoice.id, amount: 1180, appliedByUserId: admin.id } });
    await db.tradeDocument.update({ where: { id: invoice.id }, data: { status: "PAID" } });
    const cancelled = await setTradeDocumentStatus(note.id, "CANCELLED", "ZZAUDIT test");
    const after = await db.tradeDocument.findUnique({ where: { id: invoice.id }, select: { status: true } });
    ok("cancelling a credit note takes its credit off the invoice, which is open again", cancelled.ok && (await db.creditNoteApplication.count({ where: { creditNoteId: note.id } })) === 0 && after?.status === "ISSUED", { cancelled, after });
    const reapplied = await applyCreditNote({ creditNoteId: note.id, invoiceId: invoice.id, amount: 100 });
    ok("  and a cancelled credit note can't be applied", !reapplied.ok && /cancelled/.test(reapplied.ok ? "" : reapplied.error), reapplied);

    section("SEC-05: prices filled after approval");
    const item = await db.item.create({ data: { name: `${TAG} UPS`, sku: `${TAG}-UPS`, type: "GOOD", sellingPrice: 9500, createdById: admin.id }, select: { id: true } });
    const location = await db.companyLocation.create({ data: { companyId: customer.id, label: "HO", isPrimary: true } });
    const rep = await db.user.create({ data: { name: "ZZ Audit Rep", email: "rep@zzaudit.invalid", passwordHash: "!", role: "SALES" }, select: { id: true } });
    const order = (addedByUserId: string) =>
      db.companyProduct.create({ data: { companyId: customer.id, locationId: location.id, itemId: item.id, quantity: 1, orderStatus: "APPROVED", accountsApprovedAt: new Date(), addedByUserId }, select: { id: true } });
    const own = await order(admin.id);
    const theirs = await order(rep.id);
    const filled = await fillMissingPrices({ entries: [{ id: own.id, price: 1 }, { id: theirs.id, price: 9500 }] });
    const prices = await db.companyProduct.findMany({ where: { id: { in: [own.id, theirs.id] } }, select: { id: true, unitPrice: true } });
    const priceOf = (id: string) => Number(prices.find((p) => p.id === id)?.unitPrice ?? NaN);
    ok("an approved order you punched: its price isn't yours to fill", Number.isNaN(priceOf(own.id)) && filled.ok && filled.data.skipped.some((s) => /yours and already approved/.test(s.reason)), filled);
    ok("  somebody else's, as an approver: filled", priceOf(theirs.id) === 9500);
    const imported = await db.companyProduct.create({ data: { companyId: customer.id, locationId: location.id, itemId: item.id, quantity: 1, orderStatus: "FULFILLED", addedByUserId: admin.id }, select: { id: true } });
    const fromOld = await fillMissingPrices({ entries: [{ id: imported.id, price: 7000 }] });
    ok("  one brought from the old system, never approved here: still the page's to fill", fromOld.ok && fromOld.data.filled === 1, fromOld);
  } finally {
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} audit-fix checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
