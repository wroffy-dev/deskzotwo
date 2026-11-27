"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { mayAccess, orderAccess } from "@/lib/authz/access";
import { recordAudit } from "@/lib/audit";
import { formatOrderId } from "@/lib/order-id";
import { toPlain } from "@/lib/serialize";
import { MISSING_PRICE_WHERE, parsePriceCsv, priceField, readPrice } from "@/lib/orders/missing-prices";
import type { ActionResult } from "@/actions/company";

/**
 * Orders › Fill missing prices (owner, 3 Nov 2026; src/lib/orders/missing-prices.ts). Whoever may edit
 * products (`products.edit`), on the orders they may edit — the same rule as changing an order's details.
 * Only a missing price is filled; one an order already has is never changed here.
 */

const NOT_ALLOWED = "Filling in prices takes permission to edit products.";

async function filler() {
  const user = await requireModuleUser("orders");
  return (await hasEffectivePermission(user.id, "products.edit")) ? user : null;
}

/** The same, for the actions only Orders › Fill missing prices uses: Orders open to them too (Phase 2 permission fixes, audit L-6). */
async function fillerIfOpen() {
  await requireModuleAccess("orders");
  return filler();
}

export type MissingPriceRow = {
  id: string;
  ref: string;
  company: { id: string; name: string };
  item: { name: string; sku: string; sellingPrice: number | null };
  quantity: number;
  startDate: string | null;
  endDate: string | null;
  isAddon: boolean;
  orderStatus: string;
};

const PAGE = 50;

/** One page of orders still without a price, scoped to what this person may see, with the product's price to suggest. */
export async function listMissingPrices(params: { q?: string; page?: number }): Promise<{ rows: MissingPriceRow[]; total: number; withProductPrice: number; page: number; pages: number; allowed: boolean }> {
  const user = await fillerIfOpen();
  if (!user) return { rows: [], total: 0, withProductPrice: 0, page: 1, pages: 1, allowed: false };
  const q = params.q?.trim() ?? "";
  const ref = /^(?:ORD-?)?0*(\d{1,9})$/i.exec(q);
  const where: Prisma.CompanyProductWhereInput = {
    AND: [
      MISSING_PRICE_WHERE,
      await orderAccess(user.id, "view"),
      ...(q ? [{ OR: [...(ref ? [{ orderSeq: Number(ref[1]) }] : []), { company: { name: { contains: q, mode: "insensitive" as const } } }, { item: { name: { contains: q, mode: "insensitive" as const } } }] }] : []),
    ],
  };
  const [total, withProductPrice] = await Promise.all([db.companyProduct.count({ where }), db.companyProduct.count({ where: { AND: [where, { item: { sellingPrice: { gt: 0 } } }] } })]);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.min(Math.max(1, Math.trunc(params.page ?? 1)), pages);
  const rows = await db.companyProduct.findMany({
    where,
    orderBy: [{ endDate: "asc" }, { id: "asc" }],
    skip: (page - 1) * PAGE,
    take: PAGE,
    select: {
      id: true,
      orderSeq: true,
      quantity: true,
      startDate: true,
      endDate: true,
      parentId: true,
      orderStatus: true,
      company: { select: { id: true, name: true } },
      item: { select: { name: true, sku: true, sellingPrice: true } },
    },
  });
  return toPlain({
    rows: rows.map((r) => ({
      id: r.id,
      ref: formatOrderId(r.orderSeq),
      company: r.company,
      item: { name: r.item.name, sku: r.item.sku, sellingPrice: r.item.sellingPrice ? Number(r.item.sellingPrice) : null },
      quantity: r.quantity,
      startDate: r.startDate?.toISOString().slice(0, 10) ?? null,
      endDate: r.endDate?.toISOString().slice(0, 10) ?? null,
      isAddon: r.parentId !== null,
      orderStatus: r.orderStatus,
    })),
    total,
    withProductPrice,
    page,
    pages,
    allowed: true,
  });
}

export type FillOutcome = { filled: number; skipped: { ref: string; reason: string }[] };

/**
 * Fills each order's missing price, one by one with every rule: the order this person may edit, the price a
 * real one, and still missing when it is written (a conditional update, so two people can't overwrite each
 * other and a priced order is never changed). Each fill is audited.
 */
async function fill(userId: string, entries: { id: string; price: number }[]): Promise<FillOutcome> {
  const outcome: FillOutcome = { filled: 0, skipped: [] };
  // Asked once: whether this person approves orders (security audit SEC-05, below).
  let approver: boolean | null = null;
  for (const entry of entries) {
    const order = await db.companyProduct.findUnique({
      where: { id: entry.id },
      select: { id: true, orderSeq: true, parentId: true, companyId: true, orderStatus: true, addedByUserId: true, accountsApprovedAt: true },
    });
    if (!order) continue;
    const ref = formatOrderId(order.orderSeq);
    if (!(await mayAccess(userId, "orders", "edit", order.id))) {
      outcome.skipped.push({ ref, reason: "you can't edit this order" });
      continue;
    }
    /**
     * Security audit, 11 Nov 2026 (SEC-05): an order punched without a price was approved on its list price, then priced
     * at ₹1 here — a loss nobody approved, a credit limit nobody overrode. An order approved in Deskzo is filled only by
     * somebody who may approve orders, and never one they punched themselves. Waiting for approval it is still the
     * author's to fill, as before — the approver sees the price — and so is one brought from the old system, which was
     * never approved here and is what this page is mostly for.
     */
    if (order.accountsApprovedAt && order.orderStatus !== "PENDING_APPROVAL") {
      approver ??= await hasEffectivePermission(userId, "orders.approve");
      if (!approver || order.addedByUserId === userId) {
        outcome.skipped.push({ ref, reason: !approver ? "it's already approved — somebody who approves orders fills its price" : "it's yours and already approved — somebody else who approves orders fills its price" });
        continue;
      }
    }
    const field = priceField(order);
    const written = await db.companyProduct.updateMany({ where: { AND: [{ id: order.id }, MISSING_PRICE_WHERE] }, data: { [field]: entry.price } });
    if (written.count === 0) {
      outcome.skipped.push({ ref, reason: "it has a price already" });
      continue;
    }
    outcome.filled += 1;
    await recordAudit({
      userId,
      action: "UPDATE",
      entityType: "Order",
      entityId: order.id,
      entityLabel: `${ref} — filled the missing ${field === "unitPrice" ? "price" : "full-year price"}: ${entry.price.toFixed(2)}`,
    });
  }
  return outcome;
}

