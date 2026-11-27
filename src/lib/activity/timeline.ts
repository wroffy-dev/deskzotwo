import type { ActivityKind, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import {
  callAccess,
  companyAccess,
  documentAccess,
  expenseAccess,
  leadAccess,
  meetingAccess,
  orderAccess,
  paymentAccess,
  projectAccess,
  taskAccess,
  throughAccount,
  ticketAccess,
  timelineAccess,
  visitAccess,
} from "@/lib/authz/access";
import { contactScope } from "@/lib/authz/contact-access";
import { companyMasker } from "@/lib/companies/masking";
import { getDownlineUserIds } from "@/lib/org-chart";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { notMigratedYet } from "@/lib/not-migrated";
import { leadStages } from "@/lib/pipeline/server";
import { readStageNote } from "@/lib/pipeline/rules";
import { leadPageRedaction, leadRedactor, leadSecrets, listLeadMasker, maskLeadTitle, type FieldMasker, type TextRedactor } from "@/lib/leads/masking";
import { contactMasker, type ContactMasker } from "@/lib/contacts/masking";
import { contactRedactor } from "@/lib/contacts/redaction";
import type { FieldContext } from "@/lib/authz/field-policy";
import { companyPath, expensePath, leadPath, orderPath, ticketPath, visitPath } from "@/lib/record-links";
import { documentPath } from "@/lib/trade-documents";
import { ACTIVITY_GROUPS, type ActivityGroupKey, type ActivityItem, type ActivityPage, type FieldChange } from "@/lib/activity/types";

export { ACTIVITY_GROUPS, type ActivityGroupKey, type ActivityItem, type ActivityPage } from "@/lib/activity/types";

/**
 * Activity (owner, 19 Oct 2026): everything that happened to a lead, a customer or a vendor — and
 * everything a person did — newest first, each line saying what happened, who did it, and when.
 *
 * Merged from where it's already recorded:
 *   · changes — the audit log, each entry filed under its company and lead (src/lib/activity/subjects.ts),
 *     with what an edit changed field by field where the form says;
 *   · what people logged on leads — notes, calls, meetings, emails, stage moves — by the activities rule
 *     (own and team's unless `activities.viewAll`);
 *   · calls, by the calls rule, one already on a lead's log not twice;
 *   · business emails sent — a document, a notice, a ticket reply — never campaigns;
 *   · for a person, their sign-ins, exports and prints from the security log.
 *
 * Whoever can open the record sees its Activity, but only the kinds they may see elsewhere: an invoice's
 * line to someone who may see documents, a payment's to someone who may see payments. A person's activity
 * is theirs to see, their managers', and whoever sees everyone's (`activity.viewAll`).
 */

/** Which group an audit entry's kind is in. A kind not here is "other". */
const ENTITY_GROUP: Record<string, ActivityGroupKey> = {
  Company: "company",
  DomainProfile: "company",
  CompanyBankAccount: "company",
  Contact: "contacts",
  ContactConsent: "contacts",
  Lead: "leads",
  Order: "orders",
  CompanyProduct: "orders",
  OrderRebate: "orders",
  TradeDocument: "documents",
  EwayBill: "documents",
  Consignment: "documents",
  Payment: "payments",
  PaymentFollowUp: "payments",
  VendorCredit: "purchase",
  VendorStatement: "purchase",
  Ticket: "tickets",
  Task: "tasks",
  CalendarEvent: "meetings",
  Booking: "meetings",
  Visit: "visits",
  CallLog: "calls",
  Project: "projects",
  ProjectDocument: "projects",
  ProjectBillingMilestone: "projects",
  Expense: "expenses",
  FeedbackRequest: "feedback",
  PortalLogin: "portal",
};

/** What a viewer must hold to see a group's lines; a group not here, whoever may open the record. */
const GROUP_PERMISSION: Partial<Record<ActivityGroupKey, string>> = {
  contacts: "contacts.view",
  leads: "leads.view",
  notes: "leads.view",
  orders: "orders.view",
  documents: "documents.view",
  purchase: "documents.view",
  payments: "payments.view",
  tickets: "tickets.view",
  calls: "calls.view",
  visits: "visits.view",
  projects: "projects.view",
  emails: "emails.view",
  // A colleague's expense claim is theirs and the approvers': on a person's own feed they see their own.
  expenses: "expenses.viewAll",
};

export type ActivityOptions = {
  /** Older than this — the next page. */
  before?: Date;
  take?: number;
  groups?: ActivityGroupKey[];
  /** Only what this person did. */
  personId?: string;
  from?: Date;
  to?: Date;
  /** Words to find in what each line says (owner, 20 Nov 2026 — "so many records … without filters"). */
  search?: string;
};

const DEFAULT_TAKE = 50;

/** What a line is about, for its link: the record, and for a contact its company. */
type Target = { type: string; id: string; companyId?: string | null };
/** A line as it's built, with what it opens still to look up (`withLinks`). */
type Built = ActivityItem & { target?: Target | null };

/** Sign-ins and changes outside every group are a person's, never a record's: the person view adds them. */
const PERSON_ONLY = new Set<ActivityGroupKey>(["signins", "other"]);

async function allowedGroups(viewerId: string): Promise<Set<ActivityGroupKey>> {
  const out = new Set<ActivityGroupKey>();
  await Promise.all(
    ACTIVITY_GROUPS.filter((g) => !PERSON_ONLY.has(g.key)).map(async (g) => {
      const key = GROUP_PERMISSION[g.key];
      if (!key || (await can(viewerId, key))) out.add(g.key);
    }),
  );
  return out;
}

function timeWhere(field: string, opts: ActivityOptions): Record<string, unknown> {
  const range: Record<string, Date> = {};
  if (opts.before) range.lt = opts.before;
  if (opts.from) range.gte = opts.from;
  if (opts.to) range.lte = opts.to;
  return Object.keys(range).length ? { [field]: range } : {};
}

/**
 * The words searched for, in the field that says what a line is — a change's summary, a note's or call's notes, an
 * email's subject, a sign-in's summary. Matched in the database, so "Show older" pages through matches only.
 */
function textWhere(field: string, opts: ActivityOptions): Record<string, unknown> {
  const words = opts.search?.trim();
  return words ? { [field]: { contains: words, mode: "insensitive" } } : {};
}

const wants = (opts: ActivityOptions, allowed: Set<ActivityGroupKey>, group: ActivityGroupKey) => allowed.has(group) && (!opts.groups?.length || opts.groups.includes(group));

const AUDIT_SELECT = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  entityLabel: true,
  createdAt: true,
  changes: true,
  companyId: true,
  user: { select: { id: true, name: true } },
  impersonatedBy: { select: { name: true } },
} satisfies Prisma.AuditLogSelect;

