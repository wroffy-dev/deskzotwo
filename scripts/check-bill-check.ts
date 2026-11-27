/**
 * check:bill-check — a vendor's bill checked against our PO (owner, 16 Nov 2026 — src/lib/purchase/bill-check.ts).
 *
 *   1. The rules: a bill that agrees matches; a wrong SKU, more than the PO has left, a dearer unit price, a price
 *      above the deal price and a different GST rate are each said, with what they cost us; what earlier bills took
 *      counts; what the bill leaves out is noted, not flagged.
 *   2. On the database: a PO with two bills — one made from it, one naming it in its reference — read as the page does;
 *      the second sees what the first billed. Its own vendor, PO and bills, removed in a finally.
 *
 *   npm run check:bill-check
 */
import "dotenv/config";
import { db } from "../src/lib/db";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const TAG = "ZZBILLCHECK";

async function main() {
  section("1. The rules");
  const { compareBillToPo, billPoCheck } = await import("../src/lib/purchase/bill-check");
  const line = (name: string, quantity: number, unitNet: number, taxRate = 18, itemId: string | null = name, orderId: string | null = null) => ({ itemId, name, quantity, unitNet, taxRate, orderId });
  const po = [line("Laptop", 10, 50000, 18, "laptop", "ord1"), line("Mouse", 10, 500)];
  const none = new Map<string, number>();

  const same = compareBillToPo({ bill: [line("Laptop", 10, 50000, 18, "laptop"), line("Mouse", 10, 500)], po, alreadyBilled: none, dealPrices: new Map() });
  ok("a bill that agrees with the PO matches, nothing over", same.matches && same.extra === 0 && same.notBilledYet.length === 0);

  const wrong = compareBillToPo({
    bill: [line("Laptop", 12, 51000, 18, "laptop"), line("Mouse", 10, 500, 28), line("Keyboard", 2, 1500)],
    po,
    alreadyBilled: none,
    dealPrices: new Map([["ord1", 49000]]),
  });
  const laptop = wrong.rows.find((r) => r.name === "Laptop")!;
  const kinds = (r: { issues: { kind: string }[] }) => r.issues.map((i) => i.kind).sort().join();
  ok("two more laptops than ordered: ₹1,02,000 over", laptop.issues.some((i) => i.kind === "OVER_QUANTITY" && i.extra === 102000), laptop.issues);
  ok("  ₹1,000 a unit above the PO on the ten ordered: ₹10,000 over", laptop.issues.some((i) => i.kind === "ABOVE_PO_PRICE" && i.extra === 10000));
  ok("  and above the order's deal price of ₹49,000", laptop.issues.some((i) => i.kind === "ABOVE_DEAL_PRICE"));
  ok("GST at 28% where the PO has 18% is said", kinds(wrong.rows.find((r) => r.name === "Mouse")!) === "TAX_RATE");
  ok("a keyboard the PO doesn't have: a wrong SKU, ₹3,000", wrong.rows.find((r) => r.name === "Keyboard")?.issues[0]?.kind === "NOT_ON_PO" && wrong.rows.find((r) => r.name === "Keyboard")!.issues[0]!.extra === 3000);
  ok("  the bill doesn't match, ₹1,15,000 over in all", !wrong.matches && wrong.extra === 115000, wrong.extra);

  const second = compareBillToPo({ bill: [line("Laptop", 6, 50000, 18, "laptop")], po, alreadyBilled: new Map([["i:laptop", 6]]), dealPrices: new Map() });
  ok("6 billed before, 6 more of 10: 2 over what's left", second.rows[0]!.issues.some((i) => i.kind === "OVER_QUANTITY" && i.text.startsWith("2 more")) && second.extra === 100000, second.rows[0]!.issues);
  ok("  and the mouse, not on this bill, is noted — not a problem", second.notBilledYet.join() === "Mouse");
  const discounted = compareBillToPo({ bill: [line("Laptop", 10, 49500, 18, "laptop")], po: [line("Laptop", 10, 50000, 18, "laptop")], alreadyBilled: none, dealPrices: new Map() });
  ok("cheaper than the PO is no problem", discounted.matches);
  const byName = compareBillToPo({ bill: [line("  usb   cable ", 1, 100, 18, null)], po: [line("USB Cable", 1, 100, 18, null)], alreadyBilled: none, dealPrices: new Map() });
  ok("lines with no product match by name, whatever the spacing and case", byName.matches);

  section("2. On the database");
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin");
  const vendorId = `zzbc_${Date.now()}`;
  const made: string[] = [];
  try {
    await db.$executeRaw`INSERT INTO "companies" ("id", "name", "normalizedName", "relationshipType", "createdById", "ownerUserId", "updatedAt") VALUES (${vendorId}, ${`${TAG} Distributor`}, ${`${TAG.toLowerCase()} distributor`}, 'DISTRIBUTOR'::"CompanyRelationshipType", ${admin.id}, ${admin.id}, now())`;
    let n = 0;
    const doc = async (docType: "PURCHASE_ORDER" | "BILL", lines: { name: string; quantity: number; unit: number; tax?: number }[], extra: Record<string, unknown> = {}) => {
      const d = await db.tradeDocument.create({
        data: {
          docType,
          direction: "PURCHASE",
          status: "ISSUED",
          companyId: vendorId,
          docNumber: `${TAG}-${Date.now()}-${++n}`,
          createdById: admin.id,
          lines: { create: lines.map((l, i) => ({ name: l.name, quantity: l.quantity, unitPrice: l.unit, taxableValue: l.unit * l.quantity, taxRatePercent: l.tax ?? 18, lineTotal: l.unit * l.quantity * 1.18, sortOrder: i })) },
          ...extra,
        } as never,
        select: { id: true, docNumber: true },
      });
      made.push(d.id);
      return d;
    };
    const order = await doc("PURCHASE_ORDER", [{ name: "Laptop", quantity: 10, unit: 50000 }]);
    const first = await doc("BILL", [{ name: "Laptop", quantity: 6, unit: 50000 }], { sourceDocumentId: order.id });
    const firstCheck = await billPoCheck(first.id);
    ok("a bill made from our PO is checked against it, and matches", firstCheck?.po.id === order.id && firstCheck.how === "FROM_PO" && firstCheck.matches, firstCheck);
    const typed = await doc("BILL", [{ name: "Laptop", quantity: 6, unit: 52000 }], { reference: order.docNumber });
    const typedCheck = await billPoCheck(typed.id);
    ok("a bill typed by hand naming the PO in its reference is checked too", typedCheck?.po.id === order.id && typedCheck.how === "BY_REFERENCE", typedCheck);
    ok("  it sees the 6 billed already: 2 over, and ₹2,000 a unit above on the 4 left", !!typedCheck && typedCheck.rows[0]!.issues.some((i) => i.kind === "OVER_QUANTITY" && i.extra === 104000) && typedCheck.rows[0]!.issues.some((i) => i.kind === "ABOVE_PO_PRICE" && i.extra === 8000), typedCheck?.rows[0]?.issues);
    const loose = await doc("BILL", [{ name: "Laptop", quantity: 1, unit: 50000 }]);
    ok("a bill with no PO behind it has nothing to check against", (await billPoCheck(loose.id)) === null);
    ok("a PO itself isn't a bill to check", (await billPoCheck(order.id)) === null);

    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { BillPoCheckCard } = await import("../src/components/documents/bill-po-check");
    const html = renderToStaticMarkup(createElement(BillPoCheckCard, { check: typedCheck! }));
    ok("the bill's box says which PO, that a line differs, and by how much", html.includes(order.docNumber!) && html.includes("1 line differs") && html.includes("over"), html.slice(0, 200));
  } finally {
    await db.tradeDocument.deleteMany({ where: { id: { in: made } } });
    await db.company.deleteMany({ where: { id: vendorId } });
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
