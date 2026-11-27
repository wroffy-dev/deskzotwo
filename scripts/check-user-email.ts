/**
 * The super admin changing the email somebody signs in with (src/actions/user.ts `changeUserEmail`; owner, 25 Nov 2026).
 *
 *   1. Who may: the super admin alone, as themselves; not their own; not while viewing as somebody; a real address,
 *      nobody else's here, not one of the system's.
 *   2. What changes: the address, in small letters. What ends with the old one: sign-ins, unused password links, the
 *      Microsoft/Google/Zoho identity held, linked workspaces. What stays: password, two-factor, API keys, records.
 *   3. Who is told: both addresses, the old one never learning the new; somebody not set up yet gets their setup email
 *      again; somebody switched off, nothing.
 *   4. The dialog: offered only to the super admin, and not on their own row.
 *
 * The real action, with the session, `next/cache`, the dialog's portal and the platform account hooks substituted. No
 * mail leaves. The workspace's one super admin is borrowed as the actor and never changed. Fixtures are named ZZEMAIL /
 * @zzuseremail-check.invalid and removed in a finally.
 *
 *   npm run check:user-email
 */
import "dotenv/config";
import Module from "node:module";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const TAG = "ZZEMAIL";
const MAIL = "@zzuseremail-check.invalid";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