type AuditRow = Prisma.AuditLogGetPayload<{ select: typeof AUDIT_SELECT }>;

function auditItem(row: Omit<AuditRow, "changes" | "companyId"> & { changes?: unknown; companyId?: string | null }): Built {
  return {
    id: `audit-${row.id}`,
    at: row.createdAt.toISOString(),
    who: row.user,
    asBy: row.impersonatedBy?.name ?? null,
    group: ENTITY_GROUP[row.entityType] ?? "other",
    action: row.action,
    title: row.entityLabel,
    detail: null,
    changes: Array.isArray(row.changes) ? (row.changes as FieldChange[]) : [],
    href: null,
    target: { type: row.entityType, id: row.entityId, companyId: row.companyId ?? null },
  };
}

/** The audit entries matching, newest first — none where the workspace isn't migrated to file them. */
async function auditRows(where: Prisma.AuditLogWhereInput, take: number, migrated = true): Promise<Built[]> {
  try {
    const rows = await db.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take, select: migrated ? AUDIT_SELECT : { ...AUDIT_SELECT, changes: false, companyId: false } });
    return rows.map(auditItem);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return [];
  }
}

const ACTIVITY_TITLE: Record<string, string> = { CALL: "Call logged", EMAIL: "Email logged", NOTE: "Note", MEETING: "Meeting logged", STAGE_CHANGE: "Stage moved" };
const ACTIVITY_GROUP: Record<string, ActivityGroupKey> = { CALL: "calls", EMAIL: "emails", NOTE: "notes", MEETING: "notes", STAGE_CHANGE: "leads" };

/**
 * What a lead's values are read with to find them in what was written about it, on a feed of many leads — the same
 * values its own page's redactor goes by (src/lib/leads/masking.ts `leadSecrets`).
 */
const LEAD_QUOTED = {
  title: true,
  contact: { select: { id: true, name: true, email: true, phone: true } },
  company: { select: { name: true, locations: { select: { address: true, city: true, state: true, pincode: true, country: true, isPrimary: true } } } },
} satisfies Prisma.LeadSelect;

/**
 * What people logged on leads — by the activities rule.
 *
 * `people`: on a customer's or a person's feed (not a lead's own, which its page's redactor covers), where contacts
 * are shown as that screen's contacts policy says (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.7). What was
 * written about a lead — a call's notes above all — quotes its contact's name, number and address, and its own
 * values, so each line's text has the lead's values masked as a list masks them (`masker`, the list answers) and its
 * contact's as the contacts policy does. The line's title names the lead as a list names it, as it did.
 */
async function loggedRows(viewerId: string, where: Prisma.ActivityWhereInput, opts: ActivityOptions, take: number, masker: FieldMasker, people?: FieldContext) {
  const [rows, { stages }] = await Promise.all([
    db.activity.findMany({
      // And only on leads the viewer's lead rule reaches (security audit round three, 14 Nov 2026 — R3-21): a person's
      // feed listed what they logged on every lead, titles and notes, whoever was reading it.
      where: { AND: [where, timeWhere("occurredAt", opts), textWhere("notes", opts), await timelineAccess(viewerId), { lead: await leadAccess(viewerId, "view") }] },
      orderBy: { occurredAt: "desc" },
      take,
      select: { id: true, type: true, notes: true, occurredAt: true, leadId: true, user: { select: { id: true, name: true } }, lead: { select: LEAD_QUOTED } },
    }),
    leadStages(),
  ]);
  const cm = people ? await contactMasker(viewerId, people, [...new Set(rows.flatMap((a) => a.lead.contact?.id ?? []))]) : null;
  const redact = (a: (typeof rows)[number], text: string | null): string | null => {
    const lead = a.lead;
    if (!people || text == null) return text;
    const asListed = masker.active ? leadRedactor(masker, leadSecrets(lead))(text) : text;
    const c = lead.contact;
    return cm?.active && c ? contactRedactor(cm, c.id, [["name", c.name], ["email", c.email], ["phone", c.phone]])(asListed) : asListed;
  };
  return rows.map((a) => ({
    item: {
      id: `logged-${a.id}`,
      at: a.occurredAt.toISOString(),
      who: a.user,
      asBy: null,
      group: ACTIVITY_GROUP[a.type] ?? "notes",
      action: null,
      title: `${ACTIVITY_TITLE[a.type] ?? "Logged"} — ${maskLeadTitle(masker, a.lead.title)}`,
      detail: redact(a, a.type === "STAGE_CHANGE" ? readStageNote(a.notes, stages) : a.notes),
      changes: [],
      href: null,
      target: { type: "Lead", id: a.leadId },
    } satisfies Built,
    callKey: a.type === "CALL" ? `${a.leadId}|${a.user.id}|${a.occurredAt.getTime()}` : null,
  }));
}

