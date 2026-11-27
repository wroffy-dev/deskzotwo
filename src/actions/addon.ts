"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { mayAccess, orderAccess } from "@/lib/authz/access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { resellerOrderRefusal } from "@/lib/orders/reseller-gate";
import { canAddTo, proRata, renewalGroup } from "@/lib/subscriptions/proration";
import type { ActionResult } from "@/actions/company";

/**
 * Adding seats to a subscription that is already running.
 *
 * The decision this module rests on: an addon is a *separate order* that shares an expiry, never a
 * bigger number on the original. Bumping 10 seats to 15 would change last quarter's sales figure
 * retroactively, leave no record of what the extra seats cost, and give whoever sold them no
 * credit. So a new row is written, pointing at its parent, and the two come back together at
 * renewal — which is the whole point of co-terming.
 */

async function access() {
  const user = await requireModuleUser("renewals");
  return { user, allowed: await hasEffectivePermission(user.id, "orders.process") };
}

/**
 * Reading what a customer is on — the subscriptions, what each was sold at, the term — is order
 * data, so it takes "View orders" as the Orders and Renewals pages do (owner, 8 Oct 2026). The
 * pro-rata tool read it with nothing but the plan, so a role that can't open an order could still
 * see what every customer pays.
 */
async function reader() {
  const user = await requireModuleUser("renewals");
  return { user, allowed: await hasEffectivePermission(user.id, "orders.view") };
}

/**
 * `reader` for the actions only Renewals's own pages use: Renewals open to the person as well. The actions other
 * screens use keep `reader` alone (owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-6).
 */
async function readerIfOpen(...args: Parameters<typeof reader>) {
  await requireModuleAccess("renewals");
  return reader(...args);
}

/**
 * What adding seats would cost, before anybody commits to it.
 *
 * Separate from creating it so the form can show the figure as the quantity and date are typed —
 * the pro-rated price is the thing a customer queries, and it should be on screen before the order
 * exists rather than discovered on the invoice.
 */
export async function quoteAddon(params: {
  parentId: string;
  quantity: number;
  startDate: string;
  /**
   * The full-year price a seat the salesperson typed, for an order recorded without one (owner, 3 Nov 2026).
   * Used only when the order has no price of its own — an order's price is never overridden from here.
   */
  salePrice?: number;
}) {
  const { user, allowed } = await reader();
  if (!allowed) return null;
  const parent = await db.companyProduct.findUnique({
    where: { id: params.parentId },
    select: {
      id: true, quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true, endDate: true,
      orderStatus: true, parentId: true,
      item: { select: { id: true, name: true, type: true, unit: true, taxRatePercent: true } },
      company: { select: { id: true, name: true, ownerUserId: true } },
    },
  });
  if (!parent) return null;
  // The same refusal for a record out of scope as for one that does not exist, so a parent id
  // cannot be used to find out which accounts are real. The access engine answers it.
  if (!(await mayAccess(user.id, "orders", "view", parent.id))) return null;

  const problems = canAddTo({
    parent: {
      startDate: parent.startDate,
      endDate: parent.endDate,
      orderStatus: parent.orderStatus,
      itemType: parent.item.type,
      parentId: parent.parentId,
    },
    addonStart: params.startDate,
    quantity: params.quantity,
  });

  // The full-year price, falling back to the parent's own — which is already a full term — and, where the
  // order has neither, to the sale price typed for it.
  const own = Number(parent.fullTermUnitPrice ?? parent.unitPrice ?? 0);
  const typed = Number(params.salePrice);
  const priceFrom: "order" | "typed" | "none" = own > 0 ? "order" : typed > 0 && Number.isFinite(typed) ? "typed" : "none";
  const annual = priceFrom === "order" ? own : priceFrom === "typed" ? Math.round(typed * 100) / 100 : 0;

  const quote =
    parent.startDate && parent.endDate && annual > 0
      ? proRata({
          fullTermUnitPrice: annual,
          quantity: Math.max(0, params.quantity),
          addonStart: params.startDate,
          parentStart: parent.startDate,
          parentEnd: parent.endDate,
        })
      : null;

  return toPlain({ parent, problems, quote, annualUnitPrice: annual, priceFrom });
}

