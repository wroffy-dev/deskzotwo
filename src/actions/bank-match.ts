"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { copilotConfig } from "@/lib/copilot/settings";
import { bankCurrencies } from "@/lib/finance/bank-currency";
import { referenceOf } from "@/lib/bank-match/rules";
import { BankMatchRefusal, askAboutMoneyIn, bankLineOfPayment, moneyInView, sameReceiptInBooks, statementLineFor, type MoneyInView } from "@/lib/bank-match/server";
import { recordInvoicePayment, applyPaymentToInvoice } from "@/actions/receivable";
import { recordPayment } from "@/actions/payment";
import { matchStatementLine } from "@/actions/bank";
import type { ActionResult } from "@/actions/company";

/**
 * Arjun on Banking: money in the books don't have yet (owner, 20 Nov 2026 — src/lib/bank-match). Seeing it takes what the
 * Banking screen takes (accounting, "Manage finance records"); recording takes "Record payments" too, and goes through
 * the same actions as Record payment on an invoice and on a customer's account — every check they make, this makes.
 * Asking Deskzo AI takes it on and "Use Deskzo AI". Never while viewing as somebody.
 */

async function who(): Promise<{ id: string } | { error: string }> {
  const user = await requireModuleAccess("accounting");
  if (!(await can(user.id, "payments.manage"))) return { error: "Banking takes “Manage finance records”." };
  return { id: user.id };
}

export type MoneyInPanel = MoneyInView & { mayAsk: boolean; mayRecord: boolean };

/** Arjun's proposals for one account's money-in lines. Null for somebody Banking isn't for. */
export async function moneyInPanel(bankAccountId: string): Promise<MoneyInPanel | null> {
  const user = await who();
  if ("error" in user) return null;
  const view = await moneyInView(String(bankAccountId ?? ""));
  if (!view) return null;
  const [ai, mayUse, mayRecord] = await Promise.all([copilotConfig(), can(user.id, "copilot.use"), can(user.id, "payments.record")]);
  return { ...view, mayAsk: ai.enabled && mayUse, mayRecord };
}

/** Deskzo AI asked about the lines the rules couldn't place. */
export async function askArjunMoneyIn(bankAccountId: string): Promise<ActionResult<{ asked: number; placed: number }>> {
  const user = await who();
  if ("error" in user) return { ok: false, error: user.error };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await copilotConfig()).enabled) return { ok: false, error: "Deskzo AI is switched off for this workspace." };
  if (!(await can(user.id, "copilot.use"))) return { ok: false, error: "Asking Arjun uses Deskzo AI — that takes the “Use Deskzo AI” permission." };
  try {
    const result = await askAboutMoneyIn(String(bankAccountId ?? ""), user.id);
    revalidatePath("/accounting/banking");
    return { ok: true, data: result };
  } catch (err) {
    if (err instanceof BankMatchRefusal) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Records the money a statement line shows as the person confirmed it — onto one invoice; or onto the customer's account
 * and applied to each invoice; or onto their account alone — into this bank account, dated the statement's day, with
 * its UTR; then ticks the line against the payment it made. Refused when a receipt of that amount is already in the
 * books unmatched: that's to be matched, not recorded twice.
 */
export async function recordFromBankLine(input: {
  statementLineId: string;
  companyId: string;
  allocations: { invoiceId: string; amount: number }[];
}): Promise<ActionResult<{ paymentId: string; matched: boolean; notes: string[] }>> {
  const user = await who();
  if ("error" in user) return { ok: false, error: user.error };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await can(user.id, "payments.record"))) return { ok: false, error: "You don't have permission to record payments." };

  const line = await statementLineFor(String(input?.statementLineId ?? ""));
  if (!line) return { ok: false, error: "That statement line isn't there any more." };
  if (line.matchedLineId) return { ok: false, error: "That statement line is matched already." };
  const amount = Number(line.amount);
  if (!(amount > 0)) return { ok: false, error: "That line is money out — only money in is recorded from here." };
  if ((await bankCurrencies([line.bankAccount.id])).get(line.bankAccount.id)) return { ok: false, error: "Money in on a foreign-currency account is recorded by hand, for now." };
  if ((await sameReceiptInBooks(line.bankAccount.ledgerAccountId, amount, line.date)) > 0) {
    return { ok: false, error: "A receipt of this amount is already in the books, unmatched — match it to the line instead of recording it again." };
  }
  const companyId = String(input?.companyId ?? "");
  if (!(await db.company.findUnique({ where: { id: companyId }, select: { id: true } }))) return { ok: false, error: "Choose who the money is from." };
  const allocations = (Array.isArray(input?.allocations) ? input.allocations : [])
    .map((a) => ({ invoiceId: String(a?.invoiceId ?? ""), amount: Math.round(Number(a?.amount) * 100) / 100 }))
    .filter((a) => a.invoiceId && a.amount > 0);
  const applied = allocations.reduce((t, a) => t + a.amount, 0);
  if (applied > amount + 0.005) return { ok: false, error: "More is applied to invoices than the line brought in." };

  const paidOn = line.date.toISOString().slice(0, 10);
  const reference = referenceOf({ narration: line.narration, reference: line.reference }) ?? "";
  const notes = `From the bank statement: ${line.narration}`.slice(0, 500);
  const notesOut: string[] = [];
  let paymentId: string;

  if (allocations.length === 1 && Math.abs(allocations[0]!.amount - amount) <= 0.005) {
    // All of it onto one invoice: Record payment on the invoice, as a person would.
    const invoice = await db.tradeDocument.findUnique({ where: { id: allocations[0]!.invoiceId }, select: { companyId: true } });
    const r = await recordInvoicePayment({
      invoiceId: allocations[0]!.invoiceId,
      amount,
      paidOn,
      method: "BANK_TRANSFER",
      reference,
      notes,
      bankAccountId: line.bankAccount.id,
      ...(invoice && invoice.companyId !== companyId ? { paidByCompanyId: companyId } : {}),
    });
    if (!r.ok) return r;
    paymentId = r.data.id;
  } else {
    // Onto their account, then applied to each invoice — the rest stays on account, to apply later.
    const r = await recordPayment({ companyId, amount, paidOn, method: "BANK_TRANSFER", reference, notes, bankAccountId: line.bankAccount.id });
    if (!r.ok) return r;
    paymentId = r.data.id;
    for (const a of allocations) {
      const applied = await applyPaymentToInvoice(paymentId, a.invoiceId, a.amount);
      if (!applied.ok) notesOut.push(`Not applied to an invoice: ${applied.error}`);
    }
    if (amount - applied > 0.005) notesOut.push(`₹${Math.round((amount - applied) * 100) / 100} is on their account, to apply later.`);
  }

  // The line ticked against the payment just made.
  const bookLineId = await bankLineOfPayment(paymentId, line.bankAccount.ledgerAccountId);
  let matched = false;
  if (bookLineId) {
    const m = await matchStatementLine(line.id, bookLineId);
    matched = m.ok;
    if (!m.ok) notesOut.push(`Recorded, but not matched to the line: ${m.error}`);
  } else notesOut.push("Recorded, but its entry isn't on this bank account — match it by hand.");
  revalidatePath("/accounting/banking");
  return { ok: true, data: { paymentId, matched, notes: notesOut } };
}
