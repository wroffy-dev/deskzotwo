"use server";

import { db, getTenantDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { toPlain } from "@/lib/serialize";
import { workspaceClock } from "@/lib/time/workspace";
import { firstBilledBetween } from "@/lib/customers/first-billed";
import { companyAccess, documentAccess } from "@/lib/authz/access";
import { moduleAccessFor } from "@/lib/modules-access";

const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

export type NewCustomer = {
  companyId: string;
  companySeq: number;
  name: string;
  at: string;
  /** 0 for April … 11 for March. */
  month: number;
  number: string;
  value: number;
  userId: string | null;
  person: string;
  creditFrom: "SALESPERSON" | "ACCOUNT_MANAGER";
  fromArchive: boolean;
};
export type NewCustomersPerson = { userId: string | null; name: string; counts: number[]; total: number; value: number };
export type NewCustomersView = {
  /** The financial year's first calendar year — 2026 for FY 2026–27. */
  year: number;
  label: string;
  months: string[];
  /** The month in progress, 0–11, or null for a year not under way. */
  current: number | null;
  people: NewCustomersPerson[];
  totals: number[];
  total: number;
  value: number;
  customers: NewCustomer[];
  /** May download the list (Export financial data). */
  canExport: boolean;
};

/**
 * Performance › New customers (owner, 9 Nov 2026 — "how many new customers by account manager or salesperson, monthly and
 * yearly; the customer should be billed, not just the record added"): each financial year's month, who billed a customer
 * for the first time ever (src/lib/customers/first-billed.ts). For whoever may see Performance, as the scorecard is.
 */
export async function newBilledCustomers(params: { year?: string | number }): Promise<NewCustomersView | null> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "performance.view"))) return null;
  const clock = await workspaceClock();
  const today = clock.calendarDate(new Date());
  // The financial year: April to March, on the workspace's clock.
  const thisYear = today.getUTCMonth() >= 3 ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
  const asked = Number(params.year);
  const year = Number.isInteger(asked) && asked >= 2000 && asked <= thisYear + 1 ? asked : thisYear;
  const range = { gte: clock.midnight(year, 3, 1), lt: clock.midnight(year + 1, 3, 1) };

  // Security audit round three, 14 Nov 2026 (R3-19): this listed every customer's first invoice — name, number,
  // value — to anyone with Performance, HR roles included. Now only the companies the person reaches and the
  // invoices their document rule opens, and nothing at all without the sales documents module open to them.
  const documentsOpen = (await moduleAccessFor(user.id, "sales_documents")) === "available";
  const [company, document] = await Promise.all([companyAccess(user.id, "view"), documentAccess(user.id, "view")]);
  const found = documentsOpen ? await firstBilledBetween(await getTenantDb(), range, clock, undefined, { company, document }) : [];
  const names = new Map(
    (await db.user.findMany({ where: { id: { in: [...new Set(found.map((f) => f.userId).filter((v): v is string => !!v))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
  );
  const monthOf = (at: Date) => {
    const d = clock.calendarDate(at);
    return (d.getUTCFullYear() - year) * 12 + d.getUTCMonth() - 3;
  };

  const customers: NewCustomer[] = found.map((f) => ({
    ...f,
    at: f.at.toISOString(),
    month: monthOf(f.at),
    person: f.userId ? (names.get(f.userId) ?? "Somebody no longer here") : "Nobody",
  }));
  const byPerson = new Map<string, NewCustomersPerson>();
  for (const c of customers) {
    const key = c.userId ?? "";
    const row = byPerson.get(key) ?? { userId: c.userId, name: c.person, counts: Array(12).fill(0), total: 0, value: 0 };
    row.counts[c.month] += 1;
    row.total += 1;
    row.value = Math.round((row.value + c.value) * 100) / 100;
    byPerson.set(key, row);
  }
  const people = [...byPerson.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const totals = Array.from({ length: 12 }, (_, m) => customers.filter((c) => c.month === m).length);
  const current = year === thisYear ? monthOf(new Date()) : null;

  return toPlain({
    year,
    label: `FY ${year}–${String(year + 1).slice(2)}`,
    months: MONTHS,
    current,
    people,
    totals,
    total: customers.length,
    value: Math.round(customers.reduce((t, c) => t + c.value, 0) * 100) / 100,
    customers,
    canExport: await hasEffectivePermission(user.id, "data.exportFinance"),
  });
}

/**
 * Whether the signed-in person may take this list away as a file (R3-19): first invoices are financial data,
 * so the download needs Export financial data, as every other finance download does.
 */
export async function mayExportNewCustomers(): Promise<boolean> {
  const user = await requireUser();
  return (await hasEffectivePermission(user.id, "performance.view")) && (await hasEffectivePermission(user.id, "data.exportFinance"));
}