export async function createAddon(input: {
  parentId: string;
  quantity: number;
  startDate: string;
  /** Overrides the parent's annual price, where this batch was sold at a different rate. */
  fullTermUnitPrice?: number;
  purchasePrice?: number;
  poNumber?: string;
  notes?: string;
}): Promise<ActionResult<{ id: string; unitPrice: number; total: number }>> {
  const { user, allowed } = await access();
  if (!allowed) return { ok: false, error: "You can't add seats to a subscription." };

  const parent = await db.companyProduct.findUnique({
    where: { id: input.parentId },
    select: {
      id: true, companyId: true, locationId: true, itemId: true, vendorId: true, endCustomerId: true,
      startDate: true, endDate: true, orderStatus: true, parentId: true, unitPrice: true,
      fullTermUnitPrice: true, paymentTerms: true,
      item: { select: { type: true, name: true } },
      company: { select: { id: true, name: true, relationshipType: true, ownerUserId: true } },
    },
  });
  // Scoped like punching an order: seats only on an account this person could open. Out of scope and
  // missing answer the same, so an id can't be used to find out which subscriptions are real.
  if (!parent || !(await canSeeCompany(user.id, parent.company))) {
    return { ok: false, error: "That subscription no longer exists." };
  }
  const resellerRefusal = await resellerOrderRefusal(parent.company);
  if (resellerRefusal) return { ok: false, error: resellerRefusal };

  const problems = canAddTo({
    parent: {
      startDate: parent.startDate,
      endDate: parent.endDate,
      orderStatus: parent.orderStatus,
      itemType: parent.item.type,
      parentId: parent.parentId,
    },
    addonStart: input.startDate,
    quantity: input.quantity,
  });
  if (problems.length > 0) return { ok: false, error: problems[0].message };

  const annual = input.fullTermUnitPrice ?? Number(parent.fullTermUnitPrice ?? parent.unitPrice ?? 0);
  if (annual <= 0) {
    return {
      ok: false,
      error: "The original order has no price to pro-rate from. Type the sale price a seat, or fill it in under Orders › Fill missing prices.",
    };
  }

  const quote = proRata({
    fullTermUnitPrice: annual,
    quantity: input.quantity,
    addonStart: input.startDate,
    parentStart: parent.startDate!,
    parentEnd: parent.endDate!,
  });
  if (quote.daysCharged === 0) {
    return { ok: false, error: "There are no days left on that subscription. Renew it instead." };
  }

  const created = await db.companyProduct.create({
    data: {
      // Everything about *where* it goes is inherited: the same customer, the same site, the same
      // product, and — on a reseller order — the same end customer. Only the commercial terms differ.
      companyId: parent.companyId,
      locationId: parent.locationId,
      itemId: parent.itemId,
      vendorId: parent.vendorId,
      endCustomerId: parent.endCustomerId,
      paymentTerms: parent.paymentTerms,

      parentId: parent.id,
      businessType: "ADDON",
      quantity: input.quantity,

      // Co-terminated. This is the reason an addon is not simply a new subscription: the customer
      // ends up with one renewal date, not two.
      startDate: new Date(`${input.startDate}T00:00:00.000Z`),
      endDate: parent.endDate,

      // What they are charged now, and what a full year costs — kept apart because the renewal has
      // to price from the second, not the first.
      unitPrice: new Prisma.Decimal(quote.unitPrice),
      fullTermUnitPrice: new Prisma.Decimal(annual),
      proRataDays: quote.daysCharged,
      fullTermDays: quote.fullTermDays,
      purchasePrice: input.purchasePrice ? new Prisma.Decimal(input.purchasePrice) : null,

      poNumber: input.poNumber?.trim() || null,
      notes: [input.notes?.trim(), quote.workings].filter(Boolean).join("\n\n"),
      // Follows the same approval route as any other order — extra seats are a sale, and the margin
      // on them matters as much as on the original.
      orderStatus: "PENDING_APPROVAL",
      addedByUserId: user.id,
    },
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    // An order like any other in the trail, so the history of orders includes the seats added.
    entityType: "Order",
    entityId: created.id,
    entityLabel: `${input.quantity} × ${parent.item.name} added to ${parent.company.name}'s subscription — ${quote.workings}`,
  });
  revalidatePath("/orders");
  revalidatePath("/renewals");
  revalidatePath(`/companies/${parent.companyId}`);
  return { ok: true, data: { id: created.id, unitPrice: quote.unitPrice, total: quote.total } };
}

