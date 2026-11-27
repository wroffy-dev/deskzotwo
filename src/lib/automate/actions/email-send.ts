import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { STILL_THERE } from "@/lib/contacts/left";
import { withConfirmed } from "@/lib/contacts/unconfirmed";
import { moduleAccessFor } from "@/lib/modules-access";
import { getOrganisation } from "@/lib/organisation";
import { mailboxState, sendAsUser } from "@/lib/mail/mailbox";
import { deliverNow, emailRouteFor, marketingSettings, mergeValuesFor, resolveRecipients, subscriptionMergeValues, type Recipient as MarketingRecipient } from "@/lib/marketing/pipeline";
import { render } from "@/lib/marketing/merge";
import { composeEmail, escapeHtml } from "@/lib/marketing/html";
import { daysLeftPhrase } from "@/lib/marketing/customer-notices";
import { formatOrderId } from "@/lib/order-id";
import { DEFAULT_UTM, tagHtmlLinks, tagTextLinks } from "@/lib/marketing/utm";
import { utmSettings } from "@/lib/marketing/utm-settings";
import { senderDisplayName } from "@/lib/documents/mail-route-labels";
import { textToHtml } from "@/lib/pipeline/automation-rules";
import { ActionError, defineAction, type ActionContext } from "@/lib/automate/action-types";
import { priorOutput, recordedAlready, withOutsideEffect } from "@/lib/automate/effects";
import { RENEWAL_SELECT, renewalPayload } from "@/lib/automate/dates";
import { fillSubscriptions, markSubscriptions, sameDaySubscriptions, sameDayValues, subscriptionsTable, type SameDaySubscription } from "@/lib/subscriptions/same-day";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { activePerson, byWorkflow, notReached, personField, reach, type Person } from "@/lib/automate/actions/shared";

/**
 * Send an email (Deskzo Automate, Phase 2) — to a lead's contact, another contact, or a colleague.
 *
 * It goes out from a person's own mailbox — the workflow's owner's, or the lead owner's as a pipeline
 * automation's email does, because it is to their customer and the reply should come to them — or
 * through the company's mail server (Settings › Mail & messaging, transactional mail), in the owner's
 * name with replies to them. From the lead owner's mailbox only a saved template, to that lead's own contact, with no
 * colleague or typed address copied in (security audit round two, R2-10 — `leadOwnerProblems`).
 *
 * A customer's contact is held to the rules every transactional email keeps (src/lib/marketing/
 * suppression.ts): somebody still at the company, an address that works and hasn't bounced or
 * complained, and never a reseller's customer. It's a reminder, not business they're part of (owner,
 * 18 Oct 2026), so their own opt-outs stop it too — unsubscribed from everything, suppressed here by
 * hand, or its topic (service notices, renewal reminders) unticked — and it carries the link to choose:
 * stopped that way, the step finishes without sending (`sent: false`), as nothing went wrong. The workflow's owner must be able to see contacts'
 * details, and reach the lead or contact. What went out is logged as the document emails are: on the
 * contact's mail log, and on the lead's timeline when there is a lead.
 *
 * Sent at most once: if the worker stops after sending and before recording it, the run waits for a
 * person rather than send it again (src/lib/automate/effects.ts).
 *
 * Or a saved email template (owner, 1 Nov 2026 — Marketing › Templates) instead of a subject and message
 * typed in: to a customer's contact only, its merge fields filled as a campaign's are, and — with the
 * subscription it is about — the product, expiry, days left and renewal value as the renewal notices
 * fill them. A field the template needs with no value and no fallback stops the email, never a "Hi ,".
 *
 * Copies (owner, 1 Nov 2026): the customer's account manager, colleagues chosen, addresses typed in, and
 * the customer's other contacts who receive documents — those held to the same rules as the contact it
 * goes to (still there, not bounced, not opted out of its topic), and quietly left off when they aren't.
 */

type Output =
  | { sent: true; via: "mailbox" | "company"; from: string; recipient: "contact" | "person"; contactId: string | null; userId: string | null; copied?: number }
  | { sent: false; skipped: string; recipient: "contact"; contactId: string; userId: null };

