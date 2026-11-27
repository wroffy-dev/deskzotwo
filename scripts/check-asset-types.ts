/**
 * check:asset-types — the kinds of asset a workspace keeps, as its own list (owner, 18 Nov 2026; src/lib/assets/types.ts,
 * src/actions/asset-types.ts, Settings › Asset types).
 *
 *   · It starts as Deskzo's eleven, with fixed ids, and every asset has the type of its kind.
 *   · Added, renamed, moved, hidden and shown by whoever manages the register; a name once, whatever its case.
 *   · Deskzo's own: renamed or hidden, never deleted, never switched between physical and not.
 *   · One of the workspace's own: physical or not — its assets behave as it does — and deleted only while nothing has it.
 *   · Saving an asset: the type decides its kind; a hidden type refused, unless the asset has it already.
 *   · The register shows each asset's type by name; an import reads a type by name, and an export writes it so.
 *
 * Against the local database, as its super admin; the types and assets it makes are removed at the end.
 *
 *   npm run check:asset-types
 */
import "dotenv/config";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "ADMIN", name: "Zz Types", email: "zz-types@example.invalid" };
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function main() {
  const db = directClient();
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true } });
  if (!admin) throw new Error("No super admin in the local database.");
  actor = { id: admin.id, role: "ADMIN", name: admin.name, email: admin.email ?? actor.email };

  const types = await import("../src/lib/assets/types");
  const actions = await import("../src/actions/asset-types");
  const assets = await import("../src/actions/it-asset");
  const run = Date.now().toString(36).toUpperCase();
  const made: string[] = [];
  const madeAssets: string[] = [];

  try {
    section("Deskzo's eleven to begin with");
    const all = await types.assetTypes({ includeHidden: true });
    const builtIns = all.filter((t) => t.builtIn);
    ok("the eleven, with fixed ids, Laptop first", builtIns.length === 11 && builtIns.every((t) => t.id === types.builtInTypeId(t.kind)) && all[0]?.id === "atype_laptop", builtIns.map((t) => t.id));
    const untyped = await db.asset.count({ where: { typeId: null } });
    ok("every asset has a type — the migration gave each the type of its kind", untyped === 0, untyped);

    section("Settings › Asset types");
    const ups = await actions.addAssetType({ name: `  Zz UPS ${run} `, physical: true });
    ok("a type of its own added, physical: behaves as OTHER", ups.ok && (await db.assetType.findUnique({ where: { id: ups.data.id } }))?.kind === "OTHER" && (await db.assetType.findUnique({ where: { id: ups.data.id } }))?.name === `Zz UPS ${run}`);
    if (ups.ok) made.push(ups.data.id);
    const saas = await actions.addAssetType({ name: `Zz SaaS ${run}`, physical: false });
    ok("  one not physical: behaves as a licence", saas.ok && (await db.assetType.findUnique({ where: { id: saas.data.id } }))?.kind === "SOFTWARE_LICENCE");
    if (saas.ok) made.push(saas.data.id);
    const twice = await actions.addAssetType({ name: `zz ups ${run}`, physical: true });
    ok("  a name once, whatever its case", !twice.ok && /already a type called/.test(twice.error), twice.ok ? "" : twice.error);
    ok("  a name is needed", !(await actions.addAssetType({ name: "  ", physical: true })).ok);
    const last = (await types.assetTypes()).at(-1);
    ok("  added at the end of the list", last?.id === (saas.ok ? saas.data.id : ""));

    const renamed = await actions.updateAssetType({ id: "atype_network", name: `Zz Network gear ${run}` });
    ok("Deskzo's own renamed", renamed.ok && (await db.assetType.findUnique({ where: { id: "atype_network" } }))?.name === `Zz Network gear ${run}`);
    const flip = await actions.updateAssetType({ id: "atype_laptop", physical: false });
    ok("  but never switched between physical and not", !flip.ok && (await db.assetType.findUnique({ where: { id: "atype_laptop" } }))?.kind === "LAPTOP");
    const gone = await actions.deleteAssetType("atype_printer");
    ok("  nor deleted — hidden instead", !gone.ok && /Hide it instead/.test(gone.error) && !!(await db.assetType.findUnique({ where: { id: "atype_printer" } })));
    await actions.updateAssetType({ id: "atype_network", name: "Network device" });

    const before = (await types.assetTypes()).map((t) => t.id);
    const at = before.indexOf(ups.ok ? ups.data.id : "");
    await actions.moveAssetType(ups.ok ? ups.data.id : "", "up");
    const after = (await types.assetTypes()).map((t) => t.id);
    ok("moved up one place", after.indexOf(ups.ok ? ups.data.id : "") === at - 1, { at, now: after.indexOf(ups.ok ? ups.data.id : "") });

    section("Saving an asset");
    const save = (tag: string, typeId: string, id?: string) => assets.saveAsset({ id, assetTag: tag, name: `Zz ${tag}`, typeId, ownership: "INTERNAL" });
    const a1 = await save(`ZZT-${run}-1`, ups.ok ? ups.data.id : "");
    if (a1.ok) madeAssets.push(a1.data.id);
    const row1 = a1.ok ? await db.asset.findUnique({ where: { id: a1.data.id }, select: { kind: true, typeId: true } }) : null;
    ok("the type decides the kind: a UPS is kept as OTHER, with its type", row1?.kind === "OTHER" && row1.typeId === (ups.ok ? ups.data.id : ""), row1);
    const listed = await assets.listAssets({ search: `ZZT-${run}` });
    ok("  and the register shows it by the type's name", listed.some((a) => a.typeName === `Zz UPS ${run}`), listed.map((a) => a.typeName));
    const hide = await actions.updateAssetType({ id: ups.ok ? ups.data.id : "", hidden: true });
    ok("hidden: off the list offered", hide.ok && !(await types.assetTypes()).some((t) => t.id === (ups.ok ? ups.data.id : "")));
    const a2 = await save(`ZZT-${run}-2`, ups.ok ? ups.data.id : "");
    ok("  a new asset can't take it", !a2.ok && /hidden from the list/.test(a2.error), a2.ok ? "" : a2.error);
    const kept = a1.ok ? await save(`ZZT-${run}-1`, ups.ok ? ups.data.id : "", a1.data.id) : { ok: false as const, error: "" };
    ok("  an asset that has it keeps it when saved", kept.ok, kept.ok ? "" : kept.error);
    await actions.updateAssetType({ id: ups.ok ? ups.data.id : "", hidden: false });
    const del = await actions.deleteAssetType(ups.ok ? ups.data.id : "");
    ok("in use: not deleted, and says how many have it", !del.ok && /1 asset has this type/.test(del.error), del.ok ? "" : del.error);
    const toLicence = await actions.updateAssetType({ id: ups.ok ? ups.data.id : "", physical: false });
    const nowKind = a1.ok ? (await db.asset.findUnique({ where: { id: a1.data.id }, select: { kind: true } }))?.kind : null;
    ok("switched to not physical: its assets behave so too", toLicence.ok && nowKind === "SOFTWARE_LICENCE", nowKind);
    await actions.updateAssetType({ id: ups.ok ? ups.data.id : "", physical: true });

    section("Import and export");
    ok("an import names a type by its name, any case, or by Deskzo's kind", (await types.typeByName(`ZZ UPS ${run}`))?.typeId === (ups.ok ? ups.data.id : "") && (await types.typeByName("LAPTOP"))?.typeId === "atype_laptop" && (await types.typeByName("network device"))?.kind === "NETWORK" && (await types.typeByName("Toaster")) === null);
    ok("  the export writes the type's name", readFileSync("src/lib/portability/exporters/assets.ts", "utf8").includes("Kind: a.typeName,"));

    section("Deleting one nothing has");
    if (a1.ok) await db.asset.deleteMany({ where: { id: a1.data.id } });
    madeAssets.length = 0;
    const freed = await actions.deleteAssetType(ups.ok ? ups.data.id : "");
    ok("deleted once no asset has it", freed.ok && !(await db.assetType.findUnique({ where: { id: ups.ok ? ups.data.id : "" } })));

    section("Who may");
    actor = { ...actor, id: "zz-nobody" };
    const nobody = await actions.addAssetType({ name: `Zz Nope ${run}`, physical: true }).catch((e: Error) => ({ ok: false as const, error: e.message }));
    ok("somebody who doesn't manage the register can't", !nobody.ok);
    actor = { ...actor, id: admin.id };
  } finally {
    await db.assetMovement.deleteMany({ where: { assetId: { in: madeAssets } } });
    await db.asset.deleteMany({ where: { assetTag: { startsWith: `ZZT-${run}` } } });
    await db.assetType.deleteMany({ where: { id: { in: made } } });
    await db.assetType.update({ where: { id: "atype_network" }, data: { name: "Network device", hidden: false } }).catch(() => null);
  }

  console.log(failures === 0 ? `\nAll ${passes} asset type checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
