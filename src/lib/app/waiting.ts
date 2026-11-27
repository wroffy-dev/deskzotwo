import { db } from "@/lib/db";
import { ApiError } from "@/lib/api/handler";
import { workspaceClock } from "@/lib/time/workspace";
import { leadPath, companyPath } from "@/lib/record-links";
import { sendTimeFor, sendTimeLabel } from "@/lib/nurture/replies";
import { waitingForYou, type WaitingDecideKind } from "@/lib/ai/waiting";
import { workspaceTeammates } from "@/lib/ai/teammates-server";
import { sendNurtureEmail, skipNurtureEmail } from "@/actions/nurture";
import { sendReengage, skipReengage } from "@/actions/reengage";
import { discardChaseEmail, openChaseEmail, sendChaseEmail } from "@/actions/collection-chase";

/**
 * "Waiting for you" on the phone (owner, 22 Nov 2026 — "go with phone approvals", the last of the AI team's step 3):
 * what the AI teammates left for this person, and the emails among it — Tara's follow-ups and check-ins, Arjun's chase
 * emails — read, changed and sent or set aside right there. Each by the web's own action, as the phone's person
 * (src/lib/app/handler.ts), so who may send what, from which mailbox, and every check before it goes are the web's.
 * Anything else on the list (a reply to act on, an HR question, a chat) opens in Deskzo on the phone.
 */

export const DECIDE_KINDS: WaitingDecideKind[] = ["nurture", "checkin", "chase"];

export type PhoneWaitingItem = {
  teammate: string;
  teammate_name: string;
  title: string;
  detail: string | null;
  at: string;
  /** Where it's decided on the web, for the phone's Deskzo view. */
  path: string;
  /** Set for an email checked and sent in place. */
  decide: { kind: WaitingDecideKind; id: string } | null;
};

export async function waitingForPhone(userId: string): Promise<{ items: PhoneWaitingItem[]; total: number }> {
  const [w, team] = await Promise.all([waitingForYou(userId, 50), workspaceTeammates()]);
  return {
    total: w.total,
    items: w.items.map((i) => ({
      teammate: i.teammate,
      teammate_name: team[i.teammate]?.name ?? i.teammate,
      title: i.title,
      detail: i.detail,
      at: i.at,
      path: i.href,
      decide: i.decide ?? null,
    })),
  };
}

export type PhoneWaitingEmail = {
  kind: WaitingDecideKind;
  id: string;
  teammate_name: string;
  company: string;
  /** Who it goes to — a name, or the names ticked for a chase. */
  to: string;
  from_problem: string | null;
  subject: string;
  body: string;
  /** "Mon 24 Nov, 10:00" — when approving now would send it; null when it goes at once. */
  hold_until: string | null;
  /** A few lines of what it's about — a chase's invoices. */
  lines: string[];
  hint: string;
  path: string;
};

const PLACEHOLDERS = "{{firstName}} becomes their first name and {{senderName}} yours.";

async function holdLabel(now: Date): Promise<string | null> {
  const clock = await workspaceClock();
  const at = sendTimeFor(now, clock.zone);
  return at.getTime() > now.getTime() + 60_000 ? sendTimeLabel(at, clock.zone) : null;
}

const gone = () => new ApiError(404, "not_found", "That email isn't waiting any more.");

