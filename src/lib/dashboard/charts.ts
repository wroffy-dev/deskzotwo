/**
 * The dashboard's chart widgets: what can be charted, how, and how a chart is kept.
 *
 * Shared by the server (which reads the figures, src/lib/dashboard/data.ts) and the browser (which draws
 * them and builds new ones, src/components/dashboard/dashboard-board.tsx) — so nothing here may import
 * a server module.
 *
 * ## Kept in the array the dashboard already had
 *
 * A chart is an entry in `User.dashboardWidgets`, beside the older card keys ("notes", "renewals"…),
 * written as `chart:` and a query string. That array is already the dashboard's order and selection in
 * one, so a chart sits among the cards in the order somebody put it, and nothing needed a new column —
 * which would have meant every workspace's database migrating before the dashboard could open.
 *
 * `layout:2` in the array says it was saved by this dashboard. A list saved before it had charts gets
 * the default charts put in front of what it held, once; after that, removing a chart keeps it removed.
 *
 * ## No older cards (owner, 23 Oct 2026)
 *
 * The dashboard is the design and nothing else: headline numbers and chart widgets. The older cards —
 * finance, renewals, tickets, quotations and the rest — are widgets of their own now (the sources below
 * from `customers` on), and a card key still found in a saved layout, a role's defaults or a department's
 * layout is read as the widget that stands in for it (`CARD_WIDGETS`).
 */

import { baseLocale, basePrefix, bigUnits } from "@/lib/currency";

export type ChartType = "bar" | "line" | "area" | "hbar" | "donut" | "pie" | "number" | "table" | "list";
export type PresetRange = "7d" | "30d" | "90d" | "qtd" | "ytd";
/** Days of the person's own choosing, the dashboard's alone (owner, 9 Nov 2026): `yyyy-mm-dd_yyyy-mm-dd`, both days in. */
export type CustomRange = `${string}_${string}`;
export type RangeKey = PresetRange | CustomRange;
/** 0 is XS — a headline card's width, four to a row — and 1–3 the columns of three it spans. */
export type WidgetSize = 0 | 1 | 2 | 3;
export type SourceKey =
  | "tasks"
  | "leads"
  | "attendance"
  | "team"
  | "approvals"
  | "activity"
  | "customers"
  | "quotations"
  | "orders"
  | "targets"
  | "payments"
  | "finance"
  | "renewals"
  | "support"
  | "projects"
  | "expenses"
  | "vendors";

export type ChartSpec = {
  id: string;
  source: SourceKey;
  metric: string;
  type: ChartType;
  size: WidgetSize;
  /** The dashboard's own range, or one of the widget's own. */
  range: RangeKey | "inherit";
  filters: Record<string, string>;
  /** Empty for the metric's own name. */
  title: string;
};

export const CHART_TYPES: Record<ChartType, { label: string }> = {
  bar: { label: "Column Chart" },
  line: { label: "Line Chart" },
  area: { label: "Area Chart" },
  hbar: { label: "Bar Chart" },
  donut: { label: "Donut Chart" },
  pie: { label: "Pie Chart" },
  number: { label: "Number" },
  table: { label: "Table" },
  list: { label: "List" },
};
export const CHART_TYPE_ORDER = Object.keys(CHART_TYPES) as ChartType[];

export const RANGES: { key: PresetRange; label: string }[] = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "qtd", label: "This quarter" },
  { key: "ytd", label: "Year to date" },
];
export const DEFAULT_RANGE: RangeKey = "30d";

