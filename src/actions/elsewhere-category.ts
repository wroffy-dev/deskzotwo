"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { hasEffectivePermission } from "@/actions/permission";
import { keyForName } from "@/lib/companies/company-types";
import { elsewhereCategoryOptions } from "@/lib/customers/elsewhere-categories";
import type { ActionResult } from "@/actions/company";

/**
 * Installed elsewhere's categories (owner, 2 Nov 2026: "this category list should be editable so more can be added or
 * deleted" — Settings › Lists): added, renamed and deleted by whoever manages settings, as company types are. Deleting
 * one clears it from the entries that had it, which the screen says first.
 */

const NOT_YOURS = "You can't manage the installed-elsewhere categories.";
const NOT_YET = "This workspace can't keep its own categories until its next update.";
const SAME_NAME = "There's already a category with that name.";

export type ElsewhereCategoryRow = { id: string; key: string; name: string; used: number };

export async function listElsewhereCategories() {
  await requireUser();
  return elsewhereCategoryOptions();
}

/** The list with how many entries hold each, for Settings › Lists; null in a workspace not migrated yet. */
export async function listElsewhereCategoriesForSettings(): Promise<ElsewhereCategoryRow[] | null> {
  await requireUser();
  try {
    const [rows, counts] = await Promise.all([
      db.elsewhereCategoryOption.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, key: true, name: true } }),
      db.installedElsewhere.groupBy({ by: ["category"], where: { category: { not: null } }, _count: { _all: true } }),
    ]);
    const used = new Map(counts.map((c) => [c.category, c._count._all]));
    return rows.map((r) => ({ ...r, used: used.get(r.key) ?? 0 }));
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

const cleanName = (name: unknown) => String(name ?? "").trim().replace(/\s+/g, " ");

/** Another category of that name, whatever its capitals. */
const nameTaken = async (name: string, exceptId?: string) =>
  !!(await db.elsewhereCategoryOption.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } }));

export async function createElsewhereCategory(name: unknown): Promise<ActionResult<ElsewhereCategoryRow>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return { ok: false, error: NOT_YOURS };
  const label = cleanName(name);
  if (label.length < 2 || label.length > 60) return { ok: false, error: "A category needs a name of 2 to 60 characters." };
  try {
    if (await nameTaken(label)) return { ok: false, error: SAME_NAME };
    const base = keyForName(label);
    if (!base) return { ok: false, error: "A category's name needs a letter or a digit in it." };
    // A key once used stays that category's: a clash (a name differing only in punctuation) takes a number.
    let key = base;
    for (let n = 2; await db.elsewhereCategoryOption.findUnique({ where: { key }, select: { id: true } }); n++) key = `${base}_${n}`;
    const last = await db.elsewhereCategoryOption.aggregate({ _max: { sortOrder: true } });
    const row = await db.elsewhereCategoryOption.create({ data: { key, name: label, sortOrder: (last._max.sortOrder ?? 0) + 1 }, select: { id: true, key: true, name: true } });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "ElsewhereCategoryOption", entityId: row.id, entityLabel: `Added the installed-elsewhere category ${label}` });
    revalidatePath("/settings/lists");
    return { ok: true, data: { ...row, used: 0 } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, error: SAME_NAME };
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
}

export async function renameElsewhereCategory(id: string, name: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return { ok: false, error: NOT_YOURS };
  const label = cleanName(name);
  if (label.length < 2 || label.length > 60) return { ok: false, error: "A category needs a name of 2 to 60 characters." };
  try {
    if (await nameTaken(label, String(id ?? ""))) return { ok: false, error: SAME_NAME };
    // The key stays: entries, filters and saved reports name the category by it.
    const row = await db.elsewhereCategoryOption.update({ where: { id: String(id ?? "") }, data: { name: label }, select: { id: true } });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ElsewhereCategoryOption", entityId: row.id, entityLabel: `Renamed an installed-elsewhere category to ${label}` });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, error: SAME_NAME };
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return { ok: false, error: "That category isn't there any more." };
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  revalidatePath("/settings/lists");
  revalidatePath("/customers/elsewhere");
  return { ok: true, data: null };
}

/** Deletes a category; the entries that had it are left with none. */
export async function deleteElsewhereCategory(id: string): Promise<ActionResult<{ cleared: number }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return { ok: false, error: NOT_YOURS };
  try {
    const row = await db.elsewhereCategoryOption.findUnique({ where: { id: String(id ?? "") }, select: { id: true, key: true, name: true } });
    if (!row) return { ok: false, error: "That category isn't there any more." };
    const cleared = await db.$transaction(async (tx) => {
      const { count } = await tx.installedElsewhere.updateMany({ where: { category: row.key }, data: { category: null } });
      await tx.elsewhereCategoryOption.delete({ where: { id: row.id } });
      return count;
    });
    await recordAudit({
      userId: user.id,
      action: "DELETE",
      entityType: "ElsewhereCategoryOption",
      entityId: row.id,
      entityLabel: `Deleted the installed-elsewhere category ${row.name}${cleared ? `, clearing it from ${cleared} ${cleared === 1 ? "entry" : "entries"}` : ""}`,
    });
    revalidatePath("/settings/lists");
    revalidatePath("/customers/elsewhere");
    return { ok: true, data: { cleared } };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
}