function refresh() {
  revalidatePath("/orders", "layout");
  revalidatePath("/renewals");
  revalidatePath("/companies", "layout");
}

const MAX_AT_ONCE = 5000;
/**
 * Orders filled in one request (owner, 5 Nov 2026). Each is checked, written and audited on its own, so 5,000 in one
 * took minutes: Cloudflare gave up on it at 100 seconds and the page fell over while the server carried on. The page
 * asks for a batch at a time and shows how far it has got.
 */
const BATCH = 200;

/** The prices typed on the page — each a positive amount, at most two decimals. */
export async function fillMissingPrices(input: { entries: { id: unknown; price: unknown }[] }): Promise<ActionResult<FillOutcome>> {
  const user = await filler();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const list = Array.isArray(input?.entries) ? input.entries.slice(0, MAX_AT_ONCE) : [];
  const entries: { id: string; price: number }[] = [];
  for (const e of list) {
    const price = readPrice(e?.price);
    if (typeof e?.id !== "string" || price === null) continue;
    entries.push({ id: e.id, price });
  }
  if (!entries.length) return { ok: false, error: "Type a price for at least one order." };
  const outcome = await fill(user.id, entries);
  refresh();
  return { ok: true, data: outcome };
}

/**
 * The next batch of orders still without a price whose product has a selling price — the product's price. What the
 * page runs over and over for "Use the product price for all": `after` is the last order the batch before reached, so
 * one that can't be filled is passed over rather than asked again for ever. `next` is null when there are no more.
 */
export async function fillAllFromProductPrice(input: { q?: string; after?: string | null }): Promise<ActionResult<FillOutcome & { left: number; next: string | null }>> {
  const user = await fillerIfOpen();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const q = input?.q?.trim() ?? "";
  const ref = /^(?:ORD-?)?0*(\d{1,9})$/i.exec(q);
  const where: Prisma.CompanyProductWhereInput = {
    AND: [
      MISSING_PRICE_WHERE,
      await orderAccess(user.id, "edit"),
      { item: { sellingPrice: { gt: 0 } } },
      ...(q ? [{ OR: [...(ref ? [{ orderSeq: Number(ref[1]) }] : []), { company: { name: { contains: q, mode: "insensitive" as const } } }, { item: { name: { contains: q, mode: "insensitive" as const } } }] }] : []),
    ],
  };
  const after = typeof input?.after === "string" && input.after ? input.after : null;
  const rows = await db.companyProduct.findMany({ where: after ? { AND: [where, { id: { gt: after } }] } : where, take: BATCH, orderBy: { id: "asc" }, select: { id: true, item: { select: { sellingPrice: true } } } });
  const outcome = await fill(
    user.id,
    rows.map((r) => ({ id: r.id, price: Number(r.item.sellingPrice) })),
  );
  const left = await db.companyProduct.count({ where });
  refresh();
  return { ok: true, data: { ...outcome, left, next: rows.length === BATCH ? rows[rows.length - 1]!.id : null } };
}

/** "Order number, price" rows from a CSV of the real old prices — each filled only where the order still has none. */
export async function importMissingPrices(input: { csv: unknown; firstLine?: number }): Promise<ActionResult<FillOutcome & { problems: string[] }>> {
  const user = await fillerIfOpen();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const text = typeof input?.csv === "string" ? input.csv.slice(0, 2_000_000) : "";
  const parsed = parsePriceCsv(text);
  // The page sends a long file a part at a time: lines are counted from where this part began in the file.
  const offset = Math.max(0, Math.trunc(Number(input?.firstLine) || 1) - 1);
  const problems = parsed.filter((r) => r.problem).map((r) => `Line ${r.line + offset}: ${r.problem}`);
  const good = parsed.filter((r) => !r.problem && r.orderSeq !== null && r.price !== null).slice(0, MAX_AT_ONCE);
  if (!good.length) return { ok: false, error: problems[0] ?? "No rows of order number and price were found." };
  const orders = await db.companyProduct.findMany({ where: { orderSeq: { in: good.map((g) => g.orderSeq!) } }, select: { id: true, orderSeq: true } });
  const bySeq = new Map(orders.map((o) => [o.orderSeq, o.id]));
  const entries: { id: string; price: number }[] = [];
  for (const g of good) {
    const id = bySeq.get(g.orderSeq!);
    if (!id) problems.push(`Line ${g.line + offset}: no order ${formatOrderId(g.orderSeq!)}`);
    else entries.push({ id, price: g.price! });
  }
  const outcome = await fill(user.id, entries);
  refresh();
  return { ok: true, data: { ...outcome, problems: problems.slice(0, 50) } };
}
