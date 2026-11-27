import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { recordAudit } from "@/lib/audit";
import { definitionsFor } from "@/lib/custom-fields/server";
import { BUILT_IN_FIELDS, CONDITION_OPS, PATTERNS, RULE_ENTITIES, RULE_KINDS, kindOfCustomType, type FieldRule, type RuleCondition, type RuleEntity, type RuleField, type RuleRecord } from "@/lib/field-rules/catalogue";
import { checkRecord, ruleRefusal } from "@/lib/field-rules/check";
import { guardedTest } from "@/lib/field-rules/regex-guard";
import { currentUser } from "@/lib/session";
import { currentTenant } from "@/lib/tenancy/resolve";

/**
 * Field rules on the server (owner, 12 Nov 2026 — src/lib/field-rules/check.ts holds the rules themselves): the
 * fields a rule can be about, the workspace's own included; the rules, kept and changed; and `fieldRuleRefusal`,
 * which every save of a company, contact or lead by a person asks — the web forms, the phone app and the API through
 * the actions in src/actions/company.ts and lead.ts, imports through their own importers. Captures that come in on
 * their own (a website form, the chat) aren't stopped by it: a lead is never lost to a rule.
 */

/** Every field a rule can be about on this record type: the built-in ones, then the workspace's own. */
export async function ruleFields(entity: RuleEntity): Promise<RuleField[]> {
  const custom = await definitionsFor(entity).catch(() => []);
  const own: RuleField[] = [];
  for (const d of custom) {
    if (d.archived) continue;
    const kind = kindOfCustomType(d.type);
    if (!kind) continue;
    own.push({ key: `cf.${d.key}`, label: d.label, kind, ...(kind === "choice" ? { options: d.options.filter((o) => !o.archived).map((o) => ({ value: o.value, label: o.label })) } : {}) });
  }
  return [...BUILT_IN_FIELDS[entity], ...own];
}

const asEntity = (v: unknown): RuleEntity | null => ((RULE_ENTITIES as readonly string[]).includes(String(v)) ? (String(v) as RuleEntity) : null);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function rowToRule(r: { id: string; entity: string; field: string; kind: string; min: number | null; max: number | null; pattern: string | null; patternValue: string | null; when: Prisma.JsonValue; newOnly: boolean; message: string | null; active: boolean }): FieldRule | null {
  const entity = asEntity(r.entity);
  if (!entity || !(RULE_KINDS as readonly string[]).includes(r.kind)) return null;
  const w = r.when as { field?: unknown; op?: unknown; value?: unknown } | null;
  const when: RuleCondition | null = w && typeof w.field === "string" && (CONDITION_OPS as readonly string[]).includes(String(w.op)) ? { field: w.field, op: w.op as RuleCondition["op"], value: w.value == null ? null : String(w.value) } : null;
  return {
    id: r.id,
    entity,
    field: r.field,
    kind: r.kind as FieldRule["kind"],
    min: r.min,
    max: r.max,
    pattern: r.pattern && (PATTERNS as readonly string[]).includes(r.pattern) ? (r.pattern as FieldRule["pattern"]) : null,
    patternValue: r.patternValue,
    when,
    newOnly: r.newOnly,
    message: r.message,
    active: r.active,
  };
}