const optionalId = z.string().trim().min(1).max(60).optional();

type LeadOwnerFields = { from: string; to: string; templateId?: string; ccEmails?: string[]; ccPeople?: string[] };

/**
 * What stops an email going from the lead owner's own mailbox (security audit round two, 13 Nov 2026,
 * R2-10): words the workflow's owner wrote went out from a colleague's own mailbox, to any address. Now
 * it must be to the lead's own contact, a saved template, and copy in no colleague or typed address.
 *
 * Checked when the workflow is saved and published (validate.ts) and again as the step runs (senderFor).
 * Not in the input's schema, which runs at both: a lead the workflow's owner owns themselves is sent as
 * "owner" — their own mailbox, their own words — so a workflow published before this keeps working for
 * their own leads, and is refused only for a colleague's.
 */
export function leadOwnerProblems(i: LeadOwnerFields): { field: string; message: string }[] {
  if (i.from !== "lead_owner") return [];
  const out: { field: string; message: string }[] = [];
  if (i.to !== "lead_contact") out.push({ field: "to", message: "From the lead owner's mailbox it can only go to that lead's own contact." });
  if (!i.templateId) out.push({ field: "templateId", message: "From the lead owner's mailbox, choose a saved email template — a message typed here can't go out in their name." });
  if (i.ccEmails?.length) out.push({ field: "ccEmails", message: "From the lead owner's mailbox, nobody can be copied in by address." });
  if (i.ccPeople?.length) out.push({ field: "ccPeople", message: "From the lead owner's mailbox, no colleagues can be copied in." });
  return out;
}

const input = z
  .object({
    /**
     * Who to: the lead's contact, a contact by id, a customer's main contact (the primary one, else
     * whoever receives documents), or a colleague by id ("owner" for the workflow's owner).
     */
    to: z.enum(["lead_contact", "contact", "company_contact", "person"]).default("lead_contact"),
    leadId: optionalId,
    contactId: optionalId,
    companyId: optionalId,
    userId: personField.optional(),
    /** From: the workflow owner's mailbox, the lead owner's, or the company's mail server. */
    from: z.enum(["owner", "lead_owner", "company"]).default("owner"),
    /** What a customer can stop it as in the preference centre: a service notice, or a renewal reminder. */
    topic: z.enum(["SERVICE", "RENEWALS"]).default("SERVICE"),
    /** A saved email template to send instead of the subject and message below. */
    templateId: optionalId,
    /** The subscription it is about, for a template's product, expiry, days left and renewal value. */
    orderId: optionalId,
    subject: z
      .string()
      .trim()
      .max(200)
      .refine((s) => !/[\r\n]/.test(s), "The subject has to be one line.")
      .optional(),
    body: z.string().trim().max(10_000).optional(),
    /** Copies: the customer's account manager; colleagues; addresses; the customer's other document contacts. */
    ccAccountManager: z.boolean().default(false),
    ccPeople: z.array(personField).max(10).optional(),
    ccEmails: z.array(z.string().trim().toLowerCase().email("That isn't an email address.")).max(10).optional(),
    ccContacts: z.boolean().default(false),
    /** With a template: one email for the customer's subscriptions ending the same day (owner, 3 Nov 2026). */
    sameDay: z.boolean().default(true),
  })
  .strict()
  .superRefine((i, issue) => {
    if (i.templateId && i.to === "person") issue.addIssue({ code: "custom", path: ["templateId"], message: "A template goes to a customer's contact, not a colleague." });
    if (!i.templateId) {
      // Nothing to send: a template to choose (as a file imported without one is left), or the words to write.
      if (!i.subject && !i.body) issue.addIssue({ code: "custom", path: ["templateId"], message: "Choose an email template, or write a subject and message." });
      else if (!i.subject) issue.addIssue({ code: "custom", path: ["subject"], message: "Give the email a subject." });
      else if (!i.body) issue.addIssue({ code: "custom", path: ["body"], message: "Write the message." });
    }
    if ((i.to === "lead_contact" || i.from === "lead_owner") && !i.leadId) issue.addIssue({ code: "custom", path: ["leadId"], message: "Say which lead." });
    if (i.to === "contact" && !i.contactId) issue.addIssue({ code: "custom", path: ["contactId"], message: "Say which contact." });
    if (i.to === "company_contact" && !i.companyId) issue.addIssue({ code: "custom", path: ["companyId"], message: "Say which customer." });
    if (i.to === "person" && !i.userId) issue.addIssue({ code: "custom", path: ["userId"], message: "Say which person." });
  });

