import { db } from "@/lib/db";
import { workspaceClock } from "@/lib/time/workspace";
import { runRef } from "@/lib/automate/refs";
import { eachStep, type Step } from "@/lib/automate/definition";
import { contactMasker } from "@/lib/contacts/masking";
import { contactRedactor } from "@/lib/contacts/redaction";

/**
 * What a workflow emailed (owner, 2 Nov 2026: "how do I check an automation has sent how many mails?"): every "Send an
 * email" step its real runs reached — tests left out — as sent, skipped (the contact had no address, had opted out,
 * had bounced…) or failed, counted today, this month and in all, and listed newest first.
 *
 * Read from the runs' own steps: one row per step and run, at its last try, so a
 * send that failed once and went on the retry counts once, as sent. The step keeps who it went to and from where, not
 * the subject or address — those come from the contact's mail log row the step wrote as it sent (MarketingMessage),
 * matched by contact and the minute it went; a colleague's address is read from their account.
 */

export type EmailOutcome = "SENT" | "SKIPPED" | "FAILED";

export type WorkflowEmail = {
  at: Date;
  outcome: EmailOutcome;
  runRef: string;
  recipientKind: "contact" | "person" | null;
  recipientName: string | null;
  recipientEmail: string | null;
  companyName: string | null;
  companySeq: number | null;
  subject: string | null;
  from: string | null;
  copied: number;
  /** Why it was skipped, or what went wrong. */
  reason: string | null;
};

export type Tally = { sent: number; skipped: number; failed: number };
export type WorkflowEmailReport = { today: Tally; month: Tally; all: Tally; rows: WorkflowEmail[]; capped: boolean };

const MAX_STEPS = 20_000;
/** The actions that email somebody: a message, and a document (a quote, an invoice) sent to its customer. */
const EMAIL_ACTIONS = new Set(["email.send", "document.email"]);

/**
 * Which steps of which published version email somebody. A run's step row says only "action" (src/lib/automate/engine.ts
 * startStep), not which — that is in the version's definition, by step id (owner, 3 Nov 2026: "mails were sent from
 * the automation but not showing here" — the report asked for a step type no row ever had). Tests run a draft, with no
 * version, so they are never among these.
 */
async function emailSteps(workflowId: string): Promise<{ versionId: string; stepIds: string[] }[]> {
  const versions = await db.automationVersion.findMany({ where: { workflowId }, select: { id: true, definition: true } });
  return versions
    .map((v) => {
      const steps = ((v.definition ?? {}) as { steps?: Step[] }).steps ?? [];
      const stepIds = eachStep(steps)
        .map(({ step }) => step)
        .filter((s) => s.type === "action" && EMAIL_ACTIONS.has(s.action))
        .map((s) => s.id);
      return { versionId: v.id, stepIds };
    })
    .filter((v) => v.stepIds.length > 0);
}
const LISTED = 2_000;
const empty = (): Tally => ({ sent: 0, skipped: 0, failed: 0 });

type Summary = { sent?: unknown; skipped?: unknown; from?: unknown; recipient?: unknown; contactId?: unknown; userId?: unknown; copied?: unknown };
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * `viewerId`, who is looking: a contact recipient's name and address as their contacts policy shows a contact in a list,
 * and the subject and reason quoting them redacted (owner, 5 Nov 2026 — Phase 3 masking fixes; src/lib/contacts/masking.ts)
 * — the page and its Excel listed every address in full. A colleague is named as before. Null: as stored.
 */
