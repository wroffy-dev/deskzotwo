"use server";

import { checkedCc } from "@/lib/mail/cc-server";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { getOrganisation } from "@/lib/organisation";
import { PDF_MAX_BYTES, PdfError } from "@/lib/documents/pdf";
import { BODY_MAX, MAX_RECIPIENTS, SUBJECT_MAX, recipientsFor, recipientsShownTo } from "@/lib/documents/send-email";
import { toEmailHtml } from "@/lib/documents/email-template";
import { mailboxState } from "@/lib/mail/mailbox";
import { documentSender, sendDocumentMail } from "@/lib/documents/mail-route";
import { allowanceRefusal, deskzoAllowance, recordDeskzoSend, releaseDeskzoSend, reserveDeskzoSend } from "@/lib/documents/deskzo-mail-allowance";
import { MAIL_NAMES, SIGN_IN_NAMES, sayEither } from "@/lib/workplace/providers";
import { maySeeStatement } from "@/lib/statements/print-data";
import { statementFilename, statementPdf } from "@/lib/statements/render";
import type { StatementSide } from "@/lib/statements/paths";
import type { ActionResult } from "@/actions/company";
import { TEXT_MAX, tooMany } from "@/lib/validation/text";

/**
 * A customer's or vendor's statement by email, with its PDF (owner, 31 Oct 2026 — "customers ask for this"): to the
 * party's own contacts who can receive mail, from the sender's mailbox, the company's mail server or Deskzo's — as a
 * document email goes (src/lib/documents/send-email.ts) — and logged per person in the mail log and the activity.
 */

type View = { from?: string | null; to?: string | null; show?: string | null };

const isSide = (v: unknown): v is StatementSide => v === "AR" || v === "AP";
const dayLabel = (d: string) => new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
const periodWords = (view: View) => (view.from || view.to ? `${view.from ? dayLabel(view.from) : "the beginning"} to ${view.to ? dayLabel(view.to) : "today"}` : "to date");

/** Who it can go to, and the words it starts with. */
export async function statementEmailSetup(side: StatementSide, companyId: string, view: View): Promise<ActionResult<{ recipients: Awaited<ReturnType<typeof recipientsFor>>; subject: string; body: string }>> {
  const user = await requireUser();
  if (!isSide(side) || !(await maySeeStatement(user.id, side, companyId))) return { ok: false, error: "That statement isn't there." };
  const [company, org, me] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: { name: true } }),
    getOrganisation(),
    db.user.findUnique({ where: { id: user.id }, select: { name: true } }),
  ]);
  if (!company) return { ok: false, error: "That statement isn't there." };
  const ours = org.tradeName || org.legalName;
  const period = periodWords(view);
  return {
    ok: true,
    data: {
      // Only the people this person may see (owner, 3 Nov 2026 — Phase 2 permission fixes, audit H-4), each as their
      // contacts policy shows them (owner, 5 Nov 2026 — Phase 3 masking fixes); the send goes by contact id.
      recipients: await recipientsShownTo(companyId, user.id),
      subject: `Statement of accounts — ${company.name} — ${period}`,
      body: `Dear Sir/Madam,\n\nPlease find attached your statement of accounts with ${ours}, ${period}.\n\nIf anything on it doesn't match your records, do let us know.\n\nRegards,\n${me?.name ?? ours}\n${ours}`,
    },
  };
}