type Input = z.infer<typeof input>;
type Recipient =
  | { kind: "contact"; contactId: string; companyId: string; name: string; email: string; full: MarketingRecipient }
  | { kind: "person"; userId: string; name: string; email: string }
  | { kind: "opted_out"; contactId: string; reason: string };

/** Who it goes to, checked — or refused with the reason. */
async function recipientFor(ctx: ActionContext, i: Input): Promise<Recipient> {
  if (i.to === "person") {
    const person = await activePerson(ctx, i.userId!, "person to email");
    if (!person.email) throw new ActionError(`${person.name} has no email address.`, "PERMANENT");
    return { kind: "person", userId: person.id, name: person.name, email: person.email };
  }
  let contactId = i.contactId ?? null;
  if (i.to === "lead_contact") {
    await reach(ctx, "leads", "view", i.leadId!, "lead");
    contactId = (await db.lead.findUnique({ where: { id: i.leadId! }, select: { contactId: true } }))?.contactId ?? null;
    if (!contactId) throw new ActionError("The lead has no contact to email.", "PERMANENT");
  } else if (i.to === "company_contact") {
    await reach(ctx, "companies", "view", i.companyId!, "customer");
    // Security audit round two, 13 Nov 2026 (R2-14): picked by itself, so never somebody a website form added and staff
    // haven't confirmed (src/lib/contacts/unconfirmed.ts).
    const main = await withConfirmed((confirmed) =>
      db.contact.findFirst({
        where: { companyId: i.companyId!, email: { not: null }, ...STILL_THERE, ...confirmed },
        orderBy: [{ isPrimary: "desc" }, { receivesDocuments: "desc" }, { createdAt: "asc" }],
        select: { id: true },
      }),
    );
    if (!main) throw new ActionError("The customer has nobody with an email address to send it to.", "PERMANENT");
    contactId = main.id;
  } else {
    await reach(ctx, "contacts", "view", contactId!, "contact");
  }
  if (!(await can(ctx.actorId, "contacts.view"))) throw new ActionError("The workflow's owner can't see contacts' details, so can't email one.", "PERMANENT");

  const [resolved] = await resolveRecipients({
    contactIds: [contactId!],
    channel: "EMAIL",
    topic: i.topic,
    messageClass: "TRANSACTIONAL",
    settings: await marketingSettings(),
    optOuts: true,
  });
  // Not found by name: they have left their company (src/lib/contacts/left.ts).
  if (!resolved) throw new ActionError("The contact has left their company, so wasn't emailed.", "PERMANENT");
  if (!resolved.verdict.ok) {
    // Their own choice — nothing wrong with the workflow: not sent, and the run goes on.
    if (resolved.verdict.findings.every((f) => !f.hard)) return { kind: "opted_out", contactId: resolved.recipient.contactId, reason: `${resolved.recipient.name} wasn't emailed: ${resolved.verdict.detail}` };
    throw new ActionError(`${resolved.recipient.name} can't be emailed: ${resolved.verdict.detail}`, "PERMANENT");
  }
  const r = resolved.recipient;
  return { kind: "contact", contactId: r.contactId, companyId: r.companyId, name: r.name, email: r.email!.trim(), full: r };
}

/**
 * The customer's subscriptions ending the day this email's does, that this workflow would remind them of too — those
 * its trigger and the conditions before this step take on the day ("the Microsoft ones", "30 days left") — this one first. Null when there's no
 * subscription to go by.
 */