/**
 * A subscription with everything co-terminating with it.
 *
 * What the renewal conversation is actually about — "15 seats expiring on the 9th", not "10 seats
 * and, separately, 5 seats".
 */
export async function subscriptionWithAddons(id: string) {
  const { user, allowed } = await readerIfOpen();
  if (!allowed) return null;
  const parent = await db.companyProduct.findUnique({
    where: { id },
    include: {
      company: { select: { id: true, name: true, ownerUserId: true } },
      endCustomer: { select: { id: true, name: true } },
      item: { select: { id: true, name: true, sku: true, unit: true, type: true } },
      addedBy: { select: { id: true, name: true } },
      addons: {
        orderBy: { startDate: "asc" },
        include: { addedBy: { select: { id: true, name: true } } },
      },
    },
  });
  // Out of scope answers as missing does: what a customer pays is the account's own business.
  // The access engine answers the scope (`mayAccess`).
  if (!parent || !(await mayAccess(user.id, "orders", "view", parent.id))) return null;

  const live = parent.addons.filter((a) => a.orderStatus !== "CANCELLED");
  const group = renewalGroup([
    {
      id: parent.id,
      quantity: parent.quantity,
      unitPrice: parent.unitPrice ? Number(parent.unitPrice) : null,
      fullTermUnitPrice: parent.fullTermUnitPrice ? Number(parent.fullTermUnitPrice) : null,
      startDate: parent.startDate,
      isAddon: false,
    },
    ...live.map((a) => ({
      id: a.id,
      quantity: a.quantity,
      unitPrice: a.unitPrice ? Number(a.unitPrice) : null,
      fullTermUnitPrice: a.fullTermUnitPrice ? Number(a.fullTermUnitPrice) : null,
      startDate: a.startDate,
      isAddon: true,
    })),
  ]);

  return toPlain({ parent, addons: live, group });
}

/**
 * Subscriptions a customer has that can take extra seats.
 *
 * Only parents — an addon can't have its own addon, or the renewal would not know which row is the
 * real subscription.
 */
export async function addableSubscriptions(companyId: string) {
  const { user, allowed } = await reader();
  if (!allowed) return [];
  const now = new Date();
  return toPlain(
    await db.companyProduct.findMany({
      where: {
        // Scoped as well as filtered by id: a company id is not a secret, and without this
        // anybody signed in could read what any account pays by passing one in. The access
        // engine answers the scope, inside `AND` so its keys never meet the ones beside it.
        AND: [await orderAccess(user.id, "view")],
        companyId,
        parentId: null,
        item: { type: "SUBSCRIPTION" },
        orderStatus: { not: "CANCELLED" },
        endDate: { gte: now },
      },
      orderBy: { endDate: "asc" },
      select: {
        id: true, quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true, endDate: true,
        // The product's selling price, suggested where the order has none to quote from (owner, 3 Nov 2026).
        item: { select: { id: true, name: true, unit: true, taxRatePercent: true, sellingPrice: true } },
        addons: { where: { orderStatus: { not: "CANCELLED" } }, select: { quantity: true } },
      },
    }),
  );
}
