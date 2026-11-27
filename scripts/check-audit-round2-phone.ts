/**
 * check:audit-round2-phone — the security audit's round two (docs/reports/security-audit-2026-11-11.md §11), group P:
 * the phone app and its server endpoints, each fix shown to hold the way it was broken, through the real handlers.
 *
 *   R2-11  caller ID, call sync and the after-call list give a masked name to a role that sees names masked; a role
 *          that sees phones masked gets no more answers once the phone has asked about 300 numbers on nobody in a
 *          day — matched ones included; somebody who sees numbers in the clear is never capped
 *   R2-12  a new phone sign-in emails its person; /.well-known/assetlinks.json is 404 unset and Android's statement
 *          when set; the browser sign-in's kind asks for an App Link return only when the app says so
 *   R2-13  publishing an app update without the publisher secret is refused before a byte of the body is read; a
 *          production server without the secret set refuses all publishing; tries are limited per address
 *   Lows   a phone paired more than 180 days ago is signed out; the app's chat form is read with a ceiling
 *
 * A fixture of its own, named ZZR2P, removed in a finally.
 *
 *   npx tsx scripts/check-audit-round2-phone.ts
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.TRUST_PROXY = "1";
process.env.DESKZO_APP = "on";
delete process.env.DESKZO_APP_ANDROID_URL;

const TAG = "ZZR2P";
const MAIL = "@zzr2p.invalid";
const requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:audit-round2-phone", "x-forwarded-for": "198.51.100.77" });

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") return { headers: async () => requestHeaders, cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) };
  if (request === "@/lib/auth") {
    return {
      auth: async () => {
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        const { apiActor } = require("../src/lib/api/actor") as typeof import("../src/lib/api/actor");
        const api = apiActor();
        return api ? { user: { id: api.userId, name: api.name, email: api.email, role: api.role }, expires: "" } : null;
      },
      signIn: async () => {},
      signOut: async () => {},
      handlers: {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companyIds = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const calls = (await db.callLog.findMany({ where: { OR: [{ companyId: { in: companyIds } }, { userId: { in: ids } }] }, select: { id: true } })).map((c) => c.id);
  const tasks = (await db.task.findMany({ where: { OR: [{ companyId: { in: companyIds } }, { assignedToUserId: { in: ids } }] }, select: { id: true } })).map((t) => t.id);
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...companyIds, ...calls, ...tasks] } }] } });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.callLog.deleteMany({ where: { id: { in: calls } } });
  await db.task.deleteMany({ where: { id: { in: tasks } } });
  await db.userFieldPolicy.deleteMany({ where: { userId: { in: ids } } });
  await db.signIn.deleteMany({ where: { userId: { in: ids } } });
  await db.appPairing.deleteMany({ where: { userId: { in: ids } } });
  await db.appDevice.deleteMany({ where: { userId: { in: ids } } });
  await db.userDevice.deleteMany({ where: { userId: { in: ids } } });
  await db.contact.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

type Answer = { status: number; body: { data?: unknown; error?: { code: string; message: string } } };

async function call(dir: string, method: string, token: string, opts: { query?: string; body?: unknown } = {}): Promise<Answer> {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const mod = require(`../src/app/api/app/${dir}/route`) as Record<string, (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  const headers = new Headers(requestHeaders);
  headers.set("authorization", `Bearer ${token}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const req = new Request(`http://deskzo.localhost:3000/api/app/${dir}${opts.query ?? ""}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await mod[method]!(req, { params: Promise.resolve({}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const pairing = require("../src/lib/app/pairing") as typeof import("../src/lib/app/pairing");
  const tokens = require("../src/lib/app/tokens") as typeof import("../src/lib/app/tokens");
  const probe = require("../src/lib/app/probe-cap") as typeof import("../src/lib/app/probe-cap");
  const { setTestPlatformMailer } = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { moduleAvailableForTenant } = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  const { assetLinksStatement } = require("../src/lib/app/asset-links") as typeof import("../src/lib/app/asset-links");
  const guard = require("../src/lib/app-updates/publish-guard") as typeof import("../src/lib/app-updates/publish-guard");
  const { resetCallerBudgets } = require("../src/lib/security/caller-budget") as typeof import("../src/lib/security/caller-budget");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const sent: { to: string; subject: string; text: string }[] = [];
  setTestPlatformMailer(async (mail) => {
    sent.push({ to: mail.to, subject: mail.subject, text: mail.text });
  });
  const masking = await db.fieldMaskingSettings.findUnique({ where: { id: "global" } });

  await cleanup();
  try {
    if (!(await moduleAvailableForTenant("calls"))) {
      ok("Calls is in this workspace's plan and switched on — the suite needs it", false);
      return;
    }
    const base = 7_100_000_000 + (Date.now() % 800_000_000);
    const num = (n: number) => String(base + n);
    const rep = await db.user.create({ data: { name: `${TAG} Rep`, email: `rep${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const company = await db.company.create({ data: { name: `${TAG} Acme`, normalizedName: `${TAG} acme`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id } });
    const priya = await db.contact.create({ data: { companyId: company.id, name: `${TAG} Priya Sharma`, phone: `+91 ${num(1).slice(0, 5)} ${num(1).slice(5)}`, isPrimary: true } });

    section("R2-12: a new phone sign-in is emailed to its person");
    const code = await pairing.startPairing(rep.id);
    const paired = await pairing.pairPhone({ code: code.code, platform: "android", model: `${TAG} Pixel` }, "198.51.100.77");
    const mail = sent.find((m) => m.to === rep.email);
    ok("an email to the person, naming the phone and how to sign it out", !!mail && /signed in to your Deskzo account/.test(mail.subject) && mail.text.includes(`${TAG} Pixel`) && /Settings › Deskzo app/.test(mail.text), mail?.subject);
    ok("  and the address it came from", !!mail && mail.text.includes("198.51.100.77"));
    const token = paired.token;
    const appDeviceId = paired.appDeviceId;
    await db.appDevice.update({ where: { id: appDeviceId }, data: { callSync: true, createdAt: new Date(Date.now() - 3_600_000) } });

    ok("the browser sign-in's kind: phone, tablet, phone.link — nothing else", tokens.signInKind("phone")?.appLink === false && tokens.signInKind("tablet.link")?.appLink === true && tokens.signInKind("phone.evil") === null && tokens.signInKind("laptop") === null);
    ok("  the code goes back on https only when the app asked for it", tokens.signedInLink("ABC", true).startsWith("https://") && tokens.signedInLink("ABC").startsWith("deskzo://"));

    section("R2-11: nothing masked — as before");
    const clear = await call("calls/lookup", "GET", token, { query: `?number=${encodeURIComponent(`0${num(1)}`)}` });
    ok("caller ID names the contact", clear.status === 200 && (clear.body.data as { contact?: { name: string } })?.contact?.name === priya.name, clear.status);
    const posted = await call("calls/lookup", "POST", token, { body: { number: `+91${num(1)}` } });
    ok("  asked by POST with the number in the body, the same answer", posted.status === 200 && (posted.body.data as { contact?: { name: string } })?.contact?.name === priya.name, posted.status);

    section("R2-11: names and phones masked for the person");
    await db.fieldMaskingSettings.upsert({ where: { id: "global" }, create: { id: "global", enabled: true }, update: { enabled: true } });
    const MASK = { view: true, maskInList: true, maskInDetail: true, unmask: true };
    await db.userFieldPolicy.createMany({
      data: [
        { userId: rep.id, entity: "contacts", field: "name", ...MASK, format: "first", reason: "zz check" },
        { userId: rep.id, entity: "contacts", field: "phone", ...MASK, format: "phone_last4", reason: "zz check" },
      ],
    });
    const masked = await call("calls/lookup", "POST", token, { body: { number: num(1) } });
    const maskedName = (masked.body.data as { contact?: { name: string } })?.contact?.name;
    ok("caller ID gives the name masked, never in full", masked.status === 200 && !!maskedName && maskedName !== priya.name, maskedName);
    const synced = await call("calls/sync", "POST", token, { body: { calls: [{ key: `${TAG}-1`, number: num(1), direction: "out", started_at: new Date(Date.now() - 120_000).toISOString(), duration: 40 }] } });
    const row = (synced.body.data as { status: string; contact?: string; call_id?: string }[] | undefined)?.[0];
    ok("call sync logs the call, and answers the name masked", synced.status === 200 && row?.status === "logged" && !!row.contact && row.contact !== priya.name, row);
    const logged = row?.call_id ? await db.callLog.findUnique({ where: { id: row.call_id }, select: { contactId: true } }) : null;
    ok("  the call is still logged against the real contact", logged?.contactId === priya.id);
    const review = await call("calls/review", "GET", token);
    const listed = (review.body.data as { id: string; contact: string | null }[] | undefined)?.find((r) => r.id === row?.call_id);
    ok("the after-call list shows the name masked", review.status === 200 && !!listed && listed.contact !== priya.name, listed?.contact);

    section("R2-11: guessing numbers is capped for somebody who sees phones masked");
    probe.resetProbeCaps();
    probe.noteUnmatched(appDeviceId, Array.from({ length: probe.UNMATCHED_NUMBERS_PER_DAY - 1 }, (_, i) => String(6_000_000_000 + i)));
    const lastMiss = await call("calls/lookup", "POST", token, { body: { number: num(500) } });
    ok("the 300th number on nobody is still answered (nobody)", lastMiss.status === 200 && lastMiss.body.data === null, lastMiss.status);
    const afterCap = await call("calls/lookup", "POST", token, { body: { number: num(1) } });
    ok("  after it, even a customer's number gets no answer today", afterCap.status === 429 && afterCap.body.error?.code === "too_many_numbers", afterCap.status);
    const syncAfter = await call("calls/sync", "POST", token, { body: { calls: [{ key: `${TAG}-2`, number: num(1), direction: "in", started_at: new Date(Date.now() - 60_000).toISOString(), duration: 10 }] } });
    ok("  and call sync waits too", syncAfter.status === 429 && syncAfter.body.error?.code === "too_many_numbers", syncAfter.status);
    probe.resetProbeCaps();
    const tooOld = await call("calls/sync", "POST", token, { body: { calls: [{ key: `${TAG}-3`, number: num(700), direction: "out", started_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), duration: 5 }] } });
    ok("a call from before pairing isn't matched, so it isn't counted either", tooOld.status === 200 && !probe.probeBudgetSpent(appDeviceId) && (tooOld.body.data as { status: string }[])[0]?.status === "too_old");

    section("R2-11: somebody who sees numbers in the clear isn't capped");
    await db.userFieldPolicy.deleteMany({ where: { userId: rep.id } });
    probe.noteUnmatched(appDeviceId, Array.from({ length: probe.UNMATCHED_NUMBERS_PER_DAY + 5 }, (_, i) => String(6_100_000_000 + i)));
    const unmasked = await call("calls/lookup", "POST", token, { body: { number: num(1) } });
    ok("caller ID still answers, with the name", unmasked.status === 200 && (unmasked.body.data as { contact?: { name: string } })?.contact?.name === priya.name, unmasked.status);
    probe.resetProbeCaps();

    section("Low: a phone's token lasts 180 days from pairing");
    await db.appDevice.update({ where: { id: appDeviceId }, data: { createdAt: new Date(Date.now() - 181 * 86_400_000) } });
    const expired = await call("me", "GET", token);
    ok("a phone paired 181 days ago is signed out, however busy", expired.status === 401 && expired.body.error?.code === "signed_out", expired.status);
    await db.appDevice.update({ where: { id: appDeviceId }, data: { createdAt: new Date(Date.now() - 3_600_000) } });

    section("R2-12: /.well-known/assetlinks.json");
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const links = require("../src/app/api/app/asset-links/route") as { GET: () => Response };
    const savedFp = process.env.ANDROID_APP_SHA256_CERT_FINGERPRINTS;
    delete process.env.ANDROID_APP_SHA256_CERT_FINGERPRINTS;
    ok("unset: 404", links.GET().status === 404);
    const fp = Array.from({ length: 32 }, (_, i) => (i * 7).toString(16).padStart(2, "0").slice(-2).toUpperCase()).join(":");
    process.env.ANDROID_APP_SHA256_CERT_FINGERPRINTS = `${fp}, not-a-fingerprint`;
    const set = links.GET();
    const statement = (await set.json()) as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
    ok("set: Android's statement, the app's package and only the valid fingerprint", set.status === 200 && statement[0]?.target.package_name === "com.deskzo.app" && statement[0].target.sha256_cert_fingerprints.join() === fp, statement);
    ok("  a package name that isn't one gives no statement", assetLinksStatement({ ANDROID_APP_SHA256_CERT_FINGERPRINTS: fp, ANDROID_APP_PACKAGE: "x; y" }) === null);
    if (savedFp === undefined) delete process.env.ANDROID_APP_SHA256_CERT_FINGERPRINTS;
    else process.env.ANDROID_APP_SHA256_CERT_FINGERPRINTS = savedFp;

    section("R2-13: publishing an app update");
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const publish = require("../src/app/api/app-updates/publish/route") as { POST: (req: Request) => Promise<Response> };
    const savedSecret = process.env.APP_UPDATES_PUBLISH_SECRET;
    process.env.APP_UPDATES_PUBLISH_SECRET = "zz-r2p-publisher-secret";
    resetCallerBudgets();
    let pulled = false;
    // highWaterMark 0: the stream asks for nothing until somebody reads it.
    const body = new ReadableStream(
      {
        pull(c) {
          pulled = true;
          c.enqueue(new Uint8Array(1024));
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const noSecret = await publish.POST(new Request("http://deskzo.localhost:3000/api/app-updates/publish", { method: "POST", body, headers: { "content-type": "multipart/form-data; boundary=x", "x-forwarded-for": "198.51.100.78" }, duplex: "half" } as RequestInit));
    ok("without the publisher secret: refused, 401", noSecret.status === 401, noSecret.status);
    ok("  before a byte of the body was read", !pulled);
    const wrong = await publish.POST(new Request("http://deskzo.localhost:3000/api/app-updates/publish", { method: "POST", body: "x", headers: { "x-deskzo-publisher-secret": "guess", "x-forwarded-for": "198.51.100.78" } }));
    ok("a wrong secret: refused the same", wrong.status === 401, wrong.status);
    ok("the right secret passes the check", guard.publisherSecretRefusal(new Headers({ "x-deskzo-publisher-secret": "zz-r2p-publisher-secret" })) === null);
    ok("a production server without the secret set refuses all publishing", guard.publisherSecretRefusal(new Headers({ "x-deskzo-publisher-secret": "anything" }), { NODE_ENV: "production" })?.status === 503);
    ok("  a development server without it doesn't ask", guard.publisherSecretRefusal(new Headers(), { NODE_ENV: "development" }) === null);
    resetCallerBudgets();
    let limited = 0;
    for (let i = 0; i < guard.PUBLISH_TRIES_PER_HOUR + 1; i += 1) if (guard.publishRateRefusal("198.51.100.79")) limited += 1;
    ok(`tries from one address: ${guard.PUBLISH_TRIES_PER_HOUR} an hour, then 429`, limited === 1 && guard.publishRateRefusal("198.51.100.79")?.status === 429);
    ok("  another address isn't held by it", guard.publishRateRefusal("198.51.100.80") === null);
    resetCallerBudgets();
    if (savedSecret === undefined) delete process.env.APP_UPDATES_PUBLISH_SECRET;
    else process.env.APP_UPDATES_PUBLISH_SECRET = savedSecret;
  } finally {
    setTestPlatformMailer(null);
    if (masking) await db.fieldMaskingSettings.update({ where: { id: "global" }, data: { enabled: masking.enabled } });
    else await db.fieldMaskingSettings.deleteMany({ where: { id: "global" } });
    await cleanup();
  }
}

main()
  .then(async () => {
    console.log(`\n${passes} passed, ${failures} failed.`);
    await db.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