async function sameDayGroup(ctx: ActionContext, i: Input, companyId: string): Promise<SameDaySubscription[] | null> {
  const orderId = i.orderId || triggerOrderId(ctx.trigger);
  if (!orderId) return null;
  const all = await sameDaySubscriptions(orderId);
  if (all.length < 2) return all.length ? all : null;
  const day = ctx.clock.calendarDate(new Date());
  const rows = await db.companyProduct.findMany({ where: { id: { in: all.map((s) => s.id) }, companyId }, select: RENEWAL_SELECT });
  // No way to ask (a test, an older engine): this one alone.
  const taken = new Set(rows.filter((r) => r.id === orderId || (ctx.wouldReach ? ctx.wouldReach(renewalPayload(r, day)) : false)).map((r) => r.id));
  return all.filter((s) => taken.has(s.id));
}

/**
 * One email for them: the first of the customer's same-day subscriptions to reach this step today sends it; the rest
 * find it claimed and are passed over. True for the run that sends, else the subscriptions it went with, in words.
 */
async function claimSameDay(ctx: ActionContext, companyId: string, together: SameDaySubscription[]): Promise<true | string> {
  const end = together[0]!.endDate?.toISOString().slice(0, 10) ?? "none";
  const key = `sameday:${ctx.workflowId}:${companyId}:${end}:${ctx.clock.dateKey(new Date())}`;
  try {
    await db.automationEffect.create({ data: { key, runId: ctx.runId, output: { sameDay: together.map((s) => s.id) } } });
    return true;
  } catch (err) {
    if (!recordedAlready(err)) throw err;
    const held = await db.automationEffect.findUnique({ where: { key }, select: { runId: true } });
    // Its own claim, from an earlier try of this step: it is still the one that sends.
    if (held?.runId === ctx.runId) return true;
    return together.map((s) => s.itemName).join(", ");
  }
}

/** The subscription a run's trigger is about — `trigger.order.id` on a renewal coming up or an order's change — or null. */
function triggerOrderId(trigger: unknown): string | null {
  const id = (trigger as { order?: { id?: unknown } } | null | undefined)?.order?.id;
  return typeof id === "string" && id.length > 0 && id.length <= 40 ? id : null;
}