// ─── Stand-ins ───────────────────────────────────────────────────────────────────────────────────
let actor: { id: string; name: string } | null = null;
let viewingAs = false;
const changes: { ids: string[]; change: { revoke?: string; by: string } }[] = [];
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    class UnauthorizedError extends Error {}
    const user = () => (actor ? { id: actor.id, name: actor.name, email: `probe${MAIL}`, role: "ADMIN" } : null);
    return {
      UnauthorizedError,
      requireUser: async () => {
        const u = user();
        if (!u) throw new UnauthorizedError("signed out");
        return u;
      },
      currentUser: async () => user(),
      viewAsContext: async () => (viewingAs ? { user: user() } : null),
      refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody else." : null),
    };
  }
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/settings/users",
    };
  }
  if (request === "@/components/ui/dialog" || request.endsWith("components/ui/dialog")) {
    return {
      Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
        open ? createElement("div", { role: "dialog", "aria-label": title }, children) : null,
    };
  }
  if (request === "@/lib/platform/account-hooks" || request.endsWith("lib/platform/account-hooks")) {
    return { accountsChanged: async (ids: string[], change: { revoke?: string; by: string }) => void changes.push({ ids, change }) };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { noPasswordYet } = require("../src/lib/no-password") as typeof import("../src/lib/no-password");
  const { AUTOMATION_EMAIL } = require("../src/lib/people") as typeof import("../src/lib/people");
  const USER = require("../src/actions/user") as typeof import("../src/actions/user");
  const { EditStaffDialog } = require("../src/components/settings/staff/edit-staff-dialog") as typeof import("../src/components/settings/staff/edit-staff-dialog");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const mail: { to: string; subject: string; text: string }[] = [];
  let mailDown = false;
  mailer.setTestPlatformMailer(async (m) => {
    if (mailDown) throw new Error("SMTP unreachable");
    mail.push(m);
  });

  await cleanup(db);
  try {
    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true } });
    if (!superAdmin) throw new Error("no super admin");
    const signedUp = "zz-fixture-placeholder";
    const mk = (name: string, local: string, role: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name: `${TAG} ${name}`, email: `${local}${MAIL}`, role, passwordHash: signedUp, ...extra }, select: { id: true, name: true, email: true } });
    const admin = await mk("Admin", "admin", "ADMIN");
    const asha = await mk("Asha", "asha", "SALES", { twoFactorEnabledAt: new Date() });
    const other = await mk("Other", "taken", "SALES");
    const invited = await mk("Invited", "invited", "SALES", { passwordHash: noPasswordYet() });
    const off = await mk("Off", "off", "SALES", { active: false });
    const emailOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })).email;
    const as = (u: { id: string; name: string }) => {
      actor = u;
    };
    const next = `asha.new${MAIL}`;

    section("1. Who may");
    const refused = async (label: string, run: () => Promise<{ ok: boolean; error?: string }>, expect: RegExp) => {
      const r = (await run()) as { ok: boolean; error?: string };
      ok(label, !r.ok && expect.test(r.error ?? ""), r.ok ? "allowed" : r.error);
    };
    as(admin);
    await refused("not an admin, whatever else they hold", () => USER.changeUserEmail(asha.id, next), /Only the super admin/);
    as(asha);
    await refused("  nor the person themselves", () => USER.changeUserEmail(asha.id, next), /Only the super admin/);
    as(superAdmin);
    viewingAs = true;
    await refused("not while viewing as somebody", () => USER.changeUserEmail(asha.id, next), /viewing as/);
    viewingAs = false;
    await refused("not the super admin's own", () => USER.changeUserEmail(superAdmin.id, next), /your own/);
    await refused("not something that isn't an address", () => USER.changeUserEmail(asha.id, "not-an-email"), /valid email/);
    await refused("  nor one of the system's", () => USER.changeUserEmail(asha.id, AUTOMATION_EMAIL), /reserved/);
    await refused("  nor somebody else's here, however it's written", () => USER.changeUserEmail(asha.id, `TAKEN${MAIL}`), /already has that email/);
    await refused("  nor the one they have", () => USER.changeUserEmail(asha.id, ` Asha${MAIL} `), /already their email/);
    await refused("not somebody who isn't there", () => USER.changeUserEmail("nobody", next), /no longer exists/);
    const automation = await db.user.findFirst({ where: { kind: "AUTOMATION" }, select: { id: true } });
    if (automation) await refused("not the Automation account's", () => USER.changeUserEmail(automation.id, next), /no longer exists/);
    ok("none of those changed anything", (await emailOf(asha.id)) === asha.email && (await emailOf(superAdmin.id)) === superAdmin.email && mail.length === 0 && changes.length === 0);

    section("2. What changes, and what ends with the old address");
    const signIn = await db.signIn.create({ data: { sid: `${TAG}-sid-1`, userId: asha.id, provider: "credentials" }, select: { id: true } });
    const otherSignIn = await db.signIn.create({ data: { sid: `${TAG}-sid-2`, userId: other.id, provider: "credentials" }, select: { id: true } });
    await db.passwordResetToken.create({ data: { tokenHash: `${TAG}-hash-1`, userId: asha.id, expiresAt: new Date(Date.now() + 3_600_000) } });
    await db.userSsoIdentity.create({ data: { userId: asha.id, provider: "GOOGLE", subject: `${TAG}-subject-1` } });
    await db.userSsoIdentity.create({ data: { userId: other.id, provider: "GOOGLE", subject: `${TAG}-subject-2` } });
    const key = await db.apiKey.create({ data: { userId: asha.id, name: `${TAG} key`, keyId: `${TAG}-key`, secretDigest: `${TAG}-digest`, scopes: [] }, select: { id: true } });
    const changed = await USER.changeUserEmail(asha.id, `  Asha.NEW${MAIL} `);
    ok("the super admin changes it", changed.ok && changed.data.email === next && changed.data.setup === null, changed.ok ? changed.data : changed.error);
    ok("  kept in small letters, as sign-in looks it up", (await emailOf(asha.id)) === next, await emailOf(asha.id));
    const row = await db.user.findUniqueOrThrow({ where: { id: asha.id }, select: { passwordHash: true, mustChangePassword: true, twoFactorEnabledAt: true, role: true, active: true } });
    ok("  password, two-factor, role as they were", row.passwordHash === signedUp && !row.mustChangePassword && !!row.twoFactorEnabledAt && row.role === "SALES" && row.active);
    ok("  signed out everywhere", (await db.signIn.findUniqueOrThrow({ where: { id: signIn.id } })).endedAt !== null);
    ok("  their API keys stay", (await db.apiKey.findUniqueOrThrow({ where: { id: key.id }, select: { revokedAt: true } })).revokedAt === null);
    ok("  a link sent to the old address is dead", (await db.passwordResetToken.count({ where: { userId: asha.id, usedAt: null } })) === 0);
    ok("  the provider identity is let go, so the new address can sign in", (await db.userSsoIdentity.count({ where: { userId: asha.id } })) === 0);
    ok("  linked workspaces unlinked, by the super admin", changes.length === 1 && changes[0]!.ids.join() === asha.id && changes[0]!.change.revoke === "credentials" && changes[0]!.change.by === `admin:${superAdmin.id}`, changes);
    ok("nobody else's sign-in or identity is touched", (await db.signIn.findUniqueOrThrow({ where: { id: otherSignIn.id } })).endedAt === null && (await db.userSsoIdentity.count({ where: { userId: other.id } })) === 1);
    const audit = await db.auditLog.findFirst({ where: { entityId: asha.id }, orderBy: { createdAt: "desc" }, select: { userId: true, entityLabel: true } });
    ok("audited, from which address to which", audit?.userId === superAdmin.id && !!audit.entityLabel?.includes(asha.email) && audit.entityLabel.includes(next), audit);

    section("3. Who is told");
    const toNew = mail.find((m) => m.to === next);
    const toOld = mail.find((m) => m.to === asha.email);
    ok("the new address: that they sign in with it", mail.length === 2 && !!toNew && toNew.text.includes(next) && /has changed$/.test(toNew.subject), toNew);
    ok("the old address: that it no longer does — never the new one", !!toOld && /no longer signs in/.test(toOld.subject) && !toOld.text.includes(next) && !toOld.subject.includes(next), toOld);
    mail.length = 0;
    mailDown = true;
    const down = await USER.changeUserEmail(asha.id, `asha.third${MAIL}`);
    ok("mail down: changed all the same", down.ok && (await emailOf(asha.id)) === `asha.third${MAIL}`, down.ok ? "" : down.error);
    const invitedDown = await USER.changeUserEmail(invited.id, `invited.b${MAIL}`);
    ok("  and somebody not set up: their link comes back to pass on", invitedDown.ok && invitedDown.data.setup?.emailed === false && /\/reset-password\?t=/.test(invitedDown.data.setup.setupUrl ?? ""), invitedDown.ok ? "no link" : invitedDown.error);
    mailDown = false;
    const before = await db.passwordResetToken.findFirst({ where: { userId: invited.id, usedAt: null }, select: { tokenHash: true } });
    const invitedChanged = await USER.changeUserEmail(invited.id, `invited.c${MAIL}`);
    const after = await db.passwordResetToken.findMany({ where: { userId: invited.id, usedAt: null }, select: { tokenHash: true } });
    ok("not set up yet: the setup email goes to the new address, the earlier link dead", invitedChanged.ok && invitedChanged.data.setup?.emailed === true && mail.length === 1 && mail[0]!.to === `invited.c${MAIL}` && after.length === 1 && after[0]!.tokenHash !== before?.tokenHash, mail);
    mail.length = 0;
    const offChanged = await USER.changeUserEmail(off.id, `off.new${MAIL}`);
    ok("switched off: changed, nobody written to, still off", offChanged.ok && mail.length === 0 && !(await db.user.findUniqueOrThrow({ where: { id: off.id }, select: { active: true } })).active);

    section("4. Two at once");
    const [x, y] = await Promise.all([USER.changeUserEmail(asha.id, `asha.x${MAIL}`), USER.changeUserEmail(asha.id, `asha.y${MAIL}`)]);
    const won = [x, y].filter((r) => r.ok);
    const now = await emailOf(asha.id);
    ok("one of them, and the account has the address that one says", won.length >= 1 && won.some((r) => r.ok && r.data.email === now), [x, y, now]);
    const same = await Promise.all([USER.changeUserEmail(asha.id, `race${MAIL}`), USER.changeUserEmail(other.id, `race${MAIL}`)]);
    ok("one address to two people: one of them gets it, the other is told", same.filter((r) => r.ok).length === 1 && same.some((r) => !r.ok && /already has that email/.test(r.error)), same);

    section("5. The dialog");
    const dialog = (mayChangeEmail: boolean) =>
      renderToStaticMarkup(
        createElement(EditStaffDialog, {
          row: {
            id: asha.id, name: asha.name, email: asha.email, role: "SALES", roleName: "Sales", isSuperAdmin: false, status: "active", active: true, setupPending: false, setupLinkIssued: false,
            tempPassword: false, photoUpdatedAt: null, jobTitle: null, phone: null, departmentId: null, departmentName: null, managerId: null, managerName: null, branchId: null, twoFactorOn: false,
            holds: 1, total: 2, exceptions: 0, lapsingSoon: false, openLeads: null, overdueLeads: null, lastSignIn: null, isYou: false, card: null,
          } as never,
          onClose: () => {},
          roles: [{ key: "SALES", name: "Sales" }],
          departments: [],
          people: [],
          branches: null,
          mayAssignRole: true,
          mayChangeManager: true,
          mayChangeEmail,
        }) as ReactElement,
      );
    ok("offered to the super admin", dialog(true).includes("Change email"));
    ok("  and to nobody else", !dialog(false).includes("Change email") && dialog(false).includes(asha.email));
  } finally {
    mailer.setTestPlatformMailer(null);
    await cleanup(db);
    ok("the fixtures are gone", (await db.user.count({ where: { email: { endsWith: MAIL } } })) === 0);
  }
  console.log(failures === 0 ? `\nAll ${passes} user email checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function cleanup(db: typeof import("../src/lib/db").db) {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.userSsoIdentity.deleteMany({ where: { userId: { in: ids } } });
  await db.apiKey.deleteMany({ where: { userId: { in: ids } } });
  await db.signIn.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
