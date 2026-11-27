import type { CustomFieldEntity, CustomFieldType, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeCompanyName } from "@/lib/company-name";
import { clean, kindDef, type KindKey, type MatchDecision, type StrategyKey } from "./formats";
import { rowsOf } from "./store";

/**
 * What each batch of an import works with (src/lib/legacy-import): the old CRM's reference tables read once into
 * `lookups` when the import starts, the old-id log (LegacyImportRecord) for what earlier batches and runs made, and
 * the choices made on the preview.
 */

export type Tx = Prisma.TransactionClient;

export type OldUser = { name: string; email: string; phone: string; active: boolean; department: string | null; superAdmin: boolean; roles: string[] };
export type OldProduct = { name: string; sku: string; categoryType: string | null };

export type Lookups = {
  users: Record<string, OldUser>;
  departments: Record<string, string>;
  designations: Record<string, string>;
  brands: Record<string, string>;
  categories: Record<string, { name: string; type: string }>;
  customerCategories: Record<string, string>;
  tags: Record<string, string>;
  /** "customer:1813" → its live tags' names. */
  entityTags: Record<string, string[]>;
  products: Record<string, OldProduct>;
  /** The company types company_types.csv names (live ones), as written — made in Deskzo when no type of its matches. Absent on a run started before. */
  companyTypes?: string[];
  /**
   * The ids the old CRM deleted, by the tables other rows point at (owner, 27 Oct 2026): a contact of a deleted
   * customer, or a call on a deleted lead, stays behind with it rather than failing. Absent on a run started before.
   */
  deleted?: Partial<Record<KindKey, string[]>>;
};

/** The tables a row can't come in without — what a contact, an order, a call or a ticket points at. */
const PARENT_KINDS: KindKey[] = ["customers", "products", "leads", "profilings", "customer_product", "product_tickets", "anonymous_tickets"];

const deletedSets = new WeakMap<Lookups, Map<KindKey, Set<string>>>();

/** Whether the old CRM deleted the row of `kind` with this id. */
export function deletedInOldCrm(lookups: Lookups, kind: KindKey, oldId: string | null | undefined): boolean {
  if (!oldId || !lookups.deleted) return false;
  let sets = deletedSets.get(lookups);
  if (!sets) deletedSets.set(lookups, (sets = new Map()));
  let set = sets.get(kind);
  if (!set) sets.set(kind, (set = new Set(lookups.deleted[kind] ?? [])));
  return set.has(oldId);
}

export type Decisions = {
  /** By kind, for rows that meet a record Deskzo already had. */
  matches?: Partial<Record<KindKey, MatchDecision>>;
  /** Old user id → the Deskzo user to use, or "create" for a switched-off account. */
  users?: Record<string, string>;
};

const isLive = (row: Record<string, string>) => !clean(row.deletedAt);

/** Reads the reference tables of a run into lookups. */
export async function buildLookups(importId: string): Promise<Lookups> {
  const lookups: Lookups = { users: {}, departments: {}, designations: {}, brands: {}, categories: {}, customerCategories: {}, tags: {}, entityTags: {}, products: {}, deleted: {} };
  for (const kind of PARENT_KINDS) {
    const ids: string[] = [];
    for await (const { row } of rowsOf(importId, kind)) if (row.id && !isLive(row)) ids.push(row.id);
    if (ids.length) lookups.deleted![kind] = ids;
  }
  const roleNames: Record<string, string> = {};
  for await (const { row } of rowsOf(importId, "roles")) roleNames[row.id!] = row.label || row.name || "";
  const userRoles: Record<string, string[]> = {};
  for await (const { row } of rowsOf(importId, "user_roles")) {
    const name = roleNames[row.role_id!];
    if (name && !(userRoles[row.user_id!] ?? []).includes(name)) (userRoles[row.user_id!] ??= []).push(name);
  }
  for await (const { row } of rowsOf(importId, "departments")) if (row.id) lookups.departments[row.id] = row.name!;
  for await (const { row } of rowsOf(importId, "users")) {
    if (!row.id) continue;
    lookups.users[row.id] = {
      name: row.name || row.email || `Old user ${row.id}`,
      email: (row.email ?? "").toLowerCase(),
      phone: row.phone ?? "",
      active: (row.status ?? "active").toLowerCase() === "active" && isLive(row),
      department: lookups.departments[row.department_id ?? ""] ?? null,
      superAdmin: row.is_super_admin === "1",
      roles: userRoles[row.id] ?? [],
    };
  }
  for await (const { row } of rowsOf(importId, "designations")) if (row.id) lookups.designations[row.id] = row.name!;
  for await (const { row } of rowsOf(importId, "brands")) if (row.id) lookups.brands[row.id] = row.name || row.label || "";
  for await (const { row } of rowsOf(importId, "categories")) if (row.id) lookups.categories[row.id] = { name: row.name!, type: row.type ?? "" };
  for await (const { row } of rowsOf(importId, "custom_categories")) if (row.id && isLive(row)) lookups.customerCategories[row.id] = row.name!;
  for await (const { row } of rowsOf(importId, "tags")) if (row.id) lookups.tags[row.id] = row.name!.replace(/,+$/, "").trim();
  for await (const { row } of rowsOf(importId, "entity_tags")) {
    if (!isLive(row)) continue;
    const name = lookups.tags[row.tag_id ?? ""];
    if (!name) continue;
    const key = `${row.entity_type}:${row.entity_id}`;
    const list = (lookups.entityTags[key] ??= []);
    if (!list.includes(name)) list.push(name);
  }
  lookups.companyTypes = [];
  for await (const { row } of rowsOf(importId, "company_types")) if (row.name?.trim() && isLive(row)) lookups.companyTypes.push(row.name.trim());
  for await (const { row } of rowsOf(importId, "products")) {
    if (!row.id) continue;
    lookups.products[row.id] = { name: row.name!, sku: row.sku!, categoryType: lookups.categories[row.category_id ?? ""]?.type ?? null };
  }
  return lookups;
}

