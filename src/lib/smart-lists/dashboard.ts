import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { companyMasker } from "@/lib/companies/masking";
import { optionsOf, type OptionColor, type PropertyKind } from "@/lib/smart-lists/values";

/**
 * A Smart List's dashboard (owner, 20 Nov 2026: "i want a dashboard for report under same smart list so results can be
 * seen easly"): the whole list summed up — not the page on screen — from its own columns and its companies:
 *
 *   · a Select or Multi-select column: how many rows hold each option, and, with a Money column, how much each adds up to;
 *   · Number and Money columns: totals and averages; Checkbox columns: how many ticked; Date columns: overdue, this
 *     week, this month;
 *   · the companies by state (unless addresses are hidden from this person) and by account owner;
 *   · guests' work on it in the last 30 days, when it's shared (Deskzo Connect).
 *
 * The rows are the ones the person sees in the list (`members`, src/lib/smart-lists/membership.ts). Server only.
 */

export type Bar = { key: string; label: string; color?: OptionColor; count: number; amount?: number };
export type SelectSummary = { id: string; name: string; multi: boolean; bars: Bar[]; notSet: number; amountOf: string | null };
export type NumberSummary = { id: string; name: string; money: boolean; sum: number; filled: number };
export type DateSummary = { id: string; name: string; overdue: number; week: number; month: number; filled: number };
export type ListDashboard = {
  total: number;
  byHand: number;
  changedThisWeek: number;
  selects: SelectSummary[];
  numbers: NumberSummary[];
  checks: { id: string; name: string; ticked: number }[];
  dates: DateSummary[];
  /** Null when this person doesn't see addresses. */
  states: Bar[] | null;
  owners: Bar[];
  guests: { shared: number; edits: number; comments: number; suggestions: number; waiting: number } | null;
  /** Values read for the summary stopped here — a list larger than this is summed over its first rows. */
  capped: boolean;
  /** A list with rows of its own (src/lib/smart-lists/own-rows.ts): what its rows are called; `owners` is who added them. */
  own?: { rows: string } | null;
};

const CAP = 200_000;
const DAY = 86_400_000;

async function orZero<T>(q: Promise<T>, empty: T): Promise<T> {
  try {
    return await q;
  } catch (err) {
    if (notMigratedYet(err)) return empty;
    throw err;
  }
}

/** "YYYY-MM-DD" plus days, as a calendar day. */
function plus(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(d.getTime() + days * DAY).toISOString().slice(0, 10);
}

type ColumnSummary = Pick<ListDashboard, "selects" | "numbers" | "checks" | "dates">;

/**
 * The column charts and figures over `values` — each a row's value in one column, the row a company or a row of the
 * list's own (src/lib/smart-lists/own-rows.ts). `total` is how many rows the list holds, for "not set".
 */
export function summariseColumns(
  props: { id: string; name: string; kind: string; options: unknown }[],
  values: { propertyId: string; rowId: string; value: unknown }[],
  total: number,
  today: string,
): ColumnSummary {
  const counted = props.filter((p) => ["SELECT", "MULTI_SELECT", "NUMBER", "MONEY", "CHECKBOX", "DATE"].includes(p.kind));
  const byProp = new Map<string, { rowId: string; value: unknown }[]>();
  for (const v of values) {
    const list = byProp.get(v.propertyId) ?? [];
    list.push({ rowId: v.rowId, value: v.value });
    byProp.set(v.propertyId, list);
  }
  const money = props.find((p) => p.kind === "MONEY") ?? null;
  const moneyOf = new Map<string, number>();
  for (const v of (money && byProp.get(money.id)) || []) if (typeof v.value === "number") moneyOf.set(v.rowId, v.value);

  const selects: SelectSummary[] = [];
  const numbers: NumberSummary[] = [];
  const checks: ListDashboard["checks"] = [];
  const dates: DateSummary[] = [];
  for (const p of counted) {
    const rows = byProp.get(p.id) ?? [];
    const kind = p.kind as PropertyKind;
    if (kind === "SELECT" || kind === "MULTI_SELECT") {
      const options = optionsOf(p.options);
      const bars = new Map<string, Bar>(options.map((o) => [o.id, { key: o.id, label: o.name, color: o.color, count: 0, amount: money ? 0 : undefined }]));
      const withValue = new Set<string>();
      for (const r of rows) {
        const ids = kind === "SELECT" ? [r.value] : Array.isArray(r.value) ? r.value : [];
        for (const id of ids) {
          const bar = typeof id === "string" ? bars.get(id) : undefined;
          if (!bar) continue;
          bar.count += 1;
          withValue.add(r.rowId);
          if (bar.amount !== undefined) bar.amount += moneyOf.get(r.rowId) ?? 0;
        }
      }
      selects.push({ id: p.id, name: p.name, multi: kind === "MULTI_SELECT", bars: [...bars.values()], notSet: Math.max(0, total - withValue.size), amountOf: money?.name ?? null });
    } else if (kind === "NUMBER" || kind === "MONEY") {
      const nums = rows.map((r) => r.value).filter((v): v is number => typeof v === "number");
      numbers.push({ id: p.id, name: p.name, money: kind === "MONEY", sum: nums.reduce((a, b) => a + b, 0), filled: nums.length });
    } else if (kind === "CHECKBOX") {
      checks.push({ id: p.id, name: p.name, ticked: rows.filter((r) => r.value === true).length });
    } else if (kind === "DATE") {
      const days = rows.map((r) => r.value).filter((v): v is string => typeof v === "string");
      const week = plus(today, 7);
      const month = plus(today, 30);
      dates.push({ id: p.id, name: p.name, overdue: days.filter((d) => d < today).length, week: days.filter((d) => d >= today && d <= week).length, month: days.filter((d) => d >= today && d <= month).length, filled: days.length });
    }
  }
  return { selects, numbers, checks, dates };
}