/**
 * Calls, by the calls rule; one already on a lead's log isn't listed twice.
 *
 * `conceal`: on a lead's own feed, the lead page's masker (`leadPageRedaction`). A call line names the
 * person called, the number dialled and the account, and its notes quote them — the lead's contact,
 * phone and company — so each is shown as the page shows that field, the number as dialled whatever its
 * format, and the notes have those same values masked wherever they appear (audit H-3, 2 Nov 2026).
 *
 * `people`: on a customer's or a person's feed, the same for the person called by the contacts policy (owner, 5 Nov
 * 2026 — Phase 3 masking fixes, audit H.4.7): their name and the number dialled as that screen's contacts policy
 * shows them (src/lib/contacts/masking.ts) — a contact "Show"n today in the clear — and the notes with the contact's
 * name, number and address masked wherever they quote them. A number nobody is on file with is masked as the policy
 * masks phones, as the lead feed masks it. These feeds printed all of it whole, whatever the Contacts tab beside
 * them showed.
 */
async function callRows(viewerId: string, where: Prisma.CallLogWhereInput, opts: ActivityOptions, take: number, onLeads: Set<string>, conceal?: FieldMasker, people?: FieldContext): Promise<Built[]> {
  if (!(await moduleAvailableForTenant("calls"))) return [];
  const rows = await db.callLog.findMany({
    where: { AND: [where, timeWhere("startedAt", opts), textWhere("notes", opts), await throughAccount(viewerId, "view"), await callAccess(viewerId, "view")] },
    orderBy: { startedAt: "desc" },
    take,
    select: {
      id: true,
      direction: true,
      outcome: true,
      phoneNumber: true,
      notes: true,
      startedAt: true,
      durationSeconds: true,
      leadId: true,
      companyId: true,
      user: { select: { id: true, name: true } },
      // Its email and phone only to find them in the notes (`people`); never shown.
      contact: { select: { id: true, name: true, email: true, phone: true } },
      company: { select: { name: true } },
    },
  });
  const listed = rows.filter((c) => !c.leadId || !onLeads.has(`${c.leadId}|${c.user.id}|${c.startedAt.getTime()}`));
  const cm = people && !conceal?.active ? await contactMasker(viewerId, people, [...new Set(listed.flatMap((c) => c.contact?.id ?? []))]) : null;
  return listed
    .map((c) => {
      const m = conceal?.active ? conceal : null;
      const p = cm?.active ? cm : null;
      const called =
        c.contact?.name != null
          ? m
            ? (m.present("contactName", c.contact.name) ?? "")
            : p
              ? (p.present(c.contact.id, "name", c.contact.name) ?? "")
              : c.contact.name
          : m
            ? (m.present("phone", c.phoneNumber) ?? "")
            : p
              ? (p.present(c.contact?.id ?? "", "phone", c.phoneNumber) ?? "")
              : c.phoneNumber;
      const account = m ? (m.present("companyName", c.company.name) ?? "") : c.company.name;
      const notes = m
        ? leadRedactor(m, [["contactName", c.contact?.name], ["phone", c.phoneNumber], ["companyName", c.company.name]])(c.notes)
        : p
          ? contactRedactor(p, c.contact?.id ?? null, [["name", c.contact?.name], ["phone", c.phoneNumber], ["phone", c.contact?.phone], ["email", c.contact?.email]])(c.notes)
          : c.notes;
      return {
        id: `call-${c.id}`,
        at: c.startedAt.toISOString(),
        who: c.user,
        asBy: null,
        group: "calls" as const,
        action: null,
        title: `${c.direction === "INBOUND" ? "Call from" : "Call to"} ${called}, ${account} — ${c.outcome.toLowerCase().replace(/_/g, " ")}`,
        detail: [c.durationSeconds ? `${Math.round(c.durationSeconds / 60)} min` : null, notes].filter(Boolean).join(" · ") || null,
        changes: [],
        href: null,
        target: c.leadId ? { type: "Lead", id: c.leadId } : { type: "Company", id: c.companyId },
      };
    });
}

/**
 * Business emails sent — a document, a notice, a reply — never a campaign.
 *
 * Sent to a contact, the address is shown as the contacts policy shows it on this screen, and the subject has the
 * contact's values masked wherever it quotes them (owner, 5 Nov 2026 — Phase 3 masking fixes), as the Mail log does
 * (src/actions/mail-log.ts). Only these feeds call this, so it always asks.
 */
