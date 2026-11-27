/**
 * check:secret-confirm — confirming it's you with no Deskzo password to type (owner, 4 Nov 2026: "what if sso login is
 * enabled how do user put password here").
 *
 *   1. Opening a stored password: a Microsoft sign-in in the last two minutes confirms it, an older one doesn't; nor does a
 *      password sign-in, somebody else's sign-in (viewing as), or one that has ended. Passwords work as they did.
 *   2. Restore and reset (`confirmIdentity`): the same for fifteen minutes, with the two-factor code still asked after it.
 *   3. What the dialog is told, and that signing in again makes the provider ask, rather than pass straight through.
 *
 * Accounts on @zzprobe-sc.invalid, removed in a finally.
 *
 *   npm run check:secret-confirm
 */
import "dotenv/config";
import Module from "node:module";
import bcrypt from "bcryptjs";
import { directClient } from "../src/lib/tenancy/direct-client";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let sid: string | null = null;
let viewingAs = false;
let signInCall: unknown[] | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return {
      requireUser: async () => actor,
      currentUser: async () => actor,
      viewAsContext: async () => (viewingAs ? { actor } : null),
      refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody." : null),
    };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleAccess: async () => actor, requireModuleUser: async () => actor };
  }
  if (request === "@/lib/auth") {
    return {
      auth: async () => (actor ? { user: { ...actor, sid } } : null),
      signIn: async (...args: unknown[]) => {
        signInCall = args;
      },
    };
  }
  if (request === "@/lib/workplace/settings") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, signInProviders: async () => ["MICROSOFT"] };
  }
  if (request === "@/lib/notify") return { notifyUser: async () => undefined };
  if (request === "next/headers") return { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const MAIL = "@zzprobe-sc.invalid";
const SECRET = "the-stored-secret";
const PASSWORD = "Zz-correct-horse-1";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.signIn.deleteMany({ where: { userId: { in: ids } } });
  await db.vaultCredential.deleteMany({ where: { ownerId: { in: ids } } }).catch((e: unknown) => console.error("vault cleanup", String(e).slice(0, 300)));
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

let n = 0;
async function signedIn(userId: string, provider: string, minutesAgo: number, ended = false) {
  n += 1;
  sid = `zzprobe-sc-${n}`;
  await db.signIn.create({ data: { sid, userId, provider, at: new Date(Date.now() - minutesAgo * 60_000), ...(ended ? { endedAt: new Date() } : {}) } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { revealSecret } = require("../src/actions/vault") as typeof import("../src/actions/vault");
  const { secretConfirmation, reconfirmForSecret } = require("../src/actions/profile") as typeof import("../src/actions/profile");
  const { confirmIdentity } = require("../src/lib/security/confirm-identity") as typeof import("../src/lib/security/confirm-identity");
  const { noPasswordYet } = require("../src/lib/no-password") as typeof import("../src/lib/no-password");
  const { encryptSecret, digestSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");

  await cleanup();
  try {
    const make = async (name: string, passwordHash: string, extra: object = {}) =>
      db.user.create({
        data: { name: `Zzprobe ${name}`, email: `${name}${MAIL}`, role: "ADMIN", passwordHash, permissionGrants: { create: [{ permission: "vault.use", allowed: true, reason: "zzprobe" }] }, ...extra },
        select: { id: true, role: true, name: true, email: true },
      });
    const sso = await make("sso", noPasswordYet());
    const pw = await make("pw", await bcrypt.hash(PASSWORD, 4));
    const credential = async (ownerId: string, loginName: string) =>
      db.vaultCredential.create({ data: { ownerId, loginName, secretCipher: await encryptSecret(SECRET), secretDigest: await digestSecret(SECRET) }, select: { id: true } });
    const ssoRow = await credential(sso.id, "Zz sso login");
    const pwRow = await credential(pw.id, "Zz pw login");

    section("1. Opening a stored password, no Deskzo password");
    actor = sso;
    await signedIn(sso.id, "microsoft-entra-id", 60);
    let r = await revealSecret(ssoRow.id, "");
    ok("a Microsoft sign-in an hour old doesn't confirm", !r.ok, r);
    await signedIn(sso.id, "microsoft-entra-id", 3);
    r = await revealSecret(ssoRow.id, "");
    ok("  nor one three minutes old, and it isn't called a wrong password", !r.ok && r.error.includes("run out"), r);
    await signedIn(sso.id, "microsoft-entra-id", 1);
    r = await revealSecret(ssoRow.id, "");
    ok("one a minute old opens it", r.ok && r.data.secret === SECRET, r.ok ? "" : r);
    const audit = await db.auditLog.findFirst({ where: { userId: sso.id, entityId: ssoRow.id, entityLabel: { startsWith: "Opened" } }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
    ok("  and the record says how it was confirmed", !!audit?.entityLabel?.includes("confirmed by signing in again"), audit?.entityLabel ?? "");
    r = await revealSecret(ssoRow.id, "some-guess");
    ok("  a wrong password typed anyway is still wrong", !r.ok, r);
    await signedIn(sso.id, "credentials", 1);
    r = await revealSecret(ssoRow.id, "");
    ok("a password sign-in doesn't confirm", !r.ok, r);
    await signedIn(sso.id, "microsoft-entra-id", 1, true);
    r = await revealSecret(ssoRow.id, "");
    ok("  nor one that has been ended", !r.ok, r);
    await signedIn(pw.id, "microsoft-entra-id", 1);
    actor = sso;
    r = await revealSecret(ssoRow.id, "");
    ok("  nor somebody else's, as while viewing as them", !r.ok, r);

    section("2. An account with a password");
    actor = pw;
    await signedIn(pw.id, "credentials", 1);
    r = await revealSecret(pwRow.id, PASSWORD);
    ok("the password opens it", r.ok, r.ok ? "" : r);
    r = await revealSecret(pwRow.id, "wrong");
    ok("  a wrong one doesn't", !r.ok, r);
    r = await revealSecret(pwRow.id, "");
    ok("  nor none", !r.ok, r);

    section("3. Restore and reset");
    actor = sso;
    await signedIn(sso.id, "microsoft-entra-id", 10);
    r = await revealSecret(ssoRow.id, "");
    ok("ten minutes on, opening a secret needs confirming again", !r.ok, r);
    let proved = await confirmIdentity(sso.id, {}, "a test");
    ok("  but a restore or reset still takes it", proved.ok, proved);
    await signedIn(sso.id, "microsoft-entra-id", 20);
    proved = await confirmIdentity(sso.id, {}, "a test");
    ok("twenty minutes on, it doesn't", !proved.ok, proved);
    await signedIn(sso.id, "microsoft-entra-id", 1);
    await db.user.update({ where: { id: sso.id }, data: { twoFactorEnabledAt: new Date(), twoFactorSecretCipher: await encryptSecret("JBSWY3DPEHPK3PXP") } });
    proved = await confirmIdentity(sso.id, {}, "a test");
    ok("with two-factor on, the code is still asked after it", !proved.ok && proved.needsCode === true, proved);
    await db.user.update({ where: { id: sso.id }, data: { twoFactorEnabledAt: null, twoFactorSecretCipher: null } });

    section("4. What the dialog is told");
    await signedIn(sso.id, "microsoft-entra-id", 60);
    let c = await secretConfirmation("open");
    ok("no password, not just confirmed: offered Microsoft", !c.hasPassword && !c.justConfirmed && c.mayReconfirm && c.providerName === "Microsoft", c);
    await signedIn(sso.id, "microsoft-entra-id", 1);
    c = await secretConfirmation("open");
    ok("just confirmed", c.justConfirmed, c);
    viewingAs = true;
    c = await secretConfirmation("open");
    ok("while viewing as somebody, signing in again isn't offered", !c.mayReconfirm, c);
    signInCall = null;
    await reconfirmForSecret("microsoft-entra-id", "/vault");
    ok("  nor done", signInCall === null);
    viewingAs = false;
    actor = pw;
    await signedIn(pw.id, "credentials", 1);
    c = await secretConfirmation("open");
    ok("signed in with a password: the box, and no Microsoft", c.hasPassword && !c.mayReconfirm, c);
    await signedIn(pw.id, "microsoft-entra-id", 60);
    c = await secretConfirmation("open");
    ok("signed in with Microsoft, with a password: both", c.hasPassword && c.mayReconfirm, c);

    section("5. What the dialog shows");
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const { createElement } = require("react") as typeof import("react");
    const { SecretConfirmFields, secretConfirmed } = require("../src/components/security/secret-confirmation") as typeof import("../src/components/security/secret-confirmation");
    const base = { provider: "microsoft-entra-id", providerName: "Microsoft" };
    const show = (state: { hasPassword: boolean; justConfirmed: boolean; mayReconfirm: boolean }) =>
      renderToStaticMarkup(createElement(SecretConfirmFields, { confirmation: { ...base, ...state }, id: "x", password: "", onPassword: () => undefined }));
    let html = show({ hasPassword: false, justConfirmed: false, mayReconfirm: true });
    ok("no password: the Microsoft button, and no password box", html.includes("Confirm with Microsoft") && !html.includes('type="password"'));
    html = show({ hasPassword: false, justConfirmed: true, mayReconfirm: true });
    ok("just confirmed: says so", html.includes("You just signed in with Microsoft") && !html.includes('type="password"'));
    html = show({ hasPassword: true, justConfirmed: false, mayReconfirm: true });
    ok("a password, signed in with Microsoft: the box, or Microsoft", html.includes('type="password"') && html.includes("Or confirm with Microsoft"));
    html = show({ hasPassword: true, justConfirmed: false, mayReconfirm: false });
    ok("a password alone: the box only", html.includes('type="password"') && !html.includes("confirm with Microsoft"));
    const asked = { ...base, hasPassword: false, justConfirmed: false, mayReconfirm: true };
    ok("the button stays off until confirmed", !secretConfirmed(asked, "") && secretConfirmed({ ...asked, justConfirmed: true }, "") && !secretConfirmed(null, "x") && secretConfirmed({ ...asked, hasPassword: true }, "x"));

    section("6. Signing in again");
    actor = sso;
    await reconfirmForSecret("microsoft-entra-id", "/vault?x=1");
    const [id, options, params] = (signInCall ?? []) as unknown as [string, { redirectTo: string }, Record<string, string>];
    ok("goes to Microsoft and straight back", id === "microsoft-entra-id" && options.redirectTo === "/vault?x=1", signInCall);
    ok("  made to ask, for the right person", params.prompt === "login" && params.login_hint === sso.email, params);
    signInCall = null;
    await reconfirmForSecret("microsoft-entra-id", "https://elsewhere.example/");
    const [, away] = (signInCall ?? []) as unknown as [string, { redirectTo: string }];
    ok("  never back to another site", away.redirectTo === "/profile", away);
    signInCall = null;
    await reconfirmForSecret("google", "/vault");
    ok("  and only by a way in the company has on", signInCall === null);
  } finally {
    actor = null;
    await cleanup().catch((e) => console.error("cleanup", String(e).slice(0, 300)));
  }
  console.log(failures === 0 ? `\nAll ${passes} confirm-it's-you checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
