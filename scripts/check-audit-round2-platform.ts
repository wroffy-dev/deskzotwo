/**
 * check:audit-round2-platform — round two of the security audit (docs/reports/security-audit-2026-11-11.md §11), the
 * billing hold, Razorpay, the tenancy cache, the console's step-up and the lockout, each shown to hold the way it was
 * broken:
 *
 *   R2-05  a workspace held for non-payment runs billing's actions and nothing else
 *   R2-06  Razorpay "authenticated" with no payment stays INCOMPLETE
 *   R2-07  the host lookup cache stays bounded under random misses; tls-ask answers only the HTTPS proxy
 *   R2-08  a console owner's dangerous change needs a fresh authenticator code
 *   R2-16  a live lock survives a flood of other keys; IPv6 callers share a /64; a staff code works once
 *   lows   webhook-free: platform hosts, access-log redaction
 *
 * Pure rules first, then a staff fixture of its own in the control plane, tagged ZZR2T, removed in a finally.
 *
 *   npx tsx scripts/check-audit-round2-platform.ts
 */
import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import Module from "node:module";
import { authenticator } from "otplib";

// Next's request store is a real AsyncLocalStorage only where Next's server set one up; this check runs actions
// inside one of its own, as the server does.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

process.env.DESKZO_TENANCY_FALLBACK = "legacy";

const TAG = "zzr2t";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

