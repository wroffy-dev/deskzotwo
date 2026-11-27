/**
 * check:audit-fixes-b — the security audit of 11 Nov 2026 (docs/reports/security-audit-2026-11-11.md), group B: sign-in,
 * sessions, keys, backups, public forms and headers. Each fix shown to hold the way it was broken, by calling the
 * server's own code as a hand-made request would.
 *
 *   SEC-21  a correct password no longer clears the count of wrong authenticator codes
 *   SEC-22  a new password or two-factor change ends the person's other sign-ins and phones
 *   SEC-23  confirming it's you has a limit, and the session that ran it out is ended
 *   SEC-24  a full backup download needs the person's password, and the super admin is told
 *   SEC-59/60  backup files only from the workspace's own folder; unsigned uploads refused; Origin checked
 *   SEC-25/50  API keys end with sign-ins and after a year; a good key isn't locked out by others' failures
 *   SEC-26  no pushes to a signed-out or switched-off phone
 *   SEC-32  a burst of portal-code guesses gets no more tries than one at a time
 *   SEC-35/63/64/58  form budget by caller, unsubscribe answer, Razorpay event id, headers
 *
 * A fixture of its own in the local database — accounts on @zzb.invalid, a company named ZZB… — removed in a finally.
 * Assertions are on the fixture only: the local database is full.
 *
 *   npx tsx scripts/check-audit-fixes-b.ts
 */
import "dotenv/config";
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";

