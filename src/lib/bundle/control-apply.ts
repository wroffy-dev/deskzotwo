import { Prisma } from "@deskzo/control-client";
import { CARRIED, SHARED_MODELS, UNCARRIED, controlDatamodel, type ControlRowsFile, type Datamodel, type DmmfField, type DmmfModel } from "@/lib/bundle/control-rows";

/**
 * A workspace's control-plane rows (control.json — src/lib/bundle/control-rows.ts) written into this server's control
 * plane, for a restore (src/lib/bundle/restore.ts):
 *
 *   AS_NEW    the workspace isn't here: every row inserted, its shared rows matched to this server's first
 *   IN_PLACE  the owner asked for its plan, billing and settings records back: every row upserted by its primary
 *             key — never a second copy of one — and the rows here that the backup doesn't have left alone
 *
 * Shared rows (plans with their modules and prices, partners) are this server's when it has them: a plan is matched by
 * its `key`, a partner by its `slug`, and a row that matches is used as it is here, never changed — plans and partners
 * are live for every other workspace on this server. Only a plan or partner this server doesn't have is inserted. A
 * price is matched by id, or on a matched plan by gateway, currency, interval, amount and per-seat; a subscription item
 * whose price has no match here keeps its plan with no price, and the log says so.
 *
 * References to rows that don't travel (UNCARRIED — the staff member a support request was assigned to) are cleared
 * when that row isn't here. A number this server hands out itself (an autoincrement, such as a support request's
 * number) that is taken here already is left for this server to give, and its sequence moved past what was inserted.
 * A unique value taken by another row here (a gateway's customer id, an invoice's tax number) is not guessed around:
 * the write fails and the restore says which.
 *
 * Everything is done through the transaction client it is given, so a failure leaves nothing behind. What it inserted
 * is returned (`Applied`), for a rollback that runs after the transaction committed.
 */

type Row = Record<string, unknown>;
type Field = DmmfField & {
  isRequired?: boolean;
  isUnique?: boolean;
  dbName?: string | null;
  default?: { name?: string } | unknown;
};
type Model = DmmfModel & { dbName?: string | null; fields: readonly Field[] };
type Delegate = {
  findUnique(args: Record<string, unknown>): Promise<Row | null>;
  findFirst(args: Record<string, unknown>): Promise<Row | null>;
  create(args: Record<string, unknown>): Promise<Row>;
  upsert(args: Record<string, unknown>): Promise<Row>;
  update(args: Record<string, unknown>): Promise<Row>;
  deleteMany(args: Record<string, unknown>): Promise<unknown>;
};
type Tx = {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
} & Record<string, unknown>;

/** A row this wrote that wasn't there before: its model and primary key, so a rollback can remove exactly it. */
export type AppliedRow = { model: string; key: Row };
export type Applied = { inserted: AppliedRow[]; notes: string[] };

/**
 * Tenant's columns that belong to the server it lives on, never put back over this server's by IN_PLACE: its address,
 * database, keys (installed on their own, audited), state, measurements, and the plans' result (worked out again).
 */
export const TENANT_SERVER_COLUMNS = new Set([
  "id",
  "slug",
  "status",
  "isDefault",
  "region",
  "dbName",
  "dbUrlCipher",
  "dbRole",
  "keyBundleCipher",
  "keyBundleVersion",
  "schemaVersion",
  "entitlements",
  "storageUsedBytes",
  "storageMeasuredAt",
  "storageBreakdown",
  "suspendedFor",
  "suspendedAt",
  "deprovisionedAt",
  "createdAt",
  "updatedAt",
]);

const delegateOf = (tx: Tx, model: string) => tx[model.charAt(0).toLowerCase() + model.slice(1)] as unknown as Delegate;

function pkOf(model: Model): string[] {
  const single = model.fields.filter((f) => f.isId).map((f) => f.name);
  return single.length ? single : [...(model.primaryKey?.fields ?? [])];
}

function whereKey(model: Model, row: Row): Row {
  const pk = pkOf(model);
  if (pk.length === 1) return { [pk[0]!]: row[pk[0]!] };
  const name = model.primaryKey?.name ?? pk.join("_");
  return { [name]: Object.fromEntries(pk.map((f) => [f, row[f]])) };
}

