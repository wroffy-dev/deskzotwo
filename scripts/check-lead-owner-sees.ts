/**
 * check:lead-owner-sees — a lead shows to its owner, whoever's account it is on (owner, 26 Nov 2026: "if head creates
 * a lead and assigned lead owner is xyz then the lead should show to him").
 *
 * A head gives a lead on their own account to a rep outside their line: the rep sees it and works it, their manager
 * too; and whoever made a lead and handed it on keeps it in sight ("add creator too"); deleting and reassigning stay the account's, the account itself stays out of the rep's reach, and nobody else
 * gains anything. People, companies and leads are made here and removed.
 *
 * And Data Scope's two ticks under Leads "as the account" (src/lib/authz/lead-reach.ts): unticked for a role, or for one
 * person over their role's, each reach goes; saving them holds the role screens' rules and writes the history.
 *
 *   npm run check:lead-owner-sees
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; role: string; name: string; email: string } | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/auth" || request.endsWith("lib/auth")) return { auth: async () => null };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

/* eslint-disable @typescript-eslint/no-require-imports */
const { companyAccess, leadAccess, mayAccess } = require("../src/lib/authz/access") as typeof import("../src/lib/authz/access");
const { companiesOutOfReach } = require("../src/lib/companies/out-of-reach") as typeof import("../src/lib/companies/out-of-reach");
const { setRoleLeadReach } = require("../src/actions/access-levels") as typeof import("../src/actions/access-levels");
const { setPersonLeadReach, resetPersonToRole } = require("../src/actions/person-access") as typeof import("../src/actions/person-access");
const { personLeadReachView } = require("../src/lib/authz/lead-reach") as typeof import("../src/lib/authz/lead-reach");

