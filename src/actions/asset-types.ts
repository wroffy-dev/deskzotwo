"use server";

import { revalidatePath } from "next/cache";
import type { AssetKind } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { assetTypes, assetTypesReady, kindForCustom, type AssetTypeRow } from "@/lib/assets/types";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Asset types (owner, 18 Nov 2026 — src/lib/assets/types.ts): the workspace's own list of what kinds of asset it
 * keeps. Whoever manages the asset register (`assets.manage`) changes it. Deskzo's eleven are renamed, moved or hidden; one
 * the workspace added is also changed between physical and not, and deleted while nothing has it.
 */

const NOT_YET = "Asset types aren't ready in this workspace yet — they arrive with the next update. Try again shortly.";
const NAME_MAX = 60;

async function manager() {
  const user = await requireModuleAccess("it_assets");
  return (await hasEffectivePermission(user.id, "assets.manage")) ? user : null;
}

const cleanName = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

async function nameTaken(name: string, exceptId?: string) {
  const found = await db.assetType.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
  return !!found;
}

function changed() {
  revalidatePath("/settings/asset-types");
  revalidatePath("/assets");
}

export type AssetTypeSetting = AssetTypeRow & { assets: number };

/** Every type, hidden ones too, with how many assets have each. */
export async function assetTypeSettings(): Promise<AssetTypeSetting[] | null> {
  if (!(await manager())) return null;
  const types = await assetTypes({ includeHidden: true });
  if (!(await assetTypesReady())) return types.map((t) => ({ ...t, assets: 0 }));
  const counts = await db.asset.groupBy({ by: ["typeId"], _count: { _all: true } });
  const byType = new Map(counts.map((c) => [c.typeId, c._count._all]));
  return types.map((t) => ({ ...t, assets: byType.get(t.id) ?? 0 }));
}

export async function addAssetType(input: { name: string; physical: boolean }): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: "Changing asset types needs the “Manage the asset register” permission." };
  if (!(await assetTypesReady())) return { ok: false, error: NOT_YET };
  const name = cleanName(input?.name);
  if (!name) return { ok: false, error: "Give it a name — UPS, CCTV camera, projector…" };
  if (name.length > NAME_MAX) return { ok: false, error: `Keep the name to ${NAME_MAX} characters.` };
  if (await nameTaken(name)) return { ok: false, error: `There's already a type called "${name}".` };
  const last = await db.assetType.aggregate({ _max: { sortOrder: true } });
  const row = await db.assetType.create({
    data: { name, kind: kindForCustom(input?.physical !== false), sortOrder: (last._max.sortOrder ?? 0) + 10 },
    select: { id: true },
  });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "AssetType", entityId: row.id, entityLabel: `Asset type ${name}${input?.physical === false ? " (not physical)" : ""}` });
  changed();
  return { ok: true, data: { id: row.id } };
}

export async function updateAssetType(input: { id: string; name?: string; hidden?: boolean; physical?: boolean }): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: "Changing asset types needs the “Manage the asset register” permission." };
  if (!(await assetTypesReady())) return { ok: false, error: NOT_YET };
  const type = await db.assetType.findUnique({ where: { id: String(input?.id ?? "") }, select: { id: true, name: true, builtIn: true, kind: true, hidden: true } });
  if (!type) return { ok: false, error: "That type no longer exists." };
  const data: { name?: string; hidden?: boolean; kind?: AssetKind } = {};
  const said: string[] = [];
  if (input.name !== undefined) {
    const name = cleanName(input.name);
    if (!name) return { ok: false, error: "A type needs a name." };
    if (name.length > NAME_MAX) return { ok: false, error: `Keep the name to ${NAME_MAX} characters.` };
    if (name !== type.name) {
      if (await nameTaken(name, type.id)) return { ok: false, error: `There's already a type called "${name}".` };
      data.name = name;
      said.push(`renamed from "${type.name}"`);
    }
  }
  if (typeof input.hidden === "boolean" && input.hidden !== type.hidden) {
    data.hidden = input.hidden;
    said.push(input.hidden ? "hidden from the list" : "shown in the list again");
  }
  if (typeof input.physical === "boolean") {
    // Deskzo's own are what they are: a laptop is physical, a licence isn't.
    if (type.builtIn) return { ok: false, error: "Deskzo's own types can't change between physical and not. Add a type of your own instead." };
    const kind = kindForCustom(input.physical);
    if (kind !== type.kind) {
      data.kind = kind;
      said.push(input.physical ? "now physical" : "now not physical");
    }
  }
  if (Object.keys(data).length === 0) return { ok: true, data: null };
  await db.$transaction(async (tx) => {
    await tx.assetType.update({ where: { id: type.id }, data, select: { id: true } });
    // Its assets behave as it now does.
    if (data.kind) await tx.asset.updateMany({ where: { typeId: type.id }, data: { kind: data.kind } });
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "AssetType", entityId: type.id, entityLabel: `Asset type ${data.name ?? type.name}: ${said.join(", ")}` });
  changed();
  return { ok: true, data: null };
}

/** One place up or down the list. */
export async function moveAssetType(id: string, direction: "up" | "down"): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: "Changing asset types needs the “Manage the asset register” permission." };
  if (!(await assetTypesReady())) return { ok: false, error: NOT_YET };
  const list = await db.assetType.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true } });
  const at = list.findIndex((t) => t.id === id);
  const to = direction === "up" ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= list.length) return { ok: true, data: null };
  const order = list.map((t) => t.id);
  [order[at], order[to]] = [order[to]!, order[at]!];
  // Renumbered whole, so ties left by older rows can't keep two in one place.
  await db.$transaction(async (tx) => {
    for (const [i, tid] of order.entries()) await tx.assetType.update({ where: { id: tid }, data: { sortOrder: (i + 1) * 10 }, select: { id: true } });
  });
  changed();
  return { ok: true, data: null };
}

/** A type the workspace added, while no asset has it. Deskzo's own, or one in use, is hidden instead. */
export async function deleteAssetType(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: "Changing asset types needs the “Manage the asset register” permission." };
  if (!(await assetTypesReady())) return { ok: false, error: NOT_YET };
  const type = await db.assetType.findUnique({ where: { id: String(id ?? "") }, select: { id: true, name: true, builtIn: true } });
  if (!type) return { ok: true, data: null };
  if (type.builtIn) return { ok: false, error: "Deskzo's own types can't be deleted. Hide it instead, and it leaves the list." };
  const used = await db.asset.count({ where: { typeId: type.id } });
  if (used > 0) return { ok: false, error: `${used.toLocaleString("en-IN")} asset${used === 1 ? " has" : "s have"} this type. Hide it instead, or change ${used === 1 ? "that asset" : "them"} first.` };
  await db.assetType.delete({ where: { id: type.id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "AssetType", entityId: type.id, entityLabel: `Asset type ${type.name}` });
  changed();
  return { ok: true, data: null };
}
