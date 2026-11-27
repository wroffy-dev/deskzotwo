"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { mayAccess, mayAddTo } from "@/lib/authz/access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { emitPaymentReceived } from "@/lib/automate/emit-records";
import { postPaymentToLedger } from "@/lib/ledger/journal";
import { defaultBranchIdFor } from "@/lib/branches/identity";
import { formatMoney, isBaseCurrency } from "@/lib/currency";
import { claimRequest } from "@/lib/request-once";
import { recordProformaAdvanceSchema } from "@/lib/validation/payment";
import { advanceTotal, applyProformaAdvances, proformaAdvances } from "@/lib/receivables/proforma-advance";
import type { ActionResult } from "@/actions/company";

/** A proforma that can take an advance: issued, or paid against already — not a draft, nor cancelled, rejected or expired. */
const TAKES_ADVANCE = ["ISSUED", "ACCEPTED", "PARTIALLY_PAID", "PAID"];

/**
 * Records an advance received against a proforma invoice (owner, 17 Nov 2026): a payment on the customer's account, as
 * any advance is, tied to the proforma (src/lib/receivables/proforma-advance.ts). The tax invoice raised from the
 * proforma — or from the orders punched from it — takes it when it is issued; one issued already takes it now.
 */
export async function recordProformaAdvance(input: unknown): Promise<ActionResult<{ id: string; applied: number }>> {
  const user = await requireModuleUser("payments");
  if (!(await hasEffectivePermission(user.id, "payments.record"))) return { ok: false, error: "You don't have permission to record payments." };
  const parsed = recordProformaAdvanceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { proformaId, amount, paidOn, method, reference, notes } = parsed.data;

  const proforma = await db.tradeDocument.findUnique({
    where: { id: proformaId },
    select: { id: true, docType: true, status: true, docNumber: true, total: true, currency: true, companyId: true, branchId: true, company: { select: { name: true, ownerUserId: true, relationshipType: true } } },
  });
  // A proforma this person can open, on a customer they may record payments for.
  if (!proforma || proforma.docType !== "PROFORMA" || !(await mayAccess(user.id, "documents", "view", proforma.id)) || !(await mayAddTo(user.id, "payments", proforma.company))) {
    return { ok: false, error: "That proforma no longer exists." };
  }
  if (!TAKES_ADVANCE.includes(proforma.status)) {
    return { ok: false, error: proforma.status === "DRAFT" ? "Issue the proforma before recording an advance against it." : "This proforma is no longer live — record the payment on the customer's account instead." };
  }
  // An advance here is in rupees, as a payment on account is; another currency's is recorded and applied by hand.
  if (!isBaseCurrency(proforma.currency)) {
    return { ok: false, error: `This proforma is in ${proforma.currency}. Record the advance on the customer's account in ${proforma.currency}, then apply it to the invoice.` };
  }
  const received = advanceTotal(await proformaAdvances(proforma.id), proforma.currency);
  const room = Math.round((Number(proforma.total) - received) * 100) / 100;
  if (amount > room + 0.005) {
    return {
      ok: false,
      error: room < 0.01 ? "The whole proforma has been received in advance already." : `Only ${formatMoney(room, proforma.currency)} of this proforma is still to receive. Record any more on the customer's account.`,
    };
  }

  // The same request again — a double click, a retry — is the advance it already recorded (src/lib/request-once.ts).
  const claim = await claimRequest(input, "proforma-advance", user.id);
  if (claim.kind === "repeat") return { ok: true, data: { id: claim.recordId, applied: 0 } };
  if (claim.kind === "busy") return { ok: false, error: claim.error };

  // The money comes in to the branch that raised the proforma — the head office's for one from before branches.
  const branchId = proforma.branchId ?? (await defaultBranchIdFor(user.id));
  let payment: { id: string };
  try {
    payment = await db.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          companyId: proforma.companyId,
          branchId,
          amount,
          paidOn: new Date(paidOn),
          method,
          reference: reference || proforma.docNumber || null,
          notes: notes || `Advance against proforma ${proforma.docNumber ?? ""}`.trim(),
          recordedByUserId: user.id,
        },
        select: { id: true },
      });
      await tx.proformaAdvance.create({ data: { paymentId: created.id, proformaId: proforma.id } });
      // On account, unapplied: the books hold it as the customer's advance until an invoice takes it.
      await postPaymentToLedger(tx, created.id, user.id);
      await emitPaymentReceived(tx, created.id, user.id);
      return created;
    });
  } catch (err) {
    await claim.release();
    throw err;
  }
  await claim.done(payment.id);
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Payment",
    entityId: payment.id,
    entityLabel: `Advance of ${formatMoney(amount, proforma.currency)} against proforma ${proforma.docNumber ?? ""} — ${proforma.company.name}`,
  });

  // An invoice raised from this proforma and issued already takes it now; the next one takes it when it is issued.
  const issued = await db.tradeDocument.findMany({
    where: { sourceDocumentId: proforma.id, docType: "INVOICE", status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
    orderBy: { issueDate: "asc" },
    select: { id: true },
  });
  let applied = 0;
  for (const invoice of issued) applied += (await applyProformaAdvances(invoice.id, user.id)).applied;

  revalidatePath(`/documents/${proforma.id}`);
  for (const invoice of issued) revalidatePath(`/documents/${invoice.id}`);
  revalidatePath(`/companies/${proforma.companyId}`);
  revalidatePath("/payments");
  return { ok: true, data: { id: payment.id, applied } };
}
