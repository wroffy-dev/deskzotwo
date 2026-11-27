/**
 * check:workflow-emails — how many emails a workflow sent (owner, 2 Nov 2026 — src/lib/automate/email-report.ts).
 *
 *   1. Counted from its runs' "Send an email" steps, at each step's last try: sent, skipped, failed; a failure retried
 *      into a send counts once, as sent; a step still waiting on a running run isn't counted; tests aren't counted.
 *   2. Today, this month and all time on the workspace's clock.
 *   3. Each listed with who, which customer, the subject from the contact's mail log, from where, and why one was
 *      skipped; a colleague by their account.
 *   4. Only for whoever may use Automate; the Excel is the list, filtered as asked.
 *
 * Adds runs to an existing workflow of the dev workspace and removes them, their mail-log rows and audit rows after.
 *
 *   npm run check:workflow-emails
 */
import "dotenv/config";
import Module from "node:module";
import ExcelJS from "exceljs";
import { directClient } from "../src/lib/tenancy/direct-client";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let allowed = true;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/authz/resolve" || request.endsWith("lib/authz/resolve")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, can: async () => allowed };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => actor, requireModuleAccess: async () => actor };
  }
  if (request === "@/actions/module" || request.endsWith("actions/module")) return { isModuleEnabled: async () => true };
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
const DAY = 86_400_000;

