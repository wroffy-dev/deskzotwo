"use server";

import { revalidatePath } from "next/cache";
import { requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { hasEffectivePermission } from "@/actions/permission";
import { mayAccess } from "@/lib/authz/access";
import { previewCustomerNotice, queueCustomerNotice, resolveNoticeRecipients, type NoticePreview } from "@/lib/marketing/order-notice";
import type { NoticeKind } from "@/lib/marketing/customer-notices";
import type { ActionResult } from "@/actions/company";
import { tenantOrigin } from "@/lib/tenancy/resolve";

/**
 * The mail icon on a renewal, and the one on a fulfilled order.
 *
 * Thin on purpose: who is allowed, where the links point, and what goes in the audit trail. The work
 * is in src/lib/marketing/order-notice.ts, which has no session to read and can therefore be
 * exercised directly by a script.
 */

/** The same population that may change an order may write to the customer about one. */
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const MAX_COPIES = 6;

/** The copies asked for, as addresses: the sender's own, the account manager's, and those typed — checked, once each. */
async function copiesFor(userId: string, companyProductId: string, asked: { me?: boolean; accountManager?: boolean; emails?: string[] } | undefined): Promise<ActionResult<string[]>> {
  if (!asked) return { ok: true, data: [] };
  const typed = (Array.isArray(asked.emails) ? asked.emails : []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  const bad = typed.find((e) => !EMAIL.test(e) || e.length > 200);
  if (bad) return { ok: false, error: `"${bad}" isn't an email address.` };
  const [me, order] = await Promise.all([
    asked.me ? db.user.findUnique({ where: { id: userId }, select: { email: true } }) : null,
    asked.accountManager ? db.companyProduct.findUnique({ where: { id: String(companyProductId ?? "") }, select: { company: { select: { owner: { select: { email: true, active: true } } } } } }) : null,
  ]);
  const manager = order?.company.owner?.active ? order.company.owner.email : null;
  const all = [...new Set([...(me?.email ? [me.email.toLowerCase()] : []), ...(manager ? [manager.toLowerCase()] : []), ...typed])];
  if (all.length > MAX_COPIES) return { ok: false, error: `Copy it to ${MAX_COPIES} people at most.` };
  return { ok: true, data: all };
}

async function access() {
  const user = await requireModuleUser(["orders", "renewals"]);
  const allowed =
    (await hasEffectivePermission(user.id, "products.edit")) ||
    (await hasEffectivePermission(user.id, "orders.process")) ||
    (await hasEffectivePermission(user.id, "marketing.send"));
  return { user, allowed };
}

/** Where links in what this sends should point — the workspace's own address. */
async function currentOrigin() {
  return tenantOrigin();
}

/**
 * And only about an order the person may change (security review, 23 Oct 2026): the permissions above said who may
 * write to customers at all, not about whose orders — any order's id read back its customer's people and mailed them.
 */
async function mayChangeOrder(userId: string, companyProductId: string): Promise<boolean> {
  return typeof companyProductId === "string" && !!companyProductId && mayAccess(userId, "orders", "edit", companyProductId);
}

/**
 * Who this could go to, and what would happen to each of them, before anybody presses send — each person as this one's
 * contacts policy shows them (owner, 5 Nov 2026 — Phase 3 masking fixes). The send goes by contact id.
 */
export async function noticeRecipients(companyProductId: string, kind: NoticeKind = "RENEWAL") {
  const { user, allowed } = await access();
  if (!allowed || !(await mayChangeOrder(user.id, companyProductId))) return null;
  return resolveNoticeRecipients(companyProductId, kind, user.id);
}

/** What Send would email the first person ticked, under the same rules — nothing sent (owner, 3 Nov 2026). */
export async function previewNotice(input: {
  companyProductId: string;
  contactIds: string[];
  kind?: NoticeKind;
  templateId?: string;
  note?: string;
  cc?: { me?: boolean; accountManager?: boolean; emails?: string[] };
}): Promise<ActionResult<NoticePreview>> {
  const { user, allowed } = await access();
  if (!allowed) return { ok: false, error: "You can't write to customers about orders." };
  if (!(await mayChangeOrder(user.id, input?.companyProductId))) return { ok: false, error: "That order isn't one of yours to write about." };
  const cc = await copiesFor(user.id, input?.companyProductId, input?.cc);
  if (!cc.ok) return cc;
  return previewCustomerNotice({ ...input, origin: await currentOrigin(), sentByUserId: user.id, cc: cc.data });
}

export async function sendCustomerNotice(input: {
  companyProductId: string;
  contactIds: string[];
  kind?: NoticeKind;
  templateId?: string;
  note?: string;
  /** Copies (owner, 3 Nov 2026): to the sender, to the customer's account manager, and to addresses typed. */
  cc?: { me?: boolean; accountManager?: boolean; emails?: string[] };
}): Promise<ActionResult<{ sent: number; failed: number; skipped: { name: string; reason: string }[]; copied: string[] }>> {
  const { user, allowed } = await access();
  if (!allowed) return { ok: false, error: "You can't write to customers about orders." };
  if (!(await mayChangeOrder(user.id, input?.companyProductId))) return { ok: false, error: "That order isn't one of yours to write about." };

  const cc = await copiesFor(user.id, input?.companyProductId, input?.cc);
  if (!cc.ok) return cc;
  const result = await queueCustomerNotice({ ...input, origin: await currentOrigin(), sentByUserId: user.id, cc: cc.data });
  if (!result.ok) return result;

  const { product, ...outcome } = result.data;
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "CompanyProduct",
    entityId: product.id,
    entityLabel: `${input.kind === "FULFILMENT" ? "Fulfilment notice" : input.kind === "RENEWED" ? "Renewal confirmation" : input.kind === "PAYMENT" ? "Payment reminder" : "Renewal reminder"} for ${product.itemName} sent to ${outcome.sent} contact(s) at ${product.companyName}${cc.data.length ? `, copied to ${cc.data.join(", ")}` : ""}`,
  });
  revalidatePath("/renewals");
  revalidatePath("/orders");
  revalidatePath(`/companies/${product.companyId}`);

  // Who it was copied to, as the dialog says once it has gone.
  return { ok: true, data: { ...outcome, copied: cc.data } };
}
