"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { refuseWhileViewingAs } from "@/lib/session";
import { requireModuleAccess } from "@/lib/modules-access";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { recordAudit } from "@/lib/audit";
import { formatOrderId } from "@/lib/order-id";
import type { ActionResult } from "@/actions/company";

/**
 * "Add past order" (owner, 23 Nov 2026: "some entries still needs to be done in deskzo against customers! the current
 * order system has too much to do.. can a temporary option be given so old orders can be added?"). TEMPORARY — the
 * owner will take it out of the code once the old CRM's orders are all in: this file, PastOrderEntry, the
 * `orders.recordPast` permission, the button (src/components/companies/past-order-dialog.tsx) and the rule in
 * src/lib/renewal-customer-reminders.ts.
 *
 * The old CRM's form, as an order already done — the way the old-CRM import brings them in (src/lib/legacy-import/apply.ts
 * customerProducts): FULFILLED, booked from its start, no approval, purchase step, vendor PO, invoice, billing plan,
 * workflow or notifications. Its tenant / domain goes in the same "Tenant / domain" field the import uses. It counts in
 * the customer's history and comes up for renewal; one ending within 15 days of being entered sends the customer no
 * automatic reminder. Takes `orders.recordPast` and a customer this person can see.
 */

const BUSINESS_TYPES = ["NEW", "RENEWAL", "NEW_TO_US_RENEWAL"] as const;
const TERMS = ["DUE_ON_RECEIPT", "ADVANCE", "NET_15", "NET_30", "NET_45", "NET_60"] as const;
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.")
  .refine((d) => !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime()), "Choose a date.");
const blank = (s: unknown) => (typeof s === "string" && s.trim() === "" ? undefined : s);

const schema = z.object({
  companyId: z.string().min(1).max(100),
  itemId: z.string().min(1, "Choose the product.").max(100),
  quantity: z.coerce.number().int("Quantity: a whole number.").min(1, "Quantity: at least 1.").max(1_000_000),
  poNumber: z.preprocess(blank, z.string().trim().max(100).optional()),
  businessType: z.enum(BUSINESS_TYPES).default("NEW"),
  tenantDomain: z.preprocess(blank, z.string().trim().max(200).optional()),
  vendorId: z.preprocess(blank, z.string().max(100).optional()),
  locationId: z.string().min(1, "Choose the address.").max(100),
  paymentTerms: z.preprocess(blank, z.enum(TERMS).optional()),
  notes: z.preprocess(blank, z.string().trim().max(5000).optional()),
  startDate: day,
  endDate: z.preprocess(blank, day.optional()),
  unitPrice: z.preprocess(blank, z.coerce.number().min(0, "Price can't be negative.").max(9_999_999_999).optional()),
});

/** What the form sends — checked again here (`schema`). */
export type PastOrderInput = {
  companyId: string;
  itemId: string;
  quantity: number | string;
  poNumber?: string;
  businessType?: (typeof BUSINESS_TYPES)[number];
  tenantDomain?: string;
  vendorId?: string;
  locationId: string;
  paymentTerms?: (typeof TERMS)[number];
  notes?: string;
  startDate: string;
  endDate?: string;
  unitPrice?: number | string;
};

/** Whether this person may add past orders — for the button. */
export async function mayRecordPastOrders(): Promise<boolean> {
  const user = await requireModuleAccess("orders");
  return (await isModuleEnabled("orders")) && (await hasEffectivePermission(user.id, "orders.recordPast"));
}

/** The "Tenant / domain" order field the old-CRM import uses — made here when it isn't there yet. */
async function tenantField(userId: string): Promise<void> {
  const existing = await db.customFieldDefinition.findUnique({ where: { entity_key: { entity: "ORDER", key: "tenant_domain" } }, select: { id: true } });
  if (existing) return;
  await db.customFieldDefinition
    .create({ data: { entity: "ORDER", key: "tenant_domain", label: "Tenant / domain", type: "TEXT", group: "Old CRM", sortOrder: 901, createdById: userId }, select: { id: true } })
    .catch(() => undefined); // made by somebody else at the same moment
}

export async function recordPastOrder(input: PastOrderInput): Promise<ActionResult<{ id: string; orderSeq: number }>> {
  const user = await requireModuleAccess("orders");
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await isModuleEnabled("orders"))) return { ok: false, error: "You don't have access to Orders." };
  if (!(await hasEffectivePermission(user.id, "orders.recordPast"))) return { ok: false, error: "Adding past orders takes the “Add past orders” permission." };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the order." };
  const d = parsed.data;
  if (d.endDate && d.endDate < d.startDate) return { ok: false, error: "The expiry date is before the start date." };

  const company = await db.company.findUnique({ where: { id: d.companyId } });
  if (!company || !(await canSeeCompany(user.id, company))) return { ok: false, error: "Company not found." };
  const location = await db.companyLocation.findUnique({ where: { id: d.locationId }, select: { companyId: true } });
  if (!location || location.companyId !== company.id) return { ok: false, error: "That address isn't this customer's." };
  const item = await db.item.findUnique({ where: { id: d.itemId }, select: { id: true, name: true } });
  if (!item) return { ok: false, error: "That product isn't there any more." };
  if (d.vendorId) {
    const vendor = await db.company.findUnique({ where: { id: d.vendorId }, select: { relationshipType: true, alsoVendor: true } });
    if (!vendor || !(["VENDOR", "DISTRIBUTOR", "OEM"].includes(vendor.relationshipType) || vendor.alsoVendor)) return { ok: false, error: "That vendor isn't one." };
  }
  if (d.tenantDomain) await tenantField(user.id);

  const started = new Date(`${d.startDate}T00:00:00Z`);
  const made = await db.$transaction(async (tx) => {
    const order = await tx.companyProduct.create({
      data: {
        companyId: company.id,
        locationId: d.locationId,
        itemId: item.id,
        vendorId: d.vendorId ?? null,
        quantity: d.quantity,
        unitPrice: d.unitPrice ?? null,
        businessType: d.businessType,
        poNumber: d.poNumber ?? null,
        paymentTerms: d.paymentTerms ?? null,
        notes: d.notes ?? null,
        startDate: started,
        endDate: d.endDate ? new Date(`${d.endDate}T00:00:00Z`) : null,
        orderStatus: "FULFILLED",
        purchaseRelease: "RELEASED",
        fulfilledAt: started,
        bookedAt: started,
        addedByUserId: user.id,
        customFields: d.tenantDomain ? { tenant_domain: d.tenantDomain } : {},
      },
      select: { id: true, orderSeq: true },
    });
    await tx.pastOrderEntry.create({ data: { orderId: order.id, recordedById: user.id }, select: { id: true } });
    return order;
  });
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Order",
    entityId: made.id,
    entityLabel: `${formatOrderId(made.orderSeq)} — past order added for ${company.name}: ${item.name} × ${d.quantity}, ${d.startDate}${d.endDate ? ` to ${d.endDate}` : ""} (no approval, purchase or invoice)`,
  });
  revalidatePath("/orders");
  revalidatePath(`/companies/${company.id}`);
  return { ok: true, data: made };
}
