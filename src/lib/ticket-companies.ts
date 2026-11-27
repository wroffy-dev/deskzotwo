import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { orderAccess } from "@/lib/authz/access";
import { companyScope } from "@/lib/authz/company-scope";
import { companyNameMatches, nameSearchText } from "@/lib/company-name";
import { CATEGORY_SELECT } from "@/lib/customers/categories";

/**
 * The company picker on New ticket, saying which companies have an active order (owner, 25 Nov 2026: "when support person
 * search company show any live subscription going on … so it is easy to guess in case of duplicate") — that they have one
 * and nothing more: not which, how many or until when ("only show the green live banner for active orders").
 *
 * Live is the order field's own rule (`liveForSupport`, src/lib/ticket-open.ts) written as a query: delivered, not seats
 * added to another, and a subscription not expired. Only orders the person may see count, so nobody learns here what
 * the order list would not tell them.
 */

const DAY = 86_400_000;
export const TICKET_COMPANY_LIMIT = 20;

/** `liveForSupport`, as a query — `getRenewalStatus` calls a term expired a whole day after its end. */
export function liveOrderWhere(now: Date = new Date()): Prisma.CompanyProductWhereInput {
  return {
    orderStatus: "FULFILLED",
    parentId: null,
    OR: [{ item: { type: { not: "SUBSCRIPTION" } } }, { endDate: null }, { endDate: { gt: new Date(now.getTime() - DAY) } }],
  };
}

/** Those of these companies with an active order this person may see — theirs, or bought for them by a reseller. */
export async function liveOf(userId: string, companyIds: readonly string[], now: Date = new Date()): Promise<Set<string>> {
  const ids = new Set(companyIds);
  if (ids.size === 0) return new Set();
  const among = { in: [...ids] };
  const rows = await db.companyProduct.findMany({
    where: { AND: [{ OR: [{ companyId: among }, { endCustomerId: among }] }, liveOrderWhere(now), await orderAccess(userId, "view")] },
    select: { companyId: true, endCustomerId: true },
  });
  return new Set(rows.flatMap((o) => [o.companyId, o.endCustomerId]).filter((id): id is string => !!id && ids.has(id)));
}

/** Those with something live first, otherwise as they came. */
export function liveFirst<T extends { live: boolean }>(rows: readonly T[]): T[] {
  return [...rows.filter((r) => r.live), ...rows.filter((r) => !r.live)];
}

const SELECT = { id: true, name: true, relationshipType: true, customerCategory: { select: CATEGORY_SELECT } } as const;

/** The accounts the ticket form offers: this person's, nothing disqualified, no reseller's end customer. */
async function offered(userId: string): Promise<Prisma.CompanyWhereInput> {
  return { AND: [await companyScope(userId)], stage: { not: "DISQUALIFIED" }, managedByResellerId: null };
}

/**
 * Companies whose name holds what was typed, those with something live first — asked for first too, so a live one is
 * never past the cap behind twenty namesakes with nothing.
 */
export async function ticketCompanies(userId: string, query: string, now: Date = new Date()) {
  const typed = String(query ?? "").trim().slice(0, 120);
  if (typed.length < 2) return [];
  const base: Prisma.CompanyWhereInput = { ...(await offered(userId)), name: { contains: nameSearchText(typed), mode: "insensitive" } };
  const liveOrder: Prisma.CompanyProductWhereInput = { AND: [liveOrderWhere(now), await orderAccess(userId, "view")] };
  const order = { orderBy: { name: "asc" }, take: TICKET_COMPANY_LIMIT, select: SELECT } as const;
  const [withLive, without] = await Promise.all([
    db.company.findMany({ where: { AND: [base, { OR: [{ products: { some: liveOrder } }, { ordersAsEndCustomer: { some: liveOrder } }] }] }, ...order }),
    db.company.findMany({ where: { AND: [base, { products: { none: liveOrder } }, { ordersAsEndCustomer: { none: liveOrder } }] }, ...order }),
  ]);
  return [...withLive.map((c) => ({ ...c, live: true })), ...without.map((c) => ({ ...c, live: false }))]
    .filter((c) => companyNameMatches(c.name, typed))
    .slice(0, TICKET_COMPANY_LIMIT);
}

/**
 * For a company picked with nothing live: others of the same name — its legal form, a branch or a place after it aside —
 * that have something, so a ticket on the wrong copy is caught before it is logged.
 */
export async function liveNamesakes(userId: string, companyId: string, now: Date = new Date()) {
  const company = await db.company.findFirst({ where: { id: companyId, ...(await offered(userId)) }, select: { name: true } });
  if (!company) return [];
  const name = nameSearchText(company.name.replace(/\s*[([].*$/, ""));
  // A name this short would match companies that only begin alike.
  if (name.length < 4) return [];
  const liveOrder: Prisma.CompanyProductWhereInput = { AND: [liveOrderWhere(now), await orderAccess(userId, "view")] };
  const rows = await db.company.findMany({
    where: {
      AND: [
        await offered(userId),
        { id: { not: companyId }, name: { startsWith: name, mode: "insensitive" } },
        { OR: [{ products: { some: liveOrder } }, { ordersAsEndCustomer: { some: liveOrder } }] },
      ],
    },
    orderBy: { name: "asc" },
    take: 20,
    select: SELECT,
  });
  // The whole name, not the start of a longer word: "Indus" is not "Industrial Tools".
  return rows
    .filter((c) => !/^[\p{L}\p{N}]/u.test(c.name.slice(name.length)))
    .slice(0, 2)
    .map((c) => ({ ...c, live: true }));
}