export type Ctx = {
  importId: string;
  /** Whoever runs the import: the owner of anything whose old owner can't be found. */
  actorId: string;
  strategy: StrategyKey;
  decisions: Decisions;
  lookups: Lookups;
  /** The old-id log, read a batch at a time. */
  records: RecordCache;
  /** The organisation's own name, normalised — a distributor by that name is the company itself. */
  ownName: string;
  /** Zoho Books' files are in the upload: companies, items and people come in through the master lists. */
  withZoho?: boolean;
};

export type LoggedRecord = { recordId: string; action: string; importId: string; before: unknown };

/** The old-id log for the kinds a batch touches, read once and kept current as the batch writes. */
export class RecordCache {
  private map = new Map<string, LoggedRecord | null>();
  key = (kind: string, oldId: string) => `${kind}::${oldId}`;

  async load(kind: string, oldIds: string[]) {
    const wanted = [...new Set(oldIds.filter((id) => id && !this.map.has(this.key(kind, id))))];
    for (let i = 0; i < wanted.length; i += 1000) {
      const part = wanted.slice(i, i + 1000);
      const rows = await db.legacyImportRecord.findMany({ where: { kind, oldId: { in: part } }, select: { oldId: true, recordId: true, action: true, importId: true, before: true } });
      const found = new Map(rows.map((r) => [r.oldId, r]));
      for (const id of part) {
        const r = found.get(id);
        this.map.set(this.key(kind, id), r ? { recordId: r.recordId, action: r.action, importId: r.importId, before: r.before } : null);
      }
    }
  }

  async get(kind: string, oldId: string | null | undefined): Promise<LoggedRecord | null> {
    if (!oldId) return null;
    if (!this.map.has(this.key(kind, oldId))) await this.load(kind, [oldId]);
    return this.map.get(this.key(kind, oldId)) ?? null;
  }

  async id(kind: string, oldId: string | null | undefined): Promise<string | null> {
    return (await this.get(kind, oldId))?.recordId ?? null;
  }

  private pending: { key: string; was: LoggedRecord | null | undefined }[] = [];

  set(kind: string, oldId: string, value: LoggedRecord) {
    const key = this.key(kind, oldId);
    this.pending.push({ key, was: this.map.get(key) });
    this.map.set(key, value);
  }

  /** A row's transaction starts: what it remembers is provisional until it commits. */
  begin() {
    this.pending = [];
  }

  commit() {
    this.pending = [];
  }

  /** The row's transaction failed: forget what it wrote, as the database has. */
  rollback() {
    for (const { key, was } of this.pending.reverse()) {
      if (was === undefined) this.map.delete(key);
      else this.map.set(key, was);
    }
    this.pending = [];
  }
}

/** Logs what a row became, in the row's own transaction. */
export async function logRecord(tx: Tx, ctx: Ctx, kind: string, oldId: string, recordId: string, action: "CREATED" | "LINKED") {
  await tx.legacyImportRecord.create({ data: { importId: ctx.importId, kind, oldId, recordId, action } });
}

