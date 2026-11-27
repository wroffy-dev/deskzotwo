import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { Clock } from "@/lib/time/zone";
import type { PropertyKind, SelectOption } from "@/lib/smart-lists/values";
import { FIELD_CREATED, FIELD_TITLE, FIELD_UPDATED, ME, cleanQuery, decodeQuery, effectiveKind, fieldKind, resolveDay, resolveRange, type Range, type Rule, type Sort, type ViewQuery } from "@/lib/smart-lists/view-query";

/**
 * A view's filters as a database query (owner, 20 Nov 2026 — Smart Lists phase 2; the rules are
 * src/lib/smart-lists/view-query.ts). The same rules work on a list of companies (their values in `workbook_values`)
 * and on a list's own rows (`workbook_row_values`):
 *
 *   · "is empty" is no value kept; "is not", "doesn't contain" and "is none of" include the empty ones, as Notion's do;
 *   · numbers, days and choices compare in the database; text is matched whatever its case by a small lookup of the
 *     ids whose value holds it;
 *   · a row's added and changed days are days in the workspace's own time zone.
 *
 * Sorting: an own-row list (at most 5,000 rows) is sorted whole here; a list of companies sorts by one column, the
 * companies with a value first. Server only.
 */

type Prop = { id: string; name: string; kind: PropertyKind; options: SelectOption[]; formula?: { format: string } | null };
export type QueryContext = { userId: string; clock: Clock; today: string };

/** Where a row's values live and how to ask for them — a company's or an own row's. */
type Side<W> = {
  /** A value in this column, matching `value` when given. */
  has: (propertyId: string, value?: Prisma.JsonFilter) => W;
  /** No value in this column. */
  none: (propertyId: string) => W;
  ids: (ids: string[]) => W;
  title: (filter: Prisma.StringFilter) => W;
  stamp: (field: "createdAt" | "updatedAt", range: { gte?: Date; lt?: Date }) => W | null;
  /** The ids whose text value in this column matches, whatever its case. */
  textIds: (propertyId: string, pattern: string, exact: boolean) => Promise<string[]>;
  not: (w: W) => W;
  and: (ws: W[]) => W;
  or: (ws: W[]) => W;
};

const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function ruleWhere<W>(rule: Rule, props: Prop[], own: boolean, side: Side<W>, ctx: QueryContext): Promise<W | null> {
  const kind = fieldKind(rule.field, props, own);
  if (!kind) return null;
  const v = rule.value;
  if (kind === "TITLE") {
    const s = String(v ?? "");
    switch (rule.op) {
      case "contains":
        return side.title({ contains: s, mode: "insensitive" });
      case "not_contains":
        return side.not(side.title({ contains: s, mode: "insensitive" }));
      case "is":
        return side.title({ equals: s, mode: "insensitive" });
      case "is_not":
        return side.not(side.title({ equals: s, mode: "insensitive" }));
      default:
        return null;
    }
  }
  if (kind === "STAMP") {
    const field = rule.field === FIELD_CREATED ? "createdAt" : "updatedAt";
    const range = rangeOf(rule, ctx);
    if (!range) return null;
    return side.stamp(field, range);
  }
  const id = rule.field;
  if (rule.op === "empty") return side.none(id);
  if (rule.op === "not_empty") return side.has(id);
  switch (kind) {
    case "TEXT":
    case "LINK":
    case "EMAIL":
    case "PHONE": {
      const s = String(v ?? "");
      const exact = rule.op === "is" || rule.op === "is_not";
      const ids = await side.textIds(id, exact ? s : likeOf(s), exact);
      return rule.op === "contains" || rule.op === "is" ? side.ids(ids) : side.not(side.ids(ids));
    }
    case "NUMBER":
    case "MONEY":
    case "RATING": {
      const n = Number(v);
      if (rule.op === "ne") return side.not(side.has(id, { equals: n }));
      const f: Prisma.JsonFilter = rule.op === "eq" ? { equals: n } : rule.op === "gt" ? { gt: n } : rule.op === "gte" ? { gte: n } : rule.op === "lt" ? { lt: n } : { lte: n };
      return side.has(id, f);
    }
    case "DATE": {
      if (rule.op === "within") {
        const { from, to } = resolveRange(v as Range, ctx.today);
        const parts = [from ? side.has(id, { gte: from }) : null, to ? side.has(id, { lte: to }) : null].filter((x): x is W => x !== null);
        return side.and(parts);
      }
      const d = resolveDay(String(v), ctx.today);
      return side.has(id, rule.op === "is" ? { equals: d } : rule.op === "before" ? { lt: d } : { gt: d });
    }
    case "CHECKBOX":
      return rule.op === "ticked" ? side.has(id, { equals: true }) : side.not(side.has(id, { equals: true }));
    case "SELECT":
    case "PERSON":
    case "MULTI_SELECT": {
      const ids = (Array.isArray(v) ? v : []).map((x) => (x === ME ? ctx.userId : String(x)));
      if (!ids.length) return null;
      const one = (x: string) => side.has(id, kind === "MULTI_SELECT" ? { array_contains: [x] } : { equals: x });
      if (rule.op === "all_of") return side.has(id, { array_contains: ids });
      const any = ids.length === 1 ? one(ids[0]!) : side.or(ids.map(one));
      return rule.op === "none_of" ? side.not(any) : any;
    }
    default:
      return null;
  }
}