/** A saved template filled in for this contact — and the subscription, when one is named — or refused with why. */
async function fromTemplate(ctx: ActionContext, i: Input, recipient: Extract<Recipient, { kind: "contact" }>, preferencesUrl: string, together: SameDaySubscription[] | null = null): Promise<{ subject: string; html: string; text: string }> {
  const template = await db.marketingTemplate.findFirst({ where: { id: i.templateId!, channel: "EMAIL" }, select: { name: true, subject: true, preheader: true, body: true, format: true, active: true } });
  if (!template) throw new ActionError("That email template no longer exists — choose another.", "PERMANENT");
  if (!template.active) throw new ActionError(`The email template "${template.name}" is switched off.`, "PERMANENT");
  if (!template.subject?.trim()) throw new ActionError(`The email template "${template.name}" has no subject.`, "PERMANENT");
  let order = {};
  // The subscription named on the step — or, where none is, the one that started the run (a renewal coming up, an
  // order's change): owner, 3 Nov 2026 — a renewal email went out reading "Your subscription · We'll confirm" because
  // the step never named it, so its template fell back on every field.
  const orderId = i.orderId || triggerOrderId(ctx.trigger);
  const found = orderId
    ? await db.companyProduct.findUnique({ where: { id: orderId }, select: { companyId: true, orderSeq: true, quantity: true, endDate: true, fullTermUnitPrice: true, poNumber: true, item: { select: { name: true } } } })
    : null;
  // Named on the step and not this customer's: refused. Only the trigger's, and another customer's (an email to
  // somebody else the run is about): the template is filled without it, as before.
  if (i.orderId && (!found || found.companyId !== recipient.companyId)) throw new ActionError("The subscription isn't this customer's, so the template wasn't filled from it.", "PERMANENT");
  const product = found && found.companyId === recipient.companyId ? found : null;
  if (product) {
    // Days left counted on the workspace's calendar, as the renewal check counts them — never a day off near midnight.
    const daysLeft = product.endDate ? Math.round((product.endDate.getTime() - ctx.clock.calendarDate(new Date()).getTime()) / 86_400_000) : null;
    order = { ...subscriptionMergeValues(product), daysLeft, daysLeftPhrase: daysLeftPhrase(daysLeft), orderId: formatOrderId(product.orderSeq), poNumber: product.poNumber, subscriptionCount: 1 };
    // Several renewing that day, in this one email: every name, the seats and the value added up.
    if (together && together.length > 1) order = { ...order, ...sameDayValues(together) };
  }
  // The table {{subscriptions}} draws — the ones this email is about — put in once the fields are filled.
  const table = product ? (together?.length ? together : (await sameDaySubscriptions(orderId!)).slice(0, 1)) : null;
  const settings = await marketingSettings();
  const values = mergeValuesFor(recipient.full, settings, { ...order, unsubscribeUrl: preferencesUrl });
  const subject = render(template.subject, values);
  const preheader = render(template.preheader ?? "", values);
  const rendered = render(table ? markSubscriptions(template.body) : template.body, values, template.format === "HTML" ? { escape: escapeHtml } : undefined);
  const body = rendered.ok && table ? { ...rendered, text: fillSubscriptions(rendered.text, subscriptionsTable(table, template.format === "HTML" ? "HTML" : "TEXT")) } : rendered;
  const failed = [subject, preheader, body].flatMap((r) => (r.ok ? [] : [...r.missing, ...r.unknown]));
  if (failed.length || !subject.ok || !preheader.ok || !body.ok) {
    throw new ActionError(`The email template "${template.name}" needs ${[...new Set(failed)].map((f) => `{{${f}}}`).join(", ")}, which this email has no value for — give it a fallback ({{field|…}}), or name the subscription.`, "PERMANENT");
  }
  // The links tagged as the workflow's (src/lib/marketing/utm.ts), before anything else wraps them.
  const utm = { campaign: ctx.workflowName, content: template.name };
  const origin = await tenantOrigin();
  const email = composeEmail({
    format: template.format,
    body: template.format === "HTML" ? tagHtmlLinks(body.text, settings.utm ?? DEFAULT_UTM, utm, origin) : tagTextLinks(body.text, settings.utm ?? DEFAULT_UTM, utm, origin),
    preheader: preheader.text,
    footer: { senderName: settings.ourName, unsubscribeUrl: preferencesUrl, postalAddress: settings.postalAddress, includeUnsubscribe: !body.used.includes("unsubscribeUrl"), includeAddress: !body.used.includes("postalAddress") },
    origin,
  });
  return { subject: subject.text, html: email.html, text: email.text };
}

const MAX_COPIES = 20;

/** Who is copied in — each once, never the person it is to. A colleague named who has gone stops it; a customer's contact who can't be emailed is left off. */
async function copiesFor(ctx: ActionContext, i: Input, recipient: Exclude<Recipient, { kind: "opted_out" }>): Promise<{ name: string | null; email: string }[]> {
  const out = new Map<string, { name: string | null; email: string }>();
  const add = (name: string | null, email: string | null | undefined) => {
    const e = email?.trim().toLowerCase();
    if (e && e !== recipient.email.toLowerCase() && !out.has(e)) out.set(e, { name, email: e });
  };
  const companyId = recipient.kind === "contact" ? recipient.companyId : null;
  if (i.ccAccountManager && companyId) {
    // The account manager: whoever owns the customer, while they still work here.
    const owner = (await db.company.findUnique({ where: { id: companyId }, select: { owner: { select: { name: true, email: true, active: true } } } }))?.owner;
    if (owner?.active) add(owner.name, owner.email);
  }
  for (const who of i.ccPeople ?? []) {
    const person = await activePerson(ctx, who, "colleague to copy in");
    add(person.name, person.email);
  }
  for (const email of i.ccEmails ?? []) add(null, email);
  if (i.ccContacts && companyId && recipient.kind === "contact") {
    const others = await db.contact.findMany({ where: { companyId, receivesDocuments: true, email: { not: null }, id: { not: recipient.contactId }, ...STILL_THERE }, select: { id: true }, take: MAX_COPIES });
    if (others.length) {
      const resolved = await resolveRecipients({ contactIds: others.map((c) => c.id), channel: "EMAIL", topic: i.topic, messageClass: "TRANSACTIONAL", settings: await marketingSettings(), optOuts: true });
      for (const r of resolved) if (r.verdict.ok) add(r.recipient.name, r.recipient.email);
    }
  }
  return [...out.values()].slice(0, MAX_COPIES);
}

