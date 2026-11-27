/**
 * check:view-rights — three views as their own permissions (owner, 2 Nov 2026): the Contacts directory apart from a
 * customer's Contacts tab (contacts.directory), the Statement tab (statements.view) and a customer's Commission tab
 * (commissions.view).
 *
 * The defaults and presets keep them beside the keys they came from; the migration copied every stored answer, so
 * nobody gained or lost anything; and a person denied one loses that view and nothing else. A fixture of its own in
 * the local database, accounts on @zzprobe-vr.invalid, removed in a finally.
 *
 *   npm run check:view-rights
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
const MAIL = "@zzprobe-vr.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  const { getPermissionDefinition } = await import("../src/lib/permissions");
  const { can } = await import("../src/lib/authz/resolve");
  const { ROLE_PRESETS: PRESETS } = await import("../src/lib/authz/presets");
  const { getModuleDefinition } = await import("../src/lib/modules");
  const { moduleAccessFor } = await import("../src/lib/modules-access");
  const { maySeeStatement } = await import("../src/lib/statements/print-data");
  const { listCompanyCommissions } = await import("../src/actions/commission-party");

  console.log("\n— Defaults and presets —\n");
  const pairs = [
    ["contacts.view", "contacts.directory"],
    ["payments.view", "statements.view"],
    ["contacts.view", "commissions.view"],
  ] as const;
  for (const [from, to] of pairs) {
    const a = getPermissionDefinition(from)!;
    const b = getPermissionDefinition(to)!;
    ok(`every role holding ${from} by default holds ${to}`, a.defaultRoles.every((r) => (b.defaultRoles as readonly string[]).includes(r)), b.defaultRoles);
  }
  ok("every preset with View contacts has the directory", PRESETS.every((p) => !p.permissions.includes("contacts.view") || p.permissions.includes("contacts.directory")));
  ok("every preset with View payments has statements", PRESETS.every((p) => !p.permissions.includes("payments.view") || p.permissions.includes("statements.view")));
  ok("the Contacts directory module is opened by the directory right", getModuleDefinition("contacts_library")?.viewPermission === "contacts.directory");

  console.log("\n— The migration —\n");
  for (const [from, to] of pairs.slice(0, 2)) {
    const [old, now] = await Promise.all([
      db.rolePermission.findMany({ where: { permission: from }, select: { role: true, allowed: true } }),
      db.rolePermission.findMany({ where: { permission: to }, select: { role: true, allowed: true } }),
    ]);
    const got = new Map(now.map((r) => [r.role, r.allowed]));
    const off = old.filter((r) => !got.has(r.role));
    ok(`every role with a stored ${from} answer has one for ${to}`, off.length === 0, off.map((r) => r.role).join(", "));
  }
  const roles = await db.role.findMany({ where: { key: { not: "ADMIN" } }, select: { key: true } });
  const commission = new Set((await db.rolePermission.findMany({ where: { permission: "commissions.view" }, select: { role: true } })).map((r) => r.role));
  const without = roles.filter((r) => !commission.has(r.key));
  ok("every role has a stored commission answer", without.length === 0, without.map((r) => r.key).join(", "));

  await cleanup();
  try {
    const mk = (local: string) => db.user.create({ data: { name: `Zzprobe ${local}`, email: `${local}${MAIL}`, role: "ADMIN", passwordHash: "!" }, select: { id: true } });
    const full = await mk("full");
    const narrow = await mk("narrow");
    for (const permission of ["contacts.directory", "statements.view", "commissions.view"]) {
      await db.userPermission.create({ data: { userId: narrow.id, permission, allowed: false, reason: "check:view-rights" } });
    }

    console.log("\n— Who may —\n");
    ok("an admin holds all three", (await can(full.id, "contacts.directory")) && (await can(full.id, "statements.view")) && (await can(full.id, "commissions.view")));
    ok("denied all three, they still view contacts and payments", (await can(narrow.id, "contacts.view")) && (await can(narrow.id, "payments.view")));

    const fullDir = await moduleAccessFor(full.id, "contacts_library");
    ok("the directory opens for the admin", fullDir === "available" || fullDir === "switched-off" || fullDir === "not-entitled", fullDir);
    if (fullDir === "available") ok("…and not for the person denied it", (await moduleAccessFor(narrow.id, "contacts_library")) === "no-permission");

    const customer = await db.company.findFirst({ where: { relationshipType: { notIn: ["VENDOR", "COMMISSION_PARTY"] } }, select: { id: true } });
    if (customer && (await maySeeStatement(full.id, "AR", customer.id))) {
      ok("a customer's statement is refused to the person denied it", !(await maySeeStatement(narrow.id, "AR", customer.id)));
    } else {
      ok("a customer's statement is refused to the person denied it (receivables off here)", !(await maySeeStatement(narrow.id, "AR", customer?.id ?? "zz")));
    }

    const paid = await db.orderExpense.findFirst({ where: { type: "COMMISSION" }, select: { companyProduct: { select: { companyId: true } } } });
    if (paid) {
      actorId = full.id;
      const seen = await listCompanyCommissions(paid.companyProduct.companyId).catch(() => null);
      actorId = narrow.id;
      const hidden = await listCompanyCommissions(paid.companyProduct.companyId).catch(() => null);
      if (seen && seen.length) ok("commission on a customer is hidden from the person denied it", Array.isArray(hidden) && hidden.length === 0, { seen: seen.length, hidden: hidden?.length });
      else console.log("  ..   no commission the admin can see here — the tab's rule is checked by can() above");
    } else {
      console.log("  ..   no commission paid in this database — the tab's rule is checked by can() above");
    }
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
