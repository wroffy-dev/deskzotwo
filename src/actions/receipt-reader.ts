"use server";

import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { copilotConfig } from "@/lib/copilot/settings";
import { isModuleEnabled } from "@/actions/module";
import { ReceiptReadRefusal, readReceipt, type ReceiptReading } from "@/lib/bill-reader/receipt-server";
import type { ActionResult } from "@/actions/company";

/**
 * Arjun filling an expense claim in from its receipt (owner, 20 Nov 2026 — src/lib/bill-reader/receipt.ts). For
 * somebody who may raise expense claims and use Deskzo AI, with Deskzo AI on. Nothing is saved: the form is filled in,
 * and the person saves the claim as always. Never while viewing as somebody.
 */

/** Whether the expense form offers "Fill in from the receipt" to this person. */
export async function mayReadReceipts(): Promise<boolean> {
  const user = await requireModuleUser("expenses");
  if (!(await isModuleEnabled("expenses"))) return false;
  return (await copilotConfig()).enabled && (await can(user.id, "copilot.use"));
}

export async function readExpenseReceipt(input: { name: string; dataUrl: string; expenseId?: string | null }): Promise<ActionResult<ReceiptReading>> {
  const user = await requireModuleUser("expenses");
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await isModuleEnabled("expenses"))) return { ok: false, error: "You don't have access to Expenses." };
  if (!(await copilotConfig()).enabled) return { ok: false, error: "Deskzo AI is switched off for this workspace." };
  if (!(await can(user.id, "copilot.use"))) return { ok: false, error: "Reading receipts uses Deskzo AI — that takes the “Use Deskzo AI” permission." };
  try {
    return { ok: true, data: await readReceipt(user.id, { name: String(input?.name ?? ""), dataUrl: String(input?.dataUrl ?? ""), expenseId: input?.expenseId ? String(input.expenseId) : null }) };
  } catch (err) {
    if (err instanceof ReceiptReadRefusal) return { ok: false, error: err.message };
    throw err;
  }
}
