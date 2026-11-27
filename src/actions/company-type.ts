"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { companyTypeOptions, keyForName } from "@/lib/companies/company-types";
import type { ActionResult } from "@/actions/company";

/**
 * The workspace's company types (owner, 27 Oct 2026 — Settings › Lists): added, renamed and deleted by whoever
 * manages settings. Deleting one clears it from the companies that had it, which the screen says first.
 */

const NOT_YOURS = "You can't manage the company types.";

export type CompanyTypeRow = { id: string; key: string; name: string; used: number };

export async function listCompanyTypes() {
  await requireUser();
  return companyTypeOptions();
}

/** The list with how many companies hold each, for Settings › Lists. */
export async function listCompanyTypesForSettings(): Promise<CompanyTypeRow[]> {
  await requireUser();
  const [types, counts] = await Promise.all([
    db.companyTypeOption.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, key: true, name: true } }),
    db.company.groupBy({ by: ["companyType"], where: { companyType: { not: null } }, _count: { _all: true } }),
  ]);
  const used = new Map(counts.map((c) => [c.companyType, c._count._all]));
  return types.map((t) => ({ ...t, used: used.get(t.key) ?? 0 }));
}

const cleanName = (name: unknown) => String(name ?? "").trim().replace(/\s+/g, " ");

const SAME_NAME = "There's already a company type with that name.";

/** Another type of that name, whatever its capitals. */
const nameTaken = async (name: string, exceptId?: string) =>
  !!(await db.companyTypeOption.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } }));

export async function createCompanyType(name: unknown): Promise<ActionResult<CompanyTypeRow>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return { ok: false, error: NOT_YOURS };
  const label = cleanName(name);
  if (label.length < 2 || label.length > 60) return { ok: false, error: "A company type needs a name of 2 to 60 characters." };
  if (await nameTaken(label)) return { ok: false, error: SAME_NAME };
  const base = keyForName(label);
  if (!base) return { ok: false, error: "A company type's name needs a letter or a digit in it." };
  // A key once used stays that type's: a clash (a name differing only in punctuation) takes a number.
  let key = base;
  for (let n = 2; await db.companyTypeOption.findUnique({ where: { key }, select: { id: true } }); n++) key = `${base}_${n}`;
  const last = await db.companyTypeOption.aggregate({ _max: { sortOrder: true } });
  try {
    const row = await db.companyTypeOption.create({ data: { key, name: label, sortOrder: (last._max.sortOrder ?? 0) + 1 }, select: { id: true, key: true, name: true } });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "CompanyTypeOption", entityId: row.id, entityLabel: `Added the company type ${label}` });
    revalidatePath("/settings/lists");
    return { ok: true, data: { ...row, used: 0 } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, error: SAME_NAME };
    throw err;
  }
}

export async function renameCompanyType(id: string, name: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return { ok: false, error: NOT_YOURS };
  const label = cleanName(name);
  if (label.length < 2 || label.length > 60) return { ok: false, error: "A company type needs a name of 2 to 60 characters." };
  if (await nameTaken(label, String(id ?? ""))) return { ok: false, error: SAME_NAME };
  try {
    // The key stays: companies, filters and the API name the type by it.
    const row = await db.companyTypeOption.update({ where: { id: String(id ?? "") }, data: { name: label }, select: { id: true } });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "CompanyTypeOption", entityId: row.id, entityLabel: `Renamed a company type to ${label}` });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, error: SAME_NAME };
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return { ok: false, error: "That company type isn't there any more." };
    throw err;
  }
  revalidatePath("/settings/lists");
  revalidatePath("/customers");
  return { ok: true, data: null };
}

/** Deletes a type; the companies that had it are left with none. */
export async function deleteCompanyType(id: string): Promise<ActionResult<{ cleared: number }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return { ok: false, error: NOT_YOURS };
  const type = await db.companyTypeOption.findUnique({ where: { id: String(id ?? "") }, select: { id: true, key: true, name: true } });
  if (!type) return { ok: false, error: "That company type isn't there any more." };
  const cleared = await db.$transaction(async (tx) => {
    const { count } = await tx.company.updateMany({ where: { companyType: type.key }, data: { companyType: null } });
    await tx.companyTypeOption.delete({ where: { id: type.id } });
    return count;
  });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "CompanyTypeOption",
    entityId: type.id,
    entityLabel: `Deleted the company type ${type.name}${cleared ? `, clearing it from ${cleared} ${cleared === 1 ? "company" : "companies"}` : ""}`,
  });
  revalidatePath("/settings/lists");
  revalidatePath("/customers");
  return { ok: true, data: { cleared } };
}
