import type { AssetKind } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { tenantKey } from "@/lib/tenancy/cache";
import { assetKindLabels } from "@/lib/assets/lifecycle";

/**
 * The kinds of asset a workspace keeps, as its own list (owner, 18 Nov 2026: "make it a list each workspace manages").
 *
 *   · It starts as Deskzo's eleven (Laptop … Other), kept with fixed ids `atype_<kind>` by the migration that made the table
 *     (20261218600000_asset_types), every asset given the type of its kind. Those may be renamed, reordered and hidden, never
 *     deleted. A workspace adds its own — UPS, CCTV camera, projector — each physical or not.
 *   · An asset keeps its `kind` beside its type: what it behaves as (a licence has no site and no movements, `isPhysical`),
 *     and what reports across workspaces count by. A built-in type is its own kind; one the workspace added is OTHER when
 *     physical, SOFTWARE_LICENCE when not.
 *   · A workspace not migrated yet has no table and no `typeId`: it is shown Deskzo's eleven, as before, and saves the kind.
 */

export type AssetTypeRow = { id: string; name: string; kind: AssetKind; builtIn: boolean; hidden: boolean; sortOrder: number; physical: boolean };

export const builtInTypeId = (kind: AssetKind) => `atype_${kind.toLowerCase()}`;

const BUILT_IN: AssetTypeRow[] = (Object.keys(assetKindLabels) as AssetKind[]).map((kind, i) => ({
  id: builtInTypeId(kind),
  name: assetKindLabels[kind],
  kind,
  builtIn: true,
  hidden: false,
  sortOrder: (i + 1) * 10,
  physical: kind !== "SOFTWARE_LICENCE",
}));

/** What a type the workspace adds behaves as. */
export const kindForCustom = (physical: boolean): AssetKind => (physical ? "OTHER" : "SOFTWARE_LICENCE");

const ready = new Map<string, boolean>();

/** Whether this workspace has the table and the column yet — asked once a process, remembered once it has. */
export async function assetTypesReady(): Promise<boolean> {
  const key = await tenantKey().catch(() => "default");
  if (ready.get(key)) return true;
  try {
    await db.assetType.findFirst({ select: { id: true } });
    await db.asset.findFirst({ select: { typeId: true } });
    ready.set(key, true);
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/** The workspace's types in their order — the hidden ones too when asked. Deskzo's eleven before the table exists. */
export async function assetTypes(opts: { includeHidden?: boolean } = {}): Promise<AssetTypeRow[]> {
  if (!(await assetTypesReady())) return BUILT_IN;
  const rows = await db.assetType.findMany({
    where: opts.includeHidden ? {} : { hidden: false },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, kind: true, builtIn: true, hidden: true, sortOrder: true },
  });
  return rows.map((r) => ({ ...r, physical: r.kind !== "SOFTWARE_LICENCE" }));
}

/**
 * Each asset's type as the workspace calls it: `typeId` and `typeName` beside what the rows already have. An asset with no
 * type — made before, or in a workspace not migrated — reads as its kind.
 */
export async function withTypeNames<T extends { id: string; kind: AssetKind }>(rows: T[]): Promise<(T & { typeId: string | null; typeName: string })[]> {
  if (rows.length === 0) return [];
  let typeOf = new Map<string, string | null>();
  let names = new Map<string, string>();
  if (await assetTypesReady()) {
    const [assets, types] = await Promise.all([
      db.asset.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, typeId: true } }),
      assetTypes({ includeHidden: true }),
    ]);
    typeOf = new Map(assets.map((a) => [a.id, a.typeId]));
    names = new Map(types.map((t) => [t.id, t.name]));
  }
  return rows.map((r) => {
    const typeId = typeOf.get(r.id) ?? null;
    return { ...r, typeId, typeName: (typeId && names.get(typeId)) || assetKindLabels[r.kind] };
  });
}

/**
 * The type and kind a save writes, from what the form sent: a type of this workspace's — not a hidden one, unless the
 * asset has it already — else, from an older form or a workspace not migrated, a kind. A refusal says why.
 */
export async function typeForSave(input: { typeId?: string | null; kind?: string | null; currentTypeId?: string | null }): Promise<{ typeId: string | null; kind: AssetKind } | { error: string }> {
  const typeId = typeof input.typeId === "string" ? input.typeId.trim() : "";
  if (typeId && (await assetTypesReady())) {
    const type = await db.assetType.findUnique({ where: { id: typeId }, select: { id: true, kind: true, hidden: true, name: true } });
    if (!type) return { error: "That kind of asset no longer exists. Choose another." };
    if (type.hidden && type.id !== input.currentTypeId) return { error: `"${type.name}" is hidden from the list. Choose another, or show it again under Settings › Asset types.` };
    return { typeId: type.id, kind: type.kind };
  }
  const kind = (input.kind ?? "") as AssetKind;
  if (kind in assetKindLabels) return { typeId: (await assetTypesReady()) ? builtInTypeId(kind) : null, kind };
  if (typeId) {
    // A workspace not migrated: a built-in type's id names its kind.
    const built = BUILT_IN.find((t) => t.id === typeId);
    if (built) return { typeId: null, kind: built.kind };
  }
  return { error: "Choose what kind of asset it is." };
}

/** A type by name, as an import file writes it — the workspace's name, or Deskzo's kind key ("LAPTOP", "Network device"). */
export async function typeByName(text: string): Promise<{ typeId: string | null; kind: AssetKind; name: string } | null> {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return null;
  const types = await assetTypes({ includeHidden: true });
  const byName = types.find((t) => t.name.toLowerCase() === wanted);
  if (byName) return { typeId: (await assetTypesReady()) ? byName.id : null, kind: byName.kind, name: byName.name };
  const kind = (Object.keys(assetKindLabels) as AssetKind[]).find((k) => k.toLowerCase() === wanted || k.toLowerCase().replace(/_/g, " ") === wanted);
  if (!kind) return null;
  const builtIn = types.find((t) => t.id === builtInTypeId(kind));
  return { typeId: (await assetTypesReady()) ? builtInTypeId(kind) : null, kind, name: builtIn?.name ?? assetKindLabels[kind] };
}
