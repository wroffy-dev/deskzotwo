import { Prisma } from "@deskzo/control-client";
import { controlDb, type ControlClient } from "@/lib/platform/control-db";

/**
 * A workspace's rows in the control plane, for a Backup & Restore bundle (`workspaces/<id>/control.json` —
 * src/lib/bundle/build.ts): what a server needs, besides the workspace's own database and files, to have that workspace
 * — its row, its addresses, what it pays for and has been billed, its usage, its support requests…
 *
 * ## Worked out from the schema, not listed by hand
 *
 * Every model reachable from `Tenant` through relations where the child holds the foreign key is either EXPORTED or
 * EXCLUDED below, and every model that names a workspace in a plain column (no relation) is in SOFT_LINKS — and
 * `controlRowsCoverage` reads Prisma's DMMF for the control client to prove it. A new model hanging off Tenant, or a new
 * `tenantId` column anywhere, fails `check:bundle` until somebody decides here whether it travels. Same for a relation
 * from an exported row to a row outside the export: it is either CARRIED (the shared row comes along, because a fresh
 * server may not have it) or UNCARRIED (and the restore clears it where the row is missing there).
 *
 * ## Encoding
 *
 * JSON, typed by the schema rather than tagged in the data: a BigInt column is a decimal string, a DateTime an ISO
 * string, Bytes base64, a Decimal its string — and a Json column exactly as stored, so nothing inside one can be
 * mistaken for a marker. `decodeControlRows` puts the types back with the same schema.
 */

// ─── The lists ───────────────────────────────────────────────────────────────────────────────────

/** Reached from Tenant, and carried with the workspace. Rows are written parent-first (`order` in the file). */
export const EXPORTED: Record<string, string> = {
  Tenant: "the workspace itself — minus its sealed database address (TENANT_OMIT)",
  TenantDomain: "its addresses, custom domains and their checks",
  BiometricDeviceRoute: "which attendance devices report to it",
  Subscription: "what it is subscribed to",
  SubscriptionItem: "the plans in each subscription",
  TenantModuleOverride: "staff's per-module overrides of its plans",
  Invoice: "Deskzo's tax invoices to it",
  TenantUsage: "its daily usage",
  TenantActivityDay: "its daily activity",
  TenantPersonActivity: "its people's activity",
  BillingNotice: "billing mail already sent, so it isn't sent again",
  TenantNote: "staff notes about it",
  SupportRequest: "its support requests (their files travel as support/ entries)",
  SupportAttachment: "the requests' attachments, by storage key",
  SupportEntry: "the conversation on each request",
  TenantAttribution: "which partner it belongs to, and since when",
  TenantSignInPolicy: "its own switch-in rule for linked sign-in",
  OfflinePayment: "payments it made outside a gateway",
  PlatformProforma: "proforma invoices it was sent",
  ExtraSeatPurchase: "extra seats it bought",
  PlatformCreditNote: "credit notes against its invoices",
  AiCreditMonth: "its Deskzo AI credits month by month",
  AiCreditPack: "AI credit packs it bought or was given",
  AiUsage: "every charged AI turn",
  BillingEvent: "gateway webhooks about it — so a replayed one is still a no-op where it lands",
  AutomationSentStep: "outside steps its automations already took — a restored run must not take them twice",
};

/** Reached from Tenant (or naming it), and deliberately left behind. */
export const EXCLUDED: Record<string, string> = {
  PlatformAuditLog: "the platform's own audit trail of staff actions — it belongs to the server that wrote it, and outlives a closed workspace there on purpose (a full bundle has it in control.dump)",
  ProvisioningJob: "how the source server set the workspace up — operational",
  PlatformHandoffTicket: "one-time sign-in tickets, minutes long",
  TenantMigrationRun: "the source server's migration runs — operational history",
  DealRegistration: "a partner's own record of a deal, kept with the partner programme",
  CommissionEntry: "a partner's ledger — what this platform owes a partner; moving a workspace doesn't move what was earned",
  CommissionInvoiceState: "part of the partner ledger",
  LinkMember: "linked sign-in joins workspaces on one server; the other side of the link doesn't travel",
  LinkIntent: "linked sign-in requests, short-lived, between two workspaces",
  LinkSwitchTicket: "linked sign-in switch tickets, seconds long",
  WorkspaceEmail: "a derived index of its members' addresses — rebuilt from its database by the nightly reconcile",
};