async function emailRows(viewerId: string, where: Prisma.MarketingMessageWhereInput, opts: ActivityOptions, take: number, people: FieldContext): Promise<Built[]> {
  const rows = await db.marketingMessage.findMany({
    // Only on accounts the viewer reaches (security audit round three, 14 Nov 2026 — R3-21): a person's feed listed
    // every email they sent, to every customer.
    where: { AND: [where, { messageClass: "TRANSACTIONAL", status: "SENT" }, timeWhere("sentAt", opts), textWhere("subject", opts), await throughAccount(viewerId, "view")] },
    orderBy: { sentAt: "desc" },
    take,
    // The contact's email and phone only to find them in the subject; never shown.
    select: { id: true, subject: true, toEmail: true, sentAt: true, companyId: true, sentBy: { select: { id: true, name: true } }, contact: { select: { id: true, name: true, email: true, phone: true } } },
  });
  const cm = await contactMasker(viewerId, people, [...new Set(rows.flatMap((m) => m.contact?.id ?? []))]);
  const to = (m: (typeof rows)[number]) => (m.toEmail != null && m.contact && cm.active ? cm.present(m.contact.id, "email", m.toEmail) : m.toEmail);
  const subject = (m: (typeof rows)[number]) =>
    m.contact && cm.active ? contactRedactor(cm, m.contact.id, [["name", m.contact.name], ["email", m.toEmail], ["email", m.contact.email], ["phone", m.contact.phone]])(m.subject) : m.subject;
  return rows.map((m) => ({
    id: `email-${m.id}`,
    at: (m.sentAt ?? new Date(0)).toISOString(),
    who: m.sentBy,
    asBy: null,
    group: "emails" as const,
    action: null,
    title: `Email to ${to(m) ?? "a contact"}`,
    detail: subject(m),
    changes: [],
    href: null,
    target: m.companyId ? { type: "Company", id: m.companyId } : null,
  }));
}

/**
 * Emails read from people's own mailboxes (owner, 23 Nov 2026 — src/lib/mail-reading): only where an admin lets the
 * Timeline read that mailbox, only mail with this customer, vendor or lead (nothing else is kept), and only on accounts
 * the viewer reaches. The subject is shown, never the text; a contact's address as the contacts policy shows it here.
 */
