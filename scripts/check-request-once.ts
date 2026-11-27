/**
 * check:request-once — a payment, document or expense saved twice is the one it already made (owner, 29 Oct 2026 —
 * src/lib/request-once.ts, migration 20261129110000).
 *
 *   1. Sent twice in a row: the second is the first's record, not a new one.
 *   2. Sent twice at once: one claims the key, the other waits and answers with that record.
 *   3. A write that fails lets its key go, so the form, put right, can be sent again with it.
 *   4. Keys are a person's: the same token from someone else is theirs to make.
 *   5. No token, or a malformed one, writes as before — every time.
 *   6. Still being saved past the wait: "busy", never a second record.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:request-once
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host)) throw new Error("not a local database");
  const scratch = `${new URL(url).pathname.slice(1)}_requestonce`;
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
    const { claimRequest, requestIdOf } = require("../src/lib/request-once") as typeof import("../src/lib/request-once");
    /* eslint-enable @typescript-eslint/no-require-imports */

    section("1. Twice in a row");
    const first = { requestId: randomUUID() };
    const a = await claimRequest(first, "payment", "user-a");
    ok("the first send claims its key", a.kind === "new");
    if (a.kind === "new") await a.done("pay-1");
    const again = await claimRequest(first, "payment", "user-a");
    ok("  the second is the first's payment", again.kind === "repeat" && again.recordId === "pay-1", again);
    const otherKind = await claimRequest(first, "expense", "user-a");
    ok("  the same token on an expense is the expense's own", otherKind.kind === "new");

    section("2. Twice at once");
    const both = { requestId: randomUUID() };
    let made = 0;
    const send = async () => {
      const claim = await claimRequest(both, "document", "user-a");
      if (claim.kind !== "new") return claim;
      made += 1;
      await sleep(700); // the write takes a while
      await claim.done(`doc-${made}`);
      return { kind: "made" as const, recordId: `doc-${made}` };
    };
    const [x, y] = await Promise.all([send(), send()]);
    ok("one document made", made === 1, { made });
    const answers = [x, y].map((r) => ("recordId" in r ? r.recordId : r.kind));
    ok("  both sends answer with it", answers.every((r) => r === "doc-1"), answers);

    section("3. A failed write lets the key go");
    const failing = { requestId: randomUUID() };
    const tried = await claimRequest(failing, "invoice-payment", "user-a");
    if (tried.kind === "new") await tried.release();
    const retried = await claimRequest(failing, "invoice-payment", "user-a");
    ok("sent again, put right: claimed afresh", retried.kind === "new");
    if (retried.kind === "new") await retried.done("pay-2");
    if (retried.kind === "new") await retried.release();
    const after = await claimRequest(failing, "invoice-payment", "user-a");
    ok("  a release after it saved keeps the record", after.kind === "repeat" && after.recordId === "pay-2", after);

    section("4. A person's keys");
    const mine = await claimRequest(first, "payment", "user-b");
    ok("the same token from someone else is theirs", mine.kind === "new");

    section("5. No token");
    ok("none: no token", requestIdOf({}) === null);
    ok("  a malformed one: no token", requestIdOf({ requestId: "x'; drop" }) === null && requestIdOf({ requestId: 42 }) === null);
    const none1 = await claimRequest({}, "payment", "user-a");
    const none2 = await claimRequest({}, "payment", "user-a");
    ok("  writes as before, every time", none1.kind === "new" && none2.kind === "new");
    const kept = await db.requestKey.count();
    ok("  and keeps nothing for it", kept === 5, { kept });

    section("6. Still being saved");
    const slow = { requestId: randomUUID() };
    const held = await claimRequest(slow, "bill-payment", "user-a");
    const started = Date.now();
    const waited = await claimRequest(slow, "bill-payment", "user-a");
    ok("past the wait: busy, not a second payment", held.kind === "new" && waited.kind === "busy", waited);
    ok("  after about six seconds", Date.now() - started >= 5500, Date.now() - started);
  } finally {
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }
  console.log(failures === 0 ? `\nAll ${passes} request-once checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
