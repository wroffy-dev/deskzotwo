/**
 * check:alerts — alerts that reach a person (owner, 30 Oct 2026; docs: Deskzo at scale, Part 3): server errors grouped
 * and counted (src/lib/platform/errors.ts), the console's new alerts for a spike, a new kind and a stopped worker,
 * the email that tells the people on call (src/lib/platform/alert-notify.ts) — new, again, cleared, never twice — and
 * the uptime checker's address (/api/platform/health). On a scratch control plane, dropped at the end.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

async function main() {
  const url = process.env.DATABASE_URL!;
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_alerts_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  try {
    section("A scratch control plane");
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const errors = require("../src/lib/platform/errors") as typeof import("../src/lib/platform/errors");
    const alertsLib = require("../src/lib/platform/alerts") as typeof import("../src/lib/platform/alerts");
    const notify = require("../src/lib/platform/alert-notify") as typeof import("../src/lib/platform/alert-notify");
    const heartbeat = require("../src/lib/platform/worker-heartbeat") as typeof import("../src/lib/platform/worker-heartbeat");
    const settings = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const health = require("../src/app/api/platform/health/route") as typeof import("../src/app/api/platform/health/route");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const db = controlDb();
    const sent: { to: string; cc?: string[]; subject: string; text: string; type: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void sent.push({ to: m.to, cc: m.cc, subject: m.subject, text: m.text, type: m.type }));
    try {
      await db.platformUser.create({ data: { email: "owner@zzalerts.invalid", name: "Zz Owner", role: "OWNER", passwordHash: "x".repeat(60) } });
      await db.platformUser.create({ data: { email: "admin@zzalerts.invalid", name: "Zz Admin", role: "ADMIN", passwordHash: "x".repeat(60) } });

      section("Errors, grouped");
      const a = errors.normaliseMessage(`Record "cm9abcdefghijklmnopqrstu" for user 4512 not found at ravi@acme.in`);
      const b = errors.normaliseMessage(`Record "cm9zzzzzzzzzzzzzzzzzzzzz" for user 77 not found at asha@acme.in`);
      ok("the same fault with other ids, numbers and addresses reads the same", a === b, [a, b]);
      const base = { tenant: "acme", method: "POST", path: "/leads/x", routePath: "/leads/[id]", routeType: "action", digest: "d1" };
      ok("  one fingerprint; another route is another", errors.fingerprintOf({ ...base, message: "x 1" }) === errors.fingerprintOf({ ...base, message: "x 2" }) && errors.fingerprintOf({ ...base, message: "x 1" }) !== errors.fingerprintOf({ ...base, routePath: "/orders/[id]", message: "x 1" }));
      const now = new Date();
      for (let i = 0; i < 24; i++) errors.recordServerError({ ...base, message: `Cannot read properties of undefined (reading 'id') ${i}`, digest: `d${i}` }, now);
      errors.recordServerError({ ...base, routePath: "/orders/[id]", message: "Unique constraint failed on docNumber with password=hunter2", tenant: "zeta" }, now);
      await errors.flushServerErrors();
      const rows = await db.platformError.findMany({ orderBy: { count: "desc" } });
      ok("25 errors make 2 rows: 24 of one kind, 1 of another", rows.length === 2 && rows[0]!.count === 24 && rows[1]!.count === 1, rows.map((r) => [r.route, r.count]));
      ok("  the message's secrets are not kept", !rows.some((r) => r.message.includes("hunter2")), rows[1]?.message);
      ok("  the last workspace and digest are kept", rows[1]!.lastTenant === "zeta" && rows[0]!.lastDigest === "d23", [rows[1]!.lastTenant, rows[0]!.lastDigest]);
      const stats = await errors.errorStats(now);
      ok("the spike window counts 25; both kinds are new", stats.recent === 25 && stats.fresh.length === 2 && stats.topRecent[0]!.count === 24, stats);

      section("The console's alerts");
      await settings.setSetting("worker.lastSeen", new Date(now.getTime() - 10 * 60_000).toISOString(), "check");
      const list = await alertsLib.alerts("OWNER", now);
      const keys = list.open.map((x) => x.key);
      ok("a spike of 25 is a warning", list.open.some((x) => x.key === "errors.spike" && x.severity === "warning" && x.href === "/errors"), keys);
      ok("  each new kind is its own alert", rows.every((r) => keys.includes(`errors.new:${r.fingerprint}`)), keys);
      ok("  the worker not seen for ten minutes is critical", list.open.some((x) => x.key === "worker.stale" && x.severity === "critical"), keys);
      ok("  every key is one the console knows", list.open.every((x) => alertsLib.alertKeyInfo(x.key).valid), list.open.filter((x) => !alertsLib.alertKeyInfo(x.key).valid).map((x) => x.key));

      section("Told to a person");
      ok("nobody listed: every active owner is told", JSON.stringify(await notify.alertRecipients()) === JSON.stringify(["owner@zzalerts.invalid"]));
      const first = await notify.notifyAlerts(now);
      ok("one email, of the ALERTS type, to the owner", first.sent && sent.length === 1 && sent[0]!.type === "ALERTS" && sent[0]!.to === "owner@zzalerts.invalid", { first, sent: sent.map((m) => m.subject) });
      ok("  a critical one leads the subject; the worker's is in the body", sent[0]!.subject.startsWith("[CRITICAL] Deskzo: ") && sent[0]!.text.includes("CRITICAL: The platform worker hasn't run"), sent[0]!.subject);
      ok("  the body names each, with its link on the console", sent[0]!.text.includes("server errors in the last 20 minutes") && sent[0]!.text.includes("/errors") && sent[0]!.text.includes("/alerts"), sent[0]!.text.slice(0, 400));
      const again = await notify.notifyAlerts(new Date(now.getTime() + 60_000));
      ok("a minute later: nothing new, nothing sent", !again.sent && sent.length === 1, again);
      const later = await notify.notifyAlerts(new Date(now.getTime() + 2 * 3_600_000 + 60_000));
      ok("two hours on: the critical ones again, no warning yet; the spike, past its 20 minutes, cleared", later.sent && sent.at(-1)!.text.includes("Still open") && sent.at(-1)!.text.includes("platform worker") && !/Still open[sS]*Warning:/.test(sent.at(-1)!.text) && later.cleared === 1 && sent.at(-1)!.text.includes("server errors in the last"), { later, text: sent.at(-1)!.text.slice(0, 600) });

      section("Cleared");
      await heartbeat.markWorkerAlive(new Date(now.getTime() + 2 * 3_600_000 + 120_000));
      const cleared = await notify.notifyAlerts(new Date(now.getTime() + 2 * 3_600_000 + 180_000));
      ok("the worker back: its alert said cleared, once", cleared.sent && cleared.cleared === 1 && sent.at(-1)!.text.includes("Cleared") && sent.at(-1)!.subject.includes("cleared"), { cleared, subject: sent.at(-1)!.subject });
      const quiet = await notify.notifyAlerts(new Date(now.getTime() + 2 * 3_600_000 + 240_000));
      ok("  and not again", !quiet.sent, quiet);
      const acked = rows[0]!.fingerprint;
      await db.platformAlertAck.create({ data: { key: `errors.new:${acked}`, ackedBy: "check" } });
      const afterAck = await notify.notifyAlerts(new Date(now.getTime() + 2 * 3_600_000 + 300_000));
      ok("an acknowledged alert is no longer open: said cleared, its reminders stop", afterAck.cleared === 1 && sent.at(-1)!.text.includes("Cleared (fixed, or acknowledged)"), afterAck);

      section("Who is told");
      await settings.setSetting("alerts.emails", "oncall@zzalerts.invalid, Second@ZZalerts.invalid, not-an-address", "check");
      ok("the setting's addresses, cleaned, the bad one left out", JSON.stringify(await notify.alertRecipients()) === JSON.stringify(["oncall@zzalerts.invalid", "second@zzalerts.invalid"]));
      await settings.setSetting("worker.lastSeen", new Date(now.getTime() - 3 * 3_600_000).toISOString(), "check");
      const listed = await notify.notifyAlerts(new Date(now.getTime() + 3 * 3_600_000));
      ok("  one email to the first, the rest copied", listed.sent && sent.at(-1)!.to === "oncall@zzalerts.invalid" && JSON.stringify(sent.at(-1)!.cc) === JSON.stringify(["second@zzalerts.invalid"]), sent.at(-1));

      section("The uptime checker's address");
      await settings.setSetting("worker.lastSeen", new Date().toISOString(), "check");
      const res = await health.GET();
      const body = (await res.json()) as { ok: boolean; checks: Record<string, boolean> };
      ok("it answers yes or no per check, nothing more", JSON.stringify(Object.keys(body.checks).sort()) === JSON.stringify(["database", "tick", "worker"]) && body.checks.database === true && body.checks.worker === true, body);
      ok("  the platform tick never run here: 503, the tick named", res.status === 503 && body.ok === false && body.checks.tick === false, { status: res.status, body });
      await settings.setSetting("worker.lastSeen", new Date(Date.now() - 6 * 60_000).toISOString(), "check");
      const stale = (await (await health.GET()).json()) as { checks: Record<string, boolean> };
      ok("  a worker gone six minutes fails its check", stale.checks.worker === false, stale);

      section("Kept a while");
      await db.platformErrorBucket.create({ data: { fingerprint: "old", bucket: new Date(now.getTime() - 8 * 86_400_000), count: 3 } });
      await db.platformError.create({ data: { fingerprint: "old", routeType: "render", route: "/x", method: "GET", message: "old", count: 3, firstSeen: new Date(now.getTime() - 100 * 86_400_000), lastSeen: new Date(now.getTime() - 91 * 86_400_000) } });
      const purged = await errors.purgeErrors(now);
      ok("counts a week old, and kinds unseen for 90 days, go", purged.buckets === 1 && purged.errors === 1 && (await db.platformError.count()) === 2, purged);
    } finally {
      mailer.setTestPlatformMailer(null);
      await closeControlDb();
    }
  } finally {
    section("Clean-up");
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    ok("the scratch control plane is dropped", true);
    await admin.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll alert checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