async function mailboxRows(viewerId: string, where: Prisma.MailMessageWhereInput, opts: ActivityOptions, take: number, people: FieldContext): Promise<Built[]> {
  try {
    if (!(await db.mailReadSettings.findUnique({ where: { id: "default" }, select: { enabled: true } }))?.enabled) return [];
    const owners = (await db.mailReadGrant.findMany({ where: { agent: "timeline" }, select: { userId: true } })).map((g) => g.userId);
    if (!owners.length) return [];
    const rows = await db.mailMessage.findMany({
      where: { AND: [where, { userId: { in: owners } }, timeWhere("sentAt", opts), textWhere("subject", opts), await throughAccount(viewerId, "view")] },
      orderBy: { sentAt: "desc" },
      take,
      select: { id: true, subject: true, direction: true, fromEmail: true, toEmails: true, sentAt: true, companyId: true, user: { select: { id: true, name: true } }, contact: { select: { id: true, name: true, email: true, phone: true } } },
    });
    const cm = await contactMasker(viewerId, people, [...new Set(rows.flatMap((m) => m.contact?.id ?? []))]);
    const other = (m: (typeof rows)[number]) => {
      const address = m.direction === "OUT" ? (m.toEmails[0] ?? "") : m.fromEmail;
      if (m.contact) return m.contact.name || (cm.active ? cm.present(m.contact.id, "email", address) : address);
      return address;
    };
    const subject = (m: (typeof rows)[number]) =>
      m.contact && cm.active ? contactRedactor(cm, m.contact.id, [["name", m.contact.name], ["email", m.contact.email], ["phone", m.contact.phone]])(m.subject) : m.subject;
    return rows.map((m) => ({
      id: `mailbox-${m.id}`,
      at: m.sentAt.toISOString(),
      who: m.user,
      asBy: null,
      group: "emails" as const,
      action: null,
      title: m.direction === "OUT" ? `Email to ${other(m) || "a contact"}` : `Email from ${other(m) || "a contact"}`,
      detail: subject(m) || "(no subject)",
      changes: [],
      href: null,
      target: m.companyId ? { type: "Company", id: m.companyId } : null,
    }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

const SIGN_IN_KINDS: ActivityKind[] = ["LOGIN", "LOGIN_FAILED", "LOGOUT", "PASSWORD_CHANGED", "TWO_FACTOR_ENABLED", "EXPORT", "PRINT", "IMPERSONATION_STARTED", "IMPERSONATION_ENDED"];

/** A person's sign-ins, exports and prints, from the security log. */
async function signInRows(personId: string, opts: ActivityOptions, take: number): Promise<Built[]> {
  const rows = await db.activityLog.findMany({
    where: { AND: [{ userId: personId, kind: { in: SIGN_IN_KINDS } }, timeWhere("createdAt", opts), textWhere("summary", opts)] },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, summary: true, createdAt: true, ipAddress: true, userId: true, userName: true },
  });
  return rows.map((r) => ({
    id: `signin-${r.id}`,
    at: r.createdAt.toISOString(),
    who: r.userId ? { id: r.userId, name: r.userName ?? "" } : null,
    asBy: null,
    group: "signins" as const,
    action: null,
    title: r.summary,
    detail: r.ipAddress ? `From ${r.ipAddress}` : null,
    changes: [],
    href: null,
  }));
}

const LEAD_WORD: Record<string, string> = { CREATE: "Lead added", UPDATE: "Lead changed", DELETE: "Lead removed" };

/**
 * Where this viewer sees leads masked (src/lib/leads/masking.ts), a lead's own change lines say only that it
 * changed — their wording carries its title, and what changed may be a field they can't see.
 */
function maskLeadLines(items: Built[], masker: FieldMasker): Built[] {
  if (!masker.active) return items;
  return items.map((i) => (i.group === "leads" && i.id.startsWith("audit-") ? { ...i, title: LEAD_WORD[i.action ?? "UPDATE"] ?? "Lead changed", changes: [] } : i));
}

const CONTACT_WORD: Record<string, string> = { CREATE: "Contact added", UPDATE: "Contact changed", DELETE: "Contact removed" };

/**
 * On a customer's or a person's feed, where the contacts policy conceals anything of a contact from this viewer, that
 * contact's own change lines say only that it changed (owner, 5 Nov 2026 — Phase 3 masking fixes), as a masked lead's
 * do (`maskLeadLines`): their wording is the contact's name, and as often its address — "Checked ravi@… — valid",
 * "Confirmed: ravi@…", "ravi@… at Acme (from TKT-…)" — and a name change says from what to what. A contact "Show"n
 * today reads in full. The lines of contacts the policy leaves clear are as they were.
 */
async function maskContactLines(viewerId: string, items: Built[], context: FieldContext): Promise<Built[]> {
  const isContact = (i: Built) => i.group === "contacts" && i.id.startsWith("audit-") && !!i.target && (i.target.type === "Contact" || i.target.type === "ContactConsent");
  const ids = [...new Set(items.filter(isContact).map((i) => i.target!.id))];
  if (ids.length === 0) return items;
  const cm: ContactMasker = await contactMasker(viewerId, context, ids);
  if (!cm.active) return items;
  return items.map((i) => (isContact(i) && cm.concealed(i.target!.id) ? { ...i, title: CONTACT_WORD[i.action ?? "UPDATE"] ?? "Contact changed", changes: [] } : i));
}

type IdRows = Promise<{ id: string }[]>;
/** For each kind of record a change line is about: how it is read, and the viewer's rule for it. */
const RECORD_RULES: Record<string, { find: (where: object) => IdRows; rule: (viewerId: string) => Promise<object> }> = {
  Lead: { find: (w) => db.lead.findMany({ where: w as Prisma.LeadWhereInput, select: { id: true } }), rule: (v) => leadAccess(v, "view") },
  Order: { find: (w) => db.companyProduct.findMany({ where: w as Prisma.CompanyProductWhereInput, select: { id: true } }), rule: (v) => orderAccess(v, "view") },
  CompanyProduct: { find: (w) => db.companyProduct.findMany({ where: w as Prisma.CompanyProductWhereInput, select: { id: true } }), rule: (v) => orderAccess(v, "view") },
  TradeDocument: { find: (w) => db.tradeDocument.findMany({ where: w as Prisma.TradeDocumentWhereInput, select: { id: true } }), rule: (v) => documentAccess(v, "view") },
  Payment: { find: (w) => db.payment.findMany({ where: w as Prisma.PaymentWhereInput, select: { id: true } }), rule: (v) => paymentAccess(v, "view") },
  Ticket: { find: (w) => db.ticket.findMany({ where: w as Prisma.TicketWhereInput, select: { id: true } }), rule: (v) => ticketAccess(v, "view") },
  Visit: { find: (w) => db.visit.findMany({ where: w as Prisma.VisitWhereInput, select: { id: true } }), rule: (v) => visitAccess(v, "view") },
  Project: { find: (w) => db.project.findMany({ where: w as Prisma.ProjectWhereInput, select: { id: true } }), rule: (v) => projectAccess(v, "view") },
  Expense: { find: (w) => db.expense.findMany({ where: w as Prisma.ExpenseWhereInput, select: { id: true } }), rule: (v) => expenseAccess(v, "view") },
  Task: { find: (w) => db.task.findMany({ where: w as Prisma.TaskWhereInput, select: { id: true } }), rule: (v) => taskAccess(v, "view") },
  CalendarEvent: { find: (w) => db.calendarEvent.findMany({ where: w as Prisma.CalendarEventWhereInput, select: { id: true } }), rule: (v) => meetingAccess(v, "view") },
  Contact: { find: (w) => db.contact.findMany({ where: w as Prisma.ContactWhereInput, select: { id: true } }), rule: (v) => contactScope(v) },
  Company: { find: (w) => db.company.findMany({ where: w as Prisma.CompanyWhereInput, select: { id: true } }), rule: (v) => companyAccess(v, "view") },
};

/**
 * Security audit round three, 14 Nov 2026 (R3-21): change lines only about records the viewer may open. The groups'
 * permissions decided which kinds showed, never which records — so a person's feed listed every order, invoice and lead
 * they had touched, on any account, to a manager whose rules reach a handful. Each line is now asked of its record's own
 * rule (the one its screen uses); a record since deleted is judged by its company, which every line on an account
 * carries; and a line on a company the viewer doesn't reach is dropped whatever its kind.
 */
async function visibleChanges(viewerId: string, items: Built[]): Promise<Built[]> {
  const audit = items.filter((i) => i.id.startsWith("audit-") && i.target);
  if (audit.length === 0) return items;
  const companyIds = [...new Set(audit.flatMap((i) => (i.target!.companyId ? [i.target!.companyId] : [])))];
  // The companies that still exist and that the viewer doesn't reach: a company since deleted leaves its lines alone.
  const [existing, reached] = companyIds.length
    ? await Promise.all([
        db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true } }),
        companyAccess(viewerId, "view").then((rule) => db.company.findMany({ where: { AND: [{ id: { in: companyIds } }, rule] }, select: { id: true } })),
      ])
    : [[], []];
  const reachedIds = new Set(reached.map((c) => c.id));
  const unreached = new Set(existing.map((c) => c.id).filter((id) => !reachedIds.has(id)));
  const dropped = new Set<string>();
  await Promise.all(
    Object.entries(RECORD_RULES).map(async ([type, check]) => {
      const ids = [...new Set(audit.filter((i) => i.target!.type === type).map((i) => i.target!.id))];
      if (ids.length === 0) return;
      const [exists, allowed] = await Promise.all([check.find({ id: { in: ids } }), check.rule(viewerId).then((rule) => check.find({ AND: [{ id: { in: ids } }, rule] }))]);
      const open = new Set(allowed.map((r) => r.id));
      for (const r of exists) if (!open.has(r.id)) dropped.add(`${type}:${r.id}`);
    }),
  );
  return items.filter((i) => {
    if (!i.id.startsWith("audit-") || !i.target) return true;
    if (dropped.has(`${i.target.type}:${i.target.id}`)) return false;
    return !i.target.companyId || !unreached.has(i.target.companyId);
  });
}

