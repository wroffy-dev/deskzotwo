"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { refuseWhileViewingAs } from "@/lib/session";
import { requireModuleUser } from "@/lib/modules-access";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { mayAccessAccount, throughAccount } from "@/lib/authz/access";
import { ELSEWHERE_SELECT, elsewhereData, elsewhereNotKeptYet, elsewhereSchema, type ElsewhereInput } from "@/lib/customers/elsewhere";
import { workspaceClock } from "@/lib/time/workspace";
import { isElsewhereCategory } from "@/lib/customers/elsewhere-categories";
import type { ActionResult } from "@/actions/company";

/**
 * Installed elsewhere (owner, 2 Nov 2026 — src/lib/customers/elsewhere.ts): a customer's tab, and the list across every
 * customer. Seen by whoever may see the customer, added to and changed by whoever may change it — the customer's own
 * access, no permission of its own.
 */

const ACCOUNT = { id: true, name: true, ownerUserId: true, relationshipType: true } as const;

async function account(companyId: string) {
  return db.company.findUnique({ where: { id: String(companyId ?? "") }, select: ACCOUNT });
}

/** One customer's entries, soonest renewal first, and whether this person may change them. */
export async function companyElsewhere(companyId: string) {
  const user = await requireModuleUser("companies");
  const company = await account(companyId);
  if (!company || !(await canSeeCompany(user.id, company))) return null;
  try {
    const [rows, canEdit] = await Promise.all([
      db.installedElsewhere.findMany({ where: { companyId: company.id }, orderBy: [{ renewsOn: { sort: "asc", nulls: "last" } }, { productName: "asc" }], select: ELSEWHERE_SELECT }),
      mayAccessAccount(user.id, "edit", company),
    ]);
    return { rows: toPlain(rows), canEdit, ready: true };
  } catch (err) {
    if (elsewhereNotKeptYet(err)) return { rows: [], canEdit: false, ready: false };
    throw err;
  }
}

/** Our own item of that name, if the product is one we sell — so a lead from it starts with the item. */
async function itemNamed(name: string): Promise<string | null> {
  const item = await db.item.findFirst({ where: { name: { equals: name.trim(), mode: "insensitive" } }, select: { id: true } }).catch(() => null);
  return item?.id ?? null;
}

export async function saveElsewhere(input: { id?: string | null; companyId: string } & ElsewhereInput): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("companies");
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const { id, companyId, ...fields } = input ?? ({} as typeof input);
  const company = await account(companyId);
  if (!company || !(await canSeeCompany(user.id, company))) return { ok: false, error: "Customer not found." };
  if (!(await mayAccessAccount(user.id, "edit", company))) return { ok: false, error: "You can't change this customer's details." };
  const parsed = elsewhereSchema.safeParse(fields);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Something in it isn't right." };
  if (parsed.data.category && !(await isElsewhereCategory(parsed.data.category))) return { ok: false, error: "That category isn't on the list any more — pick another." };
  const data = { ...elsewhereData(parsed.data), itemId: await itemNamed(parsed.data.productName) };

  try {
    if (id) {
      const current = await db.installedElsewhere.findUnique({ where: { id }, select: { companyId: true, renewsOn: true } });
      if (!current || current.companyId !== company.id) return { ok: false, error: "That entry isn't there any more." };
      await db.installedElsewhere.update({ where: { id }, data: { ...data, updatedById: user.id } });
    } else {
      const made = await db.installedElsewhere.create({ data: { ...data, companyId: company.id, createdById: user.id, updatedById: user.id }, select: { id: true } });
      await recordAudit({ userId: user.id, action: "CREATE", entityType: "Company", entityId: company.id, entityLabel: `${company.name}: installed elsewhere — ${data.productName}${data.boughtFrom ? ` from ${data.boughtFrom}` : ""}` });
      revalidatePath("/customers/elsewhere");
      return { ok: true, data: made };
    }
  } catch (err) {
    if (elsewhereNotKeptYet(err)) return { ok: false, error: "This workspace can't keep these until its next update." };
    throw err;
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: company.id, entityLabel: `${company.name}: installed elsewhere — ${data.productName} changed` });
  revalidatePath("/customers/elsewhere");
  return { ok: true, data: { id: id! } };
}