const db = directClient();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function main() {
  const ROLE = "ZZPROBE_LOWN";
  const TAG = "Zzprobe lown";
  const clean = async () => {
    const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await db.lead.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
    await db.user.updateMany({ where: { role: ROLE }, data: { managerId: null } });
    const ids = (await db.user.findMany({ where: { role: ROLE }, select: { id: true } })).map((u) => u.id);
    await db.permissionChange.deleteMany({ where: { OR: [{ subjectRole: ROLE }, { subjectUserId: { in: ids } }] } }).catch(() => {});
    await db.user.deleteMany({ where: { role: ROLE } });
    await db.roleAccessLevel.deleteMany({ where: { role: ROLE } });
    await db.rolePermission.deleteMany({ where: { role: ROLE } });
    await db.role.deleteMany({ where: { key: ROLE } });
  };
  await clean();
  try {
    const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
    // A sales role as the presets make it: leads as far as the account, companies by line.
    await db.role.create({ data: { key: ROLE, name: TAG } });
    for (const permission of ["leads.view", "section.leads", "section.companies"]) await db.rolePermission.create({ data: { role: ROLE, permission, allowed: true } });
    await db.rolePermission.create({ data: { role: ROLE, permission: "companies.viewAll", allowed: false } });
    const person = (key: string, managerId: string | null = null) =>
      db.user.create({ data: { name: `${TAG} ${key}`, email: `${key}@zzprobe-lown.invalid`, role: ROLE, passwordHash: "x".repeat(60), managerId }, select: { id: true } });
    const head = await person("head");
    const boss = await person("boss");
    const xyz = await person("xyz", boss.id);
    const other = await person("other");
    const caller = await person("caller", boss.id);
    const company = (key: string, ownerUserId: string | null) =>
      db.company.create({ data: { name: `${TAG} ${key}`, normalizedName: `${TAG} ${key}`.toLowerCase(), relationshipType: "CLIENT", stage: "PROSPECT", ownerUserId, createdById: admin.id }, select: { id: true } });
    const headsAccount = await company("heads", head.id);
    const nobodys = await company("nobodys", null);
    const given = await db.lead.create({ data: { companyId: headsAccount.id, title: `${TAG} given`, ownerUserId: xyz.id, createdByUserId: head.id }, select: { id: true } });
    const kept = await db.lead.create({ data: { companyId: headsAccount.id, title: `${TAG} kept`, ownerUserId: head.id, createdByUserId: head.id }, select: { id: true } });
    const orphan = await db.lead.create({ data: { companyId: nobodys.id, title: `${TAG} orphan`, ownerUserId: xyz.id }, select: { id: true } });
    // A telecaller logs a lead on the head's account and hands it to the head.
    const logged = await db.lead.create({ data: { companyId: headsAccount.id, title: `${TAG} logged`, ownerUserId: head.id, createdByUserId: caller.id }, select: { id: true } });
    const leads = [given.id, kept.id, orphan.id, logged.id];
    const sees = async (userId: string, action: "view" | "edit" | "delete" | "assign" = "view") =>
      (await db.lead.findMany({ where: { AND: [{ id: { in: leads } }, await leadAccess(userId, action)] }, select: { id: true } })).map((l) => l.id).sort();

    console.log("\n— The lead's owner —\n");
    ok("sees the lead the head gave them", (await sees(xyz.id)).includes(given.id));
    ok("  and works it", (await sees(xyz.id, "edit")).includes(given.id) && (await mayAccess(xyz.id, "leads", "edit", given.id)));
    ok("  its page opens for them", await mayAccess(xyz.id, "leads", "view", given.id));
    ok("  not the head's own lead on that account", !(await sees(xyz.id)).includes(kept.id));
    ok("  a lead of theirs on an account with no manager too", (await sees(xyz.id)).includes(orphan.id));
    ok("  but neither deletes nor reassigns it", (await sees(xyz.id, "delete")).length === 0 && (await sees(xyz.id, "assign")).length === 0);
    ok("  and the account itself stays out of their reach", (await db.company.count({ where: { AND: [{ id: headsAccount.id }, await companyAccess(xyz.id)] } })) === 0);
    ok("  so its name is no link for them", (await companiesOutOfReach(xyz.id, [headsAccount.id])).includes(headsAccount.id));

    console.log("\n— Whoever made it —\n");
    ok("the caller who logged it and handed it on still sees it", (await sees(caller.id)).includes(logged.id));
    ok("  and works it", (await mayAccess(caller.id, "leads", "edit", logged.id)));
    ok("  but neither deletes nor reassigns it", !(await sees(caller.id, "delete")).includes(logged.id) && !(await sees(caller.id, "assign")).includes(logged.id));
    ok("  nor sees the others on that account", JSON.stringify(await sees(caller.id)) === JSON.stringify([logged.id]));

    console.log("\n— Everybody else —\n");
    ok("their manager sees what their team was given, and made", (await sees(boss.id)).includes(given.id) && (await sees(boss.id)).includes(logged.id) && !(await sees(boss.id)).includes(kept.id));
    ok("the head still sees and keeps every lead on their account", JSON.stringify(await sees(head.id, "assign")) === JSON.stringify([given.id, kept.id, logged.id].sort()));
    ok("somebody else gains nothing", (await sees(other.id)).length === 0);

    console.log("\n— Leads at Own —\n");
    // Own is the lead's owner or whoever made it (owner, 26 Nov 2026: "Own includes made") — support logs a lead the rules
    // hand to sales and keeps it in sight.
    for (const action of ["view", "edit"]) await db.roleAccessLevel.create({ data: { role: ROLE, record: "leads", action, level: "OWN" } });
    const bystander = await person("bystander");
    ok("the caller sees the lead they made and handed on, and works it", (await sees(caller.id)).includes(logged.id) && (await sees(caller.id, "edit")).includes(logged.id));
    ok("  the owner still sees what they own", (await sees(xyz.id)).includes(given.id) && (await sees(xyz.id)).includes(orphan.id));
    ok("  the head sees what they own and what they made", JSON.stringify(await sees(head.id)) === JSON.stringify([given.id, kept.id, logged.id].sort()));
    ok("  the caller nothing else on that account", JSON.stringify(await sees(caller.id)) === JSON.stringify([logged.id]));
    ok("  somebody who neither owns nor made one sees none", (await sees(bystander.id)).length === 0 && (await sees(other.id)).length === 0);
    await db.roleAccessLevel.deleteMany({ where: { role: ROLE, record: "leads" } });

    console.log("\n— The two ticks —\n");
    const superAdmin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true, role: true, name: true, email: true } });
    actor = superAdmin;
    const off = await setRoleLeadReach(ROLE, { owned: false, made: true });
    ok("a role's \"Leads they own\" can be unticked", off.ok && off.data.changed === 1, off.ok ? "" : off.error);
    ok("  then the owner no longer sees a lead on an account beyond them", !(await sees(xyz.id)).includes(given.id) && !(await mayAccess(xyz.id, "leads", "view", given.id)));
    ok("  nor their manager", !(await sees(boss.id)).includes(given.id));
    ok("  but the caller still sees the one they made", (await sees(caller.id)).includes(logged.id));
    ok("  and it is in the permission history", (await db.permissionChange.count({ where: { subjectRole: ROLE, permission: "access:leads:reach:owned", changeKind: "REVOKE" } })) === 1);
    await setRoleLeadReach(ROLE, { owned: false, made: false });
    ok("with both unticked, only the account rule is left", !(await sees(caller.id)).includes(logged.id) && JSON.stringify(await sees(head.id)) === JSON.stringify([given.id, kept.id, logged.id].sort()));

    const mine = await setPersonLeadReach(xyz.id, { owned: true, made: null }, { reason: "Zzprobe covering" });
    ok("one person can have it ticked over their role's", mine.ok, mine.ok ? "" : mine.error);
    ok("  they see the lead given to them again, their colleagues don't", (await sees(xyz.id)).includes(given.id) && !(await sees(caller.id)).includes(logged.id));
    const view = await personLeadReachView(xyz.id);
    ok("  the screen says what is theirs and what is the role's", !!view && view.own?.owned === true && view.own.made === null && view.role.owned === false && view.effective.owned && !view.effective.made && view.own.reason === "Zzprobe covering");
    const reset = await resetPersonToRole(xyz.id);
    ok("  \"Reset to role defaults\" takes it away", reset.ok && !(await sees(xyz.id)).includes(given.id), reset.ok ? "" : reset.error);

    // Somebody who manages roles but reaches leads no further than their own accounts.
    await db.rolePermission.create({ data: { role: ROLE, permission: "permissions.manage", allowed: true } });
    actor = { ...(await db.user.findUniqueOrThrow({ where: { id: other.id }, select: { id: true, role: true, name: true, email: true } })) };
    const wider = await setRoleLeadReach(ROLE, { owned: true, made: false });
    ok("nobody ticks one on that they haven't got themselves", !wider.ok && /don't reach/.test(wider.error), wider.ok ? "" : wider.error);
    ok("  for one person neither", !(await setPersonLeadReach(caller.id, { owned: null, made: true })).ok);
    ok("  nor for themselves", /own access/.test(((await setPersonLeadReach(other.id, { owned: false, made: null })) as { error?: string }).error ?? ""));
    await db.rolePermission.deleteMany({ where: { role: ROLE, permission: "permissions.manage" } });
    actor = { ...(await db.user.findUniqueOrThrow({ where: { id: caller.id }, select: { id: true, role: true, name: true, email: true } })) };
    ok("somebody who can't change roles is refused", !(await setRoleLeadReach(ROLE, { owned: true, made: true })).ok);
    actor = superAdmin;
    const back = await setRoleLeadReach(ROLE, { owned: true, made: true });
    ok("ticked again, everything is as it was", back.ok && (await sees(xyz.id)).includes(given.id) && (await sees(caller.id)).includes(logged.id));
    ok("bad input is refused", !(await setRoleLeadReach(ROLE, { owned: "yes" as never, made: true })).ok && !(await setRoleLeadReach("ZZ_NO_ROLE", { owned: true, made: true })).ok);

    await db.roleAccessLevel.create({ data: { role: ROLE, record: "leads", action: "view", level: "NONE" } });
    const shut = await person("shut");
    ok("a role with Leads set to None sees no lead, theirs or not", (await sees(shut.id)).length === 0 && (await db.lead.updateMany({ where: { id: orphan.id }, data: { ownerUserId: shut.id } })).count === 1 && (await sees(shut.id)).length === 0);
  } finally {
    await clean();
  }

  await db.$disconnect();
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
