"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { mayAccess } from "@/lib/authz/access";
import { refuseWhileViewingAs } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { plainError } from "@/lib/plain-error";
import { workspacePack } from "@/lib/country-pack";
import { workspaceClock } from "@/lib/time/workspace";
import { isModuleEnabled } from "@/actions/module";
import { isReceivable } from "@/lib/trade-documents";
import { invoiceBalance } from "@/lib/collect/balance";
import { lockSettlement } from "@/lib/finance/settlement-lock";
import { syncInvoiceStatus } from "@/lib/receivables/sync";
import { badDebtRelief } from "@/lib/receivables/write-off";
import { ensureChartOfAccounts, postInvoiceWriteOffToLedger, reverseInvoiceWriteOff } from "@/lib/ledger/journal";
import type { ActionResult } from "@/actions/company";

/**
 * Writing off an invoice the customer will never pay (owner, 15 Nov 2026 — src/lib/receivables/write-off.ts). Whoever
 * runs the finance function (`payments.manage`) and may open the invoice; what is left on it goes, all at once, posted
 * to Bad Debts where Accounting is on. In the UAE the VAT on it can be claimed back as bad-debt relief, once its
 * conditions are met. Undone — the customer paid after all — its entry reversed on the day it's undone.
 */

const NO_RIGHT = "Writing off needs the right to manage finance records.";
const day = (v: unknown): Date | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? new Date(`${v}T00:00:00Z`) : null);

async function financeUser(invoiceId: string, edit: boolean): Promise<{ id: string } | string> {
  const user = await requireModuleUser("receivables");
  if (edit) {
    const viewingAs = await refuseWhileViewingAs();
    if (viewingAs) return viewingAs;
  }
  if (!(await can(user.id, "payments.manage"))) return NO_RIGHT;
  if (typeof invoiceId !== "string" || !(await mayAccess(user.id, "documents", edit ? "edit" : "view", invoiceId))) return "Invoice not found.";
  return user;
}

const invoiceSelect = { id: true, docType: true, status: true, docNumber: true, companyId: true, currency: true, exchangeRate: true, total: true, igstAmount: true, issueDate: true, company: { select: { name: true } } } satisfies Prisma.TradeDocumentSelect;

export type WriteOffPreview = { balance: number; currency: string; uae: boolean; relief: number; reliefWhy: string | null; today: string; issueDate: string };

/** What writing it off would do on a day: what goes, and the VAT relief claimable (UAE) or why not. */
export async function writeOffPreview(invoiceId: string, writtenOffOn: string, customerNotifiedOn: string | null): Promise<ActionResult<WriteOffPreview>> {
  const user = await financeUser(invoiceId, false);
  if (typeof user === "string") return { ok: false, error: user };
  const invoice = await db.tradeDocument.findUnique({ where: { id: invoiceId }, select: invoiceSelect });
  if (!invoice || !isReceivable(invoice.docType)) return { ok: false, error: "Invoice not found." };
  const balance = (await invoiceBalance(invoiceId))?.balance ?? 0;
  const clock = await workspaceClock();
  const on = day(writtenOffOn) ?? new Date(`${clock.today()}T00:00:00Z`);
  const uae = workspacePack().country === "AE";
  const relief = badDebtRelief({ uae, issueDate: invoice.issueDate, writtenOffOn: on, total: Number(invoice.total), vat: Number(invoice.igstAmount), amount: balance, customerNotifiedOn: day(customerNotifiedOn) });
  return { ok: true, data: { balance, currency: invoice.currency, uae, relief: relief.vat, reliefWhy: relief.why, today: clock.today(), issueDate: invoice.issueDate.toISOString().slice(0, 10) } };
}