export async function deleteElsewhere(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("companies");
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const row = await db.installedElsewhere.findUnique({ where: { id: String(id ?? "") }, select: { id: true, productName: true, companyId: true } }).catch(() => null);
  const company = row ? await account(row.companyId) : null;
  if (!row || !company || !(await canSeeCompany(user.id, company))) return { ok: false, error: "That entry isn't there any more." };
  if (!(await mayAccessAccount(user.id, "edit", company))) return { ok: false, error: "You can't change this customer's details." };
  await db.installedElsewhere.delete({ where: { id: row.id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "Company", entityId: company.id, entityLabel: `${company.name}: installed elsewhere — ${row.productName} removed` });
  revalidatePath("/customers/elsewhere");
  return { ok: true, data: null };
}

export type ElsewhereFilters = { q?: string; category?: string; from?: string; renews?: string; owner?: string; take?: number };

/**
 * Every customer's entries this person may see — Customers › Installed elsewhere and its Excel — soonest renewal first,
 * at most 2,000. Filtered by words (product, who sold it, customer), category, seller, renewal window and account manager.
 */
export async function listElsewhere(filters: ElsewhereFilters = {}) {
  const user = await requireModuleUser("companies");
  const scope = await throughAccount(user.id, "view");
  const today = (await workspaceClock()).calendarDate(new Date());
  const q = (filters.q ?? "").trim().slice(0, 100);
  const has = { contains: q, mode: "insensitive" as const };
  const days = Number(filters.renews);
  const window: Prisma.InstalledElsewhereWhereInput =
    filters.renews === "past" ? { renewsOn: { lt: today } }
    : filters.renews === "none" ? { renewsOn: null }
    : Number.isFinite(days) && days > 0 ? { renewsOn: { gte: today, lte: new Date(today.getTime() + days * 86_400_000) } }
    : {};
  const where: Prisma.InstalledElsewhereWhereInput = {
    ...window,
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.from ? { boughtFrom: { equals: filters.from, mode: "insensitive" } } : {}),
    ...(q ? { OR: [{ productName: has }, { boughtFrom: has }, { notes: has }, { company: { name: has } }] } : {}),
    // The account's own reach, and the account manager asked for — ANDed, never merged: a merged `ownerUserId` would
    // replace the reach's own and open somebody else's customers.
    company: { AND: [scope.company ?? {}, filters.owner ? { ownerUserId: filters.owner } : {}] },
  };
  try {
    const [rows, sellers] = await Promise.all([
      db.installedElsewhere.findMany({
        where,
        orderBy: [{ renewsOn: { sort: "asc", nulls: "last" } }, { productName: "asc" }],
        take: Math.min(2000, Math.max(1, Math.trunc(filters.take ?? 2000))),
        select: { ...ELSEWHERE_SELECT, company: { select: { id: true, name: true, companySeq: true, owner: { select: { id: true, name: true } } } } },
      }),
      // Who they buy from, for the filter — across what this person may see.
      db.installedElsewhere.findMany({ where: { company: scope.company ?? {}, boughtFrom: { not: null } }, distinct: ["boughtFrom"], select: { boughtFrom: true }, orderBy: { boughtFrom: "asc" }, take: 300 }),
    ]);
    return { rows: toPlain(rows), sellers: sellers.map((s) => s.boughtFrom!).filter(Boolean), today: today.toISOString().slice(0, 10), ready: true };
  } catch (err) {
    if (elsewhereNotKeptYet(err)) return { rows: [], sellers: [], today: today.toISOString().slice(0, 10), ready: false };
    throw err;
  }
}
