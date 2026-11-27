import { LIMITS, calendarDay, isPropertyKind, type PropertyKind, type SelectOption } from "@/lib/smart-lists/values";

/**
 * A Smart List view's filters and sort (owner, 20 Nov 2026 — Smart Lists phase 2: "Live links, newest first", "Mine",
 * "Due this week"). Each saved view keeps its own; anybody can try others in the address bar, and whoever may edit the
 * list saves them for everyone. Pure and client-safe — the filter bar and the server read the same rules
 * (src/lib/smart-lists/view-query-server.ts turns them into a database query).
 *
 * A rule names a column (a property's id), or one of the list's own fields: `title` (an own row's title, a company's
 * name), `createdAt` and `updatedAt` (an own row's added and last-changed days).
 */

export const FIELD_TITLE = "title";
export const FIELD_CREATED = "createdAt";
export const FIELD_UPDATED = "updatedAt";

export const OPS = [
  "contains",
  "not_contains",
  "is",
  "is_not",
  "empty",
  "not_empty",
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "before",
  "after",
  "within",
  "any_of",
  "none_of",
  "all_of",
  "ticked",
  "not_ticked",
] as const;
export type Op = (typeof OPS)[number];

export const OP_LABELS: Record<Op, string> = {
  contains: "contains",
  not_contains: "doesn't contain",
  is: "is",
  is_not: "is not",
  empty: "is empty",
  not_empty: "is not empty",
  eq: "=",
  ne: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  before: "is before",
  after: "is after",
  within: "is within",
  any_of: "is any of",
  none_of: "is none of",
  all_of: "has all of",
  ticked: "is ticked",
  not_ticked: "is not ticked",
};

/** Ops that need no value. */
export const BARE_OPS: readonly Op[] = ["empty", "not_empty", "ticked", "not_ticked"];

/** Days relative to today a date rule can name, so a saved view stays current. */
export const RELATIVE_DAYS = { today: "Today", tomorrow: "Tomorrow", yesterday: "Yesterday" } as const;
/** Ranges a date can be within. */
export const RANGES = { next_7: "the next 7 days", next_30: "the next 30 days", last_7: "the last 7 days", last_30: "the last 30 days", this_month: "this month", overdue: "the past (gone by)" } as const;
export type Range = keyof typeof RANGES;

/** "Me", in a Person rule: whoever is looking. */
export const ME = "@me";

export type FieldKind = PropertyKind | "TITLE" | "STAMP";
export type Rule = { field: string; op: Op; value?: unknown };
export type Sort = { field: string; dir: "asc" | "desc" };
/** `group`: the column a table's rows are grouped by — a Select, a Person or a Checkbox (Smart Lists phase 3). */
export type ViewQuery = { match: "all" | "any"; rules: Rule[]; sort: Sort[]; group?: string | null };

export const EMPTY_QUERY: ViewQuery = { match: "all", rules: [], sort: [], group: null };

/** The kinds a table can group its rows by. */
export const GROUP_KINDS: readonly string[] = ["SELECT", "PERSON", "CHECKBOX"];

/** The order rows are fetched in: the group's column first, so a group's rows sit together page after page. */
export function effectiveSort(q: ViewQuery): Sort[] {
  return q.group ? [{ field: q.group, dir: "asc" as const }, ...q.sort.filter((s) => s.field !== q.group)].slice(0, 4) : q.sort;
}
export const QUERY_LIMITS = { rules: 20, sorts: 3, text: 200, choices: LIMITS.options } as const;

type Prop = { id: string; name: string; kind: PropertyKind; options: SelectOption[]; formula?: { format: string } | null };

/**
 * The kind a column filters and sorts as: its own, or — a formula (Smart Lists phase 4) — the kind of what it works out:
 * a number, money, days, a date, a tick or words.
 */
export function effectiveKind(p: { kind: PropertyKind; formula?: { format: string } | null }): PropertyKind {
  if (p.kind !== "FORMULA") return p.kind;
  const f = p.formula?.format;
  return f === "money" ? "MONEY" : f === "date" ? "DATE" : f === "checkbox" ? "CHECKBOX" : f === "text" ? "TEXT" : "NUMBER";
}