/** The Deskzo user an old user became (the users step runs first); whoever runs the import for one not found. */
export async function userOf(ctx: Ctx, oldId: string | null | undefined): Promise<string> {
  return (oldId && (await ctx.records.id("users", oldId))) || ctx.actorId;
}

/** A user, or null — for fields that may stay empty (an owner nobody was given). */
export async function userOrNull(ctx: Ctx, oldId: string | null | undefined): Promise<string | null> {
  return oldId ? ((await ctx.records.id("users", oldId)) ?? null) : null;
}

export const companyKey = (name: string) => normalizeCompanyName(name);

/**
 * A reference record found by name or made — a brand, a category, an industry… — logged by name under `kind`, so
 * the undo takes back only the ones the import made.
 */
export async function findOrMake(
  tx: Tx,
  ctx: Ctx,
  kind: string,
  name: string,
  find: () => Promise<{ id: string } | null>,
  make: () => Promise<{ id: string }>,
): Promise<string> {
  const key = name.trim().toLowerCase();
  const logged = await ctx.records.get(kind, key);
  if (logged) {
    const still = await find();
    if (still) return still.id;
  }
  const found = await find();
  if (found) return found.id;
  const made = await make();
  await tx.legacyImportRecord.upsert({ where: { kind_oldId: { kind, oldId: key } }, create: { importId: ctx.importId, kind, oldId: key, recordId: made.id, action: "CREATED" }, update: { importId: ctx.importId, recordId: made.id, action: "CREATED" } });
  ctx.records.set(kind, key, { recordId: made.id, action: "CREATED", importId: ctx.importId, before: null });
  return made.id;
}

/** The custom fields the import keeps what Deskzo has no column for in: key, label, type — by record type. */
export const CUSTOM_FIELDS: Record<"COMPANY" | "CONTACT" | "ORDER", { key: string; label: string; type: CustomFieldType }[]> = {
  COMPANY: [
    { key: "oldcrm_id", label: "Old CRM id", type: "TEXT" },
    { key: "cin", label: "CIN", type: "TEXT" },
    { key: "incorporated_on", label: "Incorporated on", type: "DATE" },
    { key: "currency", label: "Currency", type: "TEXT" },
    { key: "official_email", label: "Official email", type: "EMAIL" },
    { key: "official_phone", label: "Official phone", type: "PHONE" },
  ],
  CONTACT: [
    { key: "oldcrm_id", label: "Old CRM id", type: "TEXT" },
    { key: "job_title", label: "Job title", type: "TEXT" },
    { key: "profiling_status", label: "Profiling status", type: "TEXT" },
  ],
  ORDER: [
    { key: "oldcrm_id", label: "Old CRM id", type: "TEXT" },
    { key: "tenant_domain", label: "Tenant / domain", type: "TEXT" },
    { key: "billing_term", label: "Billing term", type: "TEXT" },
  ],
};

/** Makes sure the custom fields exist (once per run); each one made is logged so undo retires it. */
export async function ensureCustomFields(ctx: Ctx) {
  for (const [entity, fields] of Object.entries(CUSTOM_FIELDS) as [CustomFieldEntity, (typeof CUSTOM_FIELDS)["COMPANY"]][]) {
    for (const [i, field] of fields.entries()) {
      const existing = await db.customFieldDefinition.findUnique({ where: { entity_key: { entity, key: field.key } }, select: { id: true } });
      if (existing) continue;
      await db.$transaction(async (tx) => {
        const made = await tx.customFieldDefinition.create({ data: { entity, key: field.key, label: field.label, type: field.type, group: "Old CRM", sortOrder: 900 + i, createdById: ctx.actorId }, select: { id: true } });
        await tx.legacyImportRecord.upsert({
          where: { kind_oldId: { kind: "custom-field", oldId: `${entity}:${field.key}` } },
          create: { importId: ctx.importId, kind: "custom-field", oldId: `${entity}:${field.key}`, recordId: made.id, action: "CREATED" },
          update: { importId: ctx.importId, recordId: made.id, action: "CREATED" },
        });
      });
    }
  }
}

/** A custom-fields object with the empty values left out — a blank never clears what's stored. */
export function fields(values: Record<string, string | null | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined && v !== "")) as Record<string, string>;
}

export const labelOf = (kind: KindKey) => kindDef(kind)?.label ?? kind;