const DOMAIN_WORD: Record<string, string> = { CREATE: "Domain looked up", UPDATE: "Domain looked up", DELETE: "Domain removed" };

/**
 * Security audit round three, 14 Nov 2026 (R3-21): a company's change lines showed its website in full — "Website:
 * old.example → new.example", "Looked up example.com for Acme" — to someone whose field access masks the website, as
 * contacts' lines already weren't. Each change to a field the company policy conceals is shown as that policy shows it
 * here (`context`: the company's own page, or a list for a person's feed), and a domain lookup's line names no domain.
 */
async function maskCompanyLines(viewerId: string, items: Built[], context: FieldContext): Promise<Built[]> {
  const isCompany = (i: Built) => i.id.startsWith("audit-") && !!i.target && (i.target.type === "Company" || i.target.type === "DomainProfile");
  const ids = [...new Set(items.filter(isCompany).flatMap((i) => (i.target!.companyId ? [i.target!.companyId] : i.target!.type === "Company" ? [i.target!.id] : [])))];
  if (ids.length === 0) return items;
  const shown = await companyMasker(viewerId, context, ids);
  if (!shown.active) return items;
  return items.map((i) => {
    if (!isCompany(i)) return i;
    const m = shown.forCompany(i.target!.companyId ?? i.target!.id);
    if (m.visibility("website") === "clear") return i;
    if (i.target!.type === "DomainProfile") return { ...i, title: DOMAIN_WORD[i.action ?? "UPDATE"] ?? "Domain looked up", changes: [] };
    return { ...i, changes: i.changes.map((c) => (c.field === "website" ? { ...c, from: m.present("website", c.from), to: m.present("website", c.to) } : c)) };
  });
}

/**
 * A line on a lead's own feed with the lead's concealed values masked wherever its text quotes them —
 * what it's called, what was written, what an edit changed — by the lead page's own redactor
 * (src/lib/leads/masking.ts `leadRedactor`). Only that text: ids, times, people and field names are left alone.
 */
function redactLine(item: Built, redact: TextRedactor): Built {
  return {
    ...item,
    title: redact(item.title),
    detail: redact(item.detail),
    changes: item.changes.map((c) => ({ ...c, from: redact(c.from), to: redact(c.to) })),
  };
}

/** How each kind of record is opened. A contact opens its company's Contacts tab. */
const OPENS: Record<string, "lead" | "order" | "ticket" | "visit" | "expense" | "company" | "document" | "contact"> = {
  Lead: "lead",
  Order: "order",
  CompanyProduct: "order",
  Ticket: "ticket",
  Visit: "visit",
  Expense: "expense",
  Company: "company",
  DomainProfile: "company",
  TradeDocument: "document",
  Contact: "contact",
  ContactConsent: "contact",
};

/**
 * Each line's link, by its readable address (src/lib/record-links.ts), looked up for the page's lines in one
 * read a kind. A record since deleted has none, nor the record the feed is on. The page it opens checks access.
 */
async function withLinks(items: Built[], self: { companyId?: string; leadId?: string } = {}): Promise<ActivityItem[]> {
  const ids = (kind: string) => [...new Set(items.flatMap((i) => (i.target && OPENS[i.target.type] === kind ? [i.target.id] : [])))];
  const read = async (wanted: string[], rows: (ids: string[]) => Promise<{ id: string; seq: number }[]>) => (wanted.length ? new Map((await rows(wanted)).map((r) => [r.id, r.seq])) : new Map<string, number>());
  const companyIds = [...new Set([...ids("company"), ...items.flatMap((i) => (i.target && OPENS[i.target.type] === "contact" && i.target.companyId ? [i.target.companyId] : []))])];
  const [leads, orders, tickets, visits, expenses, companies, documents] = await Promise.all([
    read(ids("lead"), async (w) => (await db.lead.findMany({ where: { id: { in: w } }, select: { id: true, leadSeq: true } })).map((r) => ({ id: r.id, seq: r.leadSeq }))),
    read(ids("order"), async (w) => (await db.companyProduct.findMany({ where: { id: { in: w } }, select: { id: true, orderSeq: true } })).map((r) => ({ id: r.id, seq: r.orderSeq }))),
    read(ids("ticket"), async (w) => (await db.ticket.findMany({ where: { id: { in: w } }, select: { id: true, ticketSeq: true } })).map((r) => ({ id: r.id, seq: r.ticketSeq }))),
    read(ids("visit"), async (w) => (await db.visit.findMany({ where: { id: { in: w } }, select: { id: true, visitSeq: true } })).map((r) => ({ id: r.id, seq: r.visitSeq }))),
    read(ids("expense"), async (w) => (await db.expense.findMany({ where: { id: { in: w } }, select: { id: true, expenseSeq: true } })).map((r) => ({ id: r.id, seq: r.expenseSeq }))),
    read(companyIds, async (w) => (await db.company.findMany({ where: { id: { in: w } }, select: { id: true, companySeq: true } })).map((r) => ({ id: r.id, seq: r.companySeq }))),
    ids("document").length ? db.tradeDocument.findMany({ where: { id: { in: ids("document") } }, select: { id: true } }).then((r) => new Set(r.map((d) => d.id))) : Promise.resolve(new Set<string>()),
  ]);
  const at = (map: Map<string, number>, id: string, path: (seq: number) => string) => (map.has(id) ? path(map.get(id)!) : null);
  return items.map(({ target, ...item }) => {
    let href: string | null = null;
    switch (target ? OPENS[target.type] : undefined) {
      case "lead":
        href = target!.id === self.leadId ? null : at(leads, target!.id, leadPath);
        break;
      case "order":
        href = at(orders, target!.id, orderPath);
        break;
      case "ticket":
        href = at(tickets, target!.id, ticketPath);
        break;
      case "visit":
        href = at(visits, target!.id, visitPath);
        break;
      case "expense":
        href = at(expenses, target!.id, expensePath);
        break;
      case "company":
        href = target!.id === self.companyId ? null : at(companies, target!.id, companyPath);
        break;
      case "document":
        href = documents.has(target!.id) ? documentPath(target!.id) : null;
        break;
      case "contact":
        href = target!.companyId ? at(companies, target!.companyId, (seq) => `${companyPath(seq)}?tab=contacts`) : null;
        break;
    }
    return { ...item, href };
  });
}

