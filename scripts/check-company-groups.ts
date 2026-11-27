/**
 * check:company-groups — customer groups (owner, 17 Nov 2026 — src/lib/companies/groups.ts): legal entities that are one
 * customer, any of which may pay the others' invoices.
 *
 *   · linking: a group made from two companies, a third joining, two groups folded into one, leaving;
 *   · a payment from one group company on another's invoice: the invoice settled, a GROUP_TRANSFER moving the money
 *     between their receivables, each one's account (the ledger and the statement) back to nothing;
 *   · the allocation removed: the transfer reversed, the payment on account again;
 *   · the migration: a Zoho receipt naming an invoice that sits under another group company finds it; outside the
 *     group it waits, as before.
 *
 * Its own companies (ZZGRP …) and invoices, removed in a finally with their entries.
 *
 *   npm run check:company-groups
 */
import "dotenv/config";
import Module from "node:module";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "../src/lib/db";

// The company page's card renders as the super admin, with no session (memory: rendering pages without a session).
let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ refresh() {}, push() {} }), notFound: () => { throw new Error("notFound"); }, redirect: () => { throw new Error("redirect"); } };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { ...real, requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const TAG = "ZZGRP";
const round2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const groups = await import("../src/lib/companies/groups");
  const { recordPaymentOnInvoice } = await import("../src/lib/receivables/record");
  const { postDocumentToLedger, reverseGroupTransfer, resolveAccounts } = await import("../src/lib/ledger/journal");
  const { SYSTEM_ACCOUNTS } = await import("../src/lib/ledger/chart");
  const { partyStatement } = await import("../src/lib/receivables/statement");
  const { checkPayment } = await import("../src/lib/migration/receipts");
  const { workspaceClock } = await import("../src/lib/time/workspace");

  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin");
  actorId = admin.id;
  const head = await db.branch.findFirst({ where: { isHeadOffice: true }, select: { id: true } });
  const companies: string[] = [];
  const invoices: string[] = [];
  const payments: string[] = [];
  try {
    const company = async (name: string) => {
      const c = await db.company.create({ data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: admin.id, ownerUserId: admin.id, relationshipType: "CLIENT", stage: "CUSTOMER" } as never, select: { id: true } });
      companies.push(c.id);
      return c.id;
    };
    const payer = await company("Auctus Advisors Private Limited");
    const holder = await company("YCP India Private Limited");
    const third = await company("YCP Holdings Private Limited");
    const outsider = await company("Unrelated Traders Private Limited");

    // ── Linking
    const g1 = await groups.linkIntoGroup(payer, holder, admin.id);
    ok("two companies linked make a group of two", (await groups.groupOf(payer))?.companies.length === 2 && (await groups.sameCustomerGroup(payer, holder)));
    ok("  the other is in the group, an unrelated company isn't", (await groups.groupCompaniesOf(holder)).some((c) => c.id === payer) && !(await groups.sameCustomerGroup(payer, outsider)));
    const lone = await company("Lone Subsidiary Private Limited");
    const g2 = await groups.linkIntoGroup(third, lone, admin.id);
    ok("  a second group, separate", g2 !== g1 && !(await groups.sameCustomerGroup(holder, third)));
    await groups.linkIntoGroup(holder, third, admin.id);
    ok("  linking across them folds the two groups into one, the first's", (await groups.groupOf(lone))?.id === g1 && (await groups.groupOf(payer))?.companies.length === 4);
    await groups.leaveGroup(lone);
    ok("  leaving takes one out, the rest stay", (await groups.groupOf(lone)) === null && (await groups.groupOf(payer))?.companies.length === 3);

    // ── A payment from one, on the other's invoice
    const issued = new Date("2026-08-24T00:00:00Z");
    const invoice = await db.tradeDocument.create({
      data: { docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: holder, docNumber: `${TAG}-${Date.now()}`, taxableValue: 52800, igstAmount: 9504, total: 62304, createdById: admin.id, issueDate: issued, dueDate: issued, branchId: head?.id ?? null } as never,
      select: { id: true, docNumber: true },
    });
    invoices.push(invoice.id);
    const payment = await db.$transaction(async (tx) => {
      await postDocumentToLedger(tx, invoice.id, admin.id);
      return recordPaymentOnInvoice(tx, {
        invoiceId: invoice.id, companyId: payer, branchId: head?.id ?? "", amount: 62304, applied: 62304, currency: "INR", rate: 1,
        paidOn: new Date("2026-09-10T00:00:00Z"), method: "BANK_TRANSFER", reference: "UTR-ZZGRP", notes: null, userId: admin.id,
      });
    });
    payments.push(payment.id);
    const stored = await db.payment.findUnique({ where: { id: payment.id }, select: { companyId: true, allocations: { select: { id: true, documentId: true, amount: true } } } });
    ok("the payment is the payer's, set against the holder's invoice", stored?.companyId === payer && stored.allocations.length === 1 && stored.allocations[0]!.documentId === invoice.id, stored);

    const ar = (await resolveAccounts(db as never, [SYSTEM_ACCOUNTS.AR])).get(SYSTEM_ACCOUNTS.AR)!;
    const transfer = await db.journalEntry.findFirst({ where: { paymentId: payment.id, source: "GROUP_TRANSFER" }, select: { id: true, date: true, lines: { select: { accountId: true, debit: true, credit: true, companyId: true } } } });
    const line = (companyId: string) => transfer?.lines.find((l) => l.companyId === companyId && l.accountId === ar);
    ok("  a GROUP_TRANSFER: Dr AR the payer, Cr AR the holder, ₹62,304", Number(line(payer)?.debit) === 62304 && Number(line(holder)?.credit) === 62304, transfer?.lines);
    const ledger = async (companyId: string) => {
      const rows = await db.journalLine.findMany({ where: { accountId: ar, companyId }, select: { debit: true, credit: true } });
      return round2(rows.reduce((t, r) => t + Number(r.debit) - Number(r.credit), 0));
    };
    ok("  the ledger: each one's receivable back to nothing", (await ledger(payer)) === 0 && (await ledger(holder)) === 0, { payer: await ledger(payer), holder: await ledger(holder) });
    const [sPayer, sHolder] = await Promise.all([partyStatement("AR", payer), partyStatement("AR", holder)]);
    ok("  the statements agree: nothing owed, nothing on account, on either", sPayer.balance === 0 && sPayer.unappliedPayments === 0 && sHolder.balance === 0 && sHolder.outstanding === 0, { payer: [sPayer.balance, sPayer.unappliedPayments], holder: [sHolder.balance, sHolder.outstanding] });
    ok("  the holder's statement says who paid", sHolder.lines.some((l) => /Paid by .*Auctus/.test(l.description) && l.credit === 62304) && sHolder.lines[sHolder.lines.length - 1]!.balance === 0, sHolder.lines.map((l) => l.description));
    ok("  the payer's says where it went", sPayer.lines.some((l) => /Set against .*YCP India.*'s /.test(l.description) && l.debit === 62304) && sPayer.lines[sPayer.lines.length - 1]!.balance === 0, sPayer.lines.map((l) => l.description));

    // ── The company page
    const { CompanyGroupCard } = await import("../src/components/companies/company-group-card");
    const card = renderToStaticMarkup((await CompanyGroupCard({ companyId: holder, userId: admin.id })) as ReactElement);
    ok(
      "the company page's card names the group's companies, each one's money and the group's, and offers Link",
      card.includes("Group companies") && card.includes("Auctus Advisors") && card.includes("YCP Holdings") && card.includes("The group") && card.includes(">Link<"),
      card.slice(0, 400),
    );
    const loneCard = renderToStaticMarkup((await CompanyGroupCard({ companyId: outsider, userId: admin.id })) as ReactElement);
    ok("  a company in no group is offered the link, with what it's for", loneCard.includes("Another legal entity that is the same customer") && !loneCard.includes("The group"));

    // ── The allocation removed
    await db.$transaction(async (tx) => {
      await reverseGroupTransfer(tx, stored!.allocations[0]!.id, admin.id);
      await tx.paymentAllocation.delete({ where: { id: stored!.allocations[0]!.id } });
    });
    const [after, sPayer2, sHolder2] = await Promise.all([db.journalEntry.findFirst({ where: { id: transfer!.id }, select: { reversedBy: { select: { id: true } } } }), partyStatement("AR", payer), partyStatement("AR", holder)]);
    ok("the allocation removed: its transfer reversed", !!after?.reversedBy);
    ok("  the payer has the money on account, the holder owes the invoice again", Math.abs(sPayer2.unappliedPayments) === 62304 && sHolder2.outstanding === 62304 && (await ledger(payer)) === -62304 && (await ledger(holder)) === 62304, { onAccount: sPayer2.unappliedPayments, owes: sHolder2.outstanding, payer: await ledger(payer), holder: await ledger(holder) });

    // ── The migration: a receipt naming the holder's invoice under the payer
    const clock = await workspaceClock();
    const ctx = { migrationId: `${TAG}-dry`, window: { from: "2026-04-01", to: "2026-12-01" }, clock, userId: admin.id };
    const receipt = (party: string, number: string) => ({
      number,
      firstLine: 2,
      rows: [{ line: 2, row: { "Payment number": number, Date: "2026-09-10", Customer: `${TAG} ${party}`, Amount: "62304", Mode: "Bank Transfer", Reference: "", "Deposit to": "", Invoice: invoice.docNumber, "Amount applied": "62304", Notes: "" } }],
    });
    const across = await checkPayment("RECEIVED", receipt("Auctus Advisors Private Limited", `${TAG}-R1`), ctx);
    ok("the migration: a receipt under the payer finds the invoice under the holder", across.kind === "create", across);
    const stranger = await checkPayment("RECEIVED", receipt("Unrelated Traders Private Limited", `${TAG}-R2`), ctx);
    ok("  outside the group it still waits for the invoice", stranger.kind === "error" && /isn't in Deskzo/.test(stranger.error), stranger);
  } finally {
    const entries = (await db.journalEntry.findMany({ where: { lines: { some: { companyId: { in: companies } } } }, select: { id: true } })).map((e) => e.id);
    await db.journalEntry.deleteMany({ where: { reversesId: { in: entries } } });
    await db.journalEntry.deleteMany({ where: { id: { in: entries } } });
    await db.payment.deleteMany({ where: { id: { in: payments } } });
    await db.tradeDocument.deleteMany({ where: { id: { in: invoices } } });
    await db.companyGroupMember.deleteMany({ where: { companyId: { in: companies } } });
    await db.companyGroup.deleteMany({ where: { members: { none: {} }, name: { startsWith: TAG } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
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
