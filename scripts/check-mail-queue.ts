/**
 * check:mail-queue — the platform's mail queue (owner, 30 Oct 2026; src/lib/platform/mail/queue.ts): queued and tried
 * at once, sent by the worker in order of urgency, tried again on its schedule, given up on after six tries or at once
 * on a permanent refusal, never sent twice (a key, two workers), put back after a crash, tried again or dropped from
 * the console, the alerts, and the clean-up. Through the real send path with the mail server stood in for. On a
 * scratch control plane, dropped at the end.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const url = process.env.DATABASE_URL!;
  const realName = new URL(url).pathname.slice(1);
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname)) throw new Error("not a local database");
  const controlName = `${realName}_mailq_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  try {
    section("A scratch control plane");
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    // The server's own SMTP route, stood in for below: no account in the console, so every type goes through it.
    process.env.PLATFORM_SMTP_URL = "smtp://check.invalid";
    process.env.PLATFORM_MAIL_FROM = "Deskzo <noreply@check.invalid>";
    ok("built from its migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const queue = require("../src/lib/platform/mail/queue") as typeof import("../src/lib/platform/mail/queue");
    const store = require("../src/lib/platform/mail/store") as typeof import("../src/lib/platform/mail/store");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const alertsLib = require("../src/lib/platform/alerts") as typeof import("../src/lib/platform/alerts");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const db = controlDb();

    // The mail server: what it was handed, and how it answers — "ok", a passing refusal (421) or a lasting one (550).
    const handed: { to: unknown; subject: string; attachments?: { filename: string; content: Buffer }[] }[] = [];
    let answer: "ok" | "busy" | "refuse" = "ok";
    let delayMs = 0;
    // Its made-up domains take mail: the address gate (src/lib/mail-address-gate.ts) has its own suite.
    (await import("../src/lib/mail-address-gate")).setTestMailDomains(() => true);
    store.setTestMailTransport(
      () =>
        ({
          sendMail: async (m: { to: unknown; subject: string; attachments?: { filename: string; content: Buffer }[] }) => {
            if (delayMs) await sleep(delayMs);
            if (answer === "busy") throw Object.assign(new Error("421 Try again later"), { responseCode: 421 });
            if (answer === "refuse") throw Object.assign(new Error("550 No such mailbox"), { responseCode: 550 });
            handed.push(m);
            return { messageId: `<${handed.length}@check.invalid>` };
          },
        }) as never,
    );
    try {
      const mail = (subject: string, type: "ALERTS" | "ACCOUNT" | "BILLING" = "ALERTS") => ({ type, to: "someone@zzq.invalid", subject, text: "Hello." });

      section("Queued, then sent");
      const q1 = await queue.queuePlatformMail(mail("Q1 billing", "BILLING"), { noKick: true, tenant: "acme" });
      const q2 = await queue.queuePlatformMail(mail("Q2 account", "ACCOUNT"), { noKick: true });
      const rows = await db.platformMailJob.findMany({ orderBy: { createdAt: "asc" } });
      ok("written as waiting: account mail first in line (0), billing after (5)", rows.length === 2 && rows.every((r) => r.status === "QUEUED") && rows[1]!.priority === 0 && rows[0]!.priority === 5 && rows[0]!.tenant === "acme", rows.map((r) => [r.subject, r.priority, r.status]));
      const drained = await queue.drainMailQueue();
      ok("the worker sends both, the account mail first", drained.sent === 2 && handed[0]!.subject === "Q2 account" && handed[1]!.subject === "Q1 billing", { drained, order: handed.map((h) => h.subject) });
      ok("  marked sent, each in the Mail log", (await db.platformMailJob.count({ where: { status: "SENT", id: { in: [q1.id!, q2.id!] } } })) === 2 && (await db.mailDelivery.count({ where: { status: "SENT" } })) === 2);
      await queue.queuePlatformMail(mail("Kicked at once"));
      for (let i = 0; i < 40 && !handed.some((h) => h.subject === "Kicked at once"); i++) await sleep(50);
      ok("queued without noKick: sent at once in the background, no worker needed", handed.some((h) => h.subject === "Kicked at once"));

      section("Tried again, then given up on");
      answer = "busy";
      const busy = await queue.queuePlatformMail(mail("Busy server"), { noKick: true });
      // A moment after it was queued, by the database's clock.
      const t0 = Date.now() + 1_000;
      await queue.drainMailQueue({ now: () => new Date(t0) });
      let job = (await db.platformMailJob.findUnique({ where: { id: busy.id! } }))!;
      ok("a passing refusal: waiting again, try 1 counted, next in a minute", job.status === "QUEUED" && job.attempts === 1 && Math.abs(job.nextAttemptAt.getTime() - (t0 + 60_000)) < 2_000 && /421/.test(job.lastError ?? ""), job);
      const early = await queue.drainMailQueue({ now: () => new Date(t0 + 30_000) });
      ok("  not before its time", early.sent + early.retry + early.dead === 0, early);
      let at = t0;
      for (const gap of queue.RETRY_AFTER_MS) {
        at += gap + 1_000;
        await queue.drainMailQueue({ now: () => new Date(at) });
      }
      job = (await db.platformMailJob.findUnique({ where: { id: busy.id! } }))!;
      ok(`given up on after ${queue.MAX_ATTEMPTS} tries`, job.status === "DEAD" && job.attempts === queue.MAX_ATTEMPTS, { status: job.status, attempts: job.attempts });
      answer = "refuse";
      const refused = await queue.queuePlatformMail(mail("No such mailbox"), { noKick: true });
      await queue.drainMailQueue();
      job = (await db.platformMailJob.findUnique({ where: { id: refused.id! } }))!;
      ok("a permanent refusal (550): given up on at once", job.status === "DEAD" && job.attempts === 1, { status: job.status, attempts: job.attempts });
      // "No such mailbox" is a hard bounce: the address is on the platform's list (src/lib/platform/mail/suppressions.ts),
      // and taken off as staff would before trying again — the rest of this suite mails it.
      const suppressions = await import("../src/lib/platform/mail/suppressions");
      ok("  and the address is on the suppression list", (await suppressions.platformSuppressionOf("someone@zzq.invalid"))?.reason === "HARD_BOUNCE");
      await suppressions.removePlatformSuppression("someone@zzq.invalid");
      answer = "ok";

      section("Never twice");
      const k1 = await queue.queuePlatformMail(mail("Keyed"), { key: "reminder:acme:2026-10-30", noKick: true });
      const k2 = await queue.queuePlatformMail(mail("Keyed"), { key: "reminder:acme:2026-10-30", noKick: true });
      ok("the same key again is the same mail", k2.duplicate && k2.id === k1.id && (await db.platformMailJob.count({ where: { key: "reminder:acme:2026-10-30" } })) === 1);
      await queue.drainMailQueue();
      const before = handed.length;
      for (let i = 0; i < 12; i++) await queue.queuePlatformMail(mail(`Burst ${i}`), { noKick: true });
      delayMs = 20;
      const [w1, w2] = await Promise.all([queue.drainMailQueue(), queue.drainMailQueue()]);
      delayMs = 0;
      const burst = handed.slice(before).map((h) => h.subject);
      ok("two workers at once: twelve sent, each once", w1.sent + w2.sent === 12 && burst.length === 12 && new Set(burst).size === 12, { w1, w2, burst });

      section("Attachments, and a crash");
      const pdf = Buffer.from("%PDF-1.4 zz check");
      await queue.queuePlatformMail({ ...mail("With a file"), attachments: [{ filename: "a.pdf", contentType: "application/pdf", content: pdf }] }, { noKick: true });
      await queue.drainMailQueue();
      const withFile = handed.find((h) => h.subject === "With a file");
      ok("an attachment arrives as it was queued", !!withFile?.attachments?.[0] && Buffer.compare(withFile.attachments[0].content, pdf) === 0 && withFile.attachments[0].filename === "a.pdf");
      const crash = await queue.queuePlatformMail(mail("Held by a crash"), { noKick: true });
      await db.platformMailJob.update({ where: { id: crash.id! }, data: { status: "SENDING", lockedUntil: new Date(Date.now() - 1_000) } });
      const after = await queue.drainMailQueue();
      ok("one held past its lock is put back and sent", after.requeued === 1 && handed.some((h) => h.subject === "Held by a crash"), after);

      section("The console: try again, drop, alerts");
      const list = await alertsLib.alerts("OWNER", new Date());
      ok("given-up mail raises mail.dead, to the queue page", list.open.some((a) => a.key === "mail.dead" && a.href === "/mail/queue" && a.title.startsWith("2 platform mails")), list.open.map((a) => a.key));
      ok("  every key is one the console knows", list.open.every((a) => alertsLib.alertKeyInfo(a.key).valid));
      ok("Try again: waiting once more, tries counted afresh", (await queue.retryMailJob(refused.id!)) && (await db.platformMailJob.findUnique({ where: { id: refused.id! } }))!.attempts === 0);
      await queue.drainMailQueue();
      ok("  and sent", (await db.platformMailJob.findUnique({ where: { id: refused.id! } }))!.status === "SENT");
      ok("Drop: gone; a sent one can't be dropped", (await queue.dropMailJob(busy.id!)) && !(await db.platformMailJob.findUnique({ where: { id: busy.id! } })) && !(await queue.dropMailJob(refused.id!)));
      const late = await queue.queuePlatformMail(mail("Nobody sending"), { noKick: true });
      await db.platformMailJob.update({ where: { id: late.id! }, data: { nextAttemptAt: new Date(Date.now() - 20 * 60_000) } });
      const backlog = await alertsLib.alerts("OWNER", new Date());
      ok("mail due for twenty minutes and unsent raises mail.backlog, critical", backlog.open.some((a) => a.key === "mail.backlog" && a.severity === "critical"), backlog.open.map((a) => a.key));
      await queue.drainMailQueue();

      section("A check's stand-in sender");
      const direct: string[] = [];
      mailer.setTestPlatformMailer(async (m) => void direct.push(m.subject));
      const replaced = await queue.queuePlatformMail(mail("Straight to the stand-in"));
      mailer.setTestPlatformMailer(null);
      ok("with the sender replaced, sent there and then, nothing queued", replaced.id === null && direct.includes("Straight to the stand-in") && !(await db.platformMailJob.findFirst({ where: { subject: "Straight to the stand-in" } })));

      section("Kept a while");
      const old = new Date(Date.now() - 2 * 86_400_000);
      await db.platformMailJob.updateMany({ where: { status: "SENT" }, data: { sentAt: old } });
      const p1 = await queue.purgeMailJobs();
      ok("a sent mail's body goes after a day", p1.emptied > 0 && (await db.platformMailJob.count({ where: { status: "SENT", NOT: { payload: { equals: {} } } } })) === 0, p1);
      await db.platformMailJob.updateMany({ where: { status: "SENT" }, data: { sentAt: new Date(Date.now() - 8 * 86_400_000) } });
      const p2 = await queue.purgeMailJobs();
      ok("  its row after a week", p2.removed > 0 && (await db.platformMailJob.count({ where: { status: "SENT" } })) === 0, p2);
    } finally {
      store.setTestMailTransport(null);
      mailer.setTestPlatformMailer(null);
      await closeControlDb();
    }
  } finally {
    section("Clean-up");
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    ok("the scratch control plane is dropped", true);
    await admin.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll mail queue checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
