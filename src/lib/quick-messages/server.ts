import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { contactScope } from "@/lib/authz/contact-access";
import { contactMasker } from "@/lib/contacts/masking";
import { STILL_THERE } from "@/lib/contacts/left";
import { notMigratedYet } from "@/lib/not-migrated";
import { bytesOf, keepBytes, StoredFileMissing } from "@/lib/storage/files";
import { keepOrRefuse } from "@/lib/file-refusal";
import { getOrganisation } from "@/lib/organisation";
import { recordAudit } from "@/lib/audit";
import { mailboxState, sendAsUser } from "@/lib/mail/mailbox";
import { checkedCc } from "@/lib/mail/cc-server";
import { deliverNow, emailRouteFor, marketingSettings, resolveRecipients } from "@/lib/marketing/pipeline";
import { whatsappNumber } from "@/lib/marketing/providers/whatsapp";
import { senderDisplayName } from "@/lib/documents/mail-route-labels";
import { textToHtml } from "@/lib/pipeline/automation-rules";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { sendWhatsApp, whatsappReady } from "@/lib/inbox/whatsapp";
import { addMessage } from "@/lib/inbox/server";
import { WHATSAPP_WINDOW_MS } from "@/lib/inbox/settings";
import { STARTERS } from "@/lib/quick-messages/starters";
import { pendingNotice, type PendingNotice } from "@/lib/quick-messages/notices";
import { marketingEmailFor, type OwnFile } from "@/lib/quick-messages/extras";
import { callResultOf, fill, templateRefusal, whatsappVariables, type CallResult, type QuickMoment, type QuickValues, QUICK_MOMENTS, CALL_RESULTS } from "@/lib/quick-messages/fields";

/**
 * Messages a person sends a customer by hand, from a template (owner, 11 Nov 2026): when the account manager changes,
 * after a call, or any time from a record. Nothing here goes on its own — every send is somebody pressing Send on a
 * message they have read.
 *
 * Email goes from the sender's own connected mailbox, else the company's mail server in their name with replies to
 * them (as a workflow's email does). The new account manager's introduction is from the new manager — their mailbox,
 * their name — whoever presses Send, with the previous manager copied.
 *
 * WhatsApp is the company's (owner: "company whatsapp"): the sender's own number in the Customer inbox, else the
 * number the team shares, else the WhatsApp provider in Mail & messaging. WhatsApp's own rule decides what can go:
 * free text within 24 hours of the customer's last message there; after that only the template Meta approved, with
 * its fields filled.
 *
 * What went is on the contact's mail log (as an emailed document is), on the lead's timeline when there is a lead,
 * and in the activity log.
 */

export type QuickTemplateRow = {
  id: string;
  name: string;
  moment: QuickMoment;
  callResult: CallResult;
  emailSubject: string | null;
  emailBody: string | null;
  whatsappBody: string | null;
  whatsappTemplateName: string | null;
  starter: boolean;
  active: boolean;
  /** The PDF it sends with it — the company profile, a brochure — or null. */
  attachment: { name: string; size: number } | null;
  /** A starter written to go with a file the workspace hasn't attached yet. */
  wantsFile: boolean;
};

/** One PDF a template: small enough for any mailbox, and for the 6 MB a form may carry here. */
export const ATTACHMENT_LIMIT = 5 * 1024 * 1024;

const asMoment = (v: string): QuickMoment => ((QUICK_MOMENTS as readonly string[]).includes(v) ? (v as QuickMoment) : "ANY");
const asResult = (v: string): CallResult => ((CALL_RESULTS as readonly string[]).includes(v) ? (v as CallResult) : "ANY");

/** The starters, once: each is known by its key, so one switched off or reworded is never added again. */
export async function ensureStarters(): Promise<void> {
  const have = await db.quickTemplate.count({ where: { starterKey: { not: null } } });
  if (have >= STARTERS.length) return;
  await db.quickTemplate.createMany({
    data: STARTERS.map((s, i) => ({ name: s.name, moment: s.moment, callResult: s.callResult, emailSubject: s.emailSubject, emailBody: s.emailBody, whatsappBody: s.whatsappBody, starterKey: s.key, sortOrder: i })),
    skipDuplicates: true,
  });
}

