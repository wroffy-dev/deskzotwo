/**
 * check:old-orders — old orders and the invoices that billed them (owner, 21 Nov 2026 — src/lib/migration/old-orders.ts,
 * src/lib/collections/chased-orders.ts).
 *
 *   1. A line fits an order: same customer, same product (by item, else by name), same quantity, from a month before to
 *      two months after the order.
 *   2. Pairs: linked only when the only fit either way; two that fit, or a line two orders fit, are left to choose.
 *   3. Collections, credit and "to invoice" leave old orders out — from the switch day, and never the old CRM's.
 *   4. The order page's link: an old order takes the old system's invoice, an order raised here never does.
 *   5. "To invoice" still runs against the database with the new conditions.
 *
 *   npm run check:old-orders
 */
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fits, nearestPairs, pairUp, productKey } from "../src/lib/migration/old-orders";
import { bookedFrom } from "../src/lib/collections/chased-orders";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
const read = (p: string) => fs.readFileSync(p, "utf8");
const at = (d: string) => new Date(`${d}T00:00:00Z`);

const order = { id: "o1", companyId: "c1", itemId: "i1", itemName: "STAAD Pro", quantity: 1, at: at("2026-06-10") };
const line = { id: "l1", companyId: "c1", itemId: "i1", name: "STAAD Pro", quantity: 1, issueDate: at("2026-06-20") };

async function main() {
  console.log("1. What fits");
  await test("same customer, product, quantity, within the window", () => assert.ok(fits(order, line)));
  await test("another customer, product or quantity doesn't", () => {
    assert.ok(!fits(order, { ...line, companyId: "c2" }));
    assert.ok(!fits(order, { ...line, itemId: "i2", name: "Acrobat Pro" }));
    assert.ok(!fits(order, { ...line, quantity: 2 }));
  });
  await test("a line with no item is matched by its name", () => {
    assert.ok(fits(order, { ...line, itemId: null, name: "staad-pro" }));
    assert.ok(!fits(order, { ...line, itemId: null, name: "STAAD Pro Advanced" }));
  });
  await test("another item for the same product is matched by name — the line's, or its item's", () => {
    assert.ok(fits(order, { ...line, itemId: "zoho-staad", name: "STAAD Pro" }));
    assert.ok(fits(order, { ...line, itemId: "zoho-staad", name: "Bentley licence, 1 seat", itemName: "STAAD Pro" }));
    assert.ok(!fits(order, { ...line, itemId: "zoho-other", name: "STAAD Pro Advanced" }));
  });
  await test("brackets and how it was sold don't make another product; another edition does", () => {
    assert.equal(productKey("Microsoft 365 Business Basic (With Teams) - Annual"), productKey("Microsoft 365 Business Basic"));
    assert.equal(productKey("AutoCAD Renewal"), productKey("AutoCAD"));
    assert.notEqual(productKey("AutoCAD LT"), productKey("AutoCAD"));
    assert.notEqual(productKey("Microsoft 365 Business Standard"), productKey("Microsoft 365 Business Basic"));
  });
  await test("from a month before to two months after", () => {
    assert.ok(fits(order, { ...line, issueDate: at("2026-05-11") }));
    assert.ok(!fits(order, { ...line, issueDate: at("2026-05-10") }));
    assert.ok(fits(order, { ...line, issueDate: at("2026-08-09") }));
    assert.ok(!fits(order, { ...line, issueDate: at("2026-08-10") }));
  });

  console.log("2. Pairs");
  await test("the only fit either way is sure", () => {
    const p = pairUp([order], [line]);
    assert.equal(p.sure.length, 1);
    assert.equal(p.choose.length + p.none.length, 0);
  });
  await test("two lines that fit one order: left to choose", () => {
    const p = pairUp([order], [line, { ...line, id: "l2", issueDate: at("2026-06-25") }]);
    assert.equal(p.sure.length, 0);
    assert.equal(p.choose[0]?.[1].length, 2);
  });
  await test("one line two orders fit: both left to choose, neither linked", () => {
    const p = pairUp([order, { ...order, id: "o2" }], [line]);
    assert.equal(p.sure.length, 0);
    assert.equal(p.choose.length, 2);
  });
  await test("no line: none", () => assert.equal(pairUp([order], []).none.length, 1));

  console.log("2b. Those left to choose, by nearest date");
  await test("each order takes the line nearest its date", () => {
    const near = { ...line, id: "near", issueDate: at("2026-06-12") };
    const far = { ...line, id: "far", issueDate: at("2026-07-20") };
    const got = nearestPairs([[order, [far, near]]]);
    assert.deepEqual(got.map(([o, l]) => [o.id, l.id]), [["o1", "near"]]);
  });
  await test("a line bills one order: two orders, two lines, one each — nearest first", () => {
    const o2 = { ...order, id: "o2", at: at("2026-07-01") };
    const a = { ...line, id: "a", issueDate: at("2026-06-11") };
    const b = { ...line, id: "b", issueDate: at("2026-07-02") };
    const got = nearestPairs([[order, [a, b]], [o2, [a, b]]]);
    assert.deepEqual(got.map(([o, l]) => o.id + l.id).sort(), ["o1a", "o2b"]);
  });
  await test("one line, two orders: only the nearer order gets it", () => {
    const o2 = { ...order, id: "o2", at: at("2026-06-25") };
    const got = nearestPairs([[order, [line]], [o2, [line]]]);
    assert.deepEqual(got.map(([o]) => o.id), ["o2"]);
  });
  await test("a line a sure pair took is never offered", () => {
    assert.equal(nearestPairs([[order, [line]]], new Set(["l1"])).length, 0);
  });

  console.log("3. Left out of what's owed");
  await test("from the switch day, by booking date — else creation", () => {
    assert.deepEqual(bookedFrom(null), {});
    const w = bookedFrom(at("2026-12-01")) as { OR: unknown[] };
    assert.equal(w.OR.length, 2);
  });
  await test("collections, credit and to-invoice all use it", () => {
    const load = read("src/lib/collections/load.ts");
    assert.ok(load.includes("bookedFrom(from)") && load.includes("withoutOldCrmOrders(allOrders)"));
    const credit = read("src/lib/credit/load.ts");
    assert.ok(credit.includes("bookedFrom(await billedHereFrom())") && credit.includes("withoutOldCrmOrders(allOrders)"));
    const billing = read("src/lib/orders/billing.ts");
    assert.ok(billing.includes("legacy_import_records") && billing.includes("billedHereFrom()"));
  });

  console.log("4. The order page's link");
  await test("an old order is offered the old system's invoices; one raised here only Deskzo's", () => {
    const a = read("src/actions/order-billing.ts");
    assert.ok(a.includes(`old ? { origin: { in: ["IMPORTED", "MIGRATED"] } } : RAISED_IN_DESKZO`));
    assert.ok(a.includes("isImported(line.document) && !old") && a.includes("!isImported(line.document) && old"));
  });

  console.log("5. To invoice, against the database");
  await test("the query runs, and leaves out what the old CRM's import made", async () => {
    const { toInvoiceWhere } = await import("../src/lib/orders/billing");
    const { db } = await import("../src/lib/db");
    const where = (await toInvoiceWhere()) as { id: { in: string[] } };
    assert.ok(Array.isArray(where.id.in));
    if (where.id.in.length) {
      const imported = await db.legacyImportRecord.count({ where: { kind: "customer_product", recordId: { in: where.id.in } } });
      assert.equal(imported, 0);
    }
  });

  console.log(`\nAll ${passed} old-order checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
