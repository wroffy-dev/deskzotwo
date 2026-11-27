/**
 * check:portal-code — a code before a new browser opens a customer's portal link (owner, 29 Oct 2026 —
 * src/lib/portal/device.ts, src/actions/portal-public.ts).
 *
 *   1. Off, as it starts: a link opens as it always did.
 *   2. On: a browser that hasn't given a code sees where the code goes and nothing else — and an action called by
 *      hand from it (a question raised) is refused as a bad link is.
 *   3. The code goes to the link's own address; five wrong tries end it; the right one trusts the browser by cookie.
 *   4. Trusted: the account opens; another person's link in the same browser still asks for its own code.
 *   5. Ends: a forged cookie, an expired device, a revoked link, a link without an address; and five codes an hour.
 *
 * In a scratch workspace database built from the migrations, dropped after. The browser's cookies are a stub.
 *
 *   npm run check:portal-code
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

// The browser: one cookie jar, cleared to be another browser.
const jar = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, parent: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        set: (name: string, value: string) => void jar.set(name, value),
      }),
      headers: async () => new Headers(),
    };
  }
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname)) throw new Error("not a local database");
  const scratch = `${new URL(url).pathname.slice(1)}_portalcode`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
  let close: (() => Promise<void>) | null = null;
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = " ";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const P = require("../src/actions/portal-public") as typeof import("../src/actions/portal-public");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const mail: { to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push({ to: m.to, subject: m.subject, text: m.text }));
    const codeIn = (m: { subject: string } | undefined) => /^(\d{8}) is your code/.exec(m?.subject ?? "")?.[1] ?? "";

    const boss = await db.user.create({ data: { name: "Zz Boss", email: "boss@zz-portal.invalid", passwordHash: "!", role: "ADMIN" }, select: { id: true } });
    const acme = await db.company.create({ data: { name: "Zz Acme", normalizedName: "zz acme", relationshipType: "CLIENT", portalEnabled: true, createdById: boss.id }, select: { id: true } });
    await db.portalSettings.create({ data: { id: "global", enabled: true, access: "SELECTED", allowQuestion: true } });
    const link = (personName: string, personEmail: string | null) =>
      db.portalLogin.create({ data: { token: randomBytes(24).toString("base64url"), companyId: acme.id, personName, personEmail, createdById: boss.id }, select: { id: true, token: true } });
    const priya = await link("Zz Priya Shah", "priya@zz-portal.invalid");
    const ravi = await link("Zz Ravi Kumar", "ravi@zz-portal.invalid");
    const noMail = await link("Zz No Mail", null);
    const ask = (token: string) => P.raisePortalRequest(token, { kind: "question", message: "Zz a question" });

    section("1. Off, as it starts");
    const off = await P.openPortal(priya.token);
    ok("the link opens the account, no code asked", !!off && !off.needsCode && off.actions.includes("question"), off);
    ok("  and a question goes through", (await ask(priya.token)).ok);

    section("2. On: a new browser sees where the code goes, and nothing else");
    await db.portalSettings.update({ where: { id: "global" }, data: { requireCode: true } });
    const gate = await P.openPortal(priya.token);
    ok("it needs a code, sent to p****@zz-portal.invalid", !!gate && gate.needsCode && gate.codeTo === "p****@zz-portal.invalid", gate);
    ok("  nothing of the account on it: no sections, no actions, no welcome", !!gate && gate.sections.length === 0 && gate.actions.length === 0 && gate.welcome === null);
    const byHand = await ask(priya.token);
    ok("  a question raised by hand from this browser is refused as a bad link is", !byHand.ok && byHand.error === "This link is no longer valid.", byHand);
    ok("  as is every section", (await P.portalInvoices(priya.token)).length === 0 && (await P.portalSubscriptions(priya.token)).length === 0 && (await P.portalTickets(priya.token)).length === 0);

    section("3. The code");
    const sent = await P.sendPortalCode(priya.token);
    ok("sent to the link's own address, masked in the answer", sent.ok && sent.to === "p****@zz-portal.invalid" && mail.at(-1)?.to === "priya@zz-portal.invalid", { sent, to: mail.at(-1)?.to });
    const first = codeIn(mail.at(-1));
    ok("  eight digits in the subject (security audit round two, R2-20)", /^\d{8}$/.test(first), mail.at(-1)?.subject);
    const stored = await db.portalCode.findFirst({ where: { loginId: priya.id }, orderBy: { createdAt: "desc" } });
    ok("  kept only as a hash", !!stored && !stored.codeHash.includes(first) && stored.codeHash.length === 64);
    const wrong = first === "00000000" ? "11111111" : "00000000";
    const tries: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await P.verifyPortalCode(priya.token, wrong);
      tries.push(r.ok ? "ok" : r.error);
    }
    ok("five wrong tries, the fifth saying it was the last", tries.slice(0, 4).every((t) => /not the code/.test(t)) && /last try/.test(tries[4]!), tries);
    const late = await P.verifyPortalCode(priya.token, first);
    ok("  then even the right code is done", !late.ok && /run out/.test(late.error), late);
    ok("  and the browser isn't trusted", jar.size === 0 && (await P.openPortal(priya.token))?.needsCode === true);
    await P.sendPortalCode(priya.token);
    const second = codeIn(mail.at(-1));
    await P.sendPortalCode(priya.token);
    const third = codeIn(mail.at(-1));
    const stale = second === third ? { ok: false, error: "same code twice" } : await P.verifyPortalCode(priya.token, second);
    ok("a new code ends the one before", !stale.ok, stale);
    const right = await P.verifyPortalCode(priya.token, ` ${third.slice(0, 3)} ${third.slice(3)} `);
    ok("the right one, spaces and all: this browser is trusted by its cookie", right.ok && jar.has(`dzp_${priya.id}`), { right, jar: [...jar.keys()] });
    const cookie = jar.get(`dzp_${priya.id}`)!;
    const device = await db.portalDevice.findFirst({ where: { loginId: priya.id } });
    ok("  the database keeps only the cookie's hash, for 30 days", !!device && device.secretHash !== cookie && device.secretHash.length === 64 && Math.round((device.expiresAt.getTime() - Date.now()) / 86_400_000) === 30);
    ok("  a code opens only its own link — not Ravi's", !(await P.verifyPortalCode(ravi.token, third)).ok);

    section("4. Trusted");
    const open = await P.openPortal(priya.token);
    ok("the account opens", !!open && !open.needsCode && open.actions.includes("question"), open);
    ok("  and a question goes through", (await ask(priya.token)).ok);
    ok("Ravi's link in the same browser still asks for his own code", (await P.openPortal(ravi.token))?.needsCode === true && !(await ask(ravi.token)).ok);

    section("5. Ends");
    jar.set(`dzp_${priya.id}`, randomBytes(32).toString("base64url"));
    ok("a forged cookie: a code again", (await P.openPortal(priya.token))?.needsCode === true);
    jar.set(`dzp_${priya.id}`, cookie);
    ok("  the real one back: open", (await P.openPortal(priya.token))?.needsCode === false);
    await db.portalDevice.update({ where: { id: device!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    ok("thirty days on: a code again", (await P.openPortal(priya.token))?.needsCode === true);
    await db.portalDevice.update({ where: { id: device!.id }, data: { expiresAt: new Date(Date.now() + 86_400_000) } });
    await db.portalLogin.update({ where: { id: priya.id }, data: { revokedAt: new Date() } });
    ok("a revoked link opens nothing, cookie or not", (await P.openPortal(priya.token)) === null && !(await P.sendPortalCode(priya.token)).ok);
    const none = await P.openPortal(noMail.token);
    ok("a link without an address: no code to send, and it says so", !!none && none.needsCode && none.codeTo === null && !(await P.sendPortalCode(noMail.token)).ok);
    const flood: boolean[] = [];
    for (let i = 0; i < 6; i += 1) flood.push((await P.sendPortalCode(ravi.token)).ok);
    ok("five codes an hour a link; the sixth is refused", flood.slice(0, 5).every(Boolean) && !flood[5], flood);
    await db.portalSettings.update({ where: { id: "global" }, data: { requireCode: false } });
    jar.clear();
    ok("switched off again: links open as before", (await P.openPortal(ravi.token))?.needsCode === false);
  } finally {
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }
  console.log(failures === 0 ? `\nAll ${passes} portal code checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