/** One waiting email, to read and change — only one that is this person's to send. */
export async function waitingEmail(userId: string, kind: WaitingDecideKind, id: string, now = new Date()): Promise<PhoneWaitingEmail> {
  const team = await workspaceTeammates();
  if (kind === "nurture") {
    const t = await db.nurtureTouch.findUnique({
      where: { id },
      select: { status: true, step: true, subject: true, body: true, enrolment: { select: { ownerId: true, status: true, contact: { select: { name: true } }, lead: { select: { leadSeq: true, company: { select: { name: true } } } } } } },
    });
    if (!t || t.status !== "WAITING" || t.enrolment.status !== "ACTIVE" || t.enrolment.ownerId !== userId) throw gone();
    return {
      kind,
      id,
      teammate_name: team.tara.name,
      company: t.enrolment.lead.company.name,
      to: t.enrolment.contact.name,
      from_problem: null,
      subject: t.subject,
      body: t.body,
      hold_until: await holdLabel(now),
      lines: [`Follow-up ${t.step + 1} of 4`],
      hint: `${PLACEHOLDERS} It goes from your mailbox.`,
      path: leadPath(t.enrolment.lead.leadSeq),
    };
  }
  if (kind === "checkin") {
    const e = await db.reengageEmail.findUnique({ where: { id }, select: { status: true, ownerId: true, subject: true, body: true, contact: { select: { name: true } }, company: { select: { name: true, companySeq: true } } } });
    if (!e || e.status !== "WAITING" || e.ownerId !== userId) throw gone();
    return {
      kind,
      id,
      teammate_name: team.tara.name,
      company: e.company.name,
      to: e.contact.name,
      from_problem: null,
      subject: e.subject,
      body: e.body,
      hold_until: await holdLabel(now),
      lines: ["A check-in — they haven't ordered for a while"],
      hint: `${PLACEHOLDERS} It goes from your mailbox.`,
      path: `${companyPath(e.company.companySeq)}#check-in`,
    };
  }
  const opened = await openChaseEmail(id);
  if (!opened.ok || opened.data.status !== "WAITING") throw gone();
  const v = opened.data;
  const to = v.recipients.filter((r) => r.ticked && r.canReceive).map((r) => r.name);
  return {
    kind,
    id,
    teammate_name: team.arjun.name,
    company: v.companyName,
    to: to.join(", ") || "Nobody yet — choose who on the web",
    from_problem: v.fromProblem,
    subject: v.subject,
    body: v.body,
    hold_until: null,
    lines: v.lines.slice(0, 6).map((l) => `${l.number} · ${l.balance} · ${l.late}`),
    hint: `${PLACEHOLDERS} {{invoices}} becomes the list of invoices. To change who it goes to or attach the statement, open it on the web.`,
    path: "/collections",
  };
}

export type PhoneDecision = { action: "send" | "skip"; when: "now" | "working-hours"; subject: string; body: string };

/** Sends (or holds for the working morning) or sets aside one waiting email, by the web's own action. */
export async function decideWaiting(kind: WaitingDecideKind, id: string, d: PhoneDecision): Promise<{ done: "sent" | "held" | "skipped"; at: string | null }> {
  const refuse = (error: string): never => {
    throw new ApiError(422, "refused", error);
  };
  if (d.action === "skip") {
    const r = kind === "nurture" ? await skipNurtureEmail(id) : kind === "checkin" ? await skipReengage(id) : await discardChaseEmail(id);
    if (!r.ok) refuse(r.error);
    return { done: "skipped", at: null };
  }
  if (kind === "nurture") {
    const r = await sendNurtureEmail({ touchId: id, subject: d.subject, body: d.body, when: d.when });
    if (!r.ok) return refuse(r.error);
    return { done: r.data.at ? "held" : "sent", at: r.data.at };
  }
  if (kind === "checkin") {
    const r = await sendReengage({ id, subject: d.subject, body: d.body, when: d.when });
    if (!r.ok) return refuse(r.error);
    return { done: r.data.at ? "held" : "sent", at: r.data.at };
  }
  // A chase goes now, to whoever the web would send it to — the ticked people who can receive it.
  const opened = await openChaseEmail(id);
  if (!opened.ok) return refuse(opened.error);
  const contactIds = opened.data.recipients.filter((r) => r.ticked && r.canReceive).map((r) => r.id);
  if (!contactIds.length) return refuse("Nobody to send it to yet — choose who on the web.");
  const r = await sendChaseEmail({ id, subject: d.subject, body: d.body, contactIds, attachStatement: false });
  if (!r.ok) return refuse(r.error);
  return { done: "sent", at: null };
}