process.env.TRUST_PROXY = "1";
delete process.env.TRUST_PROXY_CLOUDFLARE;
delete process.env.BACKUP_ALLOW_UNSIGNED_RESTORE;

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let sid: string | null = null;
const callerIp = "203.0.113.7";
const notices: { userId: string; title: string }[] = [];

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => actor;
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null, UnauthorizedError: class extends Error {} };
  }
  if (request === "@/lib/auth") return { auth: async () => (actor ? { user: { ...actor, sid } } : null), signIn: async () => undefined };
  if (request === "@/lib/notify") {
    return {
      notifyUser: async (n: { userId: string; title: string }) => {
        notices.push(n);
      },
    };
  }
  if (request === "next/headers") {
    return { headers: async () => new Headers({ "x-forwarded-for": callerIp }), cookies: async () => ({ get: () => undefined, set: () => undefined }) };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const MAIL = "@zzb.invalid";
const TAG = "ZZB";
const PASSWORD = "Zzb-correct-horse-1";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/* eslint-disable @typescript-eslint/no-require-imports */
const { db } = require("../src/lib/db") as typeof import("../src/lib/db");

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.portalLogin.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.apiKey.deleteMany({ where: { userId: { in: ids } } });
  await db.appDevice.deleteMany({ where: { userId: { in: ids } } });
  await db.signIn.deleteMany({ where: { userId: { in: ids } } });
  await db.userDevice.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await db.activityLog.deleteMany({ where: { userEmail: { endsWith: MAIL } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

let n = 0;
async function signIn(userId: string, provider = "credentials", deviceId: string | null = null) {
  n += 1;
  const made = `zzb-sid-${Date.now()}-${n}`;
  await db.signIn.create({ data: { sid: made, userId, provider, ...(deviceId ? { deviceId } : {}) } });
  return made;
}
const ended = async (s: string) => !!(await db.signIn.findUnique({ where: { sid: s }, select: { endedAt: true } }))?.endedAt;

async function phone(userId: string, token = "zzb-push-token") {
  n += 1;
  const device = await db.userDevice.create({ data: { userId, kind: "MOBILE", status: "APPROVED", label: "ZZB phone", tokenHash: `zzb-${Date.now()}-${n}` } as never, select: { id: true } });
  const app = await db.appDevice.create({ data: { userId, deviceId: device.id, platform: "android", model: "ZZB", pushToken: token } as never, select: { id: true } });
  const appSid = await signIn(userId, "app-code", device.id);
  return { deviceId: device.id, appDeviceId: app.id, appSid };
}

async function main() {
  const lockout = require("../src/lib/security/lockout") as typeof import("../src/lib/security/lockout");
  const { tenantKey } = require("../src/lib/tenancy/cache") as typeof import("../src/lib/tenancy/cache");
  const { encryptSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");

  await cleanup();
  try {
    const make = async (name: string, extra: object = {}, grants: string[] = []) =>
      db.user.create({
        data: {
          name: `Zzb ${name}`,
          email: `${name}${MAIL}`,
          role: "ADMIN",
          passwordHash: await bcrypt.hash(PASSWORD, 4),
          ...(grants.length ? { permissionGrants: { create: grants.map((permission) => ({ permission, allowed: true, reason: "zzb" })) } } : {}),
          ...extra,
        },
        select: { id: true, role: true, name: true, email: true },
      });
    const workspace = await tenantKey();

    section("SEC-21: wrong authenticator codes outlive a correct password");
    const { checkCredentials } = require("../src/actions/auth") as typeof import("../src/actions/auth");
    const twofa = await make("twofa", { twoFactorEnabledAt: new Date(), twoFactorSecretCipher: await encryptSecret("JBSWY3DPEHPK3PXP") });
    lockout.resetLockouts();
    let creds = await checkCredentials(twofa.email, "wrong-one");
    for (let i = 1; i < lockout.MAX_FAILURES - 1; i += 1) creds = await checkCredentials(twofa.email, `wrong-${i}`);
    creds = await checkCredentials(twofa.email, PASSWORD);
    ok("the password is still checked and the code asked for", creds.ok && creds.needsTotp, creds);
    creds = await checkCredentials(twofa.email, "wrong-last");
    const afterRight = await checkCredentials(twofa.email, PASSWORD);
    ok("  the seven wrong ones before it are not forgotten by a right one: one more locks it", !afterRight.ok && /Too many attempts/.test(afterRight.error), afterRight);
    lockout.resetLockouts();
    const codeKey = lockout.twoFactorLockKey(workspace, twofa.email);
    for (let i = 0; i < lockout.MAX_FAILURES; i += 1) lockout.recordFailure([codeKey]);
    creds = await checkCredentials(twofa.email, PASSWORD);
    ok("after eight wrong codes, the right password is still refused", !creds.ok && /Too many attempts/.test(creds.error), creds);
    const authSource = source("src/lib/auth.ts");
    ok("  sign-in counts a wrong code on its own key and clears it only after everything passed", authSource.includes("recordFailure([codeKey])") && authSource.includes("clearFailures([...keys, codeKey])") && authSource.includes("lockoutState([...keys, codeKey])"));
    ok("  and the page's password check clears nothing", !/clearFailures\(/.test(source("src/actions/auth.ts")));
    lockout.resetLockouts();

    section("SEC-22: a new password or second factor ends the other sign-ins");
    const { changeOwnPassword, disableOwnTwoFactor } = require("../src/actions/profile") as typeof import("../src/actions/profile");
    const { createApiKey } = require("../src/lib/api/keys") as typeof import("../src/lib/api/keys");
    const { API_SCOPE_KEYS } = require("../src/lib/api/scopes") as typeof import("../src/lib/api/scopes");
    const me = await make("me", {}, ["api.manage"]);
    actor = me;
    const here = await signIn(me.id);
    const elsewhere = await signIn(me.id);
    const myPhone = await phone(me.id);
    const key = await createApiKey(me.id, { name: "ZZB key", scopes: [API_SCOPE_KEYS[0]], expiresAt: null });
    sid = here;
    const changed = await changeOwnPassword({ currentPassword: PASSWORD, newPassword: `${PASSWORD}-new`, confirmPassword: `${PASSWORD}-new` });
    ok("the password changes", changed.ok, changed);
    ok("  this session stays signed in", !(await ended(here)));
    ok("  the other browser is signed out", await ended(elsewhere));
    ok("  and the phone too, its push address gone", (await ended(myPhone.appSid)) && (await db.appDevice.findUnique({ where: { id: myPhone.appDeviceId }, select: { pushToken: true } }))?.pushToken === null);
    ok("  and the API key made before is revoked", !!(await db.apiKey.findUnique({ where: { id: key.id }, select: { revokedAt: true } }))?.revokedAt);
    const again = await signIn(me.id);
    const key2 = await createApiKey(me.id, { name: "ZZB key 2", scopes: [API_SCOPE_KEYS[0]], expiresAt: null });
    await db.user.update({ where: { id: me.id }, data: { twoFactorEnabledAt: new Date(), twoFactorSecretCipher: await encryptSecret("JBSWY3DPEHPK3PXP") } });
    const off = await disableOwnTwoFactor({ currentPassword: `${PASSWORD}-new` });
    ok("switching two-factor off ends the other sign-ins", off.ok && (await ended(again)) && !(await ended(here)), off);
    ok("  but leaves API keys, which never answered to two-factor", !(await db.apiKey.findUnique({ where: { id: key2.id }, select: { revokedAt: true } }))?.revokedAt);

    section("SEC-25: a reset by emailed link ends keys with the sign-ins");
    const { resetPassword } = require("../src/actions/password-reset") as typeof import("../src/actions/password-reset");
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const resetToken = "zzb-reset-token-0123456789";
    await db.passwordResetToken.create({ data: { tokenHash: createHash("sha256").update(resetToken).digest("hex"), userId: me.id, expiresAt: new Date(Date.now() + 600_000) } });
    const reset = await resetPassword({ token: resetToken, password: `${PASSWORD}-reset` });
    ok("the reset ends every sign-in, this one included, and every key", reset.ok && (await ended(here)) && !!(await db.apiKey.findUnique({ where: { id: key2.id }, select: { revokedAt: true } }))?.revokedAt, reset);

    section("SEC-23: confirming it's you has a limit");
    const { confirmIdentity } = require("../src/lib/security/confirm-identity") as typeof import("../src/lib/security/confirm-identity");
    const guesser = await make("guesser");
    actor = guesser;
    sid = await signIn(guesser.id);
    lockout.resetLockouts();
    let proved: Awaited<ReturnType<typeof confirmIdentity>> = { ok: true };
    for (let i = 0; i < lockout.MAX_FAILURES; i += 1) proved = await confirmIdentity(guesser.id, { password: `guess-${i}` }, "a test");
    ok("the eighth wrong password locks it, and says so", !proved.ok && /Too many wrong tries/.test(proved.error), proved);
    ok("  the session that guessed is ended", await ended(sid));
    proved = await confirmIdentity(guesser.id, { password: PASSWORD }, "a test");
    ok("  and the right password is refused until the lockout passes", !proved.ok && /Too many wrong tries/.test(proved.error), proved);
    lockout.resetLockouts();
    proved = await confirmIdentity(guesser.id, { password: PASSWORD }, "a test");
    ok("after it, the right password confirms", proved.ok, proved);

    section("SEC-24/59/60: backups");
    const { backupFilePath, unsignedRestoreAllowed } = require("../src/lib/backup/maintenance") as typeof import("../src/lib/backup/maintenance");
    const root = path.resolve("zzb-backups");
    ok("a backup's file is read from the workspace's own folder", backupFilePath(root, root, "deskzo-2026.dump") === path.join(root, "deskzo-2026.dump"));
    ok("  not from another folder a row names", backupFilePath(root, path.join(root, "workspaces", "other"), "x.dump") === null && backupFilePath(root, "/etc", "passwd") === null);
    ok("  nor by a name that climbs out or hides", [backupFilePath(root, root, "../x.dump"), backupFilePath(root, null, "a/b.dump"), backupFilePath(root, null, "..\\x.dump"), backupFilePath(root, null, ".restore")].every((p) => p === null));
    ok("unsigned uploads are refused in the first workspace too, unless the server says otherwise", !unsignedRestoreAllowed({ isDefault: true }) && !unsignedRestoreAllowed({ isDefault: false }));
    process.env.BACKUP_ALLOW_UNSIGNED_RESTORE = "1";
    ok("  with BACKUP_ALLOW_UNSIGNED_RESTORE=1, the first workspace only", unsignedRestoreAllowed({ isDefault: true }) && !unsignedRestoreAllowed({ isDefault: false }));
    delete process.env.BACKUP_ALLOW_UNSIGNED_RESTORE;

    const { sameOrigin } = require("../src/lib/http/same-origin") as typeof import("../src/lib/http/same-origin");
    const req = (h: Record<string, string>) => new Request("http://acme.localhost:3000/api/backups/x/download", { method: "POST", headers: { host: "acme.localhost:3000", ...h } });
    ok("Origin: this host passes, another refused, none refused", sameOrigin(req({ origin: "http://acme.localhost:3000" })) && !sameOrigin(req({ origin: "https://evil.example" })) && !sameOrigin(req({})));
    ok("  a form from a no-referrer page (Origin: null) passes only on the browser's same-origin word", sameOrigin(req({ origin: "null", "sec-fetch-site": "same-origin" })) && !sameOrigin(req({ origin: "null", "sec-fetch-site": "cross-site" })) && !sameOrigin(req({ origin: "null" })));

    const download = require("../src/app/api/backups/[id]/download/route") as typeof import("../src/app/api/backups/[id]/download/route");
    const keeper = await make("keeper", {}, ["backups.download"]);
    actor = keeper;
    sid = await signIn(keeper.id);
    lockout.resetLockouts();
    const post = async (fields: Record<string, string>, origin: string | null = "http://acme.localhost:3000") => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      const r = new Request("http://acme.localhost:3000/api/backups/zzb-missing/download", { method: "POST", headers: { host: "acme.localhost:3000", ...(origin ? { origin } : {}) }, body: form });
      const res = await download.POST(r, { params: Promise.resolve({ id: "zzb-missing" }) });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as { error?: string } };
    };
    const passphrase = "a long enough passphrase for zzb";
    let answer = await post({ passphrase, password: PASSWORD }, "https://evil.example");
    ok("a download posted from another site is refused", answer.status === 403, answer);
    answer = await post({ passphrase });
    ok("  a session alone isn't enough: the password is asked", answer.status === 400 && /password/i.test(answer.body.error ?? ""), answer);
    answer = await post({ passphrase, password: "wrong" });
    ok("  a wrong one is refused", answer.status === 400 && /isn't right/.test(answer.body.error ?? ""), answer);
    answer = await post({ passphrase, password: PASSWORD });
    ok("  the right one gets as far as the backup itself", answer.status === 404, answer);
    const downloadSource = source("src/app/api/backups/[id]/download/route.ts");
    ok("  and a finished download tells the super admin", downloadSource.includes("notifySuperAdminOfDownload(user, outName)") && downloadSource.includes("isSuperAdmin: true"));
    for (const file of ["src/app/api/backups/[id]/stage/route.ts", "src/app/api/backups/upload/route.ts", "src/app/api/backups/restore/route.ts"]) {
      ok(`  ${file.split("/").slice(-2).join("/")} checks the Origin first`, /export async function POST\(request: Request[^)]*\) \{\s*\/\/[^\n]*\n\s*if \(!sameOrigin\(request\)\)/.test(source(file)));
    }

    section("SEC-25/50: API keys");
    const { keyExpiry } = require("../src/lib/api/key-lifetime") as typeof import("../src/lib/api/key-lifetime");
    const year = 365 * 86_400_000;
    const made = new Date("2026-01-01T00:00:00Z");
    ok("a key with no expiry ends a year after it was made", keyExpiry({ createdAt: made, expiresAt: null }).getTime() === made.getTime() + year);
    ok("  one set for longer is held to the year; a shorter one keeps its own", keyExpiry({ createdAt: made, expiresAt: new Date(made.getTime() + 2 * year) }).getTime() === made.getTime() + year && keyExpiry({ createdAt: made, expiresAt: new Date(made.getTime() + 86_400_000) }).getTime() === made.getTime() + 86_400_000);

    const { apiRoute } = require("../src/lib/api/handler") as typeof import("../src/lib/api/handler");
    const route = apiRoute({ scope: null }, async () => ({ data: { pong: true } }));
    const apiUser = await make("api", {}, ["api.manage"]);
    const good = await createApiKey(apiUser.id, { name: "ZZB api", scopes: [API_SCOPE_KEYS[0]], expiresAt: null });
    const call = (token: string, ip: string) => route(new Request("http://acme.localhost:3000/api/v1/me", { headers: { host: "acme.localhost:3000", authorization: `Bearer ${token}`, "x-forwarded-for": ip } }));
    lockout.resetLockouts();
    const shared = "198.51.100.23";
    let last = 0;
    for (let i = 0; i <= lockout.MAX_FAILURES; i += 1) last = (await call("dzk_00000000000000000000.dzs_wrong", shared)).status;
    ok("somebody's wrong keys lock their address out", last === 429, last);
    const fromShared = await call(good.token, shared);
    ok("  but a good key from that same address is still checked and let in", fromShared.status !== 429 && fromShared.status !== 401, fromShared.status);
    await db.apiKey.update({ where: { id: good.id }, data: { createdAt: new Date(Date.now() - 400 * 86_400_000) } });
    const old = await call(good.token, "198.51.100.99");
    ok("a key made more than a year ago no longer works, though it was set to never expire", old.status === 401, old.status);
    lockout.resetLockouts();

    section("SEC-25: switched off or reset by an admin ends keys too");
    const { endSignInsFor } = require("../src/lib/security/end-sign-ins") as typeof import("../src/lib/security/end-sign-ins");
    const leaver = await make("leaver", {}, ["api.manage"]);
    const leaverKey = await createApiKey(leaver.id, { name: "ZZB leaver", scopes: [API_SCOPE_KEYS[0]], expiresAt: null });
    const leaverSid = await signIn(leaver.id);
    const endedCounts = await endSignInsFor(leaver.id, { byId: me.id });
    ok("ending somebody's sign-ins ends their keys", endedCounts.signIns === 1 && endedCounts.apiKeys === 1 && (await ended(leaverSid)) && !!(await db.apiKey.findUnique({ where: { id: leaverKey.id }, select: { revokedAt: true } }))?.revokedAt, endedCounts);
    const userSource = source("src/actions/user.ts");
    ok("  and deactivating and an admin's temporary password both do it", /if \(!active && target\.active\) await endSignInsFor\(id, \{ tx, byId: admin\.id \}\)/.test(userSource) && userSource.includes("await endSignInsFor(target.id, { tx, now, byId: admin.id })"));

    section("SEC-26: pushes only to a phone still signed in");
    const push = require("../src/lib/app/push") as typeof import("../src/lib/app/push");
    const sent: unknown[] = [];
    push.setTestPush(async (m) => {
      sent.push(m);
      return 200;
    });
    const pushed = await make("pushed");
    const p = await phone(pushed.id, "zzb-live-token");
    ok("a signed-in phone gets the notice", (await push.pushNoticeToPhones(pushed.id, { id: "n1", type: "TASK", title: "ZZB", link: null })) === 1);
    await db.signIn.update({ where: { sid: p.appSid }, data: { endedAt: new Date() } });
    ok("  one signed out — its push address still there — gets nothing", (await push.pushNoticeToPhones(pushed.id, { id: "n2", type: "TASK", title: "ZZB", link: null })) === 0 && (await push.pushChatToPhones([pushed.id], { id: "c1", title: "ZZB" })) === 0);
    const p2 = await phone(pushed.id, "zzb-live-token-2");
    await db.user.update({ where: { id: pushed.id }, data: { active: false } });
    ok("  nor a switched-off person's phone", (await push.pushNoticeToPhones(pushed.id, { id: "n3", type: "TASK", title: "ZZB", link: null })) === 0 && !(await push.phoneMayBePushed(p2.appDeviceId)));
    push.setTestPush(null);

    section("SEC-32: a burst of portal-code guesses");
    const { checkCode } = require("../src/lib/portal/device") as typeof import("../src/lib/portal/device");
    const company = await db.company.create({ data: { name: `${TAG} Portal Co`, normalizedName: `${TAG.toLowerCase()} portal co`, createdById: me.id }, select: { id: true } });
    const login = await db.portalLogin.create({ data: { token: `zzb-portal-${Date.now()}`, companyId: company.id, personName: "Zzb Person", personEmail: `person${MAIL}` }, select: { id: true } });
    const code = await db.portalCode.create({ data: { loginId: login.id, codeHash: "x".repeat(64), expiresAt: new Date(Date.now() + 600_000) }, select: { id: true } });
    const guesses = await Promise.all(Array.from({ length: 25 }, (_, i) => checkCode(login.id, String(100000 + i))));
    const tried = guesses.filter((g) => !g.ok && /not the code|not it/.test(g.error)).length;
    const row = await db.portalCode.findUnique({ where: { id: code.id }, select: { attempts: true, usedAt: true } });
    ok("twenty-five guesses at once get five tries between them", tried <= 5 && (row?.attempts ?? 99) <= 5 && !!row?.usedAt, { tried, row });
    // The try claimed in one conditional update, whatever else the where asks (GitHub's also asks verifiedAt and expiry).
    ok("  signup's code claims its try the same way", /pendingSignup\.updateMany\(\{\s*where: \{ id: pending\.id,[^}]*attempts: \{ lt: MAX_CODE_ATTEMPTS \}/.test(source("src/actions/platform/signup.ts")));

    section("SEC-35: a public form counts its caller, not just the address typed");
    const { withinCallerBudget, resetCallerBudgets } = require("../src/lib/security/caller-budget") as typeof import("../src/lib/security/caller-budget");
    resetCallerBudgets();
    const limits = [{ key: "zzb|form:1:ip", max: 3 }, { key: "zzb|forms:ip", max: 5 }];
    const answers = Array.from({ length: 4 }, () => withinCallerBudget(limits, 3_600_000));
    ok("the fourth from one caller is refused, whatever email it types", answers.join() === "true,true,true,false", answers);
    ok("  submitForm asks it, by the caller's address", /withinCallerBudget\(\s*\[\s*\{ key: `\$\{workspace\}\|form-caller:/.test(source("src/actions/marketing-public.ts")));
    resetCallerBudgets();

    section("SEC-63: one-click unsubscribe says the same either way");
    const unsubscribe = require("../src/app/api/marketing/unsubscribe/[token]/route") as typeof import("../src/app/api/marketing/unsubscribe/[token]/route");
    const res = await unsubscribe.POST(new Request("http://acme.localhost:3000/api/marketing/unsubscribe/zzb-nothing", { method: "POST" }), { params: Promise.resolve({ token: "zzb-not-a-real-token" }) });
    const body = await res.json();
    ok("an unknown token: 200 and { ok: true }, nothing more", res.status === 200 && JSON.stringify(body) === '{"ok":true}', body);

    section("SEC-64: Razorpay's event id from the signed body");
    const { razorpayEventId } = require("../src/lib/billing/webhooks") as typeof import("../src/lib/billing/webhooks");
    const event = { entity: "event" as const, event: "subscription.charged", created_at: 1762900000, payload: { subscription: { entity: { id: "sub_ZZB" } } } } as Parameters<typeof razorpayEventId>[0];
    const raw = JSON.stringify(event);
    ok("the same signed body is the same event, whatever header comes with it", razorpayEventId(event, raw) === "subscription.charged:sub_ZZB:1762900000");
    ok("  and the header isn't read at all", !/eventIdHeader\?\.trim\(\)/.test(source("src/lib/billing/webhooks.ts")));

    section("SEC-58: headers");
    const config = (require("../next.config") as { default: { headers: () => Promise<{ source: string; has?: unknown[]; headers: { key: string; value: string }[] }[]> } }).default;
    const rules = await config.headers();
    const valueOf = (key: string, onlyApi: boolean) => rules.filter((r) => (onlyApi ? r.source === "/api/:path*" : r.source === "/:path*")).flatMap((r) => r.headers).filter((h) => h.key === key);
    ok("HSTS for a year everywhere, with subdomains only on the platform's own domain", valueOf("Strict-Transport-Security", false).some((h) => h.value === "max-age=31536000") && rules.some((r) => r.has && r.headers.some((h) => h.value === "max-age=31536000; includeSubDomains")));
    ok("/api answers get nosniff and no-referrer", valueOf("X-Content-Type-Options", true)[0]?.value === "nosniff" && valueOf("Referrer-Policy", true)[0]?.value === "no-referrer");
    const proxySource = source("src/proxy.ts");
    ok("pages get a narrow CSP: base-uri, object-src, frame-ancestors as X-Frame-Options already says", proxySource.includes(`"base-uri 'self'", "object-src 'none'"`) && proxySource.includes(`"frame-ancestors 'self'"`) && proxySource.includes('pathname.startsWith("/forms/")'));
    ok("  and no script or style rules that could stop a page working", !/script-src|style-src/.test(proxySource.slice(proxySource.indexOf("function contentSecurityPolicyFor"), proxySource.indexOf("function contentSecurityPolicyFor") + 400)));
  } finally {
    actor = null;
    await cleanup().catch((e) => console.error("cleanup", String(e).slice(0, 300)));
    await db.$disconnect().catch(() => undefined);
  }
  console.log(failures === 0 ? `\nAll ${passes} audit-fix (group B) checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