export async function workflowEmailReport(workflowId: string, viewerId: string | null, now = new Date()): Promise<WorkflowEmailReport> {
  const versions = await emailSteps(workflowId);
  const steps = versions.length === 0 ? [] : await db.automationRunStep.findMany({
    where: { type: "action", run: { workflowId, isTest: false }, OR: versions.map((v) => ({ run: { versionId: v.versionId }, stepId: { in: v.stepIds } })) },
    orderBy: { startedAt: "desc" },
    take: MAX_STEPS,
    select: { runId: true, stepId: true, attempt: true, status: true, startedAt: true, finishedAt: true, outputSummary: true, error: true, run: { select: { runSeq: true, status: true } } },
  });

  // Each step of each run at its last try; one still running, or waiting to retry in a run still going, isn't an outcome yet.
  const last = new Map<string, (typeof steps)[number]>();
  for (const s of steps) {
    const key = `${s.runId}:${s.stepId}`;
    const had = last.get(key);
    if (!had || s.attempt > had.attempt) last.set(key, s);
  }
  const settled = [...last.values()].filter((s) => s.status === "SUCCEEDED" || s.status === "SKIPPED" || (s.status === "FAILED" && !["RUNNING", "QUEUED", "WAITING"].includes(s.run.status)));

  const clock = await workspaceClock();
  const todayKey = clock.today(now);
  const monthKey = clock.monthKey(now);
  const tally = { today: empty(), month: empty(), all: empty() };

  const rows: WorkflowEmail[] = settled.map((s) => {
    const out = (s.outputSummary ?? {}) as Summary;
    // "Send an email" says sent or not; "Email a document" only finishes having sent it.
    const outcome: EmailOutcome = s.status === "FAILED" ? "FAILED" : out.sent === true || (out.sent === undefined && s.status === "SUCCEEDED") ? "SENT" : "SKIPPED";
    const at = s.finishedAt ?? s.startedAt;
    const field = outcome === "SENT" ? "sent" : outcome === "SKIPPED" ? "skipped" : "failed";
    tally.all[field] += 1;
    if (clock.monthKey(at) === monthKey) tally.month[field] += 1;
    if (clock.dateKey(at) === todayKey) tally.today[field] += 1;
    return {
      at,
      outcome,
      runRef: runRef(s.run.runSeq),
      recipientKind: out.recipient === "contact" || out.recipient === "person" ? out.recipient : null,
      recipientName: null,
      recipientEmail: null,
      companyName: null,
      companySeq: null,
      subject: null,
      from: str(out.from),
      copied: typeof out.copied === "number" ? out.copied : 0,
      reason: outcome === "SKIPPED" ? str(out.skipped) : outcome === "FAILED" ? s.error : null,
      // Held for the lookups below, then dropped.
      ...{ _contactId: str(out.contactId), _userId: str(out.userId) },
    } as WorkflowEmail & { _contactId: string | null; _userId: string | null };
  });
  rows.sort((a, b) => b.at.getTime() - a.at.getTime());
  const listed = rows.slice(0, LISTED) as (WorkflowEmail & { _contactId: string | null; _userId: string | null })[];

  // Who each went to, and — for a contact — the subject from their mail log, sent within a minute of the step.
  const contactIds = [...new Set(listed.map((r) => r._contactId).filter((v): v is string => !!v))];
  const userIds = [...new Set(listed.map((r) => r._userId).filter((v): v is string => !!v))];
  const oldest = listed.length ? listed[listed.length - 1]!.at : now;
  const [contacts, users, messages] = await Promise.all([
    contactIds.length ? db.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true, email: true, phone: true, company: { select: { companySeq: true, name: true } } } }) : [],
    userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
    contactIds.length
      ? db.marketingMessage.findMany({
          where: { contactId: { in: contactIds }, channel: "EMAIL", sentAt: { gte: new Date(oldest.getTime() - 5 * 60_000) } },
          select: { contactId: true, subject: true, toEmail: true, sentAt: true },
        })
      : [],
  ]);
  const contactOf = new Map(contacts.map((c) => [c.id, c]));
  const userOf = new Map(users.map((u) => [u.id, u]));
  const seen = viewerId ? await contactMasker(viewerId, "list", contactIds) : null;
  for (const r of listed) {
    if (r._contactId) {
      const c = contactOf.get(r._contactId);
      r.recipientName = c?.name ?? null;
      r.recipientEmail = c?.email ?? null;
      r.companyName = c?.company.name ?? null;
      r.companySeq = c?.company.companySeq ?? null;
      let sentTo: string | null = null;
      if (r.outcome === "SENT") {
        const m = messages.find((x) => x.contactId === r._contactId && x.sentAt && Math.abs(x.sentAt.getTime() - r.at.getTime()) <= 5 * 60_000);
        if (m) {
          r.subject = m.subject;
          sentTo = m.toEmail;
          r.recipientEmail = m.toEmail ?? r.recipientEmail;
        }
      }
      if (seen?.active) {
        const id = r._contactId;
        const redact = contactRedactor(seen, id, [["name", c?.name], ["email", c?.email], ["email", sentTo], ["phone", c?.phone]]);
        r.recipientName = r.recipientName === null ? null : seen.present(id, "name", r.recipientName);
        r.recipientEmail = r.recipientEmail === null ? null : seen.present(id, "email", r.recipientEmail);
        r.subject = redact(r.subject);
        r.reason = redact(r.reason);
      }
    } else {
      r.companySeq = null;
      if (r._userId) {
        const u = userOf.get(r._userId);
        r.recipientName = u?.name ?? null;
        r.recipientEmail = u?.email ?? null;
      }
    }
  }

  return {
    ...tally,
    // The lookups' ids dropped: what the page and the Excel show.
    rows: listed.map((r) => { const shown: WorkflowEmail & { _contactId?: string | null; _userId?: string | null } = { ...r }; delete shown._contactId; delete shown._userId; return shown; }),
    capped: steps.length >= MAX_STEPS || rows.length > LISTED,
  };
}
