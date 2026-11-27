/**
 * check:leads-create — "Create leads" as its own permission (owner, 1 Nov 2026).
 *
 * The defaults match "View leads" for every role that held it; the migration copied every stored view
 * grant and denial onto the new key, so nobody gained or lost anything; createLead refuses a person who
 * may view but not create, before anything else; and Automate's "Create a lead" needs it of the
 * workflow's owner. A fixture of its own in the local database, accounts on @zzprobe-lc.invalid, removed
 * in a finally.
 *
 *   npm run check:leads-create
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
    const user = () => ({ id: actorId, role: "SUPPORT", name: "Zzprobe", email: `actor${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const MAIL = "@zzprobe-lc.invalid";
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
  const { createLead } = await import("../src/actions/lead");
  const { can } = await import("../src/lib/authz/resolve");
  const { actorRefusal } = await import("../src/lib/automate/registry");
  const { leadCreate } = await import("../src/lib/automate/actions/lead-create");
  const { getPreset, ROLE_PRESETS: PRESETS } = await import("../src/lib/authz/presets");

  console.log("\n— Defaults —\n");
  const view = getPermissionDefinition("leads.view")!;
  const create = getPermissionDefinition("leads.create")!;
  ok("every role that views leads by default creates them by default", view.defaultRoles.every((r) => (create.defaultRoles as readonly string[]).includes(r)), create.defaultRoles);
  ok("every preset with View leads has Create leads", PRESETS.every((p) => !p.permissions.includes("leads.view") || p.permissions.includes("leads.create")));
  ok("the sales-executive preset has it", !!getPreset("sales-executive")?.permissions.includes("leads.create"));

  console.log("\n— The migration —\n");
  const [roleView, roleCreate] = await Promise.all([
    db.rolePermission.findMany({ where: { permission: "leads.view" }, select: { role: true, allowed: true } }),
    db.rolePermission.findMany({ where: { permission: "leads.create" }, select: { role: true, allowed: true } }),
  ]);
  const created = new Map(roleCreate.map((r) => [r.role, r.allowed]));
  const missing = roleView.filter((r) => created.get(r.role) !== r.allowed);
  ok("every role's stored View leads answer is its Create leads answer", missing.length === 0, missing.map((r) => r.role).join(", "));

  await cleanup();
  try {
    const mk = (local: string) => db.user.create({ data: { name: `Zzprobe ${local}`, email: `${local}${MAIL}`, role: "SUPPORT", passwordHash: "!" }, select: { id: true } });
    const both = await mk("both");
    const viewOnly = await mk("viewonly");
    await db.userPermission.create({ data: { userId: viewOnly.id, permission: "leads.create", allowed: false, reason: "check:leads-create" } });

    console.log("\n— Who may —\n");
    ok("support holds Create leads by default", await can(both.id, "leads.create"));
    ok("a person denied it doesn't, but still views leads", !(await can(viewOnly.id, "leads.create")) && (await can(viewOnly.id, "leads.view")));

    actorId = viewOnly.id;
    const refused = await createLead({ companyId: "zz-none", title: "Zz" });
    ok("createLead refuses them, before looking at anything else", !refused.ok && refused.error === "You can't create leads.", !refused.ok ? refused.error : "");
    actorId = both.id;
    const passed = await createLead({ companyId: "zz-none", title: "Zz" });
    ok("with it, the permission doesn't stop them (the made-up customer does)", !passed.ok && passed.error !== "You can't create leads.", !passed.ok ? passed.error : "");

    console.log("\n— Automate —\n");
    ok("\"Create a lead\" needs it of the workflow's owner", leadCreate.permission === "leads.create");
    const why = await actorRefusal(viewOnly.id, leadCreate as never);
    ok("an owner without it is refused, naming the action", !!why && /Create a lead/.test(why), why ?? "");
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
