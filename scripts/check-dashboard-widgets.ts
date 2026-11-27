/**
 * check:dashboard-widgets — the dashboard as the design and nothing else (owner, 23 Oct 2026: "the whole
 * dashboard the same, everything as charts and numbers; remove the old UI").
 *
 *   · Every older card is either a widget of its own now (CARD_WIDGETS), already shown by the design's own
 *     charts (SUPERSEDED_CARDS), or Sticky notes, which isn't a figure — none is left over.
 *   · A layout naming cards — saved before charts, a role's defaults, a department's layout — reads as
 *     widgets: each card's widget in its place, notes and the superseded ones dropped, nothing twice.
 *   · Every widget a card became is a chart the dashboard can draw and keep, has figures read for it, an
 *     icon, and no date range it would ignore; rupees read short (₹2.61 Cr).
 *   · The page and the board have no card left in them.
 *
 * Pure — no database.
 *
 *   npm run check:dashboard-widgets
 */
import { formatMetric as formatReportMetric, formatTick } from "../src/components/reporting/format";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CARD_WIDGETS,
  DEFAULT_CHARTS,
  LAYOUT_MARKER,
  SOURCES,
  SOURCE_ORDER,
  SUPERSEDED_CARDS,
  asWidgets,
  againstWords,
  customRange,
  isRangeKey,
  rangeEnd,
  rangeLabel,
  rangeStart,
  decodeChart,
  encodeChart,
  resultKey,
  shortRupees,
} from "../src/lib/dashboard/charts";
import { DASHBOARD_WIDGET_REGISTRY } from "../src/lib/dashboard-widgets";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const metricsOf = (entries: string[]) => entries.filter((e) => e !== LAYOUT_MARKER).map((e) => { const s = decodeChart(e); return s ? `${s.source}.${s.metric}` : `card:${e}`; });

section("Every older card has a home");
{
  const unplaced = DASHBOARD_WIDGET_REGISTRY.map((w) => w.key).filter((k) => !(k in CARD_WIDGETS) && !SUPERSEDED_CARDS.has(k) && k !== "notes");
  ok("each card is a widget, already a design chart, or Sticky notes", unplaced.length === 0, unplaced.join(","));
  ok("…and no widget stands in for a card that doesn't exist", Object.keys(CARD_WIDGETS).every((k) => DASHBOARD_WIDGET_REGISTRY.some((w) => w.key === k)));
  for (const [key, spec] of Object.entries(CARD_WIDGETS)) {
    const back = decodeChart(encodeChart(spec));
    const metric = SOURCES[spec.source].metrics[spec.metric];
    ok(`${key} → ${spec.source}.${spec.metric} (${spec.type}) is a widget the dashboard keeps as it is`, !!metric && JSON.stringify(back) === JSON.stringify(spec), back);
  }
}

section("A layout naming cards reads as widgets");
{
  const design = DEFAULT_CHARTS.map(encodeChart);
  const oldSaved = asWidgets([LAYOUT_MARKER, ...design, "notes", "renewals", "incomeExpense", "tickets", "tasks", "recentLeads"]);
  ok("cards after the design's charts become their widgets, in order", metricsOf(oldSaved).slice(9).join("|") === "renewals.due|finance.incomeExpense|support.open", metricsOf(oldSaved).slice(9));
  ok("…Sticky notes and the cards the design already shows are dropped", oldSaved.length === 1 + 9 + 3);
  ok("…the marker first, once", oldSaved[0] === LAYOUT_MARKER && oldSaved.filter((e) => e === LAYOUT_MARKER).length === 1);
  const inPlace = asWidgets([LAYOUT_MARKER, "tickets", design[1]!, "notes", "payments"]);
  ok("a card between charts is replaced where it stands", metricsOf(inPlace).join("|") === "support.open|leads.status|payments.outstanding", metricsOf(inPlace));
  const twice = asWidgets([LAYOUT_MARKER, encodeChart({ ...CARD_WIDGETS.tickets!, id: "mine", type: "donut" }), "tickets"]);
  ok("a card whose figures are already on the board isn't added twice", metricsOf(twice).join("|") === "support.open", metricsOf(twice));
  ok("charts are kept exactly as saved", asWidgets([LAYOUT_MARKER, design[0]!])[1] === design[0]);
  ok("no card key survives", !asWidgets(["notes", "tasks", "leads", "renewals", "orders"]).some((e) => !e.startsWith("chart:")));
}