const DAY_MS = 86_400_000;
/** A `yyyy-mm-dd` moved by whole days. */
export const shiftDay = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Two years at most: longer would read most of a workspace's history for one board. */
export const MAX_CUSTOM_DAYS = 731;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (key: string) => DAY_KEY.test(key) && !Number.isNaN(Date.parse(`${key}T00:00:00Z`)) && new Date(`${key}T00:00:00Z`).toISOString().slice(0, 10) === key;
/** The days a person chose, or null for a preset, or one that isn't a real range. */
export function customRange(range: unknown): { from: string; to: string; days: number } | null {
  if (typeof range !== "string") return null;
  const [from, to, extra] = range.split("_");
  if (extra !== undefined || !from || !to || !realDay(from) || !realDay(to) || from > to) return null;
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  return days <= MAX_CUSTOM_DAYS ? { from, to, days } : null;
}
export const customKey = (from: string, to: string): CustomRange => `${from}_${to}`;

/** The first day a range covers, ending today (`yyyy-mm-dd`, the workspace's). The quarter and year are the calendar's. */
export function rangeStart(today: string, range: RangeKey): string {
  const custom = customRange(range);
  if (custom) return custom.from;
  const [year, month] = today.split("-").map(Number) as [number, number];
  if (range === "7d") return shiftDay(today, -6);
  if (range === "30d") return shiftDay(today, -29);
  if (range === "90d") return shiftDay(today, -89);
  if (range === "qtd") return `${year}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
  return `${year}-01-01`;
}
/** The last day a range covers: today, or the last day chosen. */
export const rangeEnd = (today: string, range: RangeKey): string => customRange(range)?.to ?? today;

const MONTH_WORDS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayWords = (key: string, withYear: boolean) => `${Number(key.slice(8, 10))} ${MONTH_WORDS[Number(key.slice(5, 7)) - 1]}${withYear ? ` ${key.slice(0, 4)}` : ""}`;
/** "Last 30 days", or the days chosen: "1 Oct – 9 Nov 2026", "20 Dec 2025 – 5 Jan 2026", "3 Nov 2026". */
export function rangeLabel(key: RangeKey): string {
  const custom = customRange(key);
  if (!custom) return RANGES.find((r) => r.key === key)?.label ?? key;
  if (custom.from === custom.to) return dayWords(custom.from, true);
  return `${dayWords(custom.from, custom.from.slice(0, 4) !== custom.to.slice(0, 4))} – ${dayWords(custom.to, true)}`;
}
export const isRangeKey = (v: unknown): v is RangeKey => RANGES.some((r) => r.key === v) || customRange(v) !== null;
/** A change's words: "vs prev. 30 days", or for the days chosen, as many days before them. */
export function againstWords(range: RangeKey): string {
  const custom = customRange(range);
  if (custom) return `vs prev. ${custom.days} day${custom.days === 1 ? "" : "s"}`;
  return range === "7d" ? "vs prev. 7 days" : range === "30d" ? "vs prev. 30 days" : range === "90d" ? "vs prev. 90 days" : "vs prev. period";
}

/** A filter's choices. "all" is always first and always means "everything this person may see". */
export type FilterDef = { key: string; label: string; options: { value: string; label: string }[] };

/** Filters whose options come from the workspace — its departments — filled in by the server. */
export const DEPARTMENT_FILTER = "dept";

export type MetricDef = {
  label: string;
  description: string;
  types: ChartType[];
  /**
   * A figure the dashboard's range doesn't move: a standing count ("open tickets"), or one with its own
   * period ("this fiscal year"). The builder offers no date range for it.
   */
  fixed?: true;
};
export type SourceDef = {
  label: string;
  /** Where "Open …" in the widget's menu goes. */
  href: string;
  openLabel: string;
  filters: FilterDef[];
  metrics: Record<string, MetricDef>;
};

const WHOSE = (label: string, team: string, mine: string): FilterDef => ({
  key: "whose",
  label,
  options: [
    { value: "all", label: "Everyone" },
    { value: "team", label: team },
    { value: "me", label: mine },
  ],
});
const DEPARTMENT: FilterDef = { key: DEPARTMENT_FILTER, label: "Department", options: [{ value: "all", label: "All departments" }] };

export const SOURCES: Record<SourceKey, SourceDef> = {
  tasks: {
    label: "Tasks",
    href: "/tasks",
    openLabel: "Open Tasks",
    filters: [WHOSE("Assignee", "My team", "Assigned to me")],
    metrics: {
      completion: { label: "Task Completion Trend", description: "Completed and pending tasks over time", types: ["bar", "line", "area"] },
      priority: { label: "Tasks by Priority", description: "Open tasks grouped by priority", types: ["hbar", "bar", "donut", "pie"] },
      upcoming: { label: "Upcoming Tasks", description: "Next tasks due, with priority", types: ["list"] },
      total: { label: "Total Tasks", description: "Tasks created in the period", types: ["number"] },
    },
  },
  leads: {
    label: "Leads",
    href: "/leads",
    openLabel: "Open Leads",
    filters: [WHOSE("Owner", "My team", "My leads")],
    metrics: {
      status: { label: "Lead Status", description: "Open leads by pipeline stage", types: ["donut", "pie", "hbar", "bar"] },
      source: { label: "Leads by Source", description: "Where new leads came from", types: ["donut", "pie", "bar", "hbar"] },
      recent: { label: "Recent Leads", description: "Latest leads with status and owner", types: ["table"] },
      open: { label: "Open Leads", description: "Leads not yet won or lost", types: ["number"] },
    },
  },
  attendance: {
    label: "Attendance",
    href: "/people/attendance",
    openLabel: "Open Attendance",
    filters: [DEPARTMENT],
    metrics: {
      overview: { label: "Attendance Overview", description: "Present, late, absent and on-leave headcount", types: ["area", "line", "bar"] },
      rate: { label: "Attendance Rate", description: "Share of working days attended", types: ["number"] },
    },
  },
  team: {
    label: "Team",
    href: "/tasks",
    openLabel: "Open Tasks",
    filters: [DEPARTMENT],
    metrics: {
      performance: { label: "Team Performance", description: "On-time completion rate per person", types: ["bar", "hbar", "table"] },
    },
  },
  approvals: {
    label: "Approvals",
    href: "/approvals",
    openLabel: "Open Approvals",
    filters: [],
    metrics: {
      byType: { label: "Pending Approvals by Type", description: "Requests waiting on your decision", types: ["donut", "pie", "hbar"] },
      pending: { label: "Pending Approvals", description: "Total requests waiting on your decision", types: ["number"] },
    },
  },
  activity: {
    label: "Activity",
    href: "/activity",
    openLabel: "Open Activity log",
    filters: [],
    metrics: {
      recent: { label: "Recent Activities", description: "Latest events from modules you can access", types: ["list"] },
    },
  },

  // What the older cards showed, as widgets (owner, 23 Oct 2026). Each source is open exactly where its
  // card was offered (src/lib/dashboard/data.ts SOURCE_CARD), and counts what that card counted.
  customers: {
    label: "Customers",
    href: "/companies",
    openLabel: "Open Companies",
    filters: [],
    metrics: {
      funnel: { label: "Companies by Stage", description: "Prospects, leads, awaiting order and customers", types: ["hbar", "bar", "donut", "pie"], fixed: true },
      companies: { label: "Companies", description: "Every company you can see, with how many are at each stage", types: ["number"], fixed: true },
      customers: { label: "Customers", description: "Companies that have bought at least once", types: ["number"], fixed: true },
    },
  },
  quotations: {
    label: "Quotations",
    href: "/sales/proposals",
    openLabel: "Open Quotations",
    filters: [],
    metrics: {
      pending: { label: "Pending Quotations", description: "Proposals issued and not yet answered", types: ["number"], fixed: true },
    },
  },
  orders: {
    label: "Orders",
    href: "/orders",
    openLabel: "Open Orders",
    filters: [],
    metrics: {
      action: { label: "Orders Needing Action", description: "Orders waiting for approval", types: ["number"], fixed: true },
      stages: { label: "Orders by Stage", description: "Awaiting approval and approved, awaiting sourcing", types: ["donut", "pie", "hbar", "bar"], fixed: true },
    },
  },
  targets: {
    label: "Targets",
    href: "/targets/mine",
    openLabel: "Open My target",
    filters: [],
    metrics: {
      monthly: { label: "Monthly Sales Target", description: "What you've achieved against this month's target", types: ["number"], fixed: true },
    },
  },
  payments: {
    label: "Payments",
    href: "/payments",
    openLabel: "Open Payments",
    filters: [],
    metrics: {
      outstanding: { label: "Outstanding Balance", description: "What customers still owe on issued invoices", types: ["number"], fixed: true },
      status: { label: "Unpaid Invoices", description: "Unpaid and part-paid invoices", types: ["donut", "pie", "hbar", "bar"], fixed: true },
    },
  },
  finance: {
    label: "Finance",
    href: "/accounting",
    openLabel: "Open Accounts",
    filters: [],
    metrics: {
      incomeExpense: { label: "Income and Expense", description: "Income against expenses, month by month, this fiscal year", types: ["bar", "line", "area"], fixed: true },
      cashFlow: { label: "Cash Flow", description: "Cash and bank balance at each month's end, the last 12 months", types: ["area", "line"], fixed: true },
      topExpenses: { label: "Top Expenses", description: "Where the money went this fiscal year", types: ["hbar", "bar", "donut", "pie"], fixed: true },
      receivables: { label: "Total Receivables", description: "Unpaid invoices, and how much of it is overdue", types: ["number", "donut", "pie"], fixed: true },
      payables: { label: "Total Payables", description: "Unpaid bills, and how much of it is overdue", types: ["number", "donut", "pie"], fixed: true },
    },
  },
  renewals: {
    label: "Renewals",
    href: "/renewals",
    openLabel: "Open Renewals",
    filters: [],
    metrics: {
      due: { label: "Renewals Due", description: "Expiring in the next 30 days, and already expired", types: ["number", "donut", "pie"], fixed: true },
      upcoming: { label: "Upcoming Renewals", description: "The next renewals to expire, in 30 days", types: ["table"], fixed: true },
    },
  },
  support: {
    label: "Support",
    href: "/tickets",
    openLabel: "Open Tickets",
    filters: [],
    metrics: {
      open: { label: "Open Tickets", description: "Tickets still open, and how many are overdue", types: ["number", "donut", "pie"], fixed: true },
    },
  },
  projects: {
    label: "Projects",
    href: "/projects",
    openLabel: "Open Projects",
    filters: [],
    metrics: {
      attention: { label: "Projects Needing Attention", description: "Your live projects at risk or off track", types: ["number", "donut", "pie"], fixed: true },
      mine: { label: "My Projects", description: "Live projects you're on, with progress", types: ["table"], fixed: true },
    },
  },
  expenses: {
    label: "Expenses",
    href: "/expenses",
    openLabel: "Open Expenses",
    filters: [],
    metrics: {
      awaiting: { label: "Expenses Awaiting You", description: "Claims waiting on your decision", types: ["number"], fixed: true },
    },
  },
  vendors: {
    label: "Vendors",
    href: "/vendors",
    openLabel: "Open Vendors",
    filters: [],
    metrics: {
      status: { label: "Vendors by Status", description: "Onboarding, active and inactive", types: ["donut", "pie", "hbar", "bar"], fixed: true },
      onboarding: { label: "Vendors Onboarding", description: "Vendors still being onboarded", types: ["number"], fixed: true },
    },
  },
};
export const SOURCE_ORDER = Object.keys(SOURCES) as SourceKey[];
export const isSourceKey = (v: unknown): v is SourceKey => typeof v === "string" && v in SOURCES;

/** What the dashboard opens with for somebody who has never arranged it, before what they may see narrows it. */
export const DEFAULT_CHARTS: ChartSpec[] = [
  chart("d1", "tasks", "completion", "bar"),
  chart("d2", "leads", "status", "donut"),
  chart("d3", "attendance", "overview", "area"),
  chart("d4", "tasks", "priority", "hbar"),
  chart("d5", "team", "performance", "bar"),
  chart("d6", "activity", "recent", "list"),
  // Your own, not everybody's you may see: a manager's next five would otherwise be their team's.
  { ...chart("d7", "tasks", "upcoming", "list"), filters: { whose: "me" } },
  chart("d8", "leads", "source", "donut"),
  chart("d9", "leads", "recent", "table"),
];

/**
 * The older cards the design's own charts and headline figures already show — "My open tasks" and "Latest
 * activity" twice over is two of the same — so a layout that still names them gets nothing more for them.
 */
export const SUPERSEDED_CARDS = new Set(["tasks", "leads", "recentLeads", "activity"]);

function chart(id: string, source: SourceKey, metric: string, type: ChartType, size: WidgetSize = 1): ChartSpec {
  return { id, source, metric, type, size, range: "inherit", filters: {}, title: "" };
}

/**
 * The widget that stands in for each older card (owner, 23 Oct 2026: the dashboard all charts and numbers,
 * the old cards gone). Sticky notes has none — a note isn't a figure — and stays on the Notes page.
 */
export const CARD_WIDGETS: Record<string, ChartSpec> = {
  companies: chart("c-companies", "customers", "funnel", "hbar"),
  customers: chart("c-customers", "customers", "customers", "number"),
  quotations: chart("c-quotations", "quotations", "pending", "number"),
  orders: chart("c-orders", "orders", "action", "number"),
  salesTarget: chart("c-salesTarget", "targets", "monthly", "number"),
  payments: chart("c-payments", "payments", "outstanding", "number"),
  incomeExpense: chart("c-incomeExpense", "finance", "incomeExpense", "bar", 2),
  topExpenses: chart("c-topExpenses", "finance", "topExpenses", "hbar"),
  cashFlow: chart("c-cashFlow", "finance", "cashFlow", "area", 2),
  receivables: chart("c-receivables", "finance", "receivables", "number"),
  payables: chart("c-payables", "finance", "payables", "number"),
  renewals: chart("c-renewals", "renewals", "due", "number"),
  upcomingRenewals: chart("c-upcomingRenewals", "renewals", "upcoming", "table", 2),
  tickets: chart("c-tickets", "support", "open", "number"),
  projectsAtRisk: chart("c-projectsAtRisk", "projects", "attention", "number"),
  myProjects: chart("c-myProjects", "projects", "mine", "table", 2),
  expenses: chart("c-expenses", "expenses", "awaiting", "number"),
  vendors: chart("c-vendors", "vendors", "status", "donut"),
};

/** Two widgets showing the same figures — whatever they're titled, however they're drawn. */
const sameFigures = (a: ChartSpec, b: ChartSpec) => a.source === b.source && a.metric === b.metric && JSON.stringify(a.filters) === JSON.stringify(b.filters);

/**
 * A layout as widgets only: every card key read as the widget that stands in for it, in its place, and a
 * card whose figures are already on it (or that has no widget) dropped. Charts are kept as they are.
 */
export function asWidgets(entries: readonly string[]): string[] {
  const out: string[] = [];
  const kept: ChartSpec[] = [];
  for (const entry of entries) {
    if (entry === LAYOUT_MARKER) {
      if (!out.includes(entry)) out.unshift(entry);
      continue;
    }
    const spec = isChartEntry(entry) ? decodeChart(entry) : SUPERSEDED_CARDS.has(entry) ? null : (CARD_WIDGETS[entry] ?? null);
    if (!spec) continue;
    if (!isChartEntry(entry) && kept.some((k) => sameFigures(k, spec))) continue;
    kept.push(spec);
    out.push(isChartEntry(entry) ? entry : encodeChart(spec));
  }
  return out;
}

// ─── Kept as strings ─────────────────────────────────────────────────────────

export const LAYOUT_MARKER = "layout:2";
const PREFIX = "chart:";

export const isChartEntry = (entry: string) => entry.startsWith(PREFIX);

export function encodeChart(spec: ChartSpec): string {
  const q = new URLSearchParams({ id: spec.id, s: spec.source, m: spec.metric, t: spec.type, z: String(spec.size), r: spec.range });
  if (spec.title) q.set("title", spec.title);
  for (const [k, v] of Object.entries(spec.filters)) if (v && v !== "all") q.set(`f.${k}`, v);
  return PREFIX + q.toString();
}

/**
 * A kept entry back as a chart, or null for anything that isn't a chart this dashboard can draw — a
 * metric since removed, a type the metric no longer takes. Never throws: this reads what was saved.
 */
export function decodeChart(entry: string): ChartSpec | null {
  if (!isChartEntry(entry)) return null;
  const q = new URLSearchParams(entry.slice(PREFIX.length));
  return validChart({
    id: q.get("id"),
    source: q.get("s"),
    metric: q.get("m"),
    type: q.get("t"),
    // A layout kept before there was XS may have no z at all; that is a small widget, not an XS one.
    size: Number(q.get("z") || 1),
    range: q.get("r"),
    title: q.get("title") ?? "",
    filters: Object.fromEntries([...q.entries()].filter(([k]) => k.startsWith("f.")).map(([k, v]) => [k.slice(2), v])),
  });
}

/** A chart as it may be kept — anything a browser sent, checked field by field. */
export function validChart(input: unknown): ChartSpec | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.id !== "string" || !/^[\w-]{1,40}$/.test(o.id)) return null;
  if (!isSourceKey(o.source)) return null;
  const source = SOURCES[o.source];
  if (typeof o.metric !== "string" || !Object.hasOwn(source.metrics, o.metric)) return null;
  const metric = source.metrics[o.metric]!;
  const type = metric.types.includes(o.type as ChartType) ? (o.type as ChartType) : metric.types[0]!;
  const size = ([0, 1, 2, 3] as const).find((n) => n === o.size) ?? 1;
  const range = o.range === "inherit" || isRangeKey(o.range) ? (o.range as ChartSpec["range"]) : "inherit";
  const title = typeof o.title === "string" ? o.title.trim().slice(0, 80) : "";
  const filters: Record<string, string> = {};
  if (o.filters && typeof o.filters === "object") {
    for (const f of source.filters) {
      const v = (o.filters as Record<string, unknown>)[f.key];
      // Department ids are the workspace's; their shape is all that can be checked here.
      if (typeof v === "string" && v !== "all" && /^[\w-]{1,40}$/.test(v)) filters[f.key] = v;
    }
  }
  return { id: o.id, source: o.source, metric: o.metric, type, size, range, filters, title };
}

// ─── The figures, as the server hands them over ──────────────────────────────

/** A series over time. `keys` are days (`yyyy-mm-dd`) or, for the year, months (`yyyy-mm`). */
export type SeriesData = {
  kind: "series";
  grain: "day" | "month";
  keys: string[];
  /** Whether a week's figure is the days added up, or their average — headcount is the second. */
  combine: "sum" | "avg";
  /** Drawn stacked when shown as columns. */
  stacked: boolean;
  series: { name: string; values: number[] }[];
  /** Rupees rather than a count — drawn short (₹2.6 Cr) on the chart. */
  money?: boolean;
};
export type CategoryData = {
  kind: "category";
  items: { label: string; value: number }[];
  /** Rupees rather than a count — drawn short (₹2.6 Cr) on the chart. */
  money?: boolean;
  /** The figure as a Number widget shows it, for a metric that is both a number and a split of it. */
  headline?: { value: string; delta: string | null; tone: Tone; exact?: string };
};
export type NumberData = {
  kind: "number";
  value: string;
  delta: string | null;
  tone: Tone;
  /** The exact figure, where `value` is shortened (₹7.03 Cr) — shown on hover. */
  exact?: string;
};
/** A short table — renewals coming up, projects — each row opening its record. */
export type RowsData = {
  kind: "rows";
  columns: { label: string; align?: "right" }[];
  rows: { id: string; href: string | null; cells: string[] }[];
  /** Which column is a status, drawn as a pill. */
  pill?: number;
  empty: string;
};
export type TaskListData = {
  kind: "tasks";
  items: { id: string; title: string; priority: string | null; due: string | null; dueSoon: boolean; done: boolean }[];
};
export type ActivityListData = {
  kind: "activity";
  items: { id: string; icon: ActivityIcon; title: string; sub: string; time: string }[];
  ownOnly: boolean;
};
export type LeadTableData = {
  kind: "leads";
  rows: { id: string; href: string; name: string; company: string; status: string; owner: string; date: string }[];
};
export type TeamData = { kind: "team"; rows: { name: string; initials: string; done: number; onTime: number }[] };
export type ChartData = SeriesData | CategoryData | NumberData | TaskListData | ActivityListData | LeadTableData | TeamData | RowsData;

/**
 * The workspace's money, short: ₹2.61 Cr, ₹58.6 L, ₹97.1k, ₹640 — the way the older finance cards read
 * big sums. AED 2.61 M, AED 97.1k where it is kept in dirhams.
 */
export function shortRupees(value: number, digits = 2): string {
  const sign = value < 0 ? "−" : "";
  const v = Math.abs(value);
  const prefix = basePrefix();
  const trim = (n: number, d: number) => n.toFixed(d).replace(/\.?0+$/, "");
  for (const unit of bigUnits()) {
    if (v >= unit.size) return `${sign}${prefix}${trim(v / unit.size, digits)} ${unit.short}`;
  }
  if (v >= 1e3) return `${sign}${prefix}${trim(v / 1e3, 1)}k`;
  return `${sign}${prefix}${Math.round(v).toLocaleString(baseLocale())}`;
}

export type Tone = "up" | "down" | "warn" | "flat";
export type ActivityIcon = "sign-in" | "read" | "security" | "device" | "other";

/** What a widget is drawn from: its figures, or why there are none. */
export type WidgetResult = { ok: true; data: ChartData; subtitle: string } | { ok: false; error: string };

export type KpiCard = {
  key: string;
  label: string;
  icon: "tasks" | "leads" | "attendance" | "approvals";
  value: string;
  delta: string;
  tone: Tone;
  href: string;
  spark: number[];
};

/** The data sources this person may chart, with the workspace's own filter choices filled in. */
export type ChartCatalog = {
  sources: SourceKey[];
  filters: Partial<Record<SourceKey, FilterDef[]>>;
};

/**
 * What a chart's figures depend on — never its type, title or width, so switching a column chart to a
 * line redraws what is already in hand instead of asking the server again.
 */
export function resultKey(spec: ChartSpec, dashboardRange: RangeKey): string {
  const filters = Object.entries(spec.filters).filter(([, v]) => v && v !== "all").sort();
  // A figure the range doesn't move is the same whatever the range: kept, not asked for again.
  if (SOURCES[spec.source].metrics[spec.metric]?.fixed) return JSON.stringify([spec.source, spec.metric, "fixed", filters]);
  return JSON.stringify([spec.source, spec.metric, spec.range === "inherit" ? dashboardRange : spec.range, filters, spec.range === "inherit"]);
}

/** The days a week is drawn from, for a range of daily figures shown as columns. */
export function weekly(data: SeriesData): SeriesData {
  if (data.grain !== "day") return data;
  const groups: number[][] = [];
  for (let i = 0; i < data.keys.length; i += 7) groups.push(Array.from({ length: Math.min(7, data.keys.length - i) }, (_, j) => i + j));
  const fold = (values: number[], g: number[]) => {
    const total = g.reduce((a, i) => a + values[i]!, 0);
    return data.combine === "avg" ? Math.round((total / g.length) * 10) / 10 : total;
  };
  return {
    ...data,
    keys: groups.map((g) => data.keys[g[0]!]!),
    series: data.series.map((s) => ({ ...s, values: groups.map((g) => fold(s.values, g)) })),
  };
}