/** Models that name a workspace in a plain column, no relation: "Model.field" → whether it travels, and why. */
export const SOFT_LINKS: Record<string, { travel: boolean; why: string }> = {
  "TenantJobLease.tenantId": { travel: false, why: "a lease on a scheduled job — this server's" },
  "WarmDatabase.claimedByTenantId": { travel: false, why: "the warm pool of empty databases — this server's" },
  "PendingSignup.tenantId": { travel: false, why: "a signup between form and workspace; holds codes and a password hash, finished once handed off" },
  "SupportAccessGrant.tenantId": { travel: false, why: "access given to this server's staff — must not open the workspace to another server's" },
  "BillingEvent.tenantId": { travel: true, why: EXPORTED.BillingEvent! },
  "AutomationWake.tenantId": { travel: false, why: "the scheduler's next look at it — the worker's sweep finds work anyway; a restore asks for a wake" },
  "AutomationSentStep.tenantId": { travel: true, why: EXPORTED.AutomationSentStep! },
  "OffsiteRun.tenantId": { travel: false, why: "this server's off-site work" },
  "OffsiteWorkspace.tenantId": { travel: false, why: "this server's record of what it has off-site" },
  "PlatformError.lastTenant": { travel: false, why: "the error log" },
  "PlatformMailJob.tenant": { travel: false, why: "the platform mail queue" },
  "PlatformAiTrainingFile.tenantIds": { travel: false, why: "platform-wide AI training material, not one workspace's" },
  "MailConnection.msTenantId": { travel: false, why: "a Microsoft 365 tenant, not a workspace" },
  "PlatformBackup.tenantId": { travel: false, why: "this server's bundle history" },
  "PlatformBackup.tenantSlug": { travel: false, why: "this server's bundle history" },
  "RestoreRun.tenantId": { travel: false, why: "this server's restore history" },
  "RestoreRun.tenantSlug": { travel: false, why: "this server's restore history" },
};

/** Relations from exported rows to shared rows a fresh server may not have: the shared rows come along. */
export const CARRIED: Record<string, "Plan" | "PlanPrice" | "Partner"> = {
  "SubscriptionItem.plan": "Plan",
  "SubscriptionItem.price": "PlanPrice",
  "Tenant.partner": "Partner",
  "Invoice.billToPartner": "Partner",
  "TenantAttribution.partner": "Partner",
  "OfflinePayment.partner": "Partner",
};

/**
 * The shared rows, and how far each reaches: a plan with all its modules and prices (so it works where it lands);
 * a price's plan; a partner with its parents up the chain. Never GatewayPrice — a gateway's own price ids belong to
 * the gateway account this server uses.
 */
export const SHARED_MODELS = ["Plan", "PlanModule", "PlanPrice", "Partner"] as const;
const SHARED_RELATIONS = new Set(["PlanModule.plan", "PlanPrice.plan", "Partner.parent"]);

/** Relations from exported rows to rows that do not travel: a restore clears the reference where the row isn't there. */
export const UNCARRIED: Record<string, string> = {
  "SupportRequest.assignee": "the staff member it was assigned to, on the source server",
  "SupportEntry.author": "the staff member who wrote it, on the source server",
};

/** Columns that never leave the server, by model. */
export const TENANT_OMIT: Record<string, string[]> = {
  // Sealed for this server's database, under its key, naming its database server. The restore provisions its own.
  Tenant: ["dbUrlCipher"],
};

// ─── The schema ──────────────────────────────────────────────────────────────────────────────────

export type DmmfField = {
  readonly name: string;
  readonly kind: string;
  readonly type: string;
  readonly isList: boolean;
  readonly isId: boolean;
  readonly relationFromFields?: readonly string[];
  readonly relationToFields?: readonly string[];
};
export type DmmfModel = { readonly name: string; readonly fields: readonly DmmfField[]; readonly primaryKey?: { readonly name?: string | null; readonly fields: readonly string[] } | null };
export type Datamodel = { readonly models: readonly DmmfModel[] };

