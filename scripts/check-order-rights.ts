/**
 * check:order-rights — orders, a customer's subscriptions and renewals as three permissions (owner, 26 Nov 2026: "separate
 * permission for renewal and orders and subscription"; src/lib/permissions.ts, migration 20261229200000).
 *
 *   · View subscriptions and View renewals start where View orders is: the same built-in roles, every preset with it,
 *     and — the migration — every stored answer, role and person, copied.
 *   · The Renewals module asks View renewals, not View orders; the Orders module still asks View orders.
 *   · Any of the three reaches the orders as far as the account, for the page that permission opens; none of them, none.
 *
 * Its people are made here and removed.
 *
 *   npm run check:order-rights
 */
import "dotenv/config";
import { directClient } from "../src/lib/tenancy/direct-client";

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const MAIL = "@zzprobe-order-rights.invalid";
const NEW = ["subscriptions.view", "renewals.view"] as const;

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  await db.userPermission.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
}

async function main() {
  const { getPermissionDefinition } = await import("../src/lib/permissions");
  const { ROLE_PRESETS } = await import("../src/lib/authz/presets");
  const { getModuleDefinition } = await import("../src/lib/modules");
  const { moduleAccessFor } = await import("../src/lib/modules-access");
  const { accessLevel } = await import("../src/lib/authz/access");
  const { ACCESS_MODULES } = await import("../src/lib/staff/access-modules");

  console.log("\n— Defaults and presets —\n");
  const orders = getPermissionDefinition("orders.view")!;
  for (const key of NEW) {
    const def = getPermissionDefinition(key);
    ok(`${key} exists, in Orders & fulfilment`, !!def && def.group === "Orders & fulfilment");
    ok(`  every role holding View orders by default holds it`, !!def && orders.defaultRoles.every((r) => (def.defaultRoles as readonly string[]).includes(r)), def?.defaultRoles);
    ok(`  every preset with View orders has it`, ROLE_PRESETS.every((p) => !p.permissions.includes("orders.view") || p.permissions.includes(key)));
    ok(`  it is a row of the Sales module in the matrix`, ACCESS_MODULES.some((m) => m.key === "sales" && m.keys.includes(key)));
  }
  ok("Renewals is opened by View renewals", getModuleDefinition("renewals")?.viewPermission === "renewals.view");
  ok("Orders still by View orders", getModuleDefinition("orders")?.viewPermission === "orders.view");

  console.log("\n— The migration —\n");
  const [oldRole, oldUser] = await Promise.all([
    db.rolePermission.findMany({ where: { permission: "orders.view" }, select: { role: true, allowed: true } }),
    db.userPermission.findMany({ where: { permission: "orders.view" }, select: { userId: true, allowed: true } }),
  ]);
  for (const key of NEW) {
    const [role, user] = await Promise.all([
      db.rolePermission.findMany({ where: { permission: key }, select: { role: true, allowed: true } }),
      db.userPermission.findMany({ where: { permission: key }, select: { userId: true, allowed: true } }),
    ]);
    const roles = new Map(role.map((r) => [r.role, r.allowed]));
    const users = new Map(user.map((u) => [u.userId, u.allowed]));
    const offRole = oldRole.filter((r) => roles.get(r.role) !== r.allowed);
    const offUser = oldUser.filter((u) => users.get(u.userId) !== u.allowed);
    ok(`every stored View orders answer has the same for ${key}, role and person`, offRole.length === 0 && offUser.length === 0, [...offRole.map((r) => r.role), ...offUser.map((u) => u.userId)]);
  }

  await cleanup();
  try {
    const mk = async (local: string, denied: string[]) => {
      const u = await db.user.create({ data: { name: `Zzprobe ${local}`, email: `${local}${MAIL}`, role: "ADMIN", passwordHash: "!" }, select: { id: true } });
      for (const permission of denied) await db.userPermission.create({ data: { userId: u.id, permission, allowed: false, reason: "check:order-rights" } });
      return u.id;
    };
    const full = await mk("full", []);
    const noRenewals = await mk("norenewals", ["renewals.view"]);
    const renewalsOnly = await mk("renewalsonly", ["orders.view", "subscriptions.view"]);
    const none = await mk("none", ["orders.view", "subscriptions.view", "renewals.view"]);

    console.log("\n— Who may —\n");
    const open = async (userId: string, key: string) => moduleAccessFor(userId, key);
    const renewalsHere = await open(full, "renewals");
    if (renewalsHere === "available") {
      ok("without View renewals, no Renewals — Orders still open", (await open(noRenewals, "renewals")) === "no-permission" && (await open(noRenewals, "orders")) === "available");
      ok("with only View renewals, Renewals opens — Orders doesn't", (await open(renewalsOnly, "renewals")) === "available" && (await open(renewalsOnly, "orders")) === "no-permission");
    } else console.log(`  ..   Renewals is ${renewalsHere} in this workspace — module checks skipped`);
    ok("any of the three reaches the orders as far as the account", (await accessLevel(full, "orders", "view")) === "FOLLOW" && (await accessLevel(renewalsOnly, "orders", "view")) === "FOLLOW" && (await accessLevel(noRenewals, "orders", "view")) === "FOLLOW");
    ok("  none of them, none", (await accessLevel(none, "orders", "view")) === "NONE");
  } finally {
    await cleanup();
  }
}

main()
  .catch((err) => {
    failures += 1;
    console.error(err);
  })
  .finally(async () => {
    await db.$disconnect();
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