/** The rules on a record type, oldest first. None in a workspace without the table yet. */
export async function rulesFor(entity: RuleEntity, options: { activeOnly?: boolean } = {}): Promise<FieldRule[]> {
  try {
    const rows = await db.fieldRule.findMany({ where: { entity, ...(options.activeOnly ? { active: true } : {}) }, orderBy: { createdAt: "asc" } });
    return rows.map(rowToRule).filter((r): r is FieldRule => r !== null);
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

export type FieldRuleInput = {
  id?: string;
  entity: string;
  field: string;
  kind: string;
  min?: unknown;
  max?: unknown;
  pattern?: string | null;
  patternValue?: string | null;
  when?: { field?: string; op?: string; value?: string | null } | null;
  newOnly?: boolean;
  message?: string | null;
  active?: boolean;
};

export async function saveFieldRule(userId: string, input: FieldRuleInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const entity = asEntity(input?.entity);
  if (!entity) return { ok: false, error: "Pick companies, contacts or leads." };
  if (!(RULE_KINDS as readonly string[]).includes(String(input.kind))) return { ok: false, error: "Pick what the rule asks." };
  const kind = input.kind as FieldRule["kind"];
  const w = input.when && input.when.field ? input.when : null;
  const clean = {
    field: String(input.field ?? "").slice(0, 80),
    kind,
    min: kind === "LENGTH" || kind === "RANGE" ? num(input.min) : null,
    max: kind === "LENGTH" || kind === "RANGE" ? num(input.max) : null,
    pattern: kind === "PATTERN" && input.pattern && (PATTERNS as readonly string[]).includes(input.pattern) ? (input.pattern as FieldRule["pattern"]) : null,
    patternValue: kind === "PATTERN" ? String(input.patternValue ?? "").trim().slice(0, 200) || null : null,
    when: w && (CONDITION_OPS as readonly string[]).includes(String(w.op)) ? { field: String(w.field).slice(0, 80), op: w.op as RuleCondition["op"], value: w.value == null ? null : String(w.value).trim().slice(0, 200) } : null,
    newOnly: input.newOnly === true,
    message: String(input.message ?? "").trim().slice(0, 300) || null,
    active: input.active !== false,
  };
  const refusal = ruleRefusal({ ...clean, entity }, await ruleFields(entity));
  if (refusal) return { ok: false, error: refusal };
  const data = { entity, ...clean, when: clean.when ? (clean.when as Prisma.InputJsonValue) : Prisma.DbNull };
  let id: string;
  if (input.id) {
    const found = await db.fieldRule.findUnique({ where: { id: String(input.id) }, select: { id: true } });
    if (!found) return { ok: false, error: "That rule no longer exists." };
    await db.fieldRule.update({ where: { id: found.id }, data });
    id = found.id;
  } else {
    id = (await db.fieldRule.create({ data: { ...data, createdById: userId }, select: { id: true } })).id;
  }
  await recordAudit({ userId, action: input.id ? "UPDATE" : "CREATE", entityType: "FieldRule", entityId: id, entityLabel: `Field rule on ${entity.toLowerCase()} ${clean.field}: ${kind.toLowerCase()}` });
  return { ok: true, id };
}

export async function deleteFieldRule(userId: string, id: string): Promise<void> {
  const gone = await db.fieldRule.deleteMany({ where: { id: String(id) } });
  if (gone.count) await recordAudit({ userId, action: "DELETE", entityType: "FieldRule", entityId: String(id), entityLabel: "Field rule removed" });
}

// ─── Checking a save ─────────────────────────────────────────────────────────────────────────────

/** Whether a value is already on another record of this type — the database's half of UNIQUE. */
async function taken(entity: RuleEntity, field: string, value: string, exceptId: string | null): Promise<boolean> {
  const not = exceptId ? { id: { not: exceptId } } : {};
  const text = { equals: value, mode: "insensitive" as const };
  if (field.startsWith("cf.")) {
    const where = { customFields: { path: [field.slice(3)], equals: value }, ...not };
    if (entity === "COMPANY") return (await db.company.count({ where })) > 0;
    if (entity === "CONTACT") return (await db.contact.count({ where })) > 0;
    return (await db.lead.count({ where })) > 0;
  }
  if (entity === "COMPANY" && field.startsWith("location.")) {
    const column = field.slice(9);
    return (await db.companyLocation.count({ where: { [column]: text, ...(exceptId ? { companyId: { not: exceptId } } : {}) } })) > 0;
  }
  if (entity === "COMPANY") return (await db.company.count({ where: { [field]: text, ...not } })) > 0;
  if (entity === "CONTACT") return (await db.contact.count({ where: { [field]: text, ...not, leftAt: null } })) > 0;
  return (await db.lead.count({ where: { [field]: text, ...not } })) > 0;
}

/** How many "already used" answers one person gets in `UNIQUE_WINDOW_MS` before they are asked to wait. */
export const UNIQUE_ANSWERS_PER_WINDOW = 20;
const UNIQUE_WINDOW_MS = 10 * 60_000;
const uniqueAnswers = new Map<string, number[]>();

/**
 * Notes one "already used" answer for the person saving, and says to wait when they have had too many lately — null
 * while they haven't, and always for a script or job with nobody signed in. In memory, per process: a slowing-down,
 * not a ledger.
 */
async function uniqueAnswerSlowed(now = Date.now()): Promise<string | null> {
  const user = await currentUser().catch(() => null);
  if (!user) return null;
  const tenantId = (await currentTenant().catch(() => null))?.id ?? "";
  const key = `${tenantId}|${user.id}`;
  const recent = (uniqueAnswers.get(key) ?? []).filter((t) => t > now - UNIQUE_WINDOW_MS);
  if (recent.length >= UNIQUE_ANSWERS_PER_WINDOW) {
    uniqueAnswers.set(key, recent);
    return "Too many saves were refused as already used in the last few minutes. Wait ten minutes, then try again.";
  }
  recent.push(now);
  uniqueAnswers.set(key, recent);
  // Kept small: people who stopped long ago are let go.
  if (uniqueAnswers.size > 5000) for (const [k, times] of uniqueAnswers) if (!times.some((t) => t > now - UNIQUE_WINDOW_MS)) uniqueAnswers.delete(k);
  return null;
}

/**
 * What a save would break, in one sentence for the form — or null when it is fine. `record` is the record as it will
 * be after the save; `touched` the fields this save sends (null: every one, for a new record).
 */
export async function fieldRuleRefusal(entity: RuleEntity, record: RuleRecord, opts: { id?: string | null; touched?: Iterable<string> | null } = {}): Promise<string | null> {
  const rules = await rulesFor(entity, { activeOnly: true });
  if (rules.length === 0) return null;
  const fields = await ruleFields(entity);
  const isNew = !opts.id;
  // R3-01: every custom pattern runs under a time limit (src/lib/field-rules/regex-guard.ts).
  const { problems, toCheckUnique } = checkRecord({ rules, fields, record, isNew, touched: opts.touched ? new Set(opts.touched) : null, run: guardedTest });
  for (const u of toCheckUnique) {
    if (!(await taken(entity, u.rule.field, u.value, opts.id ?? null))) continue;
    // Security audit round three, 14 Nov 2026 (low, "a unique rule reveals values outside scope"): the database is
    // asked about every record, the ones this person can't see included, so the answer is the rule's own words — never
    // the value, nor what kind of record holds it — and a person told "already used" too often in a short while is
    // stopped for a few minutes, so the form can't be used to test values one by one.
    const slowed = await uniqueAnswerSlowed();
    problems.push({ field: u.rule.field, label: u.label, message: slowed ?? (u.rule.message?.trim() || `${u.label} is already used on another record — it has to be different.`), rule: u.rule });
  }
  if (problems.length === 0) return null;
  // One sentence each, in the order the form lists its fields.
  const order = new Map(fields.map((f, i) => [f.key, i]));
  return [...new Set(problems.sort((a, b) => (order.get(a.field) ?? 0) - (order.get(b.field) ?? 0)).map((p) => p.message))].join(" ");
}

// ─── Records as the rules read them ──────────────────────────────────────────────────────────────

const customOf = (values: unknown): RuleRecord => {
  const out: RuleRecord = {};
  if (values && typeof values === "object" && !Array.isArray(values)) for (const [k, v] of Object.entries(values as Record<string, unknown>)) out[`cf.${k}`] = v;
  return out;
};

/** A company as it stands, its main address beside it. */
export async function companyRecord(id: string): Promise<RuleRecord> {
  const c = await db.company.findUnique({
    where: { id },
    select: {
      name: true,
      relationshipType: true,
      source: true,
      industryId: true,
      customerCategoryId: true,
      companyType: true,
      // The form's "Employees" band is kept as a head count.
      employeeCount: true,
      website: true,
      linkedinUrl: true,
      dunsNumber: true,
      tags: true,
      customFields: true,
      locations: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], take: 1, select: { gstNumber: true, address: true, city: true, state: true, pincode: true, country: true } },
    },
  });
  if (!c) return {};
  const { customFields, locations, employeeCount, ...plain } = c;
  const loc = locations[0];
  return { ...plain, employeeBand: employeeCount == null ? null : String(employeeCount), ...(loc ? { "location.gstNumber": loc.gstNumber, "location.address": loc.address, "location.city": loc.city, "location.state": loc.state, "location.pincode": loc.pincode, "location.country": loc.country } : {}), ...customOf(customFields) };
}