/** The ops a field offers, in the order the filter bar lists them. */
export function opsFor(kind: FieldKind): Op[] {
  switch (kind) {
    case "TITLE":
    case "TEXT":
    case "LINK":
    case "EMAIL":
    case "PHONE":
      return ["contains", "not_contains", "is", "is_not", "empty", "not_empty"];
    case "NUMBER":
    case "MONEY":
    case "RATING":
      return ["eq", "ne", "gt", "gte", "lt", "lte", "empty", "not_empty"];
    case "DATE":
      return ["is", "before", "after", "within", "empty", "not_empty"];
    case "STAMP":
      return ["is", "before", "after", "within"];
    case "SELECT":
    case "PERSON":
      return ["any_of", "none_of", "empty", "not_empty"];
    case "MULTI_SELECT":
      return ["any_of", "all_of", "none_of", "empty", "not_empty"];
    case "CHECKBOX":
      return ["ticked", "not_ticked"];
    default:
      return ["empty", "not_empty"];
  }
}

/** A field's kind: a property's, or the list's own fields'. `own` — a list with rows of its own (it has added/changed days). */
export function fieldKind(field: string, props: Prop[], own: boolean): FieldKind | null {
  if (field === FIELD_TITLE) return "TITLE";
  if (own && (field === FIELD_CREATED || field === FIELD_UPDATED)) return "STAMP";
  const p = props.find((x) => x.id === field);
  return p && isPropertyKind(p.kind) ? effectiveKind(p) : null;
}

const day = (v: unknown) => (typeof v === "string" && (v in RELATIVE_DAYS || calendarDay(v)) ? v : null);

/** A rule as kept: a field the list has, an op its kind offers, a value that op needs — or null, and it's dropped. */
export function cleanRule(raw: unknown, props: Prop[], own: boolean): Rule | null {
  const r = (raw ?? {}) as Partial<Rule>;
  if (typeof r.field !== "string" || typeof r.op !== "string") return null;
  const kind = fieldKind(r.field, props, own);
  // A count column is worked out when shown, not kept: nothing to filter on (Smart Lists phase 3).
  if (!kind || kind === "ROLLUP" || !(opsFor(kind) as string[]).includes(r.op)) return null;
  const op = r.op as Op;
  if (BARE_OPS.includes(op)) return { field: r.field, op };
  const v = r.value;
  switch (kind) {
    case "TITLE":
    case "TEXT":
    case "LINK":
    case "EMAIL":
    case "PHONE": {
      const s = String(v ?? "").replace(/\s+/g, " ").trim().slice(0, QUERY_LIMITS.text);
      return s ? { field: r.field, op, value: s } : null;
    }
    case "NUMBER":
    case "MONEY":
    case "RATING": {
      const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[,₹\s]/g, ""));
      return String(v ?? "").trim() !== "" && Number.isFinite(n) ? { field: r.field, op, value: n } : null;
    }
    case "DATE":
    case "STAMP": {
      if (op === "within") return typeof v === "string" && v in RANGES ? { field: r.field, op, value: v } : null;
      const d = day(v);
      return d ? { field: r.field, op, value: d } : null;
    }
    case "SELECT":
    case "MULTI_SELECT": {
      const options = props.find((p) => p.id === r.field)?.options ?? [];
      const ids = [...new Set((Array.isArray(v) ? v : [v]).map(String))].filter((id) => options.some((o) => o.id === id)).slice(0, QUERY_LIMITS.choices);
      return ids.length ? { field: r.field, op, value: ids } : null;
    }
    case "PERSON": {
      const ids = [...new Set((Array.isArray(v) ? v : [v]).map(String))].filter((id) => id === ME || /^[a-z0-9]{8,40}$/i.test(id)).slice(0, 50);
      return ids.length ? { field: r.field, op, value: ids } : null;
    }
    default:
      return null;
  }
}

/** A whole query as kept: rules that make sense, at most twenty; sorts on fields the list has, at most three. */
export function cleanQuery(raw: unknown, props: Prop[], own: boolean): ViewQuery {
  const q = (raw ?? {}) as Partial<ViewQuery>;
  const rules = (Array.isArray(q.rules) ? q.rules : [])
    .map((r) => cleanRule(r, props, own))
    .filter((r): r is Rule => !!r)
    .slice(0, QUERY_LIMITS.rules);
  const seen = new Set<string>();
  const sort = (Array.isArray(q.sort) ? q.sort : [])
    .filter((s): s is Sort => !!s && typeof s.field === "string" && (s.dir === "asc" || s.dir === "desc"))
    .filter((s) => {
      const kind = fieldKind(s.field, props, own);
      // A sort on a column of many choices or a checkbox has no order worth keeping; a person sorts by id.
      if (!kind || ["MULTI_SELECT", "COMPANY", "LEAD", "CONTACT", "ROW", "FILE", "ROLLUP"].includes(kind) || seen.has(s.field)) return false;
      seen.add(s.field);
      return true;
    })
    .map((s) => ({ field: s.field, dir: s.dir }))
    .slice(0, QUERY_LIMITS.sorts);
  const groupKind = typeof q.group === "string" ? fieldKind(q.group, props, own) : null;
  const group = groupKind && GROUP_KINDS.includes(groupKind) ? (q.group as string) : null;
  return { match: q.match === "any" ? "any" : "all", rules, sort, group };
}