export async function sendStatement(input: { side: StatementSide; companyId: string; view: View; contactIds: string[]; subject: string; body: string; cc?: string }): Promise<ActionResult<{ sentTo: string[]; from: string }>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  // Security audit, 13 Nov 2026 (SEC-30 follow-up): at most 50 ids sent, each a short string, before anything is read.
  const sentIds: unknown = input?.contactIds ?? [];
  if (!Array.isArray(sentIds) || sentIds.some((c) => typeof c !== "string" || c.length > TEXT_MAX.id)) return { ok: false, error: "Those recipients aren't valid." };
  if (sentIds.length > 50) return { ok: false, error: tooMany(50, "people") };
  const { side, companyId } = input ?? ({} as typeof input);
  if (!isSide(side) || typeof companyId !== "string" || !(await maySeeStatement(user.id, side, companyId))) return { ok: false, error: "That statement isn't there." };
  const company = await db.company.findUnique({ where: { id: companyId }, select: { name: true } });
  if (!company) return { ok: false, error: "That statement isn't there." };
  const view: View = { from: input.view?.from ?? null, to: input.view?.to ?? null, show: input.view?.show === "outstanding" ? "outstanding" : null };

  // To this party's own contacts, each still able to receive mail.
  const wanted = [...new Set(sentIds as string[])];
  if (wanted.length === 0) return { ok: false, error: "Tick at least one person to send it to." };
  if (wanted.length > MAX_RECIPIENTS) return { ok: false, error: `Send it to ${MAX_RECIPIENTS} people at most.` };
  // Only people the sender may see (audit H-4): one outside their Contacts level answers as somebody else's contact does.
  const contacts = await recipientsFor(companyId, user.id);
  const chosen = wanted.map((id) => contacts.find((c) => c.id === id));
  if (chosen.some((c) => !c)) return { ok: false, error: "One of those people isn't a contact of this company." };
  const refused = chosen.find((c) => !c!.canReceive);
  if (refused) return { ok: false, error: `${refused.name} can't be sent this: ${refused.blockedBecause}` };
  const recipients = (chosen as NonNullable<(typeof chosen)[number]>[]).map((r) => ({ id: r.id, name: r.name, email: r.email! }));
  // Copied (owner, 16 Nov 2026: "add cc"): typed addresses, checked as addresses and against the block rules.
  const copied = await checkedCc(typeof input.cc === "string" ? input.cc.slice(0, 1000) : "", recipients.map((r) => r.email));
  if (!copied.ok) return { ok: false, error: copied.error };
  const cc = copied.cc;
  if (recipients.length + cc.length > MAX_RECIPIENTS) return { ok: false, error: `Send it to ${MAX_RECIPIENTS} people at most, counting those copied.` };

  const subject = String(input.subject ?? "").trim();
  const text = String(input.body ?? "").trim();
  if (!subject) return { ok: false, error: "Give the email a subject." };
  if (!text) return { ok: false, error: "Write the message." };
  if (subject.length > SUBJECT_MAX || text.length > BODY_MAX) return { ok: false, error: "The message is too long." };
  if (/[\r\n]/.test(subject)) return { ok: false, error: "The subject has to be one line." };

  // How it goes, before making the PDF: no point making one to find there's nothing to send it with.
  const mailbox = await mailboxState(user.id);
  const route = await documentSender(mailbox);
  if (route.choice === "CONNECT") {
    return {
      ok: false,
      error:
        mailbox.state === "broken"
          ? `${SIGN_IN_NAMES[mailbox.provider]} stopped accepting your ${MAIL_NAMES[mailbox.provider]} connection. Connect it again from My profile.`
          : mailbox.state === "not-connected"
            ? `Connect your ${sayEither(mailbox.providers.map((p) => MAIL_NAMES[p]))} first — it's what the email is sent from.`
            : "Connect your mailbox first — it's what the email is sent from.",
    };
  }
  if (route.choice === "DESKZO") {
    const over = allowanceRefusal(await deskzoAllowance(user.id), recipients.length + cc.length);
    if (over) return { ok: false, error: over };
  }

  let pdf: Buffer;
  try {
    pdf = await statementPdf(user.id, side, companyId, view);
  } catch (e) {
    return { ok: false, error: e instanceof PdfError ? e.message : "The PDF couldn't be made. Nothing was sent." };
  }
  if (pdf.length > PDF_MAX_BYTES) return { ok: false, error: "The PDF is over 3 MB — too big to send this way. Try a shorter period. Nothing was sent." };

  const reserved = route.choice === "DESKZO" ? await reserveDeskzoSend(user.id, null, recipients.length + cc.length) : null;
  if (reserved && !reserved.ok) return { ok: false, error: reserved.error };
  const [me, org] = await Promise.all([db.user.findUnique({ where: { id: user.id }, select: { name: true, email: true } }), getOrganisation()]);
  const html = toEmailHtml(text);
  const outcome = await sendDocumentMail(route.choice, {
    senderUserId: user.id,
    senderName: me?.name ?? user.name ?? "",
    senderEmail: me?.email ?? user.email ?? "",
    companyName: org.tradeName || org.legalName,
    to: recipients.map((r) => ({ name: r.name, email: r.email })),
    ...(cc.length ? { cc: cc.map((email) => ({ name: null, email })) } : {}),
    subject,
    html,
    text,
    attachment: { filename: statementFilename(company.name, view), contentType: "application/pdf", content: pdf },
  });

  // One row per person, so the company's mail log says exactly who it went to — or didn't reach, and why.
  const now = new Date();
  const triedFrom = route.choice === "OWN" && mailbox.state === "connected" ? mailbox.mailbox : (route.company?.fromEmail ?? null);
  await db.marketingMessage.createMany({
    data: [...recipients, ...cc.map((email) => ({ id: null, email }))].map((r) => ({
      token: randomBytes(24).toString("base64url"),
      companyId,
      contactId: r.id,
      channel: "EMAIL" as const,
      messageClass: "TRANSACTIONAL" as const,
      subject,
      body: html,
      textBody: text,
      toEmail: r.email,
      status: outcome.ok ? ("SENT" as const) : ("FAILED" as const),
      error: outcome.ok ? null : outcome.error,
      scheduledFor: now,
      sentAt: outcome.ok ? now : null,
      attempts: 1,
      sentByUserId: user.id,
      fromEmail: outcome.ok ? outcome.from : triedFrom,
    })),
  });
  if (reserved?.ok && (!outcome.ok || outcome.via !== "DESKZO")) await releaseDeskzoSend(reserved.id);
  if (!outcome.ok) return { ok: false, error: outcome.error };
  if (outcome.via === "DESKZO" && !reserved?.ok) await recordDeskzoSend(user.id, null, recipients.length + cc.length);

  const to = recipients.map((r) => r.email);
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Company",
    entityId: companyId,
    entityLabel: `${company.name} — statement of accounts (${periodWords(view)}${view.show === "outstanding" ? ", outstanding only" : ""}) emailed to ${to.join(", ")}${cc.length ? `, cc ${cc.join(", ")}` : ""} from ${outcome.from}`.slice(0, 500),
    subject: { companyId },
  });
  return { ok: true, data: { sentTo: to, from: outcome.from } };
}