async function main() {
  const { workflowEmails } = await import("../src/actions/automate-emails");
  const { workflowRef } = await import("../src/lib/automate/refs");
  const { GET } = await import("../src/app/api/automate/workflow-emails/[ref]/route");

  const workflow = await db.automationWorkflow.findFirst({ select: { id: true, workflowSeq: true, name: true } });
  if (!workflow) throw new Error("No workflow in the dev workspace to add runs to.");
  const admin = await db.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true, role: true, name: true, email: true } });
  if (!admin) throw new Error("No admin.");
  actor = admin;
  const contact = await db.contact.findFirst({ where: { email: { not: null }, leftAt: null }, select: { id: true, name: true, email: true, companyId: true, company: { select: { name: true } } } });
  if (!contact) throw new Error("No contact with an email.");
  const ref = workflowRef(workflow.workflowSeq);

  const before = await workflowEmails(ref);
  const base = before!.report;
  const startedAt = new Date();
  const runs: string[] = [];
  const messages: string[] = [];
  const now = new Date();
  const lastMonth = new Date(now.getTime() - 40 * DAY);
  // A published version whose steps say which are emails, as a real run's do: the step's row says only "action" (owner,
  // 3 Nov 2026 — "mails were sent from the automation but not showing here"). The email inside a for-each, and a document.
  const definition = {
    trigger: { type: "manual" },
    steps: [
      { id: "s-each", type: "forEach", items: "{{trigger.items}}", steps: [{ id: "s-email", type: "action", action: "email.send", input: {} }] },
      { id: "s-doc", type: "action", action: "document.email", input: {} },
      { id: "s-task", type: "action", action: "task.create", input: {} },
    ],
  };
  const version = await db.automationVersion.create({
    data: { workflowId: workflow.id, number: 900_000 + Math.floor(Math.random() * 99_999), definition, definitionHash: "zz", triggerType: "manual", publishedById: admin.id },
    select: { id: true },
  });

  /** A run of the workflow with one step's tries — "Send an email" unless another is named. A test runs a draft: no version. */
  async function run(opts: { status?: "SUCCEEDED" | "FAILED" | "RUNNING"; isTest?: boolean; at?: Date; stepId?: string; tries: { status: "SUCCEEDED" | "FAILED" | "SKIPPED" | "RUNNING"; output?: object; error?: string }[] }) {
    const at = opts.at ?? now;
    const r = await db.automationRun.create({
      data: { workflowId: workflow!.id, idempotencyKey: `zz-email-check-${Math.random().toString(36).slice(2)}`, status: opts.status ?? "SUCCEEDED", cursor: {}, contextCipher: "zz", isTest: opts.isTest ?? false, versionId: opts.isTest ? null : version.id, createdAt: at, finishedAt: at },
      select: { id: true },
    });
    runs.push(r.id);
    let attempt = 1;
    for (const t of opts.tries) {
      await db.automationRunStep.create({ data: { runId: r.id, stepId: opts.stepId ?? "s-email", type: "action", attempt, status: t.status, startedAt: new Date(at.getTime() - 1000), finishedAt: t.status === "RUNNING" ? null : at, outputSummary: (t.output ?? undefined) as never, error: t.error ?? null } });
      attempt += 1;
    }
  }

  try {
    const sentOut = { sent: true, via: "company", from: "zz-sales@example.com", recipient: "contact", contactId: contact.id, userId: null, copied: 2 };
    await run({ tries: [{ status: "SUCCEEDED", output: sentOut }] });
    const m = await db.marketingMessage.create({ data: { token: `zz-${Math.random().toString(36).slice(2)}`, companyId: contact.companyId, contactId: contact.id, channel: "EMAIL", messageClass: "TRANSACTIONAL", subject: "ZZ Your Microsoft 365 renews soon", body: "<p>x</p>", toEmail: contact.email, status: "SENT", scheduledFor: now, sentAt: now, attempts: 1 }, select: { id: true } });
    messages.push(m.id);
    await run({ tries: [{ status: "FAILED", error: "Mail server didn't answer" }, { status: "SUCCEEDED", output: { ...sentOut, copied: 0 } }] });
    await run({ tries: [{ status: "SUCCEEDED", output: { sent: false, skipped: "ZZ Ravi wasn't emailed: opted out of renewals", recipient: "contact", contactId: contact.id, userId: null } }] });
    await run({ status: "FAILED", tries: [{ status: "FAILED", error: "ZZ The mailbox refused it" }] });
    await run({ status: "RUNNING", tries: [{ status: "FAILED", error: "ZZ will retry" }] });
    await run({ isTest: true, tries: [{ status: "SUCCEEDED", output: sentOut }] });
    await run({ at: lastMonth, tries: [{ status: "SUCCEEDED", output: { sent: true, via: "mailbox", from: "zz-am@example.com", recipient: "person", contactId: null, userId: admin.id } }] });

    section("1. Counted");
    const after = (await workflowEmails(ref))!.report;
    const d = (k: "sent" | "skipped" | "failed", p: "all" | "month" | "today" = "all") => after[p][k] - base[p][k];
    ok("sent: three — a retry that went counts once, a test doesn't", d("sent") === 3, { sent: d("sent") });
    ok("skipped: one", d("skipped") === 1, d("skipped"));
    ok("failed: one — not the one still running", d("failed") === 1, d("failed"));

    section("2. By period");
    ok("today: two sent, one skipped, one failed", d("sent", "today") === 2 && d("skipped", "today") === 1 && d("failed", "today") === 1, after.today);
    ok("this month leaves out last month's", d("sent", "month") === 2, after.month);

    section("3. Listed");
    const mine = after.rows.filter((r) => runs.length && (r.subject?.startsWith("ZZ") || r.reason?.startsWith("ZZ") || r.from?.startsWith("zz-")));
    const sent = mine.find((r) => r.outcome === "SENT" && r.copied === 2);
    ok("a send: the contact, their customer, the subject from the mail log, from where, CC", !!sent && sent.recipientName === contact.name && sent.companyName === contact.company.name && sent.subject === "ZZ Your Microsoft 365 renews soon" && sent.from === "zz-sales@example.com", sent);
    const skipped = mine.find((r) => r.outcome === "SKIPPED");
    ok("a skip says why", skipped?.reason === "ZZ Ravi wasn't emailed: opted out of renewals", skipped?.reason);
    const failed = mine.find((r) => r.outcome === "FAILED");
    ok("a failure says what went wrong", failed?.reason === "ZZ The mailbox refused it", failed?.reason);
    const colleague = mine.find((r) => r.recipientKind === "person");
    ok("a colleague by their account", colleague?.recipientName === admin.name && colleague.recipientEmail === admin.email && colleague.companyName === null, colleague);
    ok("newest first", after.rows.every((r, i) => i === 0 || after.rows[i - 1]!.at >= r.at));

    section("4. Who, and the Excel");
    allowed = false;
    ok("nothing for somebody who may not use Automate", (await workflowEmails(ref)) === null);
    const refused = await GET(new Request(`http://x/api/automate/workflow-emails/${ref}`), { params: Promise.resolve({ ref }) });
    ok("  the Excel a 404 to them", refused.status === 404);
    allowed = true;
    ok("nothing for a workflow that isn't there", (await workflowEmails("WF-999999")) === null);
    const res = await GET(new Request(`http://x/api/automate/workflow-emails/${ref}?show=SKIPPED`), { params: Promise.resolve({ ref }) });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await res.arrayBuffer());
    const outcomes: string[] = [];
    book.worksheets[0]!.eachRow((row, n) => n > 1 && outcomes.push(String(row.getCell(2).value)));
    ok("the Excel, only the skipped as asked", res.status === 200 && outcomes.length === after.all.skipped && outcomes.every((o) => o === "Skipped"), { rows: outcomes.length, skipped: after.all.skipped });

    section("5. A document emailed, and steps that aren't emails");
    await run({ stepId: "s-doc", tries: [{ status: "SUCCEEDED", output: { documentId: "zz", sentTo: 2, via: "DESKZO", from: "zz-docs@example.com" } }] });
    await run({ stepId: "s-task", tries: [{ status: "SUCCEEDED", output: { taskId: "zz" } }] });
    const later = (await workflowEmails(ref))!.report;
    ok("\"Email a document\" counts as sent", later.all.sent - after.all.sent === 1, { before: after.all, after: later.all });
    ok("a task doesn't count at all", later.all.sent + later.all.skipped + later.all.failed - (after.all.sent + after.all.skipped + after.all.failed) === 1);
  } finally {
    await db.automationRun.deleteMany({ where: { id: { in: runs } } });
    await db.automationVersion.delete({ where: { id: version.id } }).catch(() => undefined);
    await db.marketingMessage.deleteMany({ where: { id: { in: messages } } });
    await db.auditLog.deleteMany({ where: { entityId: workflow.id, createdAt: { gte: startedAt }, entityLabel: { startsWith: "Exported the emails" } } });
  }

  console.log(failures === 0 ? `\nAll ${passes} workflow email checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