export const controlDatamodel = (): Datamodel => Prisma.dmmf.datamodel as unknown as Datamodel;

type Lists = { exported: Record<string, unknown>; excluded: Record<string, unknown>; softLinks: Record<string, unknown>; carried: Record<string, unknown>; uncarried: Record<string, unknown> };
const LISTS: Lists = { exported: EXPORTED, excluded: EXCLUDED, softLinks: SOFT_LINKS, carried: CARRIED, uncarried: UNCARRIED };

/** A relation where this model holds the key: `{ field, target, from, to }`. */
function foreignKeys(model: DmmfModel) {
  return model.fields
    .filter((f) => f.kind === "object" && (f.relationFromFields?.length ?? 0) > 0)
    .map((f) => ({ field: f.name, target: f.type, from: [...f.relationFromFields!], to: [...(f.relationToFields ?? [])] }));
}

/** Every model reachable from Tenant through relations whose child holds the key, with one path to each. */
export function reachableFromTenant(dm: Datamodel): Map<string, string> {
  const reached = new Map<string, string>([["Tenant", "Tenant"]]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const model of dm.models) {
      if (reached.has(model.name)) continue;
      const via = foreignKeys(model).find((fk) => reached.has(fk.target));
      if (via) {
        reached.set(model.name, `${model.name}.${via.field} → ${via.target}`);
        grew = true;
      }
    }
  }
  return reached;
}

const TENANTISH = /tenant/i;

/**
 * What is wrong with the lists against this schema — empty when every tenant-related model and column is decided.
 * `check:bundle` runs it on the real schema, and on one with a model added to prove it notices.
 */
export function controlRowsCoverage(dm: Datamodel = controlDatamodel(), lists: Lists = LISTS): string[] {
  const problems: string[] = [];
  const byName = new Map(dm.models.map((m) => [m.name, m]));
  const reached = reachableFromTenant(dm);
  const exported = new Set(Object.keys(lists.exported));
  const excluded = new Set(Object.keys(lists.excluded));

  for (const [name, path] of reached) {
    if (exported.has(name) && excluded.has(name)) problems.push(`${name} is both exported and excluded.`);
    else if (!exported.has(name) && !excluded.has(name)) problems.push(`${name} is reachable from Tenant (${path}) but is neither exported nor excluded in src/lib/bundle/control-rows.ts.`);
  }

  const softKeys = new Set(Object.keys(lists.softLinks));
  for (const model of dm.models) {
    if (reached.has(model.name)) continue;
    const fkColumns = new Set(foreignKeys(model).flatMap((fk) => fk.from));
    for (const field of model.fields) {
      if (field.kind !== "scalar" || field.type !== "String" || fkColumns.has(field.name) || !TENANTISH.test(field.name)) continue;
      const key = `${model.name}.${field.name}`;
      if (!softKeys.has(key)) problems.push(`${key} looks like it names a workspace, but is not in SOFT_LINKS in src/lib/bundle/control-rows.ts — say whether it travels.`);
    }
  }

  for (const name of exported) {
    if (!byName.has(name)) {
      problems.push(`EXPORTED names ${name}, which is not a model.`);
      continue;
    }
    if (!reached.has(name) && !Object.entries(lists.softLinks).some(([k, v]) => k.startsWith(`${name}.`) && (v as { travel: boolean }).travel)) problems.push(`EXPORTED names ${name}, which nothing links to a workspace.`);
    for (const fk of foreignKeys(byName.get(name)!)) {
      const key = `${name}.${fk.field}`;
      if (fk.from.length !== 1 && (exported.has(fk.target) || key in lists.carried)) problems.push(`${key} is a key of ${fk.from.length} columns, which control-rows.ts can't follow yet.`);
      if (exported.has(fk.target)) continue;
      if (!(key in lists.carried) && !(key in lists.uncarried)) problems.push(`${key} points at ${fk.target}, which is not exported — add it to CARRIED or UNCARRIED in src/lib/bundle/control-rows.ts.`);
    }
  }
  for (const name of excluded) if (!reached.has(name)) problems.push(`EXCLUDED names ${name}, which is not reachable from Tenant — remove it or move it to SOFT_LINKS.`);
  for (const key of softKeys) {
    const [model, field] = key.split(".");
    if (!byName.get(model!)?.fields.some((f) => f.name === field)) problems.push(`SOFT_LINKS names ${key}, which is not a column.`);
  }
  for (const key of [...Object.keys(lists.carried), ...Object.keys(lists.uncarried)]) {
    const [model, field] = key.split(".");
    if (!byName.get(model!)?.fields.some((f) => f.name === field && f.kind === "object")) problems.push(`${key} is not a relation.`);
  }
  for (const name of SHARED_MODELS) {
    const model = byName.get(name);
    if (!model) {
      problems.push(`The shared model ${name} is not in the schema.`);
      continue;
    }
    for (const fk of foreignKeys(model)) {
      if (!SHARED_RELATIONS.has(`${name}.${fk.field}`)) problems.push(`The shared model ${name} gained a relation (${fk.field} → ${fk.target}) that control-rows.ts does not carry.`);
    }
  }
  if (problems.length === 0) {
    try {
      insertOrder(dm, [...exported]);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  return problems;
}

/** Parents before children among these models (self-relations aside), in schema order where it doesn't matter. */
export function insertOrder(dm: Datamodel, names: string[]): string[] {
  const set = new Set(names);
  const models = dm.models.filter((m) => set.has(m.name));
  const deps = new Map(models.map((m) => [m.name, new Set(foreignKeys(m).map((fk) => fk.target).filter((t) => set.has(t) && t !== m.name))]));
  const order: string[] = [];
  while (order.length < models.length) {
    const next = models.find((m) => !order.includes(m.name) && [...deps.get(m.name)!].every((d) => order.includes(d)));
    if (!next) throw new Error(`The exported control models have a cycle among: ${models.filter((m) => !order.includes(m.name)).map((m) => m.name).join(", ")}.`);
    order.push(next.name);
  }
  return order;
}

// ─── Encoding ────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function encodeValue(type: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "BigInt":
      return String(value);
    case "DateTime":
      return (value as Date).toISOString();
    case "Bytes":
      return Buffer.from(value as Uint8Array).toString("base64");
    case "Decimal":
      return String(value);
    default:
      return value;
  }
}