export async function listDashboard(input: { userId: string; workbookId: string; members: Prisma.CompanyWhereInput; today: string; now?: Date }): Promise<ListDashboard> {
  const { userId, workbookId, members, today } = input;
  const now = input.now ?? new Date();
  const props = await db.workbookProperty.findMany({ where: { workbookId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, kind: true, options: true } });
  const counted = props.filter((p) => ["SELECT", "MULTI_SELECT", "NUMBER", "MONEY", "CHECKBOX", "DATE"].includes(p.kind));
  const masker = await companyMasker(userId, "list");
  const probe = masker.location({ city: "\u0001", state: "\u0001" });
  const addressesShown = probe.state === "\u0001";
  const since = new Date(now.getTime() - 30 * DAY);

  const [total, byHand, changedThisWeek, values, states, owners] = await Promise.all([
    db.company.count({ where: members }),
    orZero(db.workbookPinnedRow.count({ where: { workbookId, company: members } }), 0),
    orZero(db.workbookValue.count({ where: { workbookId, updatedAt: { gte: new Date(now.getTime() - 7 * DAY) }, company: members } }), 0),
    counted.length ? db.workbookValue.findMany({ where: { workbookId, propertyId: { in: counted.map((p) => p.id) }, company: members }, select: { propertyId: true, companyId: true, value: true }, take: CAP }) : Promise.resolve([]),
    addressesShown ? db.companyLocation.groupBy({ by: ["state"], where: { isPrimary: true, company: members }, _count: { _all: true } }) : Promise.resolve(null),
    db.company.groupBy({ by: ["ownerUserId"], where: members, _count: { _all: true } }),
  ]);

  const { selects, numbers, checks, dates } = summariseColumns(props, values.map((v) => ({ propertyId: v.propertyId, rowId: v.companyId, value: v.value })), total, today);

  const ownerNames = new Map(
    (await db.user.findMany({ where: { id: { in: owners.map((o) => o.ownerUserId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
  );
  const top = (bars: Bar[], n: number) => {
    const sorted = [...bars].sort((a, b) => b.count - a.count);
    if (sorted.length <= n) return sorted;
    const rest = sorted.slice(n - 1).reduce((s, b) => s + b.count, 0);
    return [...sorted.slice(0, n - 1), { key: "rest", label: `${sorted.length - n + 1} more`, count: rest }];
  };

  // Guests' work on it — only once it's shared with somebody.
  const shared = await orZero(db.listShare.count({ where: { workbookId, revokedAt: null, OR: [{ until: null }, { until: { gt: now } }] } }), 0);
  let guests: ListDashboard["guests"] = null;
  if (shared) {
    const [kinds, waiting] = await Promise.all([
      orZero(db.guestActivity.groupBy({ by: ["kind"], where: { workbookId, at: { gte: since } }, _count: { _all: true } }), []),
      orZero(db.listSuggestion.count({ where: { workbookId, status: "PENDING" } }), 0),
    ]);
    const n = (k: string) => kinds.find((x) => x.kind === k)?._count._all ?? 0;
    guests = { shared, edits: n("EDIT"), comments: n("COMMENT"), suggestions: n("SUGGEST"), waiting };
  }

  return {
    total,
    byHand,
    changedThisWeek,
    selects,
    numbers,
    checks,
    dates,
    states: states ? top(states.map((s) => ({ key: s.state ?? "", label: s.state || "No state", count: s._count._all })), 10) : null,
    owners: top(owners.map((o) => ({ key: o.ownerUserId ?? "", label: o.ownerUserId ? (ownerNames.get(o.ownerUserId) ?? "Somebody who left") : "Nobody", count: o._count._all })), 10),
    guests,
    capped: values.length >= CAP,
  };
}
