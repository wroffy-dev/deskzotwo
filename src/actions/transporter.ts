"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import type { ActionResult } from "@/actions/company";
import { clip, clipOrNull, TEXT_MAX } from "@/lib/text/bounded";

/**
 * Couriers and transport companies, as records rather than free text.
 *
 * The reason free text fails here is the reason it always fails: "Gati", "GATI", "Gati Ltd" and
 * "gati courier" are four transporters as far as any report is concerned, none of them carries the
 * GSTIN the e-way bill portal asks for, and nobody can pick last month's courier from a list that
 * does not exist. A transporter is a party dealt with repeatedly, so it gets a row.
 */

async function gate() {
  const user = await requireModuleUser(["sales_documents", "it_assets"]);
  if (!(await can(user.id, "assets.manage")) && !(await can(user.id, "orders.process"))) {
    return { user, error: "You don't have access to despatch." };
  }
  return { user, error: null };
}

/**
 * `gate` for the actions only Sales Documents's or IT Assets's own pages use: Sales Documents or IT Assets open to the person as well. The actions other
 * screens use keep `gate` alone (owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-6).
 */
async function gateIfOpen(...args: Parameters<typeof gate>) {
  await requireModuleAccess(["sales_documents", "it_assets"]);
  return gate(...args);
}

export type TransporterRow = {
  id: string;
  name: string;
  gstin: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  defaultMode: "ROAD" | "RAIL" | "AIR" | "SHIP";
  notes: string | null;
  active: boolean;
  consignments: number;
  ewayBills: number;
};

export async function listTransporters(params?: { includeRetired?: boolean; q?: string }): Promise<
  ActionResult<TransporterRow[]>
> {
  const { error } = await gate();
  if (error) return { ok: false, error };

  const rows = await db.transporter.findMany({
    where: {
      ...(params?.includeRetired ? {} : { active: true }),
      ...(params?.q ? { name: { contains: params.q, mode: "insensitive" as const } } : {}),
    },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { consignments: true, ewayBills: true } } },
  });

  return {
    ok: true,
    data: rows.map((t) => ({
      id: t.id,
      name: t.name,
      gstin: t.gstin,
      contactName: t.contactName,
      phone: t.phone,
      email: t.email,
      defaultMode: t.defaultMode,
      notes: t.notes,
      active: t.active,
      consignments: t._count.consignments,
      ewayBills: t._count.ewayBills,
    })),
  };
}

/** Just enough for a picker, and only the ones still in use. */
export async function transporterOptions(): Promise<
  ActionResult<{ id: string; name: string; gstin: string | null; defaultMode: string }[]>
> {
  const { error } = await gate();
  if (error) return { ok: false, error };

  const rows = await db.transporter.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, gstin: true, defaultMode: true },
  });
  return { ok: true, data: rows };
}

export async function saveTransporter(input: {
  id?: string | null;
  name: string;
  gstin?: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  defaultMode: "ROAD" | "RAIL" | "AIR" | "SHIP";
  notes?: string | null;
}): Promise<ActionResult<{ id: string }>> {
  const { user, error } = await gateIfOpen();
  if (error) return { ok: false, error };

  // Typed text is capped before it is stored (owner, 15 Nov 2026 — input bounds).
  const name = clip(input.name, TEXT_MAX.name);
  if (!name) return { ok: false, error: "A transporter needs a name." };

  /**
   * GSTIN and TRANSIN are both fifteen characters and both go in the same field, so the check is
   * on length and shape rather than on which of the two it is. Refused rather than stored wrong —
   * the portal rejects a malformed one, and finding that out at despatch time is expensive.
   */
  const gstin = input.gstin?.trim().toUpperCase() || null;
  if (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) {
    return { ok: false, error: "A GSTIN or TRANSIN is 15 characters, letters and digits only." };
  }

  const duplicate = await db.transporter.findFirst({
    where: { name: { equals: name, mode: "insensitive" }, ...(input.id ? { id: { not: input.id } } : {}) },
    select: { id: true },
  });
  // The whole point of the table is one row per transporter; letting a second "Gati" in would put
  // it straight back to where free text was.
  if (duplicate) return { ok: false, error: `There is already a transporter called ${name}.` };

  const data = {
    name,
    gstin,
    contactName: clipOrNull(input.contactName, TEXT_MAX.name),
    phone: clipOrNull(input.phone, TEXT_MAX.phone),
    email: clipOrNull(input.email, TEXT_MAX.email),
    defaultMode: input.defaultMode,
    notes: clipOrNull(input.notes, TEXT_MAX.notes),
  };

  const saved = input.id
    ? await db.transporter.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.transporter.create({ data: { ...data, createdById: user.id }, select: { id: true } });

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "Transporter",
    entityId: saved.id,
    entityLabel: name,
  });

  revalidatePath("/logistics/transporters");
  return { ok: true, data: { id: saved.id } };
}

/**
 * Retires a transporter rather than deleting it.
 *
 * Every consignment they ever carried names them. Deleting the row would either break those or
 * silently blank the carrier on years of despatch history, so they come off the picker and stay in
 * the record.
 */
export async function setTransporterActive(input: { id: string; active: boolean }): Promise<
  ActionResult<{ active: boolean }>
> {
  const { user, error } = await gateIfOpen();
  if (error) return { ok: false, error };

  const transporter = await db.transporter.findUnique({ where: { id: input.id }, select: { id: true, name: true } });
  if (!transporter) return { ok: false, error: "That transporter no longer exists." };

  await db.transporter.update({ where: { id: transporter.id }, data: { active: input.active } });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Transporter",
    entityId: transporter.id,
    entityLabel: `${input.active ? "Restored" : "Retired"} ${transporter.name}`,
  });

  revalidatePath("/logistics/transporters");
  return { ok: true, data: { active: input.active } };
}