export const isEmptyQuery = (q: ViewQuery | null | undefined) => !q || (q.rules.length === 0 && q.sort.length === 0 && !q.group);

/** The query for the address bar (and back): compact JSON; anything unreadable is no query. */
export function encodeQuery(q: ViewQuery): string {
  return isEmptyQuery(q) ? "" : JSON.stringify({ m: q.match === "any" ? "any" : undefined, r: q.rules.map((r) => [r.field, r.op, r.value]), s: q.sort.map((s) => [s.field, s.dir]), g: q.group || undefined });
}

export function decodeQuery(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as { m?: string; r?: unknown[]; s?: unknown[]; g?: unknown };
    return {
      match: j.m === "any" ? "any" : "all",
      rules: (Array.isArray(j.r) ? j.r : []).map((x) => (Array.isArray(x) ? { field: x[0], op: x[1], value: x[2] } : null)),
      sort: (Array.isArray(j.s) ? j.s : []).map((x) => (Array.isArray(x) ? { field: x[0], dir: x[1] } : null)),
      group: typeof j.g === "string" ? j.g : null,
    };
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
function plusDays(today: string, n: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** A day a rule names, as a calendar day — "today" and its neighbours worked out from the workspace's today. */
export function resolveDay(value: string, today: string): string {
  if (value === "today") return today;
  if (value === "tomorrow") return plusDays(today, 1);
  if (value === "yesterday") return plusDays(today, -1);
  return value;
}

/** A range as first and last day, both included. */
export function resolveRange(range: Range, today: string): { from: string | null; to: string | null } {
  switch (range) {
    case "next_7":
      return { from: today, to: plusDays(today, 7) };
    case "next_30":
      return { from: today, to: plusDays(today, 30) };
    case "last_7":
      return { from: plusDays(today, -7), to: today };
    case "last_30":
      return { from: plusDays(today, -30), to: today };
    case "this_month": {
      const first = `${today.slice(0, 7)}-01`;
      const next = new Date(`${first}T00:00:00Z`);
      next.setUTCMonth(next.getUTCMonth() + 1);
      next.setUTCDate(0);
      return { from: first, to: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}` };
    }
    case "overdue":
      return { from: null, to: plusDays(today, -1) };
  }
}

/** A field's name in words. */
export function fieldName(field: string, props: Prop[], titleName: string): string {
  if (field === FIELD_TITLE) return titleName;
  if (field === FIELD_CREATED) return "Added";
  if (field === FIELD_UPDATED) return "Last changed";
  return props.find((p) => p.id === field)?.name ?? "A column";
}

/** A rule in words, for its chip — "Status is any of Live, Pending". */
export function describeRule(rule: Rule, props: Prop[], titleName: string, people: Map<string, string> = new Map()): string {
  const name = fieldName(rule.field, props, titleName);
  const op = OP_LABELS[rule.op];
  if (BARE_OPS.includes(rule.op)) return `${name} ${op}`;
  const prop = props.find((p) => p.id === rule.field);
  let value: string;
  if (Array.isArray(rule.value)) {
    value = rule.value
      .map((id) => (prop?.kind === "PERSON" ? (id === ME ? "me" : (people.get(String(id)) ?? "someone")) : (prop?.options.find((o) => o.id === id)?.name ?? "")))
      .filter(Boolean)
      .join(", ");
  } else if (rule.op === "within") value = RANGES[rule.value as Range] ?? String(rule.value);
  else if (typeof rule.value === "string" && rule.value in RELATIVE_DAYS) value = RELATIVE_DAYS[rule.value as keyof typeof RELATIVE_DAYS].toLowerCase();
  else if (prop?.kind === "MONEY" && typeof rule.value === "number") value = `₹${rule.value.toLocaleString("en-IN")}`;
  else value = String(rule.value ?? "");
  return `${name} ${op} ${value}`;
}
