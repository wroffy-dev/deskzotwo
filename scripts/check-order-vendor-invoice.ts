/**
 * check:order-vendor-invoice — the vendor's invoice on an order, its number and amount (owner, 16 Nov 2026 — src/lib/orders/vendor-invoice.ts,
 * src/actions/order-vendor-invoice.ts).
 *
 *   · what may be kept: trimmed, at most 60 characters, the usual separators; blank clears it;
 *   · added on a fulfilled order, changed, cleared — by whoever runs purchasing; refused on a cancelled order and for
 *     somebody who neither processes nor approves orders;
 *   · read for the list by order.
 *
 * Its own customer, item and orders, removed in a finally.
 *
 *   npm run check:order-vendor-invoice
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { ...real, requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { ...real, requireModuleUser: user, requireModuleAccess: user };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const TAG = "ZZVENDINV";

async function main() {
  const lib = await import("../src/lib/orders/vendor-invoice");
  const c = (v: unknown) => lib.cleanVendorInvoice(v);
  ok("an invoice number is kept, trimmed", JSON.stringify(c("  INGM/24-25/10234 ")) === '{"ok":true,"value":"INGM/24-25/10234"}');
  ok("  blank clears it", JSON.stringify(c("   ")) === '{"ok":true,"value":null}');
  ok("  too long, or odd characters, refused", !c("x".repeat(61)).ok && !c("INV<script>").ok);
  const a = (v: unknown) => lib.cleanBilledAmount(v);
  ok("an amount as typed, commas and ₹ and all", JSON.stringify(a("₹1,050.50")) === '{"ok":true,"value":1050.5}' && JSON.stringify(a("")) === '{"ok":true,"value":null}');
  ok("  below 0, or not a number, refused", !a("-5").ok && !a("abc").ok);

  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin");
  const made = { companies: [] as string[], items: [] as string[], orders: [] as string[], users: [] as string[] };
  try {
    const customer = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: admin.id, ownerUserId: admin.id, relationshipType: "CLIENT", stage: "CUSTOMER" } as never, select: { id: true } });
    made.companies.push(customer.id);
    const site = await db.companyLocation.create({ data: { companyId: customer.id, label: "Head Office", isPrimary: true, address: "1 MG Road", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" } });
    const item = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-1`, type: "SERVICE", sellingPrice: 1000, taxRatePercent: 18, unit: "Nos", createdById: admin.id } as never, select: { id: true } });
    made.items.push(item.id);
    const order = async (orderStatus: "FULFILLED" | "CANCELLED") => {
      const o = await db.companyProduct.create({ data: { companyId: customer.id, locationId: site.id, itemId: item.id, addedByUserId: admin.id, quantity: 2, unitPrice: 1000, purchasePrice: 900, orderStatus, purchaseRelease: "RELEASED" } as never, select: { id: true } });
      made.orders.push(o.id);
      return o.id;
    };
    const fulfilled = await order("FULFILLED");
    const cancelled = await order("CANCELLED");
    const { setVendorInvoice } = await import("../src/actions/order-vendor-invoice");
    const read = async (id: string) => (await lib.vendorInvoicesOf([id])).get(id) ?? null;

    actorId = admin.id;
    const added = await setVendorInvoice(fulfilled, { number: "INGM/24-25/10234", amount: "1,800" });
    const first = await read(fulfilled);
    ok("added on a fulfilled order: number and amount, matching 2 × ₹900", added.ok && first?.number === "INGM/24-25/10234" && first.amount === 1800 && first.expected === 1800 && first.difference === 0, first);
    await setVendorInvoice(fulfilled, { number: "INGM/24-25/10235", amount: "2,100" });
    const dearer = await read(fulfilled);
    ok("  changed to ₹2,100: ₹300 more than expected", dearer?.number === "INGM/24-25/10235" && dearer.difference === 300, dearer);
    const listed = await lib.vendorInvoicesOf([fulfilled, cancelled]);
    ok("  read for the list by order — none for one without", listed.size === 1 && listed.has(fulfilled));

    // A vendor bill in Deskzo that bills the order is the answer instead.
    const bill = await db.tradeDocument.create({
      data: { docType: "BILL", direction: "PURCHASE", status: "ISSUED", companyId: customer.id, docNumber: `${TAG}-BILL-${Date.now()}`, createdById: admin.id, lines: { create: [{ name: "Licence", quantity: 2, unitPrice: 900, taxableValue: 1800, taxRatePercent: 18, lineTotal: 2124, sortOrder: 0, companyProductId: fulfilled }] } } as never,
      select: { id: true, docNumber: true },
    });
    const fromBill = await read(fulfilled);
    ok("a vendor bill billing the order fills it: its number and amount, nothing typed", fromBill?.fromBill?.id === bill.id && fromBill.number === bill.docNumber && fromBill.amount === 1800 && fromBill.difference === 0, fromBill);
    await db.tradeDocument.delete({ where: { id: bill.id } });

    ok("  cleared", (await setVendorInvoice(fulfilled, { number: "", amount: "" })).ok && (await read(fulfilled)) === null);
    const onCancelled = await setVendorInvoice(cancelled, { number: "X/1" });
    ok("refused on a cancelled order", !onCancelled.ok && /cancelled/.test(onCancelled.ok ? "" : onCancelled.error), onCancelled);

    const seller = await db.user.create({ data: { name: `${TAG} seller`, email: `seller.${Date.now()}@zzvendinv.invalid`, role: "SALES", passwordHash: "!" } as never, select: { id: true } });
    made.users.push(seller.id);
    for (const permission of ["orders.process", "orders.approve"]) await db.userPermission.create({ data: { userId: seller.id, permission, allowed: false, reason: TAG } });
    actorId = seller.id;
    const bySeller = await setVendorInvoice(fulfilled, { number: "X/2" });
    ok("refused for somebody who neither processes nor approves orders", !bySeller.ok && /purchasing/.test(bySeller.ok ? "" : bySeller.error), bySeller);
  } finally {
    await db.userPermission.deleteMany({ where: { userId: { in: made.users } } });
    await db.user.deleteMany({ where: { id: { in: made.users } } });
    await db.companyProduct.deleteMany({ where: { id: { in: made.orders } } });
    await db.item.deleteMany({ where: { id: { in: made.items } } });
    await db.companyLocation.deleteMany({ where: { companyId: { in: made.companies } } });
    await db.company.deleteMany({ where: { id: { in: made.companies } } });
  }
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