/** Whose mailbox it goes from, connected — or refused. Null for the company's mail server. */
async function senderFor(ctx: ActionContext, i: Input, recipient: Exclude<Recipient, { kind: "opted_out" }>): Promise<Person | null> {
  if (i.from === "company") {
    if (!(await emailRouteFor("TRANSACTIONAL"))) throw new ActionError("No mail server is set up for transactional mail — add one in Settings › Mail & messaging.", "PERMANENT");
    return null;
  }
  let who = "owner";
  if (i.from === "lead_owner") {
    const lead = await db.lead.findUnique({ where: { id: i.leadId! }, select: { ownerUserId: true, contactId: true } });
    const owner = lead?.ownerUserId;
    if (!owner) throw new ActionError("The lead has no owner to send it from.", "PERMANENT");
    // R2-10: the workflow's owner's own lead goes as "owner" would. A colleague's only as leadOwnerProblems allows,
    // and only to that lead's own contact — checked here again, whatever the version published said.
    if (owner !== ctx.actorId) {
      const problems = leadOwnerProblems(i);
      if (problems.length) throw new ActionError(`Not sent: ${problems[0]!.message}`, "PERMANENT");
      if (recipient.kind !== "contact" || !lead.contactId || recipient.contactId !== lead.contactId) {
        throw new ActionError("From the lead owner's mailbox it can only go to that lead's own contact.", "PERMANENT");
      }
    }
    who = owner;
  }
  const person = await activePerson(ctx, who, i.from === "lead_owner" ? "lead's owner" : "workflow's owner");
  const mailbox = await mailboxState(person.id);
  if (mailbox.state !== "connected") throw new ActionError(`${person.name} hasn't a working mailbox connected (My profile), so nothing was sent.`, "PERMANENT");
  return person;
}

