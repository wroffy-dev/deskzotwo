/**
 * check:user-delete — deleting an account added by mistake (src/actions/user.ts deleteUser,
 * src/lib/user-delete.ts): the super admin only, never yourself or the super admin, and only an account
 * that owns nothing — its own photo, settings and notifications go with it; any work record stops it.
 *
 * A fixture of its own in the local database, every account on @zzprobe-userdel.invalid, removed in a
 * finally. The super admin is the database's own (there is exactly one); the suite only acts as them.
 *
 *   npm run check:user-delete
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "ADMIN", name: "Zzprobe", email: `actor${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const MAIL = "@zzprobe-userdel.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityLabel: { contains: MAIL } }] } });
  await db.userPhoto.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function person(name: string, extra: { role?: "ADMIN" | "SALES" } = {}) {
  return db.user.create({
    data: { name: `Zzprobe ${name}`, email: `${name.toLowerCase()}${MAIL}`, role: extra.role ?? "SALES", passwordHash: "!" },
    select: { id: true, name: true },
  });
}

async function main() {
  const { deleteUser } = await import("../src/actions/user");
  const { plainTable, holdingsText, userHoldings } = await import("../src/lib/user-delete");
  const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!superAdmin) throw new Error("The local database has no super admin.");
  await cleanup();
  try {
    console.log("\n— Words —\n");
    ok("a table reads plainly", plainTable("sales_orders") === "sales orders");
    ok("a join table reads plainly", plainTable("_OrderWatchers") === "order watchers");
    ok("holdings in a sentence", holdingsText([{ table: "leads", count: 12 }, { table: "audit_logs", count: 3 }, { table: "tasks", count: 2 }, { table: "notes", count: 1 }]) === "leads (12), history (3), tasks (2) and 1 more");

    console.log("\n— Who may —\n");
    const admin = await person("Admin", { role: "ADMIN" });
    const fresh = await person("Fresh");
    actorId = admin.id;
    const byAdmin = await deleteUser(fresh.id);
    ok("an ordinary admin is refused", !byAdmin.ok && /super admin/.test(byAdmin.error), !byAdmin.ok && byAdmin.error);
    ok("…and the account is still there", (await db.user.count({ where: { id: fresh.id } })) === 1);
    actorId = superAdmin.id;
    const self = await deleteUser(superAdmin.id);
    ok("the super admin can't delete themselves", !self.ok && /your own/.test(self.error));
    ok("…and nobody can delete the super admin", (await db.user.count({ where: { id: superAdmin.id, isSuperAdmin: true } })) === 1);

    console.log("\n— A fresh account goes, with its own rows —\n");
    await db.userPhoto.create({ data: { userId: fresh.id, dataUrl: "data:image/png;base64,AA==", mimeType: "image/png", byteSize: 1 } });
    ok("a photo is the account's own: no holdings", (await userHoldings(fresh.id)).length === 0, JSON.stringify(await userHoldings(fresh.id)));
    const gone = await deleteUser(fresh.id);
    ok("the super admin deletes it", gone.ok, !gone.ok && gone.error);
    ok("…the account is gone", (await db.user.count({ where: { id: fresh.id } })) === 0);
    ok("…and its photo", (await db.userPhoto.count({ where: { userId: fresh.id } })) === 0);
    ok("…and the delete is in the audit, by the super admin", (await db.auditLog.count({ where: { userId: superAdmin.id, action: "DELETE", entityId: fresh.id } })) === 1);

    console.log("\n— Anybody who did work stays —\n");
    const worker = await person("Worker");
    await db.auditLog.create({ data: { userId: worker.id, action: "CREATE", entityType: "Lead", entityId: "zz", entityLabel: `Zzprobe lead${MAIL}` } });
    const held = await deleteUser(worker.id);
    ok("an account with a history is refused, saying what it holds", !held.ok && held.error.includes("history (1)") && /Switch them off/.test(held.error), !held.ok && held.error);
    ok("…and nothing of it is removed", (await db.user.count({ where: { id: worker.id } })) === 1 && (await db.auditLog.count({ where: { userId: worker.id } })) === 1);
    const managed = await person("Report");
    await db.user.update({ where: { id: managed.id }, data: { managerId: admin.id } });
    const manager = await deleteUser(admin.id);
    ok("somebody's manager is refused too (a reference from another account)", !manager.ok && manager.error.includes("other people's accounts (1)"), !manager.ok && manager.error);
  } finally {
    await db.user.updateMany({ where: { email: { endsWith: MAIL } }, data: { managerId: null } });
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
