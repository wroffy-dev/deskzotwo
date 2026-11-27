/**
 * check:two-factor-sso — setting up two-factor on an account that signs in with Microsoft (owner, 3 Nov 2026: "when a
 * user signs in with Microsoft, two-factor setup asks for a password? how will they know it?").
 *
 * An account with no Deskzo password: refused without a fresh Microsoft sign-in, told why, and let through with one;
 * a Microsoft sign-in older than 15 minutes doesn't count. An account with a password still uses it. Accounts on
 * @zzprobe-tf.invalid, removed in a finally.
 *
 * And the Password card the same way (owner, 3 Nov 2026): a new password without the current one after a fresh
 * Microsoft sign-in; the current one still asked of a password account; nothing at all where the sign-in rule is
 * Microsoft only.
 *
 *   npm run check:two-factor-sso
 */
import "dotenv/config";
import Module from "node:module";
import bcrypt from "bcryptjs";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; role: string; name: string; email: string } | null = null;
let sid: string | null = null;
const mailed: string[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/auth") return { auth: async () => (actor ? { user: { ...actor, sid } } : null), signIn: async () => undefined };
  if (request === "@/lib/notify") return { notifyUser: async () => undefined };
  if (request === "next/headers") return { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) };
  if (request === "@/lib/platform/mailer") return { sendPlatformMail: async (m: { to: string }) => void mailed.push(m.to) };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const MAIL = "@zzprobe-tf.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.signIn.deleteMany({ where: { userId: { in: ids } } });
  await db.signInRule.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { beginTwoFactorSetup, twoFactorIdentity, changeOwnPassword, passwordChange, emailMyPasswordLink } = require("../src/actions/profile") as typeof import("../src/actions/profile");
  const { noPasswordYet } = require("../src/lib/no-password") as typeof import("../src/lib/no-password");

  await cleanup();
  try {
    const sso = await db.user.create({ data: { name: "Zzprobe Microsoft", email: `sso${MAIL}`, role: "SALES", passwordHash: noPasswordYet() }, select: { id: true, role: true, name: true, email: true } });
    const pw = await db.user.create({ data: { name: "Zzprobe Password", email: `pw${MAIL}`, role: "SALES", passwordHash: await bcrypt.hash("Zz-correct-horse-1", 10) }, select: { id: true, role: true, name: true, email: true } });

    console.log("\n— Signs in with Microsoft, no Deskzo password —\n");
    actor = sso;
    sid = "zzprobe-tf-old";
    await db.signIn.create({ data: { sid, userId: sso.id, provider: "microsoft-entra-id", at: new Date(Date.now() - 60 * 60_000) } });
    let who = await twoFactorIdentity();
    ok("it has no password, and an hour-old Microsoft sign-in isn't fresh", !who.hasPassword && !who.freshSignIn && who.providerName === "Microsoft", who);
    let r = await beginTwoFactorSetup({});
    ok("setting up is refused, saying to confirm with Microsoft", !r.ok && /no Deskzo password.*Confirm with Microsoft/.test(r.error), r);

    sid = "zzprobe-tf-new";
    await db.signIn.create({ data: { sid, userId: sso.id, provider: "microsoft-entra-id" } });
    who = await twoFactorIdentity();
    ok("a Microsoft sign-in a moment ago is fresh", who.freshSignIn, who);
    r = await beginTwoFactorSetup({});
    ok("…and setting up goes ahead without a password", r.ok, r.ok ? "" : r);

    console.log("\n— Signs in with a password —\n");
    actor = pw;
    sid = "zzprobe-tf-pw";
    await db.signIn.create({ data: { sid, userId: pw.id, provider: "credentials" } });
    who = await twoFactorIdentity();
    ok("it has a password, and a password sign-in is no proof on its own", who.hasPassword && !who.freshSignIn, who);
    r = await beginTwoFactorSetup({});
    ok("no password typed: asked for it", !r.ok && r.error === "Enter your current password.", r);
    r = await beginTwoFactorSetup({ currentPassword: "wrong" });
    ok("a wrong one: refused", !r.ok && r.error === "Current password is incorrect.", r);
    r = await beginTwoFactorSetup({ currentPassword: "Zz-correct-horse-1" });
    ok("the right one: goes ahead", r.ok, r.ok ? "" : r);

    console.log("\n— The Password card —\n");
    let card = await passwordChange();
    ok("a password account is asked for its current password", card.allowed && card.needsCurrent && !card.needsReconfirm, card);
    let p = await changeOwnPassword({ newPassword: "Zz-new-horse-22", confirmPassword: "Zz-new-horse-22" });
    ok("…and refused without it", !p.ok && p.error === "Enter your current password.", p);

    actor = sso;
    sid = "zzprobe-tf-old";
    card = await passwordChange();
    ok("a Microsoft account signed in an hour ago: confirm with Microsoft first", card.allowed && card.needsReconfirm, card);
    p = await changeOwnPassword({ newPassword: "Zz-new-horse-22", confirmPassword: "Zz-new-horse-22" });
    ok("…and refused until then", !p.ok && /Confirm with Microsoft/.test(p.error), p);
    sid = "zzprobe-tf-new";
    card = await passwordChange();
    ok("signed in with Microsoft a moment ago: no current password asked", card.allowed && !card.needsCurrent && !card.needsReconfirm, card);
    p = await changeOwnPassword({ newPassword: "Zz-new-horse-22", confirmPassword: "Zz-new-horse-22" });
    const set = await db.user.findUniqueOrThrow({ where: { id: sso.id }, select: { passwordHash: true } });
    ok("…and the new password is set", p.ok && (await bcrypt.compare("Zz-new-horse-22", set.passwordHash)), p);

    // It has a password now, but signs in with Microsoft — "a current password he doesn't have" (owner, 3 Nov 2026).
    sid = "zzprobe-tf-old";
    card = await passwordChange();
    ok("a password, but signed in with Microsoft: Microsoft leads, the password still offered", card.needsReconfirm && card.hasPassword && card.needsCurrent, card);
    const sent = await emailMyPasswordLink();
    const token = await db.passwordResetToken.findFirst({ where: { userId: sso.id, usedAt: null } });
    ok("\"Email me a link\" sends the sign-in page's reset link to their own address", sent.ok && mailed.includes(`sso${MAIL}`) && !!token, sent);
    sid = "zzprobe-tf-new";

    await db.signInRule.create({ data: { userId: sso.id, method: "MICROSOFT" } });
    card = await passwordChange();
    ok("Microsoft only, by the admin's rule: no password to set", !card.allowed, card);
    p = await changeOwnPassword({ newPassword: "Zz-other-horse-3", confirmPassword: "Zz-other-horse-3" });
    ok("…and refused, saying why", !p.ok && /only — your administrator set it/.test(p.error), p);
    const none = await emailMyPasswordLink();
    ok("…and no link either", !none.ok, none);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