/**
 * With words searched for, only the lines that say them as this viewer reads them: the database found them in the
 * line's own text, and a value hidden from the viewer (a masked phone, a withheld amount) must not be confirmed by a
 * match. The page's place stays the database's, so "Show older" carries on past what was left out.
 */
function shownMatches(found: ActivityPage, opts: ActivityOptions): ActivityPage {
  const words = opts.search?.trim().toLowerCase();
  if (!words) return found;
  const says = (i: ActivityItem) =>
    [i.title, i.detail ?? "", ...i.changes.flatMap((c) => [c.label, c.from ?? "", c.to ?? ""])].join("\n").toLowerCase().includes(words);
  return { ...found, items: found.items.filter(says) };
}

async function page(lists: Built[][], take: number, self?: { companyId?: string; leadId?: string }): Promise<ActivityPage> {
  const merged = lists.flat().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const items = merged.slice(0, take);
  const more = merged.length > take || lists.some((l) => l.length >= take);
  return { items: await withLinks(items, self), more, before: more && items.length ? items[items.length - 1]!.at : null };
}

/**
 * A lead's, or a customer's or vendor's, Activity. The caller has checked the viewer may open the record.
 * `of.companyId`: the company, its contacts, leads, orders, documents, payments, tickets and the rest.
 */
export async function recordActivity(viewerId: string, of: { companyId: string } | { leadId: string }, opts: ActivityOptions = {}): Promise<ActivityPage> {
  const take = Math.min(Math.max(opts.take ?? DEFAULT_TAKE, 1), 200);
  const allowed = await allowedGroups(viewerId);
  const person = opts.personId ? { userId: opts.personId } : {};
  const entityTypes = Object.entries(ENTITY_GROUP).filter(([, g]) => wants(opts, allowed, g)).map(([t]) => t);
  const subject = "companyId" in of ? { companyId: of.companyId } : { leadId: of.leadId };
  const masker = await listLeadMasker(viewerId);
  /**
   * A lead's own feed is drawn on the lead's page, beside its masked fields, and must say no more than
   * they do (owner, 2 Nov 2026 — Phase 1 security fixes, audit H-3). Its call lines put the contact, the
   * number and the account in the clear, and notes quote them, even with the lead masked and the day's
   * unmasking used up. So, where this person sees any of the lead concealed, the feed is masked with the
   * page's own answers and redactor: the lead's change lines say only that it changed, calls show what
   * they called as the page shows those fields, and every line's text has the lead's values masked.
   * Null for somebody who sees the lead whole — their feed is exactly as it was.
   */
  const onLead = "leadId" in of ? await leadPageRedaction(viewerId, of.leadId) : null;
  /**
   * A customer's feed is drawn on its page, beside its Contacts tab, and shows its people as that tab does: the
   * contacts policy's detail answers (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.7). A lead's own feed is
   * its page's, above, and keeps the lead page's answers.
   */
  const people: FieldContext | undefined = "companyId" in of ? "detail" : undefined;

  const [audit, logged] = await Promise.all([
    entityTypes.length ? auditRows({ AND: [subject, person, { entityType: { in: entityTypes } }, timeWhere("createdAt", opts), textWhere("entityLabel", opts)] }, take) : Promise.resolve([]),
    wants(opts, allowed, "notes") || wants(opts, allowed, "calls") || wants(opts, allowed, "leads")
      ? loggedRows(viewerId, { AND: ["companyId" in of ? { lead: { companyId: of.companyId } } : { leadId: of.leadId }, opts.personId ? { userId: opts.personId } : {}] }, opts, take, masker, people)
      : Promise.resolve([]),
  ]);
  const loggedItems = logged.filter((l) => wants(opts, allowed, l.item.group));
  const onLeads = new Set(logged.map((l) => l.callKey).filter((k): k is string => !!k));
  const [calls, emails, mailbox] = await Promise.all([
    wants(opts, allowed, "calls") ? callRows(viewerId, { AND: ["companyId" in of ? { companyId: of.companyId } : { leadId: of.leadId }, opts.personId ? { userId: opts.personId } : {}] }, opts, take, onLeads, onLead?.masker, people) : Promise.resolve([]),
    "companyId" in of && wants(opts, allowed, "emails") ? emailRows(viewerId, { AND: [{ companyId: of.companyId }, opts.personId ? { sentByUserId: opts.personId } : {}] }, opts, take, "detail") : Promise.resolve([]),
    wants(opts, allowed, "emails") ? mailboxRows(viewerId, { AND: ["companyId" in of ? { companyId: of.companyId } : { leadId: of.leadId }, opts.personId ? { userId: opts.personId } : {}] }, opts, take, people ?? "list") : Promise.resolve([]),
  ]);
  // A change to a call is its own line already: the call itself is listed from the call log.
  // Only lines on records the viewer may open, and a company's website as its policy shows it here (R3-21).
  const changes = await maskCompanyLines(viewerId, maskLeadLines(await visibleChanges(viewerId, audit.filter((a) => a.group !== "calls")), onLead?.masker ?? masker), people ?? "list");
  const lists: Built[][] = [people ? await maskContactLines(viewerId, changes, people) : changes, loggedItems.map((l) => l.item), calls, emails, mailbox];
  return shownMatches(await page(onLead ? lists.map((list) => list.map((item) => redactLine(item, onLead.redact))) : lists, take, subject), opts);
}

