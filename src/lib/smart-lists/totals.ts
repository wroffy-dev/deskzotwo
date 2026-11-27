import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { OWN_ROWS, rowsMatching } from "@/lib/smart-lists/own-rows";
import type { PropertyKind, SelectOption } from "@/lib/smart-lists/values";

/**
 * A Smart List table's footer (owner, 20 Nov 2026 — Smart Lists phase 2: "a footer row adds up the Money and Number
 * columns and counts the Checkbox and Select columns"): over every row the view shows — its search and filters — not
 * only the page on screen. Server only.
 */

export type ColumnTotal = { filled: number; sum?: number; ticked?: number };
export type ListTotals = { count: number; columns: Record<string, ColumnTotal> };

type Prop = { id: string; name: string; kind: PropertyKind; options: SelectOption[]; formula?: { format: string } | null };
// A formula adds up when it works out a number, money or days (Smart Lists phase 4).
const sums = (p: Prop) => p.kind === "NUMBER" || p.kind === "MONEY" || (p.kind === "FORMULA" && ["number", "money", "days"].includes(p.formula?.format ?? "number"));

function add(props: Prop[], values: { propertyId: string; value: unknown }[]): Record<string, ColumnTotal> {
  const kinds = new Map(props.map((p) => [p.id, sums(p) ? "NUMBER" : p.kind === "FORMULA" && p.formula?.format === "checkbox" ? "CHECKBOX" : p.kind]));
  const out: Record<string, ColumnTotal> = {};
  for (const p of props) out[p.id] = sums(p) ? { filled: 0, sum: 0 } : kinds.get(p.id) === "CHECKBOX" ? { filled: 0, ticked: 0 } : { filled: 0 };
  for (const v of values) {
    const kind = kinds.get(v.propertyId);
    const t = out[v.propertyId];
    if (!kind || !t || v.value === null || (Array.isArray(v.value) && v.value.length === 0)) continue;
    t.filled += 1;
    if ((kind === "NUMBER" || kind === "MONEY") && typeof v.value === "number") t.sum = Math.round(((t.sum ?? 0) + v.value) * 100) / 100;
    if (kind === "CHECKBOX" && v.value === true) t.ticked = (t.ticked ?? 0) + 1;
  }
  return out;
}

/** A list of its own rows: the totals over the rows its search and filter show. */
export async function ownRowTotals(workbookId: string, props: Prop[], opts: { search?: string; filter?: Prisma.WorkbookRowWhereInput | null }): Promise<ListTotals> {
  const searched = await rowsMatching(workbookId, opts.search ?? "", props);
  const where: Prisma.WorkbookRowWhereInput = opts.filter ? { AND: [searched, opts.filter] } : searched;
  const ids = (await db.workbookRow.findMany({ where, select: { id: true }, take: OWN_ROWS.perList })).map((r) => r.id);
  const values = ids.length ? await db.workbookRowValue.findMany({ where: { rowId: { in: ids } }, select: { propertyId: true, value: true } }) : [];
  return { count: ids.length, columns: add(props, values) };
}

/** A list of companies: the totals over the companies in it for this person, as its search and filter narrow them. */
export async function companyTotals(workbookId: string, members: Prisma.CompanyWhereInput, props: Prop[]): Promise<ListTotals> {
  const [count, values] = await Promise.all([
    db.company.count({ where: members }),
    db.workbookValue.findMany({ where: { workbookId, company: members }, select: { propertyId: true, value: true }, take: 200_000 }),
  ]);
  return { count, columns: add(props, values) };
}
