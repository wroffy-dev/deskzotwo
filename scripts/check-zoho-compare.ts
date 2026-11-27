/**
 * check:zoho-compare — whether what Deskzo says customers owe is right (owner, 6 Nov 2026): the receipts check and
 * Compare with Zoho (src/lib/receivables/zoho-compare.ts). Both read only.
 *
 * Compare's rule on made-up rows; the receipts check on a payment of its own (ZZPROBE_ZC), its figures as they move
 * from what the database held already. Removed in a finally.
 *
 *   npm run check:zoho-compare
 */
import "dotenv/config";
import { directClient } from "../src/lib/tenancy/direct-client";

const db = directClient();
const REF = "ZZPROBE_ZC";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function main() {
  const { compareRows, receiptsCheck } = await import("../src/lib/receivables/zoho-compare");

  console.log("\n— Compare with Zoho —\n");
  const invoice = (docNumber: string, total: number, paid: number, credited = 0, paidBefore = 0) => ({ docNumber, total, paidBefore, exchangeRate: 1, company: { companySeq: 7 }, payments: paid ? [{ amount: paid }] : [], creditsReceived: credited ? [{ amount: credited }] : [] });
  const zoho = (invoice_number: string, balance: number, status = "overdue") => ({ invoice_number, balance, status, customer_name: "Zz Co", date: "2026-05-01", currency_code: "INR" });
  const page = compareRows(
    [zoho("A-SAME", 500), zoho("A-PAID-THERE", 0, "paid"), zoho("A-ROUNDED", 100), zoho("A-LESS-HERE", 900), zoho("A-OLD", 700), zoho("A-NEW", 300), zoho("A-PAID-GONE", 0, "paid"), zoho("A-VOID", 400, "void"), zoho("A-DRAFT", 250, "draft"), zoho("A-APPROVED", 600, "approved"), zoho("A-PENDING", 700, "pending_approval"), zoho("A-REJECTED", 800, "rejected")],
    [invoice("A-SAME", 1000, 500), invoice("A-PAID-THERE", 1000, 0), invoice("A-ROUNDED", 1000, 900.5), invoice("A-LESS-HERE", 1000, 500), invoice("A-VOID", 400, 0)],
    new Set(["A-OLD"]),
    3,
    true,
  );
  const diff = (n: string) => page.differences.find((d) => d.number === n);
  ok("the same balance agrees", !diff("A-SAME") && page.matches >= 1);
  ok("paid in Zoho, owing here: named, with what's over", diff("A-PAID-THERE")?.deskzo === 1000 && diff("A-PAID-THERE")?.zoho === 0 && diff("A-PAID-THERE")?.difference === 1000, diff("A-PAID-THERE"));
  ok("a rupee of rounding is no difference", !diff("A-ROUNDED"), diff("A-ROUNDED"));
  ok("owing less here than in Zoho is named too", diff("A-LESS-HERE")?.difference === -400, diff("A-LESS-HERE"));
  ok("owing in Zoho, an earlier year's not opened: said so", page.notInDeskzo.find((d) => d.number === "A-OLD")?.archived === true);
  ok("owing in Zoho, Deskzo hasn't got it: said so", page.notInDeskzo.find((d) => d.number === "A-NEW")?.archived === false);
  ok("paid in Zoho and not here: nothing to say", !page.notInDeskzo.some((d) => d.number === "A-PAID-GONE"));
  ok("void in Zoho, live here: owes nothing there", diff("A-VOID")?.zoho === 0 && diff("A-VOID")?.deskzo === 400, diff("A-VOID"));
  ok("a draft in Zoho owes nothing", !page.notInDeskzo.some((d) => d.number === "A-DRAFT"));
  // Zoho's approval steps keep a balance on an invoice it doesn't count (owner, 18 Nov 2026): not owing there, not missing here.
  ok("approved but not sent, waiting for approval, rejected: owe nothing in Zoho, not listed as missing", !page.notInDeskzo.some((d) => ["A-APPROVED", "A-PENDING", "A-REJECTED"].includes(d.number)), page.notInDeskzo);
  ok("every row is counted, and the page's own place kept", page.checked === 12 && page.page === 3 && page.hasMore);
  ok("what Zoho says owing: void, drafts and the approval steps out", page.zohoOwing === 500 + 100 + 900 + 700 + 300, page.zohoOwing);

  console.log("\n— The receipts check —\n");
  const company = await db.company.findFirstOrThrow({ select: { id: true } });
  const user = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
  const before = await receiptsCheck();
  const payment = await db.payment.create({ data: { companyId: company.id, direction: "RECEIVED", amount: 1000, paidOn: new Date(), method: "OTHER", reference: REF, recordedByUserId: user.id } });
  try {
    await db.paymentAllocation.create({ data: { paymentId: payment.id, amount: 400, allocatedByUserId: user.id } });
    const after = await receiptsCheck();
    const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
    ok("the payment is counted as received", near(after.received - before.received, 1000) && after.payments - before.payments === 1, { received: after.received - before.received });
    ok("what's set against something is applied", near(after.applied - before.applied, 400));
    ok("the rest is on account", near(after.onAccount - before.onAccount, 600) && after.withMoneyLeft - before.withMoneyLeft === 1);
    ok("the owing figure doesn't move", near(after.open, before.open));
    ok("could-settle never exceeds what's on account, nor what's owing", after.couldSettle <= after.onAccount + 0.01 && after.couldSettle <= after.open + 0.01, after);
    ok("the list is largest could-settle first", after.customers.every((c, i, all) => i === 0 || all[i - 1]!.couldSettle >= c.couldSettle));
  } finally {
    await db.payment.delete({ where: { id: payment.id } });
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