const isAutoincrement = (f: Field) => (f.default as { name?: string } | undefined)?.name === "autoincrement";

/** A decoded row as the client takes it: a null in a Json column is the database's NULL. */
function asData(model: Model, row: Row): Row {
  const out: Row = {};
  for (const f of model.fields) {
    if (f.kind === "object" || !(f.name in row)) continue;
    const v = row[f.name];
    out[f.name] = f.type === "Json" && v === null ? Prisma.DbNull : v;
  }
  return out;
}

function relationColumn(model: Model, relation: string): string | null {
  const f = model.fields.find((x) => x.name === relation && x.kind === "object");
  return f?.relationFromFields?.[0] ?? null;
}

type Context = {
  tx: Tx;
  dm: Datamodel;
  byName: Map<string, Model>;
  applied: Applied;
  idMap: Record<"Plan" | "PlanPrice" | "Partner", Map<unknown, unknown>>;
};

async function insert(ctx: Context, name: string, row: Row): Promise<void> {
  const model = ctx.byName.get(name)!;
  const data = asData(model, row);
  // A number this server hands out, taken here already: left for the database to give.
  for (const f of model.fields.filter(isAutoincrement)) {
    if (data[f.name] === undefined || data[f.name] === null) continue;
    const taken = await delegateOf(ctx.tx, name).findFirst({
      where: { [f.name]: data[f.name] },
      select: { [f.name]: true },
    });
    if (taken) {
      ctx.applied.notes.push(`${name} ${String(data[f.name])} is taken on this server; it was given a new number.`);
      delete data[f.name];
    }
  }
  await delegateOf(ctx.tx, name).create({ data });
  ctx.applied.inserted.push({
    model: name,
    key: Object.fromEntries(pkOf(model).map((k) => [k, row[k]])),
  });
}

/** The shared rows: this server's where it has them (matched, never changed), inserted where it hasn't. */
async function applyShared(ctx: Context, file: ControlRowsFile): Promise<void> {
  const { tx, idMap, applied } = ctx;
  const shared = file.shared ?? {};
  const newPlans = new Set<unknown>();

  for (const plan of shared.Plan ?? []) {
    const byId = await delegateOf(tx, "Plan").findUnique({
      where: { id: plan.id },
      select: { id: true },
    });
    if (byId) {
      idMap.Plan.set(plan.id, plan.id);
      continue;
    }
    const byKey = await delegateOf(tx, "Plan").findUnique({
      where: { key: plan.key },
      select: { id: true },
    });
    if (byKey) {
      idMap.Plan.set(plan.id, byKey.id);
      applied.notes.push(`Plan "${String(plan.key)}" is on this server already; this server's is used.`);
      continue;
    }
    await insert(ctx, "Plan", plan);
    idMap.Plan.set(plan.id, plan.id);
    newPlans.add(plan.id);
  }
  for (const mod of shared.PlanModule ?? []) {
    if (newPlans.has(mod.planId)) await insert(ctx, "PlanModule", mod);
  }
  for (const price of shared.PlanPrice ?? []) {
    const byId = await delegateOf(tx, "PlanPrice").findUnique({
      where: { id: price.id },
      select: { id: true },
    });
    if (byId) {
      idMap.PlanPrice.set(price.id, price.id);
      continue;
    }
    if (newPlans.has(price.planId)) {
      const row = { ...price };
      if (
        row.externalId &&
        (await delegateOf(tx, "PlanPrice").findUnique({
          where: { externalId: row.externalId },
          select: { id: true },
        }))
      )
        row.externalId = null;
      await insert(ctx, "PlanPrice", row);
      idMap.PlanPrice.set(price.id, price.id);
      continue;
    }
    const planHere = idMap.Plan.get(price.planId);
    const match = planHere
      ? await delegateOf(tx, "PlanPrice").findFirst({
          where: {
            planId: planHere,
            gateway: price.gateway ?? null,
            currency: price.currency,
            interval: price.interval,
            amount: price.amount,
            perSeat: price.perSeat,
          },
          select: { id: true },
        })
      : null;
    idMap.PlanPrice.set(price.id, match?.id ?? null);
    if (!match)
      applied.notes.push(
        `A ${String(price.currency)} ${String(price.interval).toLowerCase()} price of plan ${String(price.planId)} has no match on this server's plan; the subscription keeps the plan without it — check its billing.`,
      );
  }
  // Parents before children, as the file has them.
  for (const partner of shared.Partner ?? []) {
    const byId = await delegateOf(tx, "Partner").findUnique({
      where: { id: partner.id },
      select: { id: true },
    });
    if (byId) {
      idMap.Partner.set(partner.id, partner.id);
      continue;
    }
    const bySlug = await delegateOf(tx, "Partner").findUnique({
      where: { slug: partner.slug },
      select: { id: true },
    });
    if (bySlug) {
      idMap.Partner.set(partner.id, bySlug.id);
      applied.notes.push(`Partner "${String(partner.slug)}" is on this server already; this server's is used.`);
      continue;
    }
    const row = {
      ...partner,
      parentId: partner.parentId ? (idMap.Partner.get(partner.parentId) ?? null) : null,
    };
    await insert(ctx, "Partner", row);
    idMap.Partner.set(partner.id, partner.id);
  }
}

