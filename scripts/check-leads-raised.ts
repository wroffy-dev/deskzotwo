/**
 * check:leads-raised — incentives for leads somebody raised and somebody else won (owner, 1 Nov 2026):
 * the "Leads raised and won" and "Value of leads raised and won" target measures
 * (src/lib/targets/measure.ts), the Support lead source, and the metric definitions.
 *
 * A fixture of its own in the local database: a support person raises three leads — one won by sales, one
 * still open, one they own and won themselves — and only the first counts, by number and by value; the
 * salesperson's own "Leads won" still counts it. Named ZZPROBE_LR and removed in a finally.
 *
 *   npm run check:leads-raised
 */
import "dotenv/config";
import { directClient } from "../src/lib/tenancy/direct-client";
import { measure } from "../src/lib/targets/measure";
import { METRICS } from "../src/lib/targets/metrics";
import { LEAD_SOURCE_LABELS } from "../src/lib/leads/source";
import { SOURCE_POINTS } from "../src/lib/leads/score";
import { raisedLeadInvoices, raisedLeadMetric } from "../src/lib/incentives/raised-collection";

const db = directClient();
const TAG = "ZZPROBE_LR";
const MAIL = "@zzprobe-lr.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  await db.payment.deleteMany({ where: { reference: { startsWith: TAG } } });
  await db.tradeDocument.deleteMany({ where: { docNumber: { startsWith: TAG } } });
  await db.lead.deleteMany({ where: { title: { startsWith: TAG } } });
  await db.company.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.user.deleteMany({ where: { email: { endsWith: MAIL } } });
}

async function main() {
  console.log("\n— Definitions —\n");
  const raised = METRICS.find((m) => m.key === "LEADS_RAISED_WON");
  const value = METRICS.find((m) => m.key === "LEAD_VALUE_RAISED_WON");
  ok("Leads raised and won: a count, for support, needing leads", raised?.unit === "COUNT" && raised.team === "Support" && raised.needsLeads === true);
  ok("Value of leads raised and won: money", value?.unit === "CURRENCY" && value.needsLeads === true);
  ok("a Support lead source, as warm as an existing customer asking", LEAD_SOURCE_LABELS.SUPPORT === "Support team" && SOURCE_POINTS.SUPPORT === SOURCE_POINTS.EXISTING_CUSTOMER);

  await cleanup();
  try {
    const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
    if (!admin) throw new Error("The local database has no super admin.");
    const support = await db.user.create({ data: { name: "Zz Support", email: `support${MAIL}`, role: "SUPPORT", passwordHash: "!" }, select: { id: true } });
    const seller = await db.user.create({ data: { name: "Zz Seller", email: `seller${MAIL}`, role: "SALES", passwordHash: "!" }, select: { id: true } });
    const company = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, createdById: admin.id } });
    const now = new Date();
    const lead = (title: string, data: { ownerUserId: string; status: "WON" | "NEW"; value: number }) =>
      db.lead.create({
        data: { title: `${TAG} ${title}`, companyId: company.id, createdByUserId: support.id, ownerUserId: data.ownerUserId, status: data.status, estimatedValue: data.value, source: "SUPPORT", stageChangedAt: now },
      });
    const won = await lead("passed on and won", { ownerUserId: seller.id, status: "WON", value: 50000 });
    await lead("passed on, still open", { ownerUserId: seller.id, status: "NEW", value: 90000 });
    await lead("their own and won", { ownerUserId: support.id, status: "WON", value: 70000 });

    console.log("\n— Measured —\n");
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const window = (userIds: string[]) => ({ from: new Date(day.getTime() - 86_400_000), to: new Date(day.getTime() + 86_400_000), userIds });
    const count = await measure(db, "LEADS_RAISED_WON", window([support.id]));
    ok("support: one lead raised and won — not the open one, not their own", count === 1, count);
    const worth = await measure(db, "LEAD_VALUE_RAISED_WON", window([support.id]));
    ok("…worth its estimated value", worth === 50000, worth);
    const own = await measure(db, "LEADS_WON", window([support.id]));
    ok("their own win is under Leads won instead", own === 1, own);
    const sellerWon = await measure(db, "LEADS_WON", window([seller.id]));
    ok("the salesperson's Leads won still counts the one passed on", sellerWon === 1, sellerWon);
    const sellerRaised = await measure(db, "LEADS_RAISED_WON", window([seller.id]));
    ok("…and the salesperson raised none", sellerRaised === 0, sellerRaised);

    console.log("\n— Pay once the money is in —\n");
    const from = new Date(day.getTime() - 86_400_000);
    const to = new Date(day.getTime() + 86_400_000);
    ok("both raised measures ask about collection", raisedLeadMetric("LEADS_RAISED_WON") && raisedLeadMetric("LEAD_VALUE_RAISED_WON") && !raisedLeadMetric("LEADS_WON"));
    ok("won but not invoiced yet: nothing to collect against — held", ((await raisedLeadInvoices([support.id], from, to)).get(support.id) ?? []).length === 0);
    const invoice = await db.tradeDocument.create({
      data: { docNumber: `${TAG}-INV-1`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: company.id, createdById: admin.id, leadId: won.id, total: 59000, issueDate: now },
    });
    await db.tradeDocument.create({
      data: { docNumber: `${TAG}-INV-OTHER`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: company.id, createdById: admin.id, total: 1000, issueDate: now },
    });
    const owed = (await raisedLeadInvoices([support.id], from, to)).get(support.id) ?? [];
    ok("the lead's own invoice is the one counted — not the customer's others", owed.length === 1 && Number(owed[0]!.total) === 59000, owed.length);
    ok("…nothing paid on it yet", owed[0]?.payments.length === 0);
    const payment = await db.payment.create({ data: { companyId: company.id, amount: 59000, paidOn: now, method: "BANK_TRANSFER", reference: `${TAG}-PAY`, recordedByUserId: admin.id } });
    await db.paymentAllocation.create({ data: { paymentId: payment.id, documentId: invoice.id, amount: 59000, allocatedByUserId: admin.id } });
    const paid = (await raisedLeadInvoices([support.id], from, to)).get(support.id) ?? [];
    ok("paid in full: the payment is there to release it", paid.length === 1 && paid[0]!.payments.reduce((t, p) => t + Number(p.amount), 0) === 59000);
    ok("the salesperson's raised leads have no invoices of theirs", !(await raisedLeadInvoices([seller.id], from, to)).has(seller.id));
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
