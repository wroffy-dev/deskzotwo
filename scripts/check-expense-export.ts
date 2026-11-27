/**
 * check:expense-export — the Expenses page's Excel download (owner, 18 Nov 2026: "expense export in xls on expense page -
 * permission based"; src/actions/expense.ts exportExpenses):
 *
 *   · refused without `expenses.export`, and the refusal logged;
 *   · with it, every claim the filters hold — not one page — as rows with the claimant, category, amount and status, in
 *     a workbook that opens;
 *   · only what the person may see: someone who sees their own claims gets theirs, never a colleague's;
 *   · the default roles: Management and Accounts hold it, Sales doesn't.
 *
 * Its own people and claims, removed in a finally.
 *
 *   npm run check:expense-export
 */
import "dotenv/config";
import Module from "node:module";
import ExcelJS from "exceljs";
import { db } from "../src/lib/db";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const user = async () => ({ id: actorId, name: "Probe", email: "probe@zzexpexp.invalid", role: "SALES" });
    return { ...real, requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const user = async () => ({ id: actorId, name: "Probe", email: "probe@zzexpexp.invalid", role: "SALES" });
    return { ...real, requireModuleUser: user, requireModuleAccess: user };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const TAG = "ZZEXPEXP";

async function main() {
  const { exportExpenses } = await import("../src/actions/expense");
  const { PERMISSIONS } = await import("../src/lib/permissions");
  const def = PERMISSIONS.find((p) => p.key === "expenses.export");
  ok("the permission is in the catalogue, held by Management and Accounts, not Sales", !!def && def.defaultRoles.includes("MANAGEMENT") && def.defaultRoles.includes("ACCOUNTS") && !def.defaultRoles.includes("SALES"), def);

  const users: string[] = [];
  try {
    const person = async (name: string) => {
      const u = await db.user.create({ data: { name: `${TAG} ${name}`, email: `${name.toLowerCase()}.${Date.now()}@zzexpexp.invalid`, role: "SALES", passwordHash: "!" } as never, select: { id: true } });
      users.push(u.id);
      return u.id;
    };
    const me = await person("Meera");
    const colleague = await person("Kabir");
    const claim = (userId: string, description: string, amount: number, status: "DRAFT" | "SUBMITTED" | "APPROVED") =>
      db.expense.create({ data: { userId, description: `${TAG} ${description}`, amount, category: "TRAVEL", spentOn: new Date("2026-11-10T00:00:00Z"), status } as never });
    for (let i = 0; i < 3; i++) await claim(me, `Cab ${i + 1}`, 450 + i, "SUBMITTED");
    await claim(me, "Hotel", 5200, "APPROVED");
    await claim(colleague, "Colleague's flight", 9800, "APPROVED");

    actorId = me;
    const refused = await exportExpenses({ search: TAG });
    ok("without the permission: refused, saying why", !refused.ok && /permission/i.test(refused.ok ? "" : refused.error), refused);
    const logged = await db.activityLog.findFirst({ where: { kind: "PERMISSION_DENIED", summary: { contains: "download expenses" }, createdAt: { gte: new Date(Date.now() - 60_000) } }, select: { id: true } }).catch(() => null);
    ok("  and the refusal is in the activity log", !!logged);

    await db.userPermission.create({ data: { userId: me, permission: "expenses.export", allowed: true, reason: TAG } });
    const mine = await exportExpenses({ search: TAG });
    ok("with it: a workbook", mine.ok && mine.data.filename.endsWith(".xlsx") && mine.data.base64.length > 100, mine.ok ? mine.data.filename : mine);
    if (mine.ok) {
      ok("  every claim she may see — her own four, never her colleague's", mine.data.rows === 4, mine.data.rows);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(mine.data.base64, "base64") as never);
      const sheet = wb.worksheets.find((s) => s.name === "Expenses");
      const header = (sheet?.getRow(1).values as unknown[] | undefined)?.map(String) ?? [];
      const text = sheet ? sheet.getSheetValues().flat().map(String).join(" | ") : "";
      ok("  it opens, with the columns that matter", ["Expense", "Spent on", "Claimant", "Category", "Amount", "Status", "Reimbursable"].every((h) => header.includes(h)), header);
      ok("  the rows carry the claims", text.includes(`${TAG} Hotel`) && text.includes("5200") && !text.includes("Colleague's flight"));
    }
    const filtered = await exportExpenses({ search: TAG, status: "APPROVED" });
    ok("the filters on screen narrow the file: approved only", filtered.ok && filtered.data.rows === 1, filtered.ok ? filtered.data.rows : filtered);
    const none = await exportExpenses({ search: `${TAG}-nothing` });
    ok("nothing matching: said so, no empty file", !none.ok && /no expenses/i.test(none.ok ? "" : none.error));
  } finally {
    await db.expense.deleteMany({ where: { userId: { in: users } } });
    await db.userPermission.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