export async function writeOffInvoice(input: { invoiceId: string; writtenOffOn: string; reason: string; customerNotifiedOn?: string | null; claimRelief?: boolean }): Promise<ActionResult<{ amount: number; relief: number }>> {
  const invoiceId = input?.invoiceId;
  const user = await financeUser(invoiceId, true);
  if (typeof user === "string") return { ok: false, error: user };
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
  if (reason.length < 3) return { ok: false, error: "Say why it's written off — the customer closed, a dispute lost, too small to chase." };
  const on = day(input.writtenOffOn);
  if (!on) return { ok: false, error: "Pick the day it's written off." };
  const notified = input.customerNotifiedOn ? day(input.customerNotifiedOn) : null;
  if (input.customerNotifiedOn && !notified) return { ok: false, error: "The day the customer was told isn't a date." };
  const clock = await workspaceClock();
  if (on.toISOString().slice(0, 10) > clock.today()) return { ok: false, error: "A write-off can't be dated ahead of today." };

  const invoice = await db.tradeDocument.findUnique({ where: { id: invoiceId }, select: invoiceSelect });
  if (!invoice || !isReceivable(invoice.docType)) return { ok: false, error: "Only an invoice or a debit note can be written off." };
  if (invoice.status === "DRAFT") return { ok: false, error: "A draft isn't owed — issue it, or delete it." };
  if (invoice.status === "CANCELLED") return { ok: false, error: "A cancelled invoice isn't owed." };
  if (on < invoice.issueDate) return { ok: false, error: "That's before the invoice's own date." };

  const uae = workspacePack().country === "AE";
  const books = await isModuleEnabled("accounting");
  let result: { amount: number; relief: number };
  try {
    if (books) await ensureChartOfAccounts();
    result = await db.$transaction(
      async (tx) => {
        // As a payment would (SEC-12): the invoice locked and its balance read again, so a payment recorded at the same
        // moment can't be written off too.
        await lockSettlement(tx, { documents: [invoiceId] });
        if (await tx.invoiceWriteOff.findUnique({ where: { invoiceId }, select: { id: true } })) throw new Error("It's already written off.");
        const balance = (await invoiceBalance(invoiceId, tx))?.balance ?? 0;
        if (balance < 0.01) throw new Error("Nothing is left to write off — it's settled.");
        const relief = input.claimRelief ? badDebtRelief({ uae, issueDate: invoice.issueDate, writtenOffOn: on, total: Number(invoice.total), vat: Number(invoice.igstAmount), amount: balance, customerNotifiedOn: notified }) : { vat: 0, why: null };
        if (input.claimRelief && relief.why) throw new Error(relief.why);
        const rate = Number(invoice.exchangeRate) || 1;
        const baseAmount = Math.round(balance * rate * 100) / 100;
        const row = await tx.invoiceWriteOff.create({
          data: { invoiceId, companyId: invoice.companyId, amount: balance, currency: invoice.currency, baseAmount, reliefVat: relief.vat, writtenOffOn: on, reason, customerNotifiedOn: notified, createdById: user.id },
          select: { id: true },
        });
        if (books) {
          const entry = await postInvoiceWriteOffToLedger(tx, { writeOffId: row.id, companyId: invoice.companyId, baseAmount, reliefVat: Math.round(relief.vat * rate * 100) / 100, on, label: `${invoice.docNumber}, ${invoice.company.name}`, userId: user.id });
          await tx.invoiceWriteOff.update({ where: { id: row.id }, data: { journalEntryId: entry.id } });
        }
        return { amount: balance, relief: relief.vat };
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    return { ok: false, error: plainError(error, "It couldn't be written off.") };
  }
  await syncInvoiceStatus(invoiceId);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TradeDocument", entityId: invoiceId, entityLabel: `${invoice.docNumber} written off: ${result.amount.toFixed(2)} ${invoice.currency}${result.relief > 0 ? `, VAT relief ${result.relief.toFixed(2)}` : ""} — ${reason}` });
  revalidatePath(`/documents/${invoiceId}`);
  revalidatePath("/receivables");
  revalidatePath("/accounting/journal");
  return { ok: true, data: result };
}

/** Takes a write-off back: the invoice owed again, its entry reversed today. */
export async function undoWriteOff(invoiceId: string): Promise<ActionResult<null>> {
  const user = await financeUser(invoiceId, true);
  if (typeof user === "string") return { ok: false, error: user };
  const clock = await workspaceClock();
  const today = new Date(`${clock.today()}T00:00:00Z`);
  let label = "";
  try {
    await db.$transaction(
      async (tx) => {
        await lockSettlement(tx, { documents: [invoiceId] });
        const row = await tx.invoiceWriteOff.findUnique({ where: { invoiceId } });
        if (!row) throw new Error("It isn't written off.");
        label = `${Number(row.amount).toFixed(2)} ${row.currency}`;
        if (row.journalEntryId) await reverseInvoiceWriteOff(tx, row.journalEntryId, today, user.id);
        await tx.invoiceWriteOff.delete({ where: { id: row.id } });
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    return { ok: false, error: plainError(error, "The write-off couldn't be undone.") };
  }
  await syncInvoiceStatus(invoiceId);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TradeDocument", entityId: invoiceId, entityLabel: `Write-off of ${label} undone` });
  revalidatePath(`/documents/${invoiceId}`);
  revalidatePath("/receivables");
  revalidatePath("/accounting/journal");
  return { ok: true, data: null };
}
