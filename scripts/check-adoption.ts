/**
 * check:adoption — the console's Adoption tab (owner, 23 Nov 2026: "can deskzo console admin see performance of every
 * workspace? user wise? module wise" — "Counts only"; src/lib/platform/adoption.ts, adoption-view.ts, adoption-areas.ts).
 *
 *   · Each day is counted from the workspace's own logs: people active (time on the app, a sign-in or a change),
 *     sign-ins, minutes and changes, and changes by area — a record kind's area, sales and purchase documents one.
 *   · Each person with a seat is numbered in the order their accounts were made, never named: last sign-in, last day
 *     active, days active, minutes and changes in 30 days. A switched-off account has no seat, so no row.
 *   · The first count goes back 90 days; the next starts from the last day counted.
 *   · The tab: active this week of the seats, idle seats, never signed in, week-on-week trend, and each module switched
 *     on as used, barely used, not used — or not counted, where none of its records are audited.
 *
 * People here are this suite's own (the local database is full — only they are counted); the control plane stands in,
 * in memory. Everything made is removed.
 *
 *   npm run check:adoption
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

const real = directClient();
const fixture: string[] = [];

// ── The control plane, in memory ──
type DayRow = { tenantId: string; day: Date; activeUsers: number; signIns: number; activeMinutes: number; changes: number; areas: unknown; modulesOn: string[]; recordedAt: Date };
type PersonRow = { tenantId: string; number: number; lastSignInAt: Date | null; lastActiveOn: Date | null; daysActive30: number; minutes30: number; changes30: number; areas30: unknown; recordedAt: Date };
const dayRows = new Map<string, DayRow>();
let personRows: PersonRow[] = [];
let upserts = 0;
const control = {
  tenant: { findUnique: async () => ({ timezone: "Asia/Kolkata" }) },
  tenantActivityDay: {
    findFirst: async ({ where }: { where: { tenantId: string } }) => [...dayRows.values()].filter((r) => r.tenantId === where.tenantId).sort((a, b) => b.day.getTime() - a.day.getTime())[0] ?? null,
    findMany: async ({ where }: { where: { tenantId: string; day: { gte: Date } } }) =>
      [...dayRows.values()].filter((r) => r.tenantId === where.tenantId && r.day >= where.day.gte).sort((a, b) => a.day.getTime() - b.day.getTime()),
    upsert: async ({ create, update }: { create: DayRow; update: Partial<DayRow> }) => {
      upserts++;
      const key = `${create.tenantId}|${create.day.toISOString()}`;
      dayRows.set(key, { ...(dayRows.get(key) ?? create), ...update });
    },
  },
  tenantPersonActivity: {
    findMany: async ({ where }: { where: { tenantId: string } }) => personRows.filter((r) => r.tenantId === where.tenantId).sort((a, b) => a.number - b.number),
    deleteMany: async ({ where }: { where: { tenantId: string } }) => void (personRows = personRows.filter((r) => r.tenantId !== where.tenantId)),
    createMany: async ({ data }: { data: PersonRow[] }) => void personRows.push(...data),
  },
  $transaction: async (run: (tx: unknown) => Promise<void>): Promise<void> => run(control),
};

const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  const from = String((parent as { filename?: string })?.filename ?? "");
  const ours = /adoption(-view)?\.ts$/.test(from);
  if (request === "@/lib/platform/control-db" && ours) return { controlDb: () => control };
  // The people counted are this suite's only.
  if (request === "@/lib/db" && ours) {
    return {
      db: new Proxy(real, {
        get(target, prop) {
          if (prop === "user") return { findMany: (args: { where: object }) => real.user.findMany({ ...args, where: { AND: [args.where, { id: { in: fixture } }] } }) };
          return Reflect.get(target, prop);
        },
      }),
    };
  }
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const DAY = 86_400_000;

async function main() {
  const { snapshotAdoption } = await import("../src/lib/platform/adoption");
  const view = await import("../src/lib/platform/adoption-view");
  const areas = await import("../src/lib/platform/adoption-areas");
  const { parseEntitlements } = await import("../src/lib/entitlements");
  const { clockFor } = await import("../src/lib/time/zone");

  section("1. Areas and the week's trend");
  ok("a lead's change is Leads'; a sales or purchase document one area; a setting setup's", areas.areaOf("Lead") === "leads" && areas.areaOf("TradeDocument") === "documents" && areas.areaOf("BrandingSettings") === "setup" && areas.areaOf("SomethingNew") === "setup");
  ok("  labels: the module's own, and the two of our own", areas.areaLabel("leads") === "Leads" && areas.areaLabel("documents") === "Sales & purchase documents" && areas.areaLabel("setup") === "Settings & setup");
  ok("  documents stand for both document modules; a module with no audited records isn't counted", areas.modulesOfArea("documents").join() === "sales_documents,purchase_documents" && !areas.moduleIsCounted("domains") && areas.moduleIsCounted("leads") && !areas.moduleIsCounted("chat") && !areas.moduleIsCounted("automate"));
  ok("  trend: up a fifth rising, down a fifth dropping, between steady, nobody quiet", view.trendOf(6, 5) === "rising" && view.trendOf(4, 5) === "dropping" && view.trendOf(5.5, 5) === "steady" && view.trendOf(0, 0) === "quiet" && view.trendOf(1, 0) === "rising");

  section("2. Counting a workspace");
  const role = (await real.role.findFirst({ select: { key: true }, orderBy: { key: "asc" } }))!.key;
  const run = Date.now().toString(36);
  const made = async (n: number, active: boolean, at: Date) => {
    const u = await real.user.create({ data: { name: `Zzprobe adoption ${n}`, email: `adoption-${n}-${run}@zzprobe-adoption.invalid`, role, passwordHash: "x".repeat(60), active, createdAt: at }, select: { id: true } });
    fixture.push(u.id);
    return u.id;
  };
  const now = new Date();
  const clock = clockFor("Asia/Kolkata");
  const today = clock.today(now);
  const dayKey = (n: number) => new Date(new Date(`${today}T00:00:00Z`).getTime() - n * DAY).toISOString().slice(0, 10);
  // Noon in India on a day n back: 06:30 UTC.
  const noon = (n: number) => new Date(`${dayKey(n)}T06:30:00Z`);
  const one = await made(1, true, new Date("2020-01-01T00:00:00Z"));
  await made(2, true, new Date("2020-01-02T00:00:00Z"));
  await made(3, false, new Date("2020-01-03T00:00:00Z"));

  const logins: string[] = [];
  const login = async (userId: string, at: Date) => logins.push((await real.activityLog.create({ data: { userId, kind: "LOGIN", summary: "Zzprobe signed in", createdAt: at }, select: { id: true } })).id);
  await login(one, noon(1));
  await login(one, noon(40));
  await real.userDailyActivity.create({ data: { userId: one, date: new Date(`${dayKey(1)}T00:00:00Z`), activeSeconds: 600, lastHeartbeatAt: noon(1) } });
  const audit = (userId: string, entityType: string, action: "CREATE" | "UPDATE" | "DELETE", at: Date) =>
    real.auditLog.create({ data: { userId, entityType, action, entityId: `zz-${run}`, entityLabel: "Zzprobe", createdAt: at } });
  await audit(one, "Lead", "CREATE", noon(1));
  await audit(one, "Lead", "CREATE", noon(1));
  await audit(one, "TradeDocument", "UPDATE", noon(1));
  await audit(one, "Company", "DELETE", noon(3));
  // Just before midnight in India, yesterday — still yesterday on the workspace's clock, though UTC's day is the same.
  await audit(one, "Item", "UPDATE", new Date(`${dayKey(1)}T18:20:00Z`));

  const tenant = { id: `zz-adoption-${run}`, slug: "zz-adoption", name: "Zz", status: "ACTIVE", country: "IN", timezone: "Asia/Kolkata", entitlements: parseEntitlements({ v: 1, all: true, modules: [], seats: null, copilotTokens: null }) } as unknown as import("../src/lib/tenancy/state").Tenant;
  const first = await snapshotAdoption(tenant, now);
  ok("the first count goes back 90 days, to yesterday", first.days === 90 && dayRows.size === 90, first);
  const y = [...dayRows.values()].find((r) => r.day.toISOString().startsWith(dayKey(1)))!;
  ok("  yesterday: one person active, one sign-in, ten minutes, four changes", y.activeUsers === 1 && y.signIns === 1 && y.activeMinutes === 10 && y.changes === 4, y);
  const ya = y.areas as Record<string, { created: number; changed: number; removed: number; people: number }>;
  ok("  by area: two leads added, a document edited, an item edited late in India's evening", ya.leads?.created === 2 && ya.leads.people === 1 && ya.documents?.changed === 1 && ya.items?.changed === 1, ya);
  const d3 = [...dayRows.values()].find((r) => r.day.toISOString().startsWith(dayKey(3)))!;
  ok("  three days back: a company removed", (d3.areas as Record<string, { removed: number }>).companies?.removed === 1 && d3.activeUsers === 1, d3);
  ok("  a day with nothing is still a day, of noughts", [...dayRows.values()].some((r) => r.activeUsers === 0 && r.changes === 0));
  ok("  every day carries the modules switched on", y.modulesOn.includes("leads"), y.modulesOn.length);

  ok("people with a seat: two, numbered in the order they were made; the one switched off has none", personRows.length === 2 && personRows[0]!.number === 1 && personRows[1]!.number === 2, personRows.map((p) => p.number));
  const p1 = personRows[0]!;
  ok("  person 1: signed in yesterday, active yesterday, 2 days of 30, ten minutes, five changes", p1.lastSignInAt?.getTime() === noon(1).getTime() && p1.lastActiveOn?.toISOString().startsWith(dayKey(1)) && p1.daysActive30 === 2 && p1.minutes30 === 10 && p1.changes30 === 5, p1);
  const a30 = p1.areas30 as Record<string, number>;
  ok("  their areas over 30 days", Object.keys(a30).length === 4 && a30.leads === 2 && a30.documents === 1 && a30.items === 1 && a30.companies === 1, a30);
  const p2 = personRows[1]!;
  ok("  person 2: never signed in, nothing", p2.lastSignInAt === null && p2.lastActiveOn === null && p2.daysActive30 === 0 && p2.changes30 === 0, p2);
  ok("  nobody's name or address is kept", !JSON.stringify(personRows).includes("Zzprobe") && !JSON.stringify(personRows).includes("@"));

  upserts = 0;
  const again = await snapshotAdoption(tenant, now);
  ok("the next count starts from the last day counted", again.days === 1 && upserts === 1 && dayRows.size === 90, again);

  section("3. The tab");
  const panel = await view.workspaceAdoption(tenant.id, now);
  ok("seats, active this week and in 30 days, never signed in", panel.seats === 2 && panel.active7 === 1 && panel.active30 === 1 && panel.neverActive === 1, { seats: panel.seats, a7: panel.active7, a30: panel.active30, never: panel.neverActive });
  ok("  90 days in order, on the workspace's clock", panel.days.length === 90 && panel.days.at(-1)!.day === dayKey(1) && panel.today === today);
  ok("  the week: one person on two days of seven — rising from none", Math.abs(panel.lastWeek - 2 / 7) < 1e-9 && panel.weekBefore === 0 && panel.trend === "rising", { lastWeek: panel.lastWeek, trend: panel.trend });
  const mod = (key: string) => panel.modules.find((m) => m.key === key);
  ok("  Leads barely used (two changes, one person); IT Assets not used; Domain Intel not counted", mod("leads")?.state === "light" && mod("leads")?.changes === 2 && mod("it_assets")?.state === "unused" && mod("domains")?.state === "uncounted" && mod("domains")?.changes === null, [mod("leads"), mod("it_assets"), mod("domains")]);
  ok("  a document's change shows on both document modules", mod("sales_documents")?.changes === 1 && mod("purchase_documents")?.changes === 1);
  ok("  areas, busiest first, with the people in them", panel.areas[0]?.area === "leads" && panel.areas[0].created === 2 && panel.areas[0].people === 1, panel.areas.slice(0, 2));
  ok("  person 1's busiest areas", panel.people[0]?.top[0]?.label === "Leads" && panel.people[0].top[0].changes === 2, panel.people[0]?.top);

  const list = await (async () => {
    const shared = Object.assign(control, {
      tenantPersonActivity: {
        ...control.tenantPersonActivity,
        groupBy: async ({ where }: { where: { tenantId: { in: string[] }; lastActiveOn?: { gte: Date } } }) => {
          const rows = personRows.filter((r) => where.tenantId.in.includes(r.tenantId) && (!where.lastActiveOn || (r.lastActiveOn && r.lastActiveOn >= where.lastActiveOn.gte)));
          const by = new Map<string, number>();
          for (const r of rows) by.set(r.tenantId, (by.get(r.tenantId) ?? 0) + 1);
          return [...by].map(([tenantId, n]) => ({ tenantId, _count: { _all: n } }));
        },
      },
    });
    void shared;
    return view.activeThisWeek([tenant.id, "zz-none"], now);
  })();
  ok("the Workspaces list: active this week of the seats; a workspace not counted yet has none", list.get(tenant.id)?.active7 === 1 && list.get(tenant.id)?.seats === 2 && !list.has("zz-none"), [...list]);

  await real.activityLog.deleteMany({ where: { id: { in: logins } } });
}

main()
  .catch((err) => {
    failures += 1;
    console.error(err);
  })
  .finally(async () => {
    // Their heartbeats and audit rows go with them.
    await real.activityLog.deleteMany({ where: { userId: { in: fixture } } }).catch(() => {});
    await real.user.deleteMany({ where: { id: { in: fixture } } }).catch((err) => console.error("cleanup", err));
    await real.$disconnect();
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