/** A workspace row with its references to shared rows mapped to this server's, and dangling staff references cleared. */
async function remap(ctx: Context, name: string, row: Row): Promise<Row> {
  const model = ctx.byName.get(name)!;
  const out = { ...row };
  for (const [key, target] of Object.entries(CARRIED)) {
    const [m, relation] = key.split(".");
    if (m !== name) continue;
    const column = relationColumn(model, relation!);
    if (!column || out[column] === null || out[column] === undefined) continue;
    const mapped = ctx.idMap[target].get(out[column]);
    if (mapped === undefined) throw new Error(`${name}.${column} names a ${target} that is not in the backup's shared rows — the backup is incomplete.`);
    out[column] = mapped;
  }
  for (const key of Object.keys(UNCARRIED)) {
    const [m, relation] = key.split(".");
    if (m !== name) continue;
    const column = relationColumn(model, relation!);
    const f = model.fields.find((x) => x.name === relation);
    if (!column || !f || out[column] === null || out[column] === undefined) continue;
    const here = await delegateOf(ctx.tx, f.type).findUnique({
      where: { id: out[column] },
      select: { id: true },
    });
    if (!here) out[column] = null;
  }
  return out;
}

/** Each autoincrement's sequence moved past the highest value now in its table, so the next one handed out is free. */
async function bumpSequences(ctx: Context, names: string[]): Promise<void> {
  for (const name of names) {
    const model = ctx.byName.get(name)!;
    const table = model.dbName ?? name;
    for (const f of model.fields.filter(isAutoincrement)) {
      const column = f.dbName ?? f.name;
      await ctx.tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"${table.replace(/"/g, "")}"', '${column.replace(/'/g, "")}'), GREATEST((SELECT COALESCE(MAX("${column.replace(/"/g, "")}"), 0) FROM "${table.replace(/"/g, "")}"), 1))`,
      );
    }
  }
}

function context(tx: Tx, dm: Datamodel): Context {
  return {
    tx,
    dm,
    byName: new Map(dm.models.map((m) => [m.name, m as Model])),
    applied: { inserted: [], notes: [] },
    idMap: { Plan: new Map(), PlanPrice: new Map(), Partner: new Map() },
  };
}

const workspaceModels = (file: ControlRowsFile) => file.order.filter((n) => !(SHARED_MODELS as readonly string[]).includes(n));

/**
 * AS_NEW: every row of a workspace this server doesn't have, inserted. `tenant` is laid over the Tenant row — this
 * server's sealed database address, its state while it is restored. Throws on anything that can't go in as it is.
 */
export async function insertWorkspaceRows(tx: Tx, file: ControlRowsFile, tenant: Row, dm: Datamodel = controlDatamodel()): Promise<Applied> {
  const ctx = context(tx, dm);
  await applyShared(ctx, file);
  const names = workspaceModels(file);
  for (const name of names) {
    for (const raw of file.models[name] ?? []) {
      const row = await remap(ctx, name, name === "Tenant" ? { ...raw, ...tenant } : raw);
      await insert(ctx, name, row);
    }
  }
  await bumpSequences(ctx, [...SHARED_MODELS, ...names]);
  return ctx.applied;
}