function decodeValue(type: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "BigInt":
      return BigInt(value as string);
    case "DateTime":
      return new Date(value as string);
    case "Bytes":
      return Buffer.from(value as string, "base64");
    case "Decimal":
      return new Prisma.Decimal(value as string);
    default:
      return value;
  }
}

function scalarFields(model: DmmfModel) {
  return model.fields.filter((f) => f.kind === "scalar" || f.kind === "enum");
}

/** A row as JSON can hold it, by the schema's types; omitted columns left out. */
export function encodeRow(model: DmmfModel, row: Row): Row {
  const omit = new Set(TENANT_OMIT[model.name] ?? []);
  const out: Row = {};
  for (const f of scalarFields(model)) {
    if (omit.has(f.name) || !(f.name in row)) continue;
    const v = row[f.name];
    out[f.name] = f.isList && Array.isArray(v) ? v.map((x) => encodeValue(f.type, x)) : encodeValue(f.type, v);
  }
  return out;
}

export function decodeRow(model: DmmfModel, row: Row): Row {
  const out: Row = {};
  for (const f of scalarFields(model)) {
    if (!(f.name in row)) continue;
    const v = row[f.name];
    out[f.name] = f.isList && Array.isArray(v) ? v.map((x) => decodeValue(f.type, x)) : decodeValue(f.type, v);
  }
  return out;
}

export type ControlRowsFile = {
  format: 1;
  tenantId: string;
  exportedAt: string;
  /** Shared rows first, then the workspace's, parents before children: the order to insert them in. */
  order: string[];
  models: Record<string, Row[]>;
  shared: Record<string, Row[]>;
  omitted: Record<string, string[]>;
  uncarried: Record<string, string>;
};