export const emailSend = defineAction({
  key: "email.send",
  label: "Send an email",
  description: "Emails a lead's contact, another contact or a colleague, from a person's mailbox or the company's mail server.",
  module: "companies",
  permission: null,
  risk: "irreversible",
  input,
  outputs: ["sent", "skipped", "via", "from", "recipient", "contactId", "userId", "copied"],
  preview: (i) =>
    `Would email ${i.to === "lead_contact" ? "the lead's contact" : i.to === "contact" ? "a contact" : i.to === "company_contact" ? "the customer's main contact" : "a colleague"} from ${i.from === "company" ? "the company's mail server" : i.from === "lead_owner" ? "the lead owner's mailbox" : "the workflow owner's mailbox"}${i.templateId ? ", using a saved email template" : `: "${i.subject}"`}.`,
  async run(ctx, i): Promise<Output> {
    // Sent on an earlier try: that stands, whatever has changed since.
    const done = await priorOutput<Output>(ctx);
    if (done) return done.output;

    // A lead named is one the owner may open now — in a workspace whose plan and switch have Leads.
    if (i.leadId && (await moduleAccessFor(ctx.actorId, "leads")) !== "available") throw new ActionError("The workflow's owner can't use Leads, so can't email from a lead.", "PERMANENT");
    if (i.leadId && i.to !== "lead_contact") await reach(ctx, "leads", "view", i.leadId, "lead");
    const recipient = await recipientFor(ctx, i);
    if (recipient.kind === "opted_out") return { sent: false, skipped: recipient.reason, recipient: "contact", contactId: recipient.contactId, userId: null };
    const sender = await senderFor(ctx, i, recipient);
    const actor = await db.user.findUnique({ where: { id: ctx.actorId }, select: { name: true, email: true } });
    if (!actor) throw notReached("workflow's owner");
    // To a customer: the link to choose what they're sent, as every reminder carries — this email's own.
    const token = randomBytes(24).toString("base64url");
    const preferencesUrl = `${await tenantOrigin()}/preferences/${token}`;
    // A customer's other subscriptions this workflow would remind them of, ending the same day: one email for them all.
    const together = i.templateId && i.sameDay && recipient.kind === "contact" ? await sameDayGroup(ctx, i, recipient.companyId) : null;
    if (together && together.length > 1 && recipient.kind === "contact") {
      const first = await claimSameDay(ctx, recipient.companyId, together);
      if (first !== true) return { sent: false, skipped: `Sent in one email with the customer's other subscriptions renewing that day (${first}).`, recipient: "contact", contactId: recipient.contactId, userId: null };
    }
    const written = i.templateId && recipient.kind === "contact" ? await fromTemplate(ctx, i, recipient, preferencesUrl, together) : null;
    const subject = written?.subject ?? i.subject!;
    // A message typed in has its links tagged as the workflow's too — to a customer; a colleague's are left as written.
    const typed = recipient.kind === "contact" && !written ? tagTextLinks(i.body!, await utmSettings(), { campaign: ctx.workflowName, content: "message" }, await tenantOrigin()) : i.body!;
    const text = written?.text ?? (recipient.kind === "contact" ? `${typed}\n\n—\nManage what we send you: ${preferencesUrl}` : typed);
    const html = written?.html ?? textToHtml(text);
    const cc = await copiesFor(ctx, i, recipient);

    const { output, fresh } = await withOutsideEffect<Extract<Output, { sent: true }>>(ctx, async () => {
      const base = { sent: true as const, copied: cc.length, recipient: recipient.kind, contactId: recipient.kind === "contact" ? recipient.contactId : null, userId: recipient.kind === "person" ? recipient.userId : null };
      if (sender) {
        const sent = await sendAsUser(sender.id, { subject, html, to: [{ name: recipient.name, email: recipient.email }], ...(cc.length ? { cc } : {}), attachments: [] });
        if (!sent.ok) return { ok: false, error: `${sender.name}'s mailbox didn't send it: ${sent.error}`, kind: sent.reconnect ? "PERMANENT" : "TRANSIENT" };
        return { ok: true, output: { ...base, via: "mailbox", from: sent.mailbox } };
      }
      const org = await getOrganisation();
      const sent = await deliverNow(
        {
          to: recipient.email,
          toName: recipient.name,
          fromName: senderDisplayName(actor.name, org.tradeName || org.legalName || ""),
          replyTo: actor.email,
          ...(cc.length ? { cc: cc.map((c) => c.email) } : {}),
          subject,
          html,
          text,
        },
        "TRANSACTIONAL",
        { delivering: true },
      );
      if (!sent.ok) return { ok: false, error: `The company's mail server didn't take it: ${sent.error}`, kind: "TRANSIENT" };
      return { ok: true, output: { ...base, via: "company", from: sent.fromEmail ?? sent.provider } };
    });

    if (fresh) {
      const senderId = sender?.id ?? ctx.actorId;
      const now = new Date();
      // The contact's mail log, as an emailed document is logged.
      if (recipient.kind === "contact") {
        await db.marketingMessage.create({
          data: {
            token,
            companyId: recipient.companyId,
            contactId: recipient.contactId,
            channel: "EMAIL",
            messageClass: "TRANSACTIONAL",
            subject,
            body: html,
            textBody: text,
            toEmail: recipient.email,
            status: "SENT",
            scheduledFor: now,
            sentAt: now,
            attempts: 1,
            sentByUserId: senderId,
            fromEmail: output.from,
          },
        });
      }
      if (i.leadId) {
        // R2-10: the lead's timeline names the workflow's owner, who chose what went, even when it went from
        // the lead owner's mailbox — never the mailbox's owner as if they had written it.
        const mailboxNote = sender && sender.id !== ctx.actorId ? ` (from ${sender.name}'s mailbox)` : "";
        await db.activity.create({ data: { leadId: i.leadId, userId: ctx.actorId, type: "EMAIL", notes: `Sent ${byWorkflow(ctx)}${mailboxNote}: ${subject}`.slice(0, 2000) } });
      }
    }
    return output;
  },
});