/**
 * IN_PLACE: the workspace's rows put back as the backup has them — each upserted by its primary key, the Tenant row's
 * plan, billing and settings columns only (TENANT_SERVER_COLUMNS stay this server's). Rows here the backup doesn't have
 * are left. Returns the rows that weren't here before, for a rollback.
 */
export async function upsertWorkspaceRows(tx: Tx, file: ControlRowsFile, dm: Datamodel = controlDatamodel()): Promise<Applied> {
  const ctx = context(tx, dm);
  await applyShared(ctx, file);
  const names = workspaceModels(file);
  for (const name of names) {
    const model = ctx.byName.get(name)!;
    for (const raw of file.models[name] ?? []) {
      const row = await remap(ctx, name, raw);
      const where = whereKey(model, row);
      const there = await delegateOf(tx, name).findUnique({ where });
      if (!there) {
        if (name === "Tenant") throw new Error("The workspace's own record is not on this server.");
        await insert(ctx, name, row);
        continue;
      }
      const pk = new Set(pkOf(model));
      const data = asData(model, row);
      for (const k of Object.keys(data)) if (pk.has(k) || (name === "Tenant" && TENANT_SERVER_COLUMNS.has(k)) || model.fields.some((f) => f.name === k && isAutoincrement(f))) delete data[k];
      await delegateOf(tx, name).update({ where, data });
    }
  }
  await bumpSequences(ctx, [...SHARED_MODELS, ...names]);
  return ctx.applied;
}

/**
 * Undoes IN_PLACE: every row of the snapshot taken before (control.json of this workspace as it was) put back by its
 * key, and every row the restore inserted removed, children first.
 */
export async function putBackSnapshot(tx: Tx, snapshot: ControlRowsFile, inserted: AppliedRow[], dm: Datamodel = controlDatamodel()): Promise<void> {
  const byName = new Map(dm.models.map((m) => [m.name, m as Model]));
  // What was there first, put back — so nothing kept points at a row about to be removed — then what was added, removed.
  for (const name of workspaceModels(snapshot)) {
    const model = byName.get(name)!;
    for (const raw of snapshot.models[name] ?? []) {
      const where = whereKey(model, raw);
      const data = asData(model, raw);
      const pk = new Set(pkOf(model));
      const update = { ...data };
      for (const k of Object.keys(update)) if (pk.has(k) || (name === "Tenant" && TENANT_SERVER_COLUMNS.has(k)) || model.fields.some((f) => f.name === k && isAutoincrement(f))) delete update[k];
      if (name === "Tenant") await delegateOf(tx, name).update({ where, data: update });
      else await delegateOf(tx, name).upsert({ where, create: data, update });
    }
  }
  for (const row of [...inserted].reverse()) await delegateOf(tx, row.model).deleteMany({ where: row.key });
}

/** Removes what `insertWorkspaceRows` put in, children first — an AS_NEW restore's rollback. */
export async function removeInserted(tx: Tx, inserted: AppliedRow[]): Promise<void> {
  for (const row of [...inserted].reverse()) await delegateOf(tx, row.model).deleteMany({ where: row.key });
}

/** A unique value taken by another row here, said as which model and columns — the rest of Prisma's error is noise. */
export function describeWriteError(err: unknown): string {
  const known = err as {
    code?: string;
    meta?: { target?: unknown; modelName?: string };
  };
  if (known?.code === "P2002") {
    const target = Array.isArray(known.meta?.target) ? (known.meta.target as string[]).join(", ") : String(known.meta?.target ?? "a unique column");
    return `${known.meta?.modelName ?? "A record"} could not be written: its ${target} is already used by another record on this server.`;
  }
  if (known?.code === "P2003")
    return `A record could not be written: it points at something that is not on this server (${String((known.meta as { field_name?: string } | undefined)?.field_name ?? "a reference")}).`;
  return err instanceof Error ? err.message.split("\n").filter(Boolean).slice(-2).join(" ") : String(err);
}