/** control.json back into rows with their types — Date, BigInt, Buffer, Decimal — ready for the control client. */
export function decodeControlRows(text: string | Buffer, dm: Datamodel = controlDatamodel()): ControlRowsFile {
  const file = JSON.parse(typeof text === "string" ? text : text.toString("utf8")) as ControlRowsFile;
  if (file?.format !== 1 || typeof file.models !== "object") throw new Error("That is not a workspace's control-plane rows.");
  const byName = new Map(dm.models.map((m) => [m.name, m]));
  const decode = (group: Record<string, Row[]>) =>
    Object.fromEntries(
      Object.entries(group ?? {}).map(([name, rows]) => {
        const model = byName.get(name);
        if (!model) throw new Error(`control.json has rows of ${name}, which this server's control plane doesn't have.`);
        return [name, rows.map((r) => decodeRow(model, r))];
      }),
    );
  return { ...file, models: decode(file.models), shared: decode(file.shared) };
}

// ─── Reading them out ────────────────────────────────────────────────────────────────────────────

type Delegate = { findMany(args: Record<string, unknown>): Promise<Row[]> };
const delegateOf = (client: ControlClient, model: string) => (client as unknown as Record<string, Delegate>)[model.charAt(0).toLowerCase() + model.slice(1)]!;
const PAGE = 1000;
const IN_CHUNK = 5000;

function pkOf(model: DmmfModel): string[] {
  const single = model.fields.filter((f) => f.isId).map((f) => f.name);
  return single.length ? single : [...(model.primaryKey?.fields ?? [])];
}

/** Every row matching `where`, a page at a time, ordered by the primary key and resumed from the last one seen. */
async function* pages(client: ControlClient, model: DmmfModel, where: Record<string, unknown>): AsyncGenerator<Row> {
  const pk = pkOf(model);
  const compound = pk.length > 1 ? (model.primaryKey?.name ?? pk.join("_")) : null;
  let cursor: Record<string, unknown> | null = null;
  for (;;) {
    const rows: Row[] = await delegateOf(client, model.name).findMany({
      where,
      orderBy: pk.map((f) => ({ [f]: "asc" })),
      take: PAGE,
      ...(cursor ? { cursor, skip: 1 } : {}),
    });
    for (const row of rows) yield row;
    if (rows.length < PAGE) return;
    const last = rows[rows.length - 1]!;
    cursor = compound ? { [compound]: Object.fromEntries(pk.map((f) => [f, last[f]])) } : { [pk[0]!]: last[pk[0]!] };
  }
}

/** Partners with each one's parent before it, so they can be inserted in this order. */
function parentsFirst(rows: Row[]): Row[] {
  const ids = new Set(rows.map((r) => r.id));
  const placed = new Set<unknown>();
  const out: Row[] = [];
  while (out.length < rows.length) {
    const ready = rows.filter((r) => !placed.has(r.id) && (!r.parentId || !ids.has(r.parentId) || placed.has(r.parentId)));
    if (!ready.length) throw new Error("The partners carried with this workspace are each other's parents.");
    for (const r of ready) {
      placed.add(r.id);
      out.push(r);
    }
  }
  return out;
}

const chunks = <T>(values: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
};

/**
 * One workspace's control-plane rows, as the text of control.json, streamed: each model's rows are read a page at a
 * time and written out as they come, so memory holds the keys children are found by, never the rows. Parents are read
 * before children, so by the time a model is read every row it could hang off is known.
 */
