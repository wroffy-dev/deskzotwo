/**
 * check:attendance-print — a month's attendance on paper (owner, 26 Nov 2026: "option for HR to print the attendance
 * of whole month of all employees or employee wise"; src/app/(print)/people/attendance/print).
 *
 *   1. The codes: what each day prints as, recorded or not.
 *   2. Everybody on one sheet: a row each, a column a day, the month's totals.
 *   3. A page each: day by day, with a line to sign.
 *   4. Who may print: "Print attendance" — HR's, an admin's and the super admin's; anybody else gets no page.
 *
 * Reads the local workspace and writes nothing. The rendered pages are left in the system temp folder to look at.
 *
 *   npm run check:attendance-print
 */
import "dotenv/config";
import Module from "node:module";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, type ReactElement, type ReactNode } from "react";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

type Actor = { id: string; name: string; email: string; role: string; isSuperAdmin?: boolean };
let actor: Actor | null = null;
const who = async () => {
  if (!actor) throw new Error("The check called an action without saying who was calling it.");
  return actor;
};
const session = { requireUser: who, currentUser: async () => actor, requireModuleUser: who, requireModuleAccess: who, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
class NotFound extends Error {}
const navigation = {
  useRouter: () => ({ push: () => {}, refresh: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  notFound: () => {
    throw new NotFound("not found");
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const react = { ...(load("react") as object), cache: <T,>(fn: T) => fn };
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["react", react],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("react"), react],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

/** Awaits the async components in a tree, so renderToStaticMarkup sees plain elements. */
async function settle(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(settle));
  if (!node || typeof node !== "object" || !("type" in node)) return node;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return settle(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props));
  if (el.props?.children === undefined) return el;
  return { ...el, props: { ...el.props, children: await settle(el.props.children) } } as ReactElement;
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { printCode, printDayWords } = require("../src/lib/hr/attendance-print") as typeof import("../src/lib/hr/attendance-print");
  const Page = (require("../src/app/(print)/people/attendance/print/page") as typeof import("../src/app/(print)/people/attendance/print/page")).default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  try {
    section("1. What a day prints as");
    const day = (status: string | null, offDay: "week off" | "holiday" | null = null, future = false) => ({ status, offDay, future }) as Parameters<typeof printCode>[0];
    ok("present, absent, leave, half day, from home", ["PRESENT", "ABSENT", "ON_LEAVE", "HALF_DAY", "WORK_FROM_HOME"].map((s) => printCode(day(s)).code).join(" ") === "P A L ½ WFH");
    ok("  a week off or a holiday nobody recorded", printCode(day(null, "week off")).code === "WO" && printCode(day(null, "holiday")).code === "H");
    ok("  a holiday somebody worked says they worked", printCode(day("PRESENT", "holiday")).code === "P");
    ok("  a working day gone by with nothing: not recorded, not absent", printCode(day(null)).code === "–" && printDayWords(day(null)) === "Not recorded");
    ok("  a day still to come: blank", printCode(day(null, null, true)).code === "" && printDayWords(day(null, null, true)) === "");

    const hr = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true, role: true } });
    if (!hr) throw new Error("No super admin in this workspace.");
    actor = { ...hr, isSuperAdmin: true };
    const render = async (query: Record<string, string>) => renderToStaticMarkup(createElement("div", null, await settle(await Page({ searchParams: Promise.resolve(query) }))));
    const anyone = await db.attendanceDay.findFirst({ orderBy: { date: "desc" }, select: { date: true } });
    const at = anyone?.date ?? new Date();
    const month = String(at.getUTCMonth() + 1);
    const year = String(at.getUTCFullYear());
    const active = await db.user.count({ where: { active: true, kind: "MEMBER" } });

    section(`2. Everybody on one sheet (${month}/${year})`);
    const sheet = await render({ month, year, layout: "sheet" });
    writeFileSync(join(tmpdir(), "attendance-sheet.html"), sheet);
    const rows = (sheet.match(/<tr>/g) ?? []).length;
    ok("a row for each active person", rows >= 1 && rows <= active, `${rows} rows, ${active} active`);
    ok("  turned sideways", sheet.includes("A4 landscape"));
    ok("  the month's totals and the key", sheet.includes(">NR<") && sheet.includes("Not recorded") && sheet.includes("Working days"));
    ok("  days that are recorded show their mark", /<td class="[^"]*">P(<sup|<\/td>)/.test(sheet));

    section("3. A page each");
    const each = await render({ month, year, layout: "each" });
    writeFileSync(join(tmpdir(), "attendance-each.html"), each);
    const pages = (each.match(/class="person-page/g) ?? []).length;
    ok("a page for each of the same people", pages === rows, `${pages} pages`);
    ok("  each to sign", (each.match(/Employee&#x27;s signature/g) ?? []).length === pages);
    ok("  starting on a page of its own", each.includes("break-after: page"));
    const person = await db.attendanceDay.findFirst({ where: { date: at, user: { active: true } }, select: { user: { select: { id: true, name: true } } } });
    if (person) {
      const solo = await render({ month, year, layout: "each", userId: person.user.id });
      ok("  one person, when the screen was filtered to them", (solo.match(/class="person-page/g) ?? []).length === 1 && solo.includes(person.user.name.replace(/'/g, "&#x27;")), person.user.name);
    }

    section("4. Who may print");
    const nobody = await db.user.findMany({ where: { active: true, kind: "MEMBER", isSuperAdmin: false }, select: { id: true, name: true, email: true, role: true }, take: 60 });
    let refused: (typeof nobody)[number] | null = null;
    const { heldByDefaultKey } = await import("../src/lib/permissions");
    ok("HR, HR head and management hold it by default", ["HR", "HR_HEAD", "MANAGEMENT"].every((r) => heldByDefaultKey("hr.printAttendance", r)) && !heldByDefaultKey("hr.printAttendance", "SALES"));
    const admin = await db.user.findFirst({ where: { active: true, role: "ADMIN", isSuperAdmin: false }, select: { id: true } });
    if (admin) ok("  an admin holds it", await can(admin.id, "hr.printAttendance"));
    ok("  the super admin holds it", await can(hr.id, "hr.printAttendance"));
    for (const u of nobody) if (!(await can(u.id, "hr.printAttendance"))) {
      refused = u;
      break;
    }
    if (refused) {
      actor = refused;
      let answer = "rendered";
      try {
        await render({ month, year, layout: "sheet" });
      } catch (err) {
        answer = err instanceof NotFound ? "not found" : String(err);
      }
      ok("somebody without it gets no page", answer === "not found", `${refused.name}: ${answer}`);
    } else ok("somebody without it gets no page", false, "nobody in this workspace lacks it");
  } finally {
    actor = null;
    await db.$disconnect();
  }
  console.log(`\nThe pages: ${join(tmpdir(), "attendance-sheet.html")} and attendance-each.html beside it.`);
  console.log(failures ? `\n${failures} of ${failures + passes} attendance-print checks FAILED.` : `\nAll ${passes} attendance-print checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
