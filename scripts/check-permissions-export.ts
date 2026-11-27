/**
 * check:permissions-export — every assigned permission as a workbook, for the super admin only (owner, 2 Nov 2026 —
 * src/app/api/access/permissions-export/route.ts).
 *
 *   1. Refused (a 404) to nobody signed in, to an admin who isn't the super admin, and to anybody else.
 *   2. The super admin gets a workbook of four sheets: People, Who has what, Roles, Exceptions.
 *   3. It agrees with the resolver: each person's "Permissions held" and their "Yes" rows are exactly what
 *      permissionsFor gives; the Roles sheet has every permission and role; every exception is there.
 *   4. The export is in the audit log.
 *
 * Reads the dev workspace; removes the audit rows it made.
 *
 *   npm run check:permissions-export
 */
import "dotenv/config";
import Module from "node:module";
import ExcelJS from "exceljs";
import { directClient } from "../src/lib/tenancy/direct-client";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const pick = { id: true, role: true, name: true, email: true } as const;

async function main() {
  const { GET } = await import("../src/app/api/access/permissions-export/route");
  const { permissionsFor } = await import("../src/lib/authz/resolve");
  const { PERMISSIONS } = await import("../src/lib/permissions");
  const startedAt = new Date();

  section("1. Who may export");
  actor = null;
  ok("nobody signed in: not found", (await GET()).status === 404);
  const admin = await db.user.findFirst({ where: { role: "ADMIN", active: true, isSuperAdmin: false }, select: pick });
  if (admin) {
    actor = admin;
    ok("an admin who isn't the super admin: not found", (await GET()).status === 404, admin.name);
  }
  const staff = await db.user.findFirst({ where: { role: { not: "ADMIN" }, active: true, isSuperAdmin: false }, select: pick });
  if (staff) {
    actor = staff;
    ok("anybody else: not found", (await GET()).status === 404, staff.name);
  }

  section("2. The workbook");
  const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: pick });
  if (!superAdmin) throw new Error("No super admin to act as.");
  actor = superAdmin;
  const res = await GET();
  ok("the super admin gets an Excel file to save", res.status === 200 && /spreadsheetml/.test(res.headers.get("content-type") ?? "") && /attachment; filename="permissions-\d{4}-\d{2}-\d{2}\.xlsx"/.test(res.headers.get("content-disposition") ?? ""), res.headers.get("content-disposition"));
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await res.arrayBuffer());
  ok("four sheets: People, Who has what, Roles, Exceptions", book.worksheets.map((s) => s.name).join() === "People,Who has what,Roles,Exceptions", book.worksheets.map((s) => s.name));

  const rows = (name: string) => {
    const out: string[][] = [];
    book.getWorksheet(name)!.eachRow((row, n) => {
      if (n > 1) out.push((row.values as unknown[]).slice(1).map((v) => (v === null || v === undefined ? "" : String(v))));
    });
    return out;
  };

  section("3. It agrees with the resolver");
  // People, not the workspace's own Automation account — the app never lists it (src/lib/automation-user.ts).
  const people = await db.user.findMany({ where: { kind: { not: "AUTOMATION" } }, select: { id: true, email: true, name: true } });
  const summary = rows("People");
  ok("everybody listed once", summary.length === people.length, { sheet: summary.length, people: people.length });
  const detail = rows("Who has what");
  const wrong: string[] = [];
  for (const p of people) {
    const held = new Set(await permissionsFor(p.id));
    const line = summary.find((r) => r[1] === p.email && r[0] === p.name);
    const yes = new Set(detail.filter((r) => r[1] === p.email && r[0] === p.name && r[6] === "Yes").map((r) => r[5]));
    if (!line || Number(line[6]) !== held.size || yes.size !== held.size || [...held].some((k) => !yes.has(k))) wrong.push(`${p.name}: resolver ${held.size}, sheet ${line?.[6]}, rows ${yes.size}`);
  }
  ok("each person's count and rows are exactly what they hold", wrong.length === 0, wrong.slice(0, 3));
  ok("every row says how it was come by", detail.every((r) => r[7] && r[7] !== "Not held."));
  const noes = detail.filter((r) => r[6] === "No");
  ok("  a No is only ever a personal deny", noes.every((r) => r[7]!.startsWith("Denied to this person directly")), noes.slice(0, 2));
  const roles = rows("Roles");
  const header = (book.getWorksheet("Roles")!.getRow(1).values as unknown[]).slice(1).map(String);
  ok("the Roles sheet: every permission, against every role", roles.length === PERMISSIONS.length && header.includes("ADMIN") && header.length > 4, { rows: roles.length, permissions: PERMISSIONS.length, roles: header.slice(3) });
  const exceptions = await db.userPermission.count();
  ok("every exception listed", rows("Exceptions").length === exceptions, { sheet: rows("Exceptions").length, stored: exceptions });

  section("4. Recorded");
  const audit = await db.auditLog.findMany({ where: { entityType: "Permission", entityId: "all", userId: superAdmin.id, createdAt: { gte: startedAt } }, select: { id: true, entityLabel: true } });
  ok("the export is in the audit log, once", audit.length === 1 && audit[0]!.entityLabel.startsWith("Exported every assigned permission"), audit.map((a) => a.entityLabel));
  await db.auditLog.deleteMany({ where: { id: { in: audit.map((a) => a.id) } } });

  console.log(failures === 0 ? `\nAll ${passes} permissions export checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