section("The widgets the cards became");
{
  const data = read("src/lib/dashboard/data.ts");
  const board = read("src/components/dashboard/dashboard-board.tsx");
  for (const source of SOURCE_ORDER) {
    ok(`${source} has an icon on the board`, new RegExp(`\\b${source}: [A-Z]\\w+,`).test(board));
    for (const metric of Object.keys(SOURCES[source].metrics)) {
      ok(`  ${source}.${metric} has figures read for it`, data.includes(`case "${source}.${metric}"`));
    }
  }
  const newer = SOURCE_ORDER.slice(SOURCE_ORDER.indexOf("customers"));
  ok("every source a card became is open only where its card was", newer.every((s) => new RegExp(`\\n  ${s}: "\\w+",`).test(data)), newer);
  ok("none of their figures follows the dashboard's range (no range to pick)", newer.every((s) => Object.values(SOURCES[s].metrics).every((m) => m.fixed)));
  const spec = CARD_WIDGETS.tickets!;
  ok("…so a range change keeps them, not asks again", resultKey(spec, "7d") === resultKey(spec, "ytd"));
  ok("a ranged chart is still asked for per range", resultKey(DEFAULT_CHARTS[0]!, "7d") !== resultKey(DEFAULT_CHARTS[0]!, "ytd"));
  ok("the builder offers no range for them", board.includes("{!metric.fixed && ("));
}

section("Days of one's own choosing (owner, 9 Nov 2026)");
{
  const today = "2026-11-09";
  ok("a chosen range is read", JSON.stringify(customRange("2026-10-01_2026-10-31")) === JSON.stringify({ from: "2026-10-01", to: "2026-10-31", days: 31 }));
  ok("  it starts and ends where chosen, not today", rangeStart(today, "2026-10-01_2026-10-31") === "2026-10-01" && rangeEnd(today, "2026-10-01_2026-10-31") === "2026-10-31");
  ok("  a preset still ends today", rangeEnd(today, "30d") === today && rangeStart(today, "7d") === "2026-11-03");
  ok("  one day is a range", customRange("2026-11-03_2026-11-03")?.days === 1 && rangeLabel("2026-11-03_2026-11-03") === "3 Nov 2026");
  ok("its words: one year once, two when it crosses one", rangeLabel("2026-10-01_2026-11-09") === "1 Oct – 9 Nov 2026" && rangeLabel("2025-12-20_2026-01-05") === "20 Dec 2025 – 5 Jan 2026");
  ok("a change is against as many days before", againstWords("2026-10-01_2026-10-31") === "vs prev. 31 days" && againstWords("30d") === "vs prev. 30 days");
  ok("refused: backwards, a day that isn't, a made-up word, longer than two years", [
    "2026-11-09_2026-10-01", "2026-02-30_2026-03-01", "2026-13-01_2026-12-31", "2026-00-10_2026-01-10", "2026-10-01", "2026-10-01_2026-10-02_x", "abc_def", "2023-01-01_2026-01-01",
  ].every((bad) => !isRangeKey(bad) && customRange(bad) === null));
  ok("the presets are range keys still", ["7d", "30d", "90d", "qtd", "ytd"].every(isRangeKey));
  const board = read("src/components/dashboard/dashboard-board.tsx");
  ok("the picker offers it, and opens the board on it", board.includes("Custom range") && /router\.push\(`\/dashboard\?range=\$\{key\}`/.test(board));
}

section("Rupees, short");
for (const [v, want] of [[26100000, "₹2.61 Cr"], [10000000, "₹1 Cr"], [5859000, "₹58.59 L"], [97100, "₹97.1k"], [640, "₹640"], [-38900000, "−₹3.89 Cr"], [0, "₹0"]] as const) {
  ok(`${v} → ${want}`, shortRupees(v) === want, shortRupees(v));
}
// Off the axis, the whole figure, as the books say it (owner, 12 Nov 2026: "like Zoho, not 5.08 Cr").
ok("a report figure is in full, to the paisa", formatReportMetric(50800808.18, "currency") === "₹5,08,00,808.18" && formatReportMetric(68, "currency") === "₹68.00", formatReportMetric(50800808.18, "currency"));
ok("  short only where asked, and on an axis", formatReportMetric(50800808.18, "currency", { short: true }) === "₹5.08 Cr" && formatTick(50800808.18, "currency") === "₹5.1Cr", formatTick(50800808.18, "currency"));

section("XS — a headline card's width");
{
  const xs = { ...DEFAULT_CHARTS[0]!, size: 0 as const };
  ok("an XS widget is kept as XS", decodeChart(encodeChart(xs))?.size === 0);
  const noSize = encodeChart(DEFAULT_CHARTS[0]!).replace(/&?z=\d/, "");
  ok("…and one kept with no size is small, not XS", decodeChart(noSize)?.size === 1, noSize);
}

section("No card left in the page or the board");
{
  const page = read("src/app/(dashboard)/dashboard/page.tsx");
  const board = read("src/components/dashboard/dashboard-board.tsx");
  ok("the page renders no older card", !/cardsFor|StatCard|ListCard|TargetCard|IncomeExpenseCard|getDashboardSummary/.test(page));
  ok("the board has no card items or 'Other cards'", !/cardNodes|addableCards|Other cards|CardOption/.test(board));
  ok("saving keeps widgets only", /export async function saveDashboardLayout[\s\S]*?!isChartEntry\(entry\)\) continue/.test(read("src/actions/dashboard.ts")));
  ok("a department's layout names widgets", read("src/components/settings/departments-manager.tsx").includes("CARD_WIDGETS") && read("src/actions/department.ts").includes("Object.keys(CARD_WIDGETS)"));
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