export async function* controlRowsJson(tenantId: string, client: ControlClient = controlDb(), dm: Datamodel = controlDatamodel()): AsyncGenerator<string> {
  const byName = new Map(dm.models.map((m) => [m.name, m]));
  const order = insertOrder(dm, Object.keys(EXPORTED));
  /** model → column → values seen, for the children that hang off that column. */
  const keys = new Map<string, Map<string, Set<unknown>>>();
  const need = new Map<string, Set<string>>();
  for (const name of order) {
    for (const fk of foreignKeys(byName.get(name)!)) {
      if (!EXPORTED[fk.target] || fk.target === name) continue;
      for (const col of fk.to) {
        if (!need.has(fk.target)) need.set(fk.target, new Set());
        need.get(fk.target)!.add(col);
      }
    }
  }
  const refs = new Map<string, Set<unknown>>(Object.keys(CARRIED).map((k) => [k, new Set()]));
  const softFor = (name: string) => Object.entries(SOFT_LINKS).filter(([k, v]) => v.travel && k.startsWith(`${name}.`)).map(([k]) => k.split(".")[1]!);

  yield `{"format":1,"tenantId":${JSON.stringify(tenantId)},"exportedAt":${JSON.stringify(new Date().toISOString())},`;
  yield `"order":${JSON.stringify([...SHARED_MODELS, ...order])},"omitted":${JSON.stringify(TENANT_OMIT)},"uncarried":${JSON.stringify(UNCARRIED)},"models":{`;

  for (const [i, name] of order.entries()) {
    const model = byName.get(name)!;
    const wheres: Record<string, unknown>[] = [];
    if (name === "Tenant") wheres.push({ id: tenantId });
    for (const field of softFor(name)) wheres.push({ [field]: tenantId });
    for (const fk of foreignKeys(model)) {
      if (!EXPORTED[fk.target] || fk.target === name || fk.from.length !== 1) continue;
      const values = [...(keys.get(fk.target)?.get(fk.to[0]!) ?? [])];
      for (const part of chunks(values, IN_CHUNK)) wheres.push({ [fk.from[0]!]: { in: part } });
    }
    const pk = pkOf(model);
    const seen = new Set<string>();
    const wanted = need.get(name) ?? new Set<string>();
    const mine = new Map<string, Set<unknown>>([...wanted].map((c) => [c, new Set()]));
    keys.set(name, mine);
    const carriedHere = foreignKeys(model).filter((fk) => `${name}.${fk.field}` in CARRIED);

    yield `${i ? "," : ""}${JSON.stringify(name)}:[`;
    let first = true;
    for (const where of wheres) {
      for await (const row of pages(client, model, where)) {
        const id = JSON.stringify(pk.map((f) => row[f] instanceof Date ? (row[f] as Date).toISOString() : row[f]));
        if (seen.has(id)) continue;
        seen.add(id);
        for (const [col, set] of mine) if (row[col] !== null && row[col] !== undefined) set.add(row[col]);
        for (const fk of carriedHere) {
          const v = row[fk.from[0]!];
          if (v !== null && v !== undefined) refs.get(`${name}.${fk.field}`)!.add(v);
        }
        yield `${first ? "" : ","}${JSON.stringify(encodeRow(model, row))}`;
        first = false;
      }
    }
    yield "]";
  }

  yield `},"shared":{`;
  const all = (kind: string) => [...Object.entries(CARRIED)].filter(([, t]) => t === kind).flatMap(([k]) => [...refs.get(k)!]);
  const fetchIn = async (name: string, column: string, values: unknown[]): Promise<Row[]> => {
    const out: Row[] = [];
    for (const part of chunks([...new Set(values)], IN_CHUNK)) for await (const row of pages(client, byName.get(name)!, { [column]: { in: part } })) out.push(row);
    return out;
  };
  // A plan's prices name their plan; a subscription item's price may be another plan's.
  const pricedPlans = (await fetchIn("PlanPrice", "id", all("PlanPrice"))).map((p) => p.planId);
  const planIds = [...new Set([...all("Plan"), ...pricedPlans])];
  const partners: Row[] = [];
  let partnerIds = [...new Set(all("Partner"))];
  const partnerSeen = new Set<unknown>();
  while (partnerIds.length) {
    const found = await fetchIn("Partner", "id", partnerIds.filter((id) => !partnerSeen.has(id)));
    for (const p of found) partnerSeen.add(p.id);
    partners.push(...found);
    partnerIds = found.map((p) => p.parentId).filter((id) => id && !partnerSeen.has(id));
  }
  const shared: Record<string, Row[]> = {
    Plan: await fetchIn("Plan", "id", planIds),
    PlanModule: await fetchIn("PlanModule", "planId", planIds),
    PlanPrice: await fetchIn("PlanPrice", "planId", planIds),
    Partner: parentsFirst(partners),
  };
  yield SHARED_MODELS.map((name) => `${JSON.stringify(name)}:[${shared[name]!.map((r) => JSON.stringify(encodeRow(byName.get(name)!, r))).join(",")}]`).join(",");
  yield "}}";
}