export async function listQuickTemplates(filter: { moment?: QuickMoment; outcome?: string | null; activeOnly?: boolean } = {}): Promise<QuickTemplateRow[]> {
  try {
    await ensureStarters();
    const rows = await db.quickTemplate.findMany({ where: filter.activeOnly ? { active: true } : {}, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    // Each one's file by name and size only — the bytes are read when it is sent.
    const kept = await db.quickTemplateFile.findMany({ select: { templateId: true, fileName: true, size: true } }).catch((err) => (notMigratedYet(err) ? [] : Promise.reject(err)));
    const files = new Map(kept.map((f) => [f.templateId, { name: f.fileName, size: f.size }]));
    const wanting = new Set(STARTERS.filter((x) => x.wantsFile).map((x) => x.key));
    const result = callResultOf(filter.outcome);
    return rows
      .map((r) => ({ id: r.id, name: r.name, moment: asMoment(r.moment), callResult: asResult(r.callResult), emailSubject: r.emailSubject, emailBody: r.emailBody, whatsappBody: r.whatsappBody, whatsappTemplateName: r.whatsappTemplateName, starter: r.starterKey !== null, active: r.active, attachment: files.get(r.id) ?? null, wantsFile: !!r.starterKey && wanting.has(r.starterKey) && !files.has(r.id) }))
      // A moment's own templates first, then the any-time ones; after a call, the ones for how it went.
      .filter((r) => !filter.moment || r.moment === filter.moment || r.moment === "ANY")
      .filter((r) => filter.moment !== "AFTER_CALL" || r.moment !== "AFTER_CALL" || r.callResult === "ANY" || !result || r.callResult === result)
      .sort((a, b) => Number(b.moment === filter.moment) - Number(a.moment === filter.moment));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

export type QuickTemplateInput = { id?: string; name: string; moment: string; callResult: string; emailSubject?: string | null; emailBody?: string | null; whatsappBody?: string | null; whatsappTemplateName?: string | null; active?: boolean };

export async function saveQuickTemplate(userId: string, input: QuickTemplateInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const clean = {
    name: String(input.name ?? "").trim().slice(0, 120),
    moment: asMoment(String(input.moment ?? "ANY")),
    callResult: asResult(String(input.callResult ?? "ANY")),
    emailSubject: String(input.emailSubject ?? "").trim().slice(0, 300) || null,
    emailBody: String(input.emailBody ?? "").trim().slice(0, 20_000) || null,
    whatsappBody: String(input.whatsappBody ?? "").trim().slice(0, 1024) || null,
    whatsappTemplateName: String(input.whatsappTemplateName ?? "").trim() || null,
    active: input.active !== false,
  };
  const refusal = templateRefusal(clean);
  if (refusal) return { ok: false, error: refusal };
  if (clean.moment !== "AFTER_CALL") clean.callResult = "ANY";
  if (input.id) {
    const found = await db.quickTemplate.findUnique({ where: { id: String(input.id) }, select: { id: true } });
    if (!found) return { ok: false, error: "That template no longer exists." };
    await db.quickTemplate.update({ where: { id: found.id }, data: clean });
    await recordAudit({ userId, action: "UPDATE", entityType: "QuickTemplate", entityId: found.id, entityLabel: `Message template "${clean.name}"` });
    return { ok: true, id: found.id };
  }
  const last = await db.quickTemplate.aggregate({ _max: { sortOrder: true } });
  const made = await db.quickTemplate.create({ data: { ...clean, createdById: userId, sortOrder: (last._max.sortOrder ?? 0) + 1 }, select: { id: true } });
  await recordAudit({ userId, action: "CREATE", entityType: "QuickTemplate", entityId: made.id, entityLabel: `Message template "${clean.name}"` });
  return { ok: true, id: made.id };
}

/** A workspace's own template goes; a starter is switched off instead, so it isn't handed out again. */
export async function deleteQuickTemplate(userId: string, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const found = await db.quickTemplate.findUnique({ where: { id: String(id) }, select: { id: true, name: true, starterKey: true } });
  if (!found) return { ok: true };
  if (found.starterKey) await db.quickTemplate.update({ where: { id: found.id }, data: { active: false } });
  else {
    await db.quickTemplateFile.deleteMany({ where: { templateId: found.id } });
    await db.quickTemplate.delete({ where: { id: found.id } });
  }
  await recordAudit({ userId, action: found.starterKey ? "UPDATE" : "DELETE", entityType: "QuickTemplate", entityId: found.id, entityLabel: `Message template "${found.name}"${found.starterKey ? " switched off" : ""}` });
  return { ok: true };
}

// ─── A template's file ───────────────────────────────────────────────────────────────────────────

/** A template's PDF, attached or replaced. A PDF by its bytes, not its name; at most 5 MB. */
export async function attachTemplateFile(userId: string, templateId: string, file: { bytes: Buffer; name: string }): Promise<{ ok: true; name: string; size: number } | { ok: false; error: string }> {
  const template = await db.quickTemplate.findUnique({ where: { id: String(templateId) }, select: { id: true, name: true } });
  if (!template) return { ok: false, error: "That template no longer exists." };
  if (file.bytes.length === 0) return { ok: false, error: "Choose a PDF." };
  if (file.bytes.length > ATTACHMENT_LIMIT) return { ok: false, error: "That PDF is over 5 MB — save a smaller copy and try again." };
  if (file.bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return { ok: false, error: "That isn't a PDF." };
  const name = `${file.name.replace(/\.pdf$/i, "").replace(/[^\p{L}\p{N} _.-]+/gu, " ").trim().slice(0, 80) || "Attachment"}.pdf`;
  // In the storage box when the server has one (src/lib/storage/files.ts); the row keeps its reference and the real size.
  // Out of storage, the person is told and the template keeps the file it had (src/lib/file-refusal.ts).
  const kept = await keepOrRefuse(() => keepBytes("quick-templates", file.bytes, "application/pdf"));
  if (!kept.ok) return kept;
  const data = { fileName: name, mimeType: "application/pdf", size: file.bytes.length, data: kept.value, createdById: userId };
  await db.quickTemplateFile.upsert({ where: { templateId: template.id }, create: { templateId: template.id, ...data }, update: { ...data, createdAt: new Date() } });
  await recordAudit({ userId, action: "UPDATE", entityType: "QuickTemplate", entityId: template.id, entityLabel: `Message template "${template.name}" — attached ${name}` });
  return { ok: true, name, size: file.bytes.length };
}

export async function removeTemplateFile(userId: string, templateId: string): Promise<void> {
  const gone = await db.quickTemplateFile.deleteMany({ where: { templateId: String(templateId) } });
  if (gone.count) await recordAudit({ userId, action: "UPDATE", entityType: "QuickTemplate", entityId: String(templateId), entityLabel: "Message template — attachment removed" });
}

/**
 * The file itself, for a send or a download — from the storage box when it is kept there. Throws `StoredFileMissing`
 * for one the box no longer has; a send asks `fileForSend`, which says so.
 */
export async function templateFile(templateId: string | null | undefined): Promise<{ name: string; mime: string; bytes: Buffer } | null> {
  if (!templateId) return null;
  const f = await db.quickTemplateFile.findUnique({ where: { templateId: String(templateId) }, select: { fileName: true, mimeType: true, data: true } }).catch((err) => (notMigratedYet(err) ? null : Promise.reject(err)));
  return f ? { name: f.fileName, mime: f.mimeType, bytes: Buffer.from(await bytesOf(f.data)) } : null;
}

/** The template's PDF for a send, or why it can't go: one the storage box no longer has isn't quietly left off. */
export async function fileForSend(templateId: string | null | undefined): Promise<{ file: Awaited<ReturnType<typeof templateFile>> } | { error: string }> {
  try {
    return { file: await templateFile(templateId) };
  } catch (err) {
    if (err instanceof StoredFileMissing) return { error: "The template's PDF can't be found any more — attach it to the template again, or untick it to send without." };
    throw err;
  }
}

// ─── Who it goes to, and from ────────────────────────────────────────────────────────────────────

export type QuickContact = { id: string; name: string; email: string | null; phone: string | null; primary: boolean; emailStopped: string | null; whatsappOpen: boolean };
export type QuickContext = {
  company: { id: string; name: string };
  sender: { id: string; name: string };
  /** How the sender's email would go: their own mailbox, the company's mail server, or not at all. */
  emailRoute: { via: "mailbox"; from: string } | { via: "company" } | { via: "none"; why: string };
  /** Whether WhatsApp can go at all, and from which number. */
  whatsapp: { ready: true; from: string; inbox: boolean } | { ready: false; why: string };
  contacts: QuickContact[];
  /** A number with no contact behind it — a cold call. */
  loose: { phone: string; whatsappOpen: boolean } | null;
  values: QuickValues;
  copied: string | null;
};

type Asked = { moment: QuickMoment; companyId: string; leadId?: string | null; contactId?: string | null; phone?: string | null };

type Channel = { id: string; phoneNumberId: string; displayPhone: string | null };

/** The sender's own WhatsApp number in the Customer inbox, else the one the team shares. */
async function inboxNumber(senderId: string): Promise<Channel | null> {
  const rows = await db.inboxChannel.findMany({ where: { kind: "WHATSAPP", active: true, phoneNumberId: { not: null }, OR: [{ ownerUserId: senderId }, { ownerUserId: null }] }, select: { id: true, phoneNumberId: true, displayPhone: true, ownerUserId: true }, orderBy: { createdAt: "asc" } }).catch((err) => {
    if (notMigratedYet(err)) return [];
    throw err;
  });
  const pick = rows.find((r) => r.ownerUserId === senderId) ?? rows[0];
  return pick ? { id: pick.id, phoneNumberId: pick.phoneNumberId!, displayPhone: pick.displayPhone } : null;
}

/** The customer's conversation on that number, when they wrote within WhatsApp's 24 hours. */
async function openWindow(channel: Channel | null, phone: string | null, now = new Date()): Promise<string | null> {
  const waId = phone ? whatsappNumber(phone) : null;
  if (!channel || !waId) return null;
  const c = await db.conversation.findFirst({ where: { channelId: channel.id, waId, lastCustomerAt: { gt: new Date(now.getTime() - WHATSAPP_WINDOW_MS) } }, orderBy: { lastCustomerAt: "desc" }, select: { id: true } });
  return c?.id ?? null;
}

/** Whoever the message is from: the new account manager for their introduction, else the person sending. */
async function senderOf(userId: string, asked: Asked): Promise<{ id: string; name: string; email: string; phone: string | null; notice: PendingNotice | null } | { error: string }> {
  const notice = asked.moment === "MANAGER_CHANGED" ? await pendingNotice(asked.companyId) : null;
  if (asked.moment === "MANAGER_CHANGED" && !notice) return { error: "There's no change of account manager to tell this customer about." };
  const who = await db.user.findUnique({ where: { id: notice?.toUserId ?? userId }, select: { id: true, name: true, email: true, phone: true, active: true } });
  if (!who?.active) return { error: "Whoever it would be from no longer works here." };
  return { id: who.id, name: who.name, email: who.email, phone: who.phone, notice };
}

/** Everything the send dialog shows before anything is sent. Null for a customer this person can't open. */
export async function quickContext(userId: string, asked: Asked): Promise<QuickContext | { error: string } | null> {
  const company = await db.company.findUnique({ where: { id: asked.companyId }, select: { id: true, name: true, ownerUserId: true, relationshipType: true } });
  if (!company || !(await canSeeCompany(userId, company))) return null;
  const sender = await senderOf(userId, asked);
  if ("error" in sender) return { error: sender.error };

  const [org, mailbox, route, channel, ready, people] = await Promise.all([
    getOrganisation(),
    mailboxState(sender.id),
    emailRouteFor("TRANSACTIONAL"),
    inboxNumber(sender.id),
    whatsappReady(),
    // The contacts this person may see (security audit, 11 Nov 2026 — SEC-08), not every one of the customer's.
    contactScope(userId).then((scope) =>
      db.contact.findMany({ where: { AND: [{ companyId: company.id, ...STILL_THERE }, scope] }, select: { id: true, name: true, email: true, phone: true, isPrimary: true }, orderBy: [{ isPrimary: "desc" }, { name: "asc" }], take: 100 }),
    ),
  ]);
  // The contact the call or the lead was about first, then the primary one.
  const lead = asked.leadId ? await db.lead.findUnique({ where: { id: asked.leadId }, select: { contactId: true, companyId: true } }).catch(() => null) : null;
  const first = asked.contactId ?? (lead?.companyId === company.id ? lead.contactId : null);
  people.sort((a, b) => Number(b.id === first) - Number(a.id === first));

  const mailable = people.filter((p) => p.email);
  const verdicts = mailable.length
    ? await resolveRecipients({ contactIds: mailable.map((p) => p.id), channel: "EMAIL", topic: "SERVICE", messageClass: "TRANSACTIONAL", settings: await marketingSettings(), optOuts: true })
    : [];
  const stopped = new Map(verdicts.map((v) => [v.recipient.contactId, v.verdict.ok ? null : v.verdict.detail]));

  const contacts: QuickContact[] = [];
  for (const p of people) {
    contacts.push({ id: p.id, name: p.name, email: p.email, phone: p.phone, primary: p.isPrimary, emailStopped: p.email ? (stopped.get(p.id) ?? null) : null, whatsappOpen: !!(await openWindow(channel, p.phone)) });
  }
  const loosePhone = asked.phone && !people.some((p) => p.phone && whatsappNumber(p.phone) === whatsappNumber(asked.phone!)) ? asked.phone : null;
  const previous = sender.notice?.fromName ?? null;

  return {
    company: { id: company.id, name: company.name },
    sender: { id: sender.id, name: sender.name },
    emailRoute: mailbox.state === "connected" ? { via: "mailbox", from: mailbox.mailbox } : route ? { via: "company" } : { via: "none", why: `${sender.id === userId ? "You haven't" : `${sender.name} hasn't`} a mailbox connected (My profile), and no mail server is set up for the company (Settings › Mail & messaging).` },
    whatsapp: !ready
      ? { ready: false, why: "WhatsApp isn't set up for the company — add the WhatsApp provider in Settings › Mail & messaging, or a number in the Customer inbox." }
      : channel
        ? { ready: true, from: channel.displayPhone ?? "the company's WhatsApp number", inbox: true }
        : { ready: true, from: "the company's WhatsApp number", inbox: false },
    contacts,
    loose: loosePhone ? { phone: loosePhone, whatsappOpen: !!(await openWindow(channel, loosePhone)) } : null,
    values: {
      companyName: company.name,
      // Named in Settings › Organisation; until it is, words that still read (as Marketing says "us").
      ourName: org.tradeName || org.legalName || "our company",
      myName: sender.name,
      myPhone: sender.phone,
      myEmail: sender.email,
      newManagerName: sender.notice ? sender.name : null,
      newManagerPhone: sender.notice ? sender.phone : null,
      newManagerEmail: sender.notice ? sender.email : null,
      oldManagerName: previous,
    },
    copied: sender.notice ? previous : null,
  };
}

/**
 * The context as the dialog shows it (security audit, 11 Nov 2026 — SEC-08): each contact's email and phone as this
 * person's field access says, the same as the customer's Contacts tab. It went out as stored, so a role whose contacts
 * are masked read every number and address it could see through this dialog. Sending doesn't need them in the browser:
 * the server sends by contact, from the stored values (`sendQuickEmail`, `sendQuickWhatsApp`).
 */
export async function quickContextForScreen(userId: string, context: QuickContext): Promise<QuickContext> {
  const masker = await contactMasker(userId, "detail", context.contacts.map((c) => c.id));
  if (!masker.active) return context;
  return {
    ...context,
    contacts: context.contacts.map((c) => ({
      ...c,
      name: masker.present(c.id, "name", c.name) ?? c.name,
      email: c.email === null ? null : masker.present(c.id, "email", c.email),
      phone: c.phone === null ? null : masker.present(c.id, "phone", c.phone),
    })),
  };
}

/** A contact's own values on top of the message's. */
export const valuesFor = (base: QuickValues, contact: { name: string } | null): QuickValues => ({
  ...base,
  fullName: contact?.name ?? null,
  firstName: contact?.name.trim().split(/\s+/)[0] ?? null,
});

// ─── Sending ─────────────────────────────────────────────────────────────────────────────────────

export type SendResult = { ok: true; sent: number; skipped: { name: string; why: string }[]; note?: string } | { ok: false; error: string };

/** `attach`: false leaves the template's file off this once. */
type SendBase = Asked & { templateId?: string | null; callId?: string | null; attach?: boolean };

const missingWords = (keys: string[]) => `It has no value for ${keys.map((k) => `{{${k}}}`).join(", ")} — give ${keys.length === 1 ? "it" : "them"} a fallback ({{field|…}}) or type the words in.`;

async function afterSend(userId: string, asked: SendBase, senderId: string, what: string, type: "EMAIL" | "NOTE" = "EMAIL"): Promise<void> {
  if (asked.leadId) {
    const lead = await db.lead.findUnique({ where: { id: asked.leadId }, select: { companyId: true } });
    if (lead?.companyId === asked.companyId) await db.activity.create({ data: { leadId: asked.leadId, userId: senderId, type, notes: what.slice(0, 2000) } }).catch(() => undefined);
  }
  if (asked.moment === "MANAGER_CHANGED") {
    await db.accountManagerNotice.updateMany({ where: { companyId: asked.companyId, toldAt: null }, data: { toldAt: new Date(), toldById: userId } });
  }
  await recordAudit({ userId, action: "CREATE", entityType: "QuickMessage", entityId: asked.companyId, entityLabel: what.slice(0, 300), subject: { companyId: asked.companyId, leadId: asked.leadId ?? null } });
}

/**
 * Security audit, 11 Nov 2026 (SEC-49): the most quick messages one person sends in a day — counted from the audit
 * rows every send writes (`afterSend`), whichever mailbox or number it went from. A person messaging customers by
 * hand never comes near it; a script, or a compromised account, stops here.
 */
export const QUICK_MESSAGES_PER_DAY = 200;

export async function quickDailyRefusal(userId: string, now = new Date()): Promise<string | null> {
  const sent = await db.auditLog.count({ where: { userId, entityType: "QuickMessage", createdAt: { gte: new Date(now.getTime() - 86_400_000) } } });
  return sent >= QUICK_MESSAGES_PER_DAY ? `That's ${QUICK_MESSAGES_PER_DAY} messages from you in the last day — the most one person sends by hand. Try again tomorrow, or use a campaign.` : null;
}

/**
 * The email, to each contact chosen — the subject and message as the sender left them, their fields filled for each
 * person. A contact who can't be emailed (left, bounced, opted out) is skipped and named.
 */
export async function sendQuickEmail(
  userId: string,
  asked: SendBase & {
    contactIds: string[];
    subject: string;
    body: string;
    cc?: string;
    /** One of Marketing's designed emails instead of a message template (owner, 16 Nov 2026 — src/lib/quick-messages/extras.ts). */
    marketingTemplateId?: string | null;
    /** The sender's own files, already checked by `checkedOwnFiles`. */
    files?: OwnFile[];
  },
): Promise<SendResult> {
  const capped = await quickDailyRefusal(userId);
  if (capped) return { ok: false, error: capped };
  const template = asked.templateId ? await db.quickTemplate.findUnique({ where: { id: String(asked.templateId) }, select: { active: true, moment: true, emailSubject: true, emailBody: true } }) : null;
  // A template that isn't live, or is for another moment, lends nothing — its file included (security audit SEC-49).
  const usable = !!template?.active && (template.moment === "ANY" || template.moment === asked.moment);
  let subject = String(asked.subject ?? "").trim().slice(0, 300);
  let body = String(asked.body ?? "").trim().slice(0, 20_000);
  const designed = asked.marketingTemplateId ? String(asked.marketingTemplateId) : null;
  // A designed email brings its own words: the subject may be typed over, the body is the template's.
  if (!designed && (!subject || !body)) return { ok: false, error: "An email needs a subject and a message." };
  const ids = [...new Set((asked.contactIds ?? []).map(String))].slice(0, 25);
  if (ids.length === 0) return { ok: false, error: "Choose who to send it to." };
  const context = await quickContext(userId, asked);
  if (!context) return { ok: false, error: "That customer no longer exists." };
  if ("error" in context) return { ok: false, error: context.error };
  if (context.emailRoute.via === "none") return { ok: false, error: context.emailRoute.why };
  /**
   * From somebody else's mailbox — the new account manager's introduction, sent by a colleague (security audit SEC-18):
   * the words are the template's, as written, not the sender's own. Free text from another person's mailbox spoke in
   * their name; only they may change what it says, by sending it themselves.
   */
  if (context.sender.id !== userId) {
    if (designed) return { ok: false, error: `Sent from ${context.sender.name}'s mailbox, it goes as a message template says — choose one of those.` };
    if (!usable || !template?.emailSubject || !template.emailBody) return { ok: false, error: `Sent from ${context.sender.name}'s mailbox, it goes as the template says — choose a template with an email.` };
    subject = template.emailSubject.slice(0, 300);
    body = template.emailBody.slice(0, 20_000);
  }

  const chosen = context.contacts.filter((c) => ids.includes(c.id));
  if (chosen.length === 0) return { ok: false, error: "Those contacts aren't this customer's any more." };
  const origin = await tenantOrigin();
  const marketing = designed ? await marketingEmailFor(designed, context.company.id, subject, origin) : null;
  if (marketing && !marketing.ok) return { ok: false, error: marketing.error };
  // Every one's fields, before the first is sent: nothing half goes.
  for (const c of chosen) {
    if (marketing?.ok) {
      const trial = c.email ? marketing.build({ contactId: c.id, name: c.name, email: c.email }, "check") : null;
      if (trial && !trial.ok) return { ok: false, error: trial.error };
      continue;
    }
    const filled = [fill(subject, valuesFor(context.values, c)), fill(body, valuesFor(context.values, c))];
    const bad = filled.flatMap((f) => [...f.missing, ...f.unknown]);
    if (bad.length) return { ok: false, error: `For ${c.name}: ${missingWords([...new Set(bad)])}` };
  }

  const sender = await db.user.findUnique({ where: { id: context.sender.id }, select: { id: true, name: true, email: true } });
  if (!sender) return { ok: false, error: "Whoever it would be from no longer works here." };
  // The previous account manager is copied on the new one's introduction, while they still work here.
  const notice = asked.moment === "MANAGER_CHANGED" ? await db.accountManagerNotice.findUnique({ where: { companyId: asked.companyId }, select: { fromUserId: true } }) : null;
  const previous = notice?.fromUserId ? await db.user.findUnique({ where: { id: notice.fromUserId }, select: { name: true, email: true, active: true } }) : null;
  const cc: { name: string | null; email: string }[] = previous?.active && previous.email !== sender.email ? [{ name: previous.name, email: previous.email }] : [];
  // And whoever the sender copies (owner, 16 Nov 2026: "add cc") — checked as addresses and against the block rules.
  const typedCc = await checkedCc(asked.cc ?? "", [...chosen.map((c) => c.email ?? ""), ...cc.map((x) => x.email)]);
  if (!typedCc.ok) return { ok: false, error: typedCc.error };
  cc.push(...typedCc.cc.map((email) => ({ name: null, email })));
  const org = await getOrganisation();
  // The template's PDF goes with it — the company profile, say — unless the sender unticked it. Not with a designed email.
  const attached = asked.attach === false || !usable || designed ? { file: null } : await fileForSend(asked.templateId);
  if ("error" in attached) return { ok: false, error: attached.error };
  const file = attached.file;
  // And the sender's own files (owner, 16 Nov 2026: "no attachment option?").
  const files: { name: string; mime: string; bytes: Buffer }[] = [...(file ? [{ name: file.name, mime: file.mime, bytes: file.bytes }] : []), ...(asked.files ?? [])];

  let sent = 0;
  const skipped: { name: string; why: string }[] = [];
  for (const c of chosen) {
    if (!c.email) {
      skipped.push({ name: c.name, why: "No email address." });
      continue;
    }
    if (c.emailStopped) {
      skipped.push({ name: c.name, why: c.emailStopped });
      continue;
    }
    const values = valuesFor(context.values, c);
    const token = randomBytes(24).toString("base64url");
    let text: string;
    let html: string;
    let line: string;
    if (marketing?.ok) {
      // Filled in for this person, with its own footer and unsubscribe link, as a campaign would.
      const built = marketing.build({ contactId: c.id, name: c.name, email: c.email }, token);
      if (!built.ok) {
        skipped.push({ name: c.name, why: built.error });
        continue;
      }
      ({ text, html, subject: line } = built);
    } else {
      text = `${fill(body, values).text}\n\n—\nManage what we send you: ${origin}/preferences/${token}`;
      html = textToHtml(text);
      line = fill(subject, values).text;
    }
    let from: string;
    if (context.emailRoute.via === "mailbox") {
      const out = await sendAsUser(sender.id, { subject: line, html, to: [{ name: c.name, email: c.email }], ...(cc.length ? { cc } : {}), attachments: files.map((f) => ({ name: f.name, contentType: f.mime, bytes: f.bytes })) });
      if (!out.ok) return sent ? { ok: true, sent, skipped: [...skipped, { name: c.name, why: out.error }] } : { ok: false, error: `${sender.name}'s mailbox didn't send it: ${out.error}` };
      from = out.mailbox;
    } else {
      const out = await deliverNow(
        { to: c.email, toName: c.name, fromName: senderDisplayName(sender.name, org.tradeName || org.legalName || ""), replyTo: sender.email, ...(cc.length ? { cc: cc.map((x) => x.email) } : {}), subject: line, html, text, ...(files.length ? { attachments: files.map((f) => ({ filename: f.name, contentType: f.mime, content: f.bytes })) } : {}) },
        "TRANSACTIONAL",
        { delivering: true },
      );
      if (!out.ok) return sent ? { ok: true, sent, skipped: [...skipped, { name: c.name, why: out.error }] } : { ok: false, error: `The company's mail server didn't take it: ${out.error}` };
      from = out.fromEmail ?? out.provider;
    }
    const now = new Date();
    await db.marketingMessage.create({
      data: { token, companyId: context.company.id, contactId: c.id, channel: "EMAIL", messageClass: "TRANSACTIONAL", subject: line, body: html, textBody: text, toEmail: c.email, status: "SENT", scheduledFor: now, sentAt: now, attempts: 1, sentByUserId: sender.id, fromEmail: from, ccEmails: cc.map((x) => x.email) },
    });
    sent += 1;
  }
  if (sent) await afterSend(userId, asked, sender.id, `Emailed ${chosen.filter((c) => c.email && !c.emailStopped).map((c) => c.name).join(", ")}: ${subject || "a marketing email"}${files.length ? ` (with ${files.map((f) => f.name).join(", ")})` : ""}`);
  return sent || skipped.length ? { ok: true, sent, skipped } : { ok: false, error: "Nobody chosen can be emailed." };
}

/**
 * The WhatsApp message, to one contact or one number. Within 24 hours of their last message on that number: the
 * text as the sender left it. After that: the template Meta approved, by its name, its fields filled — the words
 * themselves can't differ from what Meta has, so the stored text is what counts and an edit is ignored.
 */
export async function sendQuickWhatsApp(userId: string, asked: SendBase & { templateId: string; body?: string | null }): Promise<SendResult> {
  const capped = await quickDailyRefusal(userId);
  if (capped) return { ok: false, error: capped };
  const context = await quickContext(userId, asked);
  if (!context) return { ok: false, error: "That customer no longer exists." };
  if ("error" in context) return { ok: false, error: context.error };
  if (!context.whatsapp.ready) return { ok: false, error: context.whatsapp.why };
  const template = await db.quickTemplate.findUnique({ where: { id: String(asked.templateId) } });
  if (!template?.active || !template.whatsappBody) return { ok: false, error: "That template has no WhatsApp message." };

  const contact = asked.contactId ? (context.contacts.find((c) => c.id === asked.contactId) ?? null) : null;
  const phone = contact?.phone ?? (contact ? null : (asked.phone ?? null));
  if (asked.contactId && !contact) return { ok: false, error: "That contact isn't this customer's any more." };
  /**
   * A number that isn't one of the customer's contacts (security audit SEC-49): only the one this person just called
   * about this customer, within the fortnight — the case it exists for. Any number typed went from the company's
   * WhatsApp, a paid conversation each, to people who had nothing to do with the customer.
   */
  if (!contact && phone) {
    const call = asked.callId
      ? await db.callLog.findFirst({ where: { id: String(asked.callId), userId, companyId: context.company.id, startedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } }, select: { phoneNumber: true } })
      : null;
    if (!call || whatsappNumber(call.phoneNumber) !== whatsappNumber(phone)) {
      return { ok: false, error: "A WhatsApp goes to one of the customer's contacts, or to the number you just called them on." };
    }
  }
  if (!phone || !whatsappNumber(phone)) return { ok: false, error: `${contact?.name ?? "That"} has no phone number WhatsApp can use.` };
  const values = valuesFor(context.values, contact);
  const channel = await inboxNumber(context.sender.id);
  const conversationId = await openWindow(channel, phone);
  const attached = asked.attach === false ? { file: null } : await fileForSend(template.id);
  if ("error" in attached) return { ok: false, error: attached.error };
  const file = attached.file;
  let note: string | undefined;

  let said: string;
  let externalId: string | null = null;
  if (conversationId && channel) {
    // They wrote in the last 24 hours: free text, as edited.
    const text = fill(String(asked.body ?? "").trim() || template.whatsappBody, values);
    if (!text.ok) return { ok: false, error: missingWords([...text.missing, ...text.unknown]) };
    const out = await sendWhatsApp({ phoneNumberId: channel.phoneNumberId, to: phone, text: text.text.slice(0, 4000) });
    if (!out.ok) return { ok: false, error: out.error };
    said = text.text;
    externalId = out.id;
    await addMessage(conversationId, "AGENT", said, { userId: context.sender.id, externalId, delivery: "SENT" }).catch(() => undefined);
    // Its PDF after the words, as a document.
    if (file) {
      const doc = await sendWhatsApp({ phoneNumberId: channel.phoneNumberId, to: phone, media: { bytes: file.bytes, mime: file.mime, name: file.name } });
      if (doc.ok) await addMessage(conversationId, "AGENT", `Sent ${file.name}`, { userId: context.sender.id, externalId: doc.id, delivery: "SENT" }).catch(() => undefined);
      else note = `The message went, but ${file.name} didn't: ${doc.error}`;
    }
  } else {
    if (!template.whatsappTemplateName) {
      return { ok: false, error: `WhatsApp only lets a company write first with a message it has approved. Get "${template.name}" approved at Meta and put its template name in Settings › Message templates — or wait for the customer to write to you.` };
    }
    const variables = whatsappVariables(template.whatsappBody, values);
    if (!variables.ok) return { ok: false, error: missingWords(variables.missing) };
    said = fill(template.whatsappBody, values).text;
    if (channel) {
      const out = await sendWhatsApp({ phoneNumberId: channel.phoneNumberId, to: phone, template: { name: template.whatsappTemplateName, variables: variables.variables, ...(file ? { document: file } : {}) } });
      if (!out.ok) return { ok: false, error: out.error };
      externalId = out.id;
      // Their conversation on that number, if there is one, shows what was sent.
      const waId = whatsappNumber(phone)!;
      const known = await db.conversation.findFirst({ where: { channelId: channel.id, waId }, orderBy: { createdAt: "desc" }, select: { id: true } });
      if (known) await addMessage(known.id, "AGENT", said, { userId: context.sender.id, templateName: template.whatsappTemplateName, externalId, delivery: "SENT" }).catch(() => undefined);
    } else {
      const out = await deliverNow({ to: phone, toName: contact?.name ?? null, subject: template.whatsappTemplateName, html: variables.variables.join("\n") }, "TRANSACTIONAL", { delivering: true, kind: "WHATSAPP" });
      if (!out.ok) return { ok: false, error: out.error };
      // The WhatsApp provider in Mail & messaging sends the words only.
      if (file) note = `${file.name} wasn't attached — a file goes on WhatsApp only from a number in the Customer inbox.`;
    }
  }

  const now = new Date();
  await db.marketingMessage.create({
    data: { token: randomBytes(24).toString("base64url"), companyId: context.company.id, contactId: contact?.id ?? null, channel: "WHATSAPP", messageClass: "TRANSACTIONAL", subject: template.name, body: said, textBody: said, toPhone: phone, status: "SENT", scheduledFor: now, sentAt: now, attempts: 1, sentByUserId: context.sender.id, providerMessageId: externalId },
  });
  await afterSend(userId, asked, context.sender.id, `WhatsApp to ${contact?.name ?? phone}: ${template.name}`, "NOTE");
  return { ok: true, sent: 1, skipped: [], ...(note ? { note } : {}) };
}