export async function contactRecord(id: string): Promise<RuleRecord> {
  const c = await db.contact.findUnique({ where: { id }, select: { name: true, email: true, phone: true, linkedinUrl: true, customFields: true, designationRef: { select: { name: true } } } }).catch(() => null);
  if (!c) return {};
  return { name: c.name, email: c.email, phone: c.phone, linkedinUrl: c.linkedinUrl, designationName: c.designationRef?.name ?? null, ...customOf(c.customFields) };
}

export async function leadRecord(id: string): Promise<RuleRecord> {
  const l = await db.lead.findUnique({ where: { id }, select: { title: true, source: true, description: true, estimatedValue: true, expectedCloseDate: true, contactId: true, sourceDetail: true, customFields: true } });
  if (!l) return {};
  const { customFields, estimatedValue, expectedCloseDate, ...plain } = l;
  return { ...plain, estimatedValue: estimatedValue == null ? null : Number(estimatedValue), expectedCloseDate: expectedCloseDate ? expectedCloseDate.toISOString().slice(0, 10) : null, ...customOf(customFields) };
}

/** A company's address as the rules read it — the one a new company is made with. */
export function locationRecord(location: { gstNumber?: string | null; address?: string | null; city?: string | null; state?: string | null; pincode?: string | null; country?: string | null } | null | undefined): RuleRecord {
  if (!location) return {};
  return { "location.gstNumber": location.gstNumber ?? null, "location.address": location.address ?? null, "location.city": location.city ?? null, "location.state": location.state ?? null, "location.pincode": location.pincode ?? null, "location.country": location.country ?? null };
}

/**
 * An import row, checked as a save would be: a new record against every rule; one already here against the rules on
 * the cells the row fills and the own fields it changes. `sent` leaves out (undefined) what the row doesn't say.
 */
export async function importRuleRefusal(entity: RuleEntity, id: string | null, sent: RuleRecord, custom?: Record<string, unknown> | null): Promise<string | null> {
  const base = id ? await (entity === "COMPANY" ? companyRecord(id) : entity === "CONTACT" ? contactRecord(id) : leadRecord(id)) : {};
  const said = Object.fromEntries(Object.entries(sent).filter(([, v]) => v !== undefined));
  const own = customOf(custom);
  const ownChanged = Object.keys(own).filter((k) => JSON.stringify(own[k] ?? null) !== JSON.stringify(base[k] ?? null));
  return fieldRuleRefusal(entity, { ...base, ...said, ...own }, id ? { id, touched: [...Object.keys(said), ...ownChanged] } : {});
}

/** A form's custom-field answers as the rules read them, beside the fields it touches. */
export function customInput(values: unknown): { record: RuleRecord; touched: string[] } {
  const record = customOf(values);
  return { record, touched: Object.keys(record) };
}
