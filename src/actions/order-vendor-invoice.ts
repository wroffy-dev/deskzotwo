"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { mayAccess } from "@/lib/authz/access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { refuseWhileViewingAs } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { formatOrderId } from "@/lib/order-id";
import { orderPath } from "@/lib/record-links";
import { cleanBilledAmount, cleanVendorInvoice } from "@/lib/orders/vendor-invoice";
import type { ActionResult } from "@/actions/company";

/**
 * The vendor's invoice on an order — its number and what it billed us before GST (owner, 16 Nov 2026 —
 * src/lib/orders/vendor-invoice.ts): whoever runs purchasing or approves orders, on an order they may edit, at any stage
 * but cancelled or rejected — fulfilled included, as the vendor's invoice usually comes after. Blank clears either.
 */
export async function setVendorInvoice(orderId: string, input: { number?: string | null; amount?: string | number | null }): Promise<ActionResult<{ number: string | null; amount: number | null }>> {
  const user = await requireModuleUser("orders");
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await can(user.id, "orders.process")) && !(await can(user.id, "orders.approve"))) return { ok: false, error: "Adding the vendor's invoice is for purchasing, or whoever approves orders." };
  const number = cleanVendorInvoice(input?.number);
  if (!number.ok) return { ok: false, error: number.error };
  const amount = cleanBilledAmount(input?.amount);
  if (!amount.ok) return { ok: false, error: amount.error };
  const order = typeof orderId === "string" ? await db.companyProduct.findUnique({ where: { id: orderId }, select: { id: true, orderSeq: true, orderStatus: true, company: { select: { id: true, ownerUserId: true, relationshipType: true } } } }) : null;
  if (!order || !(await canSeeCompany(user.id, order.company)) || !(await mayAccess(user.id, "orders", "edit", order.id))) return { ok: false, error: "Order not found." };
  if (order.orderStatus === "CANCELLED" || order.orderStatus === "REJECTED") return { ok: false, error: "This order was cancelled — nothing was bought for it." };
  try {
    await db.companyProduct.update({ where: { id: order.id }, data: { vendorInvoiceNumber: number.value, vendorBilledAmount: amount.value === null ? null : new Prisma.Decimal(amount.value) }, select: { id: true } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace is being updated — try again in a minute." };
    throw err;
  }
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Order",
    entityId: order.id,
    entityLabel: `${formatOrderId(order.orderSeq)} — vendor invoice ${number.value ?? "none"}${amount.value !== null ? `, ₹${amount.value.toFixed(2)} before GST` : ""}`,
  });
  revalidatePath(orderPath(order.orderSeq));
  revalidatePath("/orders");
  return { ok: true, data: { number: number.value, amount: amount.value } };
}