/** Whether a viewer may see what a person did: their own, their team's as a manager, or everyone's. */
export async function mayViewPersonActivity(viewerId: string, personId: string): Promise<boolean> {
  if (viewerId === personId) return true;
  if (await can(viewerId, "activity.viewAll")) return true;
  return (await getDownlineUserIds(viewerId)).includes(personId);
}

/** Everything a person did. The caller has checked `mayViewPersonActivity`. */
export async function personActivity(viewerId: string, personId: string, opts: ActivityOptions = {}): Promise<ActivityPage> {
  const take = Math.min(Math.max(opts.take ?? DEFAULT_TAKE, 1), 200);
  const allowed = await allowedGroups(viewerId);
  // Changes to things outside every group — settings, roles, the vault — are for themselves and whoever sees everyone's.
  if (viewerId === personId || (await can(viewerId, "activity.viewAll"))) allowed.add("other");
  if (viewerId === personId) allowed.add("expenses");
  allowed.add("signins");
  const mapped = Object.entries(ENTITY_GROUP).filter(([, g]) => wants(opts, allowed, g)).map(([t]) => t);
  const kinds: Prisma.AuditLogWhereInput = wants(opts, allowed, "other") ? { OR: [{ entityType: { in: mapped } }, { entityType: { notIn: Object.keys(ENTITY_GROUP) } }] } : { entityType: { in: mapped } };
  const auditWhere: Prisma.AuditLogWhereInput = { AND: [{ userId: personId }, kinds, timeWhere("createdAt", opts), textWhere("entityLabel", opts)] };
  const masker = await listLeadMasker(viewerId);

  const [audit, logged] = await Promise.all([
    auditRows(auditWhere, take).then(async (rows) => (rows.length || !(await auditNeedsPlainRead()) ? rows : auditRows(auditWhere, take, false))),
    wants(opts, allowed, "notes") || wants(opts, allowed, "calls") || wants(opts, allowed, "leads") ? loggedRows(viewerId, { userId: personId }, opts, take, masker, "list") : Promise.resolve([]),
  ]);
  const onLeads = new Set(logged.map((l) => l.callKey).filter((k): k is string => !!k));
  // A person's feed spans every customer they worked: contacts as a list shows them (owner, 5 Nov 2026 — Phase 3
  // masking fixes, audit H.4.7) — calls, emails, notes and contacts' change lines alike.
  const [calls, emails, signIns] = await Promise.all([
    wants(opts, allowed, "calls") ? callRows(viewerId, { userId: personId }, opts, take, onLeads, undefined, "list") : Promise.resolve([]),
    wants(opts, allowed, "emails") ? emailRows(viewerId, { sentByUserId: personId }, opts, take, "list") : Promise.resolve([]),
    wants(opts, allowed, "signins") ? signInRows(personId, opts, take) : Promise.resolve([]),
  ]);
  // Only lines on records the viewer may open, and a company's website as a list shows it (R3-21).
  const visible = await maskCompanyLines(viewerId, await visibleChanges(viewerId, audit.filter((a) => a.group !== "calls")), "list");
  const changes = await maskContactLines(viewerId, maskLeadLines(visible, masker), "list");
  return shownMatches(await page([changes, logged.filter((l) => wants(opts, allowed, l.item.group)).map((l) => l.item), calls, emails, signIns], take), opts);
}

/** A workspace not migrated yet has no `changes` column: a person's entries are read without it. */
async function auditNeedsPlainRead(): Promise<boolean> {
  try {
    await db.auditLog.findFirst({ select: { changes: true }, take: 1 });
    return false;
  } catch (err) {
    if (notMigratedYet(err)) return true;
    throw err;
  }
}

/** The kinds a viewer may filter by: on a record's feed, or a person's — sign-ins, and the rest for themselves or with the reach. */
export async function activityGroupsFor(viewerId: string, of: "record" | "person", personId?: string): Promise<ActivityGroupKey[]> {
  const allowed = await allowedGroups(viewerId);
  if (of === "person") {
    allowed.add("signins");
    if (personId === viewerId || (await can(viewerId, "activity.viewAll"))) allowed.add("other");
    if (personId === viewerId) allowed.add("expenses");
  }
  return ACTIVITY_GROUPS.map((g) => g.key).filter((k) => allowed.has(k));
}