function rangeOf(rule: Rule, ctx: QueryContext): { gte?: Date; lt?: Date } | null {
  if (rule.op === "within") {
    const { from, to } = resolveRange(rule.value as Range, ctx.today);
    return ctx.clock.dayRange(from, to);
  }
  const d = resolveDay(String(rule.value), ctx.today);
  const whole = ctx.clock.dayRange(d, d);
  if (!whole) return null;
  if (rule.op === "is") return whole;
  if (rule.op === "before") return whole.gte ? { lt: whole.gte } : null;
  return whole.lt ? { gte: whole.lt } : null;
}

async function whereOf<W>(query: ViewQuery, props: Prop[], own: boolean, side: Side<W>, ctx: QueryContext): Promise<W | null> {
  const parts: W[] = [];
  for (const rule of query.rules) {
    const w = await ruleWhere(rule, props, own, side, ctx);
    if (w !== null) parts.push(w);
  }
  if (!parts.length) return null;
  return query.match === "any" ? side.or(parts) : side.and(parts);
}

/** A view's rules over a list's own rows — null when it has none. */
export async function ownRowsQueryWhere(workbookId: string, query: ViewQuery, props: Prop[], ctx: QueryContext): Promise<Prisma.WorkbookRowWhereInput | null> {
  const side: Side<Prisma.WorkbookRowWhereInput> = {
    has: (propertyId, value) => ({ values: { some: value ? { propertyId, value } : { propertyId } } }),
    none: (propertyId) => ({ values: { none: { propertyId } } }),
    ids: (ids) => ({ id: { in: ids } }),
    title: (filter) => ({ title: filter }),
    stamp: (field, range) => ({ [field]: range }),
    textIds: async (propertyId, pattern, exact) =>
      (
        await db.$queryRaw<{ id: string }[]>`
          SELECT DISTINCT "rowId" AS id FROM "workbook_row_values"
          WHERE "workbookId" = ${workbookId} AND "propertyId" = ${propertyId}
            AND ${exact ? Prisma.sql`lower("value" #>> '{}') = lower(${pattern})` : Prisma.sql`("value" #>> '{}') ILIKE ${pattern}`}`
      ).map((r) => r.id),
    not: (w) => ({ NOT: w }),
    and: (ws) => ({ AND: ws }),
    or: (ws) => ({ OR: ws }),
  };
  return whereOf(query, props, true, side, ctx);
}

/** A view's rules over a list of companies — null when it has none. */
export async function companyQueryWhere(workbookId: string, query: ViewQuery, props: Prop[], ctx: QueryContext): Promise<Prisma.CompanyWhereInput | null> {
  const side: Side<Prisma.CompanyWhereInput> = {
    has: (propertyId, value) => ({ smartListValues: { some: value ? { propertyId, value } : { propertyId } } }),
    none: (propertyId) => ({ smartListValues: { none: { propertyId } } }),
    ids: (ids) => ({ id: { in: ids } }),
    title: (filter) => ({ name: filter }),
    stamp: () => null,
    textIds: async (propertyId, pattern, exact) =>
      (
        await db.$queryRaw<{ id: string }[]>`
          SELECT DISTINCT "companyId" AS id FROM "workbook_values"
          WHERE "workbookId" = ${workbookId} AND "propertyId" = ${propertyId}
            AND ${exact ? Prisma.sql`lower("value" #>> '{}') = lower(${pattern})` : Prisma.sql`("value" #>> '{}') ILIKE ${pattern}`}
          LIMIT 50000`
      ).map((r) => r.id),
    not: (w) => ({ NOT: w }),
    and: (ws) => ({ AND: ws }),
    or: (ws) => ({ OR: ws }),
  };
  return whereOf(query, props, false, side, ctx);
}

// ─── Sorting ──────────────────────────────────────────────────────────────────

type Sortable = { id: string; title: string; createdAt: Date; updatedAt: Date };

/** How one value compares by its column's kind; empty always last, whichever way. */
function compareBy(kind: PropertyKind, options: SelectOption[], people: Map<string, string>) {
  const rank = new Map(options.map((o, i) => [o.id, i]));
  return (a: unknown, b: unknown): number => {
    if (kind === "NUMBER" || kind === "MONEY" || kind === "RATING") return Number(a) - Number(b);
    if (kind === "SELECT") return (rank.get(String(a)) ?? 999) - (rank.get(String(b)) ?? 999);
    if (kind === "CHECKBOX") return (a === true ? 1 : 0) - (b === true ? 1 : 0);
    if (kind === "PERSON") return (people.get(String(a)) ?? "").localeCompare(people.get(String(b)) ?? "", "en");
    return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
  };
}

/** Rows in the order a view's sorts ask — the title, a stamp, or a column — ties kept in the list's own order. */
export async function sortOwnRows<R extends Sortable>(rows: R[], sort: Sort[], props: Prop[]): Promise<R[]> {
  if (!sort.length || rows.length < 2) return rows;
  const columnSorts = sort.filter((s) => props.some((p) => p.id === s.field));
  const cells = columnSorts.length
    ? await db.workbookRowValue.findMany({ where: { rowId: { in: rows.map((r) => r.id) }, propertyId: { in: columnSorts.map((s) => s.field) } }, select: { rowId: true, propertyId: true, value: true } })
    : [];
  const valueOf = new Map(cells.map((c) => [`${c.rowId}:${c.propertyId}`, c.value as unknown]));
  const personIds = [...new Set(cells.filter((c) => props.find((p) => p.id === c.propertyId)?.kind === "PERSON").map((c) => String(c.value)))];
  const people = new Map(personIds.length ? (await db.user.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]) : []);
  const keys = sort.map((s) => {
    const dir = s.dir === "desc" ? -1 : 1;
    if (s.field === FIELD_TITLE) return { get: (r: R) => r.title as unknown, cmp: (a: unknown, b: unknown) => String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" }), dir };
    if (s.field === FIELD_CREATED || s.field === FIELD_UPDATED) return { get: (r: R) => (s.field === FIELD_CREATED ? r.createdAt : r.updatedAt).getTime() as unknown, cmp: (a: unknown, b: unknown) => Number(a) - Number(b), dir };
    const p = props.find((x) => x.id === s.field)!;
    return { get: (r: R) => valueOf.get(`${r.id}:${p.id}`) ?? null, cmp: compareBy(effectiveKind(p), p.options, people), dir };
  });
  const order = new Map(rows.map((r, i) => [r.id, i]));
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const va = k.get(a);
      const vb = k.get(b);
      if (va === null && vb === null) continue;
      if (va === null) return 1;
      if (vb === null) return -1;
      const c = k.cmp(va, vb) * k.dir;
      if (c) return c;
    }
    return order.get(a.id)! - order.get(b.id)!;
  });
}

/**
 * One page of a company list sorted by one of its columns: the companies with a value, in its order, then the rest by
 * name. `members` is who is in the list for this person, already narrowed by the view's rules.
 */
export async function companyPageByColumn(input: {
  members: Prisma.CompanyWhereInput;
  prop: Prop;
  dir: "asc" | "desc";
  skip: number;
  take: number;
}): Promise<{ ids: string[]; total: number }> {
  const { members, prop, dir, skip, take } = input;
  const [valued, total] = await Promise.all([
    db.workbookValue.findMany({ where: { propertyId: prop.id, company: members }, select: { companyId: true, value: true }, take: 50_000 }),
    db.company.count({ where: members }),
  ]);
  const people = prop.kind === "PERSON" ? new Map((await db.user.findMany({ where: { id: { in: [...new Set(valued.map((v) => String(v.value)))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name])) : new Map<string, string>();
  const cmp = compareBy(effectiveKind(prop), prop.options, people);
  const sorted = valued.sort((a, b) => cmp(a.value, b.value) * (dir === "desc" ? -1 : 1)).map((v) => v.companyId);
  const head = sorted.slice(skip, skip + take);
  if (head.length === take) return { ids: head, total };
  // The rest of the page from the companies without a value, by name.
  const restSkip = Math.max(0, skip - sorted.length);
  const rest = await db.company.findMany({ where: { AND: [members, { smartListValues: { none: { propertyId: prop.id } } }] }, orderBy: { name: "asc" }, skip: restSkip, take: take - head.length, select: { id: true } });
  return { ids: [...head, ...rest.map((r) => r.id)], total };
}

// ─── A page's query ───────────────────────────────────────────────────────────

/** A list's saved views' filters and sorts, by view id — none on a workspace not migrated yet. */
export async function savedViewQueries(workbookId: string): Promise<Record<string, unknown>> {
  try {
    const rows = await db.workbookViewQuery.findMany({ where: { workbookId }, select: { viewId: true, query: true } });
    return Object.fromEntries(rows.map((r) => [r.viewId, r.query]));
  } catch {
    return {};
  }
}

/**
 * The query a list's page shows: the saved view's, or the one in the address bar (`fq`) when somebody is trying
 * another. `saved` is what "Back to the saved view" returns to.
 */
export async function pageQuery(input: { workbookId: string; viewId: string | null; param: string | undefined; props: Prop[]; own: boolean }): Promise<{ saved: ViewQuery; current: ViewQuery }> {
  const stored = input.viewId ? (await savedViewQueries(input.workbookId))[input.viewId] : null;
  const saved = cleanQuery(stored ?? {}, input.props, input.own);
  const current = input.param !== undefined ? cleanQuery(decodeQuery(input.param) ?? {}, input.props, input.own) : saved;
  return { saved, current };
}