// ─── Stubs: a signed-in workspace person, and a console owner ────────────────────────────────────
type StaffStub = { id: string; email: string; name: string; role: "OWNER" };
let staffActor: StaffStub | null = null;
class StubStaffRefused extends Error {}
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
  if (request === "@/lib/auth") return { auth: async () => ({ user: { id: "zzr2t-user", sid: "zzr2t-sid", name: "Probe", email: "probe@zzr2t.invalid", role: "ADMIN" } }), signIn: async () => {}, signOut: async () => {} };
  if (request === "@/lib/access/request") return { requestFacts: async () => ({ inRequest: false }) };
  if (request === "@/lib/impersonation") return { resolveViewAs: async () => null, VIEW_AS_BLOCKED_MESSAGE: "viewing as" };
  if (request === "@/lib/platform/staff-session") {
    return {
      StaffRefused: StubStaffRefused,
      requireStaff: async () => {
        if (!staffActor) throw new StubStaffRefused("Sign in to the console.");
        return staffActor;
      },
      currentStaffSession: async () => null,
    };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

async function main() {
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external");
  const { actionRefusedForHold } = await import("../src/lib/tenancy/hold");
  const { heldForBillingInAction } = await import("../src/lib/tenancy/billing-hold-action");
  const session = await import("../src/lib/session");
  const { runAsTenant } = await import("../src/lib/tenancy/resolve");
  const { razorpayStatus } = await import("../src/lib/billing/razorpay");
  const registry = await import("../src/lib/tenancy/registry");
  const { tenancyState } = await import("../src/lib/tenancy/state");
  const lockout = await import("../src/lib/security/lockout");
  const { callerKeyIp } = await import("../src/lib/client-ip");
  const totp = await import("../src/lib/totp");
  const { tlsAskAllowed } = await import("../src/lib/platform/tls-ask-auth");
  const { PLATFORM_HOSTS } = await import("../src/lib/workspace-names");
  const { redactAccessPath } = await import("../src/lib/logs/access-log");
  const { UNRESTRICTED } = await import("../src/lib/entitlements");

  // ─── R2-05 ─────────────────────────────────────────────────────────────────────────────────────
  section("R2-05: a workspace held for billing runs billing's actions only");
  const base = { slug: TAG, name: TAG, dbUrl: "", primaryHost: `${TAG}.localhost`, hosts: [`${TAG}.localhost`], source: "env" as const, isDefault: false, keyBundleCipher: null, country: "IN", entitlements: UNRESTRICTED };
  const held = { ...base, id: `${TAG}-held`, status: "SUSPENDED" as const, holdReason: "BILLING" as const };
  const open = { ...base, id: `${TAG}-open`, status: "ACTIVE" as const, holdReason: null };
  const staffHeld = { ...base, id: `${TAG}-staff`, status: "SUSPENDED" as const, holdReason: "STAFF" as const };
  ok("the rule: held for billing, an action that isn't billing's is refused", actionRefusedForHold(held, { inAction: true, billingAction: false }));
  ok("  billing's own action runs", !actionRefusedForHold(held, { inAction: true, billingAction: true }));
  ok("  a page render (not an action) is left alone", !actionRefusedForHold(held, { inAction: false, billingAction: false }));
  ok("  an open workspace, and a staff hold (the proxy shuts that whole), are not this rule's", !actionRefusedForHold(open, { inAction: true, billingAction: false }) && !actionRefusedForHold(staffHeld, { inAction: true, billingAction: false }));

  const inStore = <T,>(phase: "action" | "render", fn: () => Promise<T>) =>
    workUnitAsyncStorage.run({ type: "request", phase, headers: new Headers() } as never, fn);
  ok("Next's request store in the action phase, held: refused", await inStore("action", () => runAsTenant(held, () => heldForBillingInAction(false))));
  ok("  the same, as billing's action: allowed", !(await inStore("action", () => runAsTenant(held, () => heldForBillingInAction(true)))));
  ok("  the billing page re-rendered after the action: allowed", !(await inStore("render", () => runAsTenant(held, () => heldForBillingInAction(false)))));
  ok("  outside a request (a script, a job): allowed", !(await runAsTenant(held, () => heldForBillingInAction(false))));

  const outcome = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return "ran";
    } catch (err) {
      return err instanceof Error ? err.name : "threw";
    }
  };
  const searchLike = await inStore("action", () => runAsTenant(held, () => outcome(() => session.requireUser())));
  ok("requireUser in a held workspace's action (global search, onboarding, copilot): BillingHoldError", searchLike === "BillingHoldError", searchLike);
  const billingLike = await inStore("action", () => runAsTenant(held, () => outcome(() => session.requireUser({ billingHold: "allow" }))));
  ok("  requireUser({ billingHold: \"allow\" }) — src/actions/billing.ts: runs", billingLike === "ran", billingLike);
  const openLike = await inStore("action", () => runAsTenant(open, () => outcome(() => session.requireUser())));
  ok("  an open workspace's action: runs", openLike === "ran", openLike);
  const currentNull = await inStore("action", () => runAsTenant(held, () => session.currentUser()));
  ok("  currentUser in a held workspace's action finds nobody", currentNull === null);

  // ─── R2-06 ─────────────────────────────────────────────────────────────────────────────────────
  section("R2-06: a Razorpay mandate isn't payment");
  ok("authenticated, starting now, nothing paid: INCOMPLETE", razorpayStatus("authenticated", { paidCount: 0 }) === "INCOMPLETE");
  ok("  and with no paid_count at all: INCOMPLETE", razorpayStatus("authenticated") === "INCOMPLETE");
  ok("  its first charge (paid_count 1): ACTIVE", razorpayStatus("authenticated", { paidCount: 1 }) === "ACTIVE");
  ok("  a captured subscription.charged event: ACTIVE", razorpayStatus("authenticated", { paidCount: 0, charged: true }) === "ACTIVE");
  ok("  a change starting at the next renewal, authorised: ACTIVE, held by its startsAt", razorpayStatus("authenticated", { startsLater: true }) === "ACTIVE");
  ok("active with a charge: ACTIVE; active saying nothing paid: INCOMPLETE", razorpayStatus("active", { paidCount: 3 }) === "ACTIVE" && razorpayStatus("active") === "ACTIVE" && razorpayStatus("active", { paidCount: 0 }) === "INCOMPLETE");
  ok("  created INCOMPLETE, pending PAST_DUE, cancelled CANCELLED, as before", razorpayStatus("created") === "INCOMPLETE" && razorpayStatus("pending") === "PAST_DUE" && razorpayStatus("cancelled") === "CANCELLED");

  // ─── R2-07 ─────────────────────────────────────────────────────────────────────────────────────
  section("R2-07: the host lookup cache stays bounded");
  tenancyState().registry.clear();
  for (let i = 0; i < 20_000; i++) await registry.rememberedLookup(`domain:zzr2t-${i}-${Math.random().toString(36).slice(2)}.example`, async () => null);
  ok(`20,000 random misses leave at most ${registry.REGISTRY_MAX.toLocaleString("en-IN")} entries`, registry.registrySize() <= registry.REGISTRY_MAX, registry.registrySize());
  let loads = 0;
  await registry.rememberedLookup("domain:zzr2t-repeat.example", async () => (loads++, null));
  await registry.rememberedLookup("domain:zzr2t-repeat.example", async () => (loads++, null));
  ok("  a miss is still remembered briefly (one load for two asks)", loads === 1);
  tenancyState().registry.clear();

  const h = (entries: Record<string, string>) => new Headers(entries);
  ok("tls-ask: Caddy's internal call (Host app:3000, private X-Forwarded-For) answers", tlsAskAllowed({ headers: h({ host: "app:3000", "x-forwarded-for": "172.18.0.5" }), key: null }, ""));
  ok("  from the internet through Traefik (a public address added): refused", !tlsAskAllowed({ headers: h({ host: "app:3000", "x-forwarded-for": "203.0.113.9" }), key: null }, ""));
  ok("  on a workspace's or the platform's name: refused", !tlsAskAllowed({ headers: h({ host: "acme.deskzo.com", "x-forwarded-for": "10.0.0.2" }), key: null }, "") && !tlsAskAllowed({ headers: h({ host: "deskzo.com" }), key: null }, ""));
  ok("  through Cloudflare: refused", !tlsAskAllowed({ headers: h({ host: "app:3000", "x-forwarded-for": "10.0.0.2", "cf-connecting-ip": "203.0.113.9" }), key: null }, ""));
  ok("  with the shared secret, from anywhere: answers; a wrong one: refused", tlsAskAllowed({ headers: h({ host: "deskzo.com", "x-forwarded-for": "203.0.113.9" }), key: "s3cret-zz" }, "s3cret-zz") && !tlsAskAllowed({ headers: h({ host: "deskzo.com", "x-forwarded-for": "203.0.113.9" }), key: "wrong" }, "s3cret-zz"));

  // ─── R2-16 ─────────────────────────────────────────────────────────────────────────────────────
  section("R2-16: the lockout keeps live locks, and keys IPv6 by /64");
  lockout.resetLockouts();
  const victim = [`${TAG}|account:victim@zzr2t.invalid`];
  for (let i = 0; i < lockout.MAX_FAILURES; i++) lockout.recordFailure(victim);
  ok("the victim's account is locked", lockout.lockoutState(victim).lockedOut);
  for (let i = 0; i < 30_000; i++) lockout.recordFailure([`${TAG}|caller:198.51.${(i >> 8) & 255}.${i & 255}-${i}`]);
  ok("  after a flood of 30,000 other callers' tries, it is still locked", lockout.lockoutState(victim).lockedOut);
  ok("  and the map stayed bounded", lockout.trackedLockouts() <= 40_000, lockout.trackedLockouts());
  for (let i = 0; i < 30_000; i++) lockout.recordFailure([`${TAG}|account:flood-${i}@zzr2t.invalid`]);
  ok("  a flood of 30,000 made-up accounts doesn't erase it either", lockout.lockoutState(victim).lockedOut);
  lockout.resetLockouts();
  // A map full of live locks: a new caller is counted but not kept, and a new account still locks.
  for (let i = 0; i < 20_000; i++) for (let j = 0; j < lockout.MAX_FAILURES; j++) lockout.recordFailure([`${TAG}|caller:locked-${i}`]);
  ok("  a map full of live locks keeps every one of them", lockout.trackedLockouts() === 20_000 && lockout.lockoutState([`${TAG}|caller:locked-0`]).lockedOut && lockout.lockoutState([`${TAG}|caller:locked-19999`]).lockedOut);
  const lateAccount = [`${TAG}|account:late@zzr2t.invalid`];
  for (let i = 0; i < lockout.MAX_FAILURES; i++) lockout.recordFailure(lateAccount);
  ok("  and an account's own lock still takes hold then", lockout.lockoutState(lateAccount).lockedOut);
  lockout.resetLockouts();

  ok("callerKeyIp: an IPv6 address becomes its /64; IPv4 stays", callerKeyIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd") === "2001:db8:1:2::/64" && callerKeyIp("203.0.113.9") === "203.0.113.9");
  for (let i = 0; i < lockout.MAX_FAILURES; i++) lockout.recordFailure([`${TAG}|caller:2001:db8:1:2:${(i + 1).toString(16)}::${i + 7}`]);
  ok("  eight tries from eight addresses in one /64 lock the whole /64", lockout.lockoutState([`${TAG}|caller:2001:db8:1:2:ffff::1`]).lockedOut);
  ok("  a neighbouring /64 is not locked", !lockout.lockoutState([`${TAG}|caller:2001:db8:1:3::1`]).lockedOut);
  lockout.resetLockouts();

  const secret = authenticator.generateSecret();
  totp.forgetUsedTotpSteps();
  const code = authenticator.generate(secret);
  ok("a staff code is accepted once", totp.verifyTotpCodeOnce(`staff:${TAG}`, secret, code));
  ok("  the same code again (the same time step): refused", !totp.verifyTotpCodeOnce(`staff:${TAG}`, secret, code));
  ok("  another account's use of its own code isn't affected", totp.verifyTotpCodeOnce(`staff:${TAG}-other`, secret, code));
  const previous = authenticator.clone({ epoch: Date.now() - 30_000 }).generate(secret);
  ok("  an older step's code after a newer one: refused", previous === code || !totp.verifyTotpCodeOnce(`staff:${TAG}`, secret, previous));
  totp.forgetUsedTotpSteps();

  // ─── Lows ──────────────────────────────────────────────────────────────────────────────────────
  section("Lows");
  ok("tickets, infra and mg are locked platform hosts", ["tickets", "infra", "mg"].every((w) => PLATFORM_HOSTS.has(w)));
  ok(
    "the access log writes tokens in paths as :token",
    redactAccessPath("/v/abc123") === "/v/:token" &&
      redactAccessPath("/id/xyz") === "/id/:token" &&
      redactAccessPath("/api/marketing/unsubscribe/tok/extra") === "/api/marketing/unsubscribe/:token/extra" &&
      redactAccessPath("/preferences/confirm/tok") === "/preferences/confirm/:token" &&
      redactAccessPath("/leads/abc") === "/leads/abc",
  );

  // ─── R2-08 (control plane) ─────────────────────────────────────────────────────────────────────
  section("R2-08: a console owner's dangerous change needs a fresh code");
  const { controlConfigured, controlDb } = await import("../src/lib/platform/control-db");
  if (!controlConfigured() || !process.env.PLATFORM_MASTER_KEY) {
    ok("a control plane and PLATFORM_MASTER_KEY to try it against", false, "CONTROL_DATABASE_URL / PLATFORM_MASTER_KEY not set");
  } else {
    const { sealForPlatform } = await import("../src/lib/platform/kek");
    const consoleActions = await import("../src/actions/platform/console");
    const { setTestPlatformMailer } = await import("../src/lib/platform/mailer");
    const mail: { to: string; subject: string }[] = [];
    setTestPlatformMailer(async (m) => void mail.push({ to: m.to, subject: m.subject }));
    const control = controlDb();
    const cleanup = async () => {
      const ids = (await control.platformUser.findMany({ where: { email: { endsWith: `@${TAG}.invalid` } }, select: { id: true } })).map((u) => u.id);
      await control.platformAuditLog.deleteMany({ where: { actor: { in: ids } } });
      await control.platformSession.deleteMany({ where: { userId: { in: ids } } });
      await control.platformUser.deleteMany({ where: { id: { in: ids } } });
    };
    try {
      await cleanup();
      const ownerSecret = authenticator.generateSecret();
      const owner = await control.platformUser.create({
        data: { email: `owner@${TAG}.invalid`, name: "ZZR2T Owner", role: "OWNER", passwordHash: "x", totpSecretCipher: sealForPlatform("staff-totp", ownerSecret), totpEnabledAt: new Date() },
      });
      const target = await control.platformUser.create({
        data: { email: `target@${TAG}.invalid`, name: "ZZR2T Target", role: "OWNER", passwordHash: "x", totpSecretCipher: "kept", totpEnabledAt: new Date() },
      });
      staffActor = { id: owner.id, email: owner.email, name: owner.name, role: "OWNER" };
      totp.forgetUsedTotpSteps();
      lockout.resetLockouts();
      const noCode = await consoleActions.consoleResetStaffTwoFactor(target.id);
      const after = await control.platformUser.findUniqueOrThrow({ where: { id: target.id } });
      ok("resetting another owner's two-factor with no code: refused, nothing changed", !noCode.ok && !!after.totpEnabledAt, noCode.ok ? "" : noCode.error);
      const wrong = await consoleActions.consoleNewSetupLink(target.id, "000000");
      ok("  a password link for an owner with a wrong code: refused", !wrong.ok && !(await control.platformUser.findUniqueOrThrow({ where: { id: target.id } })).passwordSetupHash);
      const policyNoCode = await consoleActions.consoleSetStaffTwoFactor("off");
      ok("  turning staff two-factor off with no code: refused", !policyNoCode.ok);
      const keysNoCode = await consoleActions.consoleSaveGatewayKeys({ values: { "stripe.secretKey": "sk_test_zzr2t" } });
      ok("  changing a gateway key with no code: refused", !keysNoCode.ok);
      const closeNoCode = await consoleActions.consoleDeprovision("zzr2t-nonexistent", "zzr2t");
      ok("  closing a workspace with no code: refused", !closeNoCode.ok);
      mail.length = 0;
      const fresh = authenticator.generate(ownerSecret);
      const withCode = await consoleActions.consoleResetStaffTwoFactor(target.id, fresh);
      ok("with a fresh code from the owner's own authenticator: done", withCode.ok && !(await control.platformUser.findUniqueOrThrow({ where: { id: target.id } })).totpEnabledAt, withCode.ok ? "" : withCode.error);
      ok("  and the other owners are told (the one acting is not)", mail.some((m) => m.to === target.email) && !mail.some((m) => m.to === owner.email));
      const replay = await consoleActions.consoleNewSetupLink(target.id, fresh);
      ok("  the same code again: refused (each works once)", !replay.ok && !(await control.platformUser.findUniqueOrThrow({ where: { id: target.id } })).passwordSetupHash, replay.ok ? "" : replay.error);
    } finally {
      staffActor = null;
      setTestPlatformMailer(null);
      totp.forgetUsedTotpSteps();
      lockout.resetLockouts();
      await cleanup();
    }
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
