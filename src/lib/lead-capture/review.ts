import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { normalizeCompanyName } from "@/lib/company-name";
import { leadPath } from "@/lib/record-links";
import { companyByEmailDomain } from "./domain-match";
import { intakeLead, leadPayloadSchema, type IntakeResult, type IntakeSource, type LeadPayload } from "./intake";

/**
 * Website enquiries held for review (owner, 9 Nov 2026). A website's form takes whatever is typed in its company box —
 * "Twentytwelve" — and a company made from that is one nobody wants. With the workspace's switch on (Settings › Lead
 * capture API, off until an admin turns it on), an enquiry from a website's key waits here and nothing is made; whoever
 * may assign leads accepts it — onto an existing company (the sender's work email, or the name typed, suggests one), a
 * new one named properly, or the person as an individual — and it goes through the lead capture as any would; or
 * dismisses it, and nothing is made at all. Off, enquiries become leads at once, as before.
 */

export const enquiryRef = (seq: number) => `ENQ-${String(seq).padStart(6, "0")}`;

export async function holdsWebsiteEnquiries(): Promise<boolean> {
  try {
    return (await db.leadReviewSettings.findUnique({ where: { id: "default" }, select: { holdWebsite: true } }))?.holdWebsite ?? false;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/** The company an enquiry points at, as the lead capture would pick it: the name typed when it's on file, else the sender's work email. */
export async function suggestCompany(p: Pick<LeadPayload, "email" | "company">): Promise<{ id: string; name: string; why: "email" | "name" } | null> {
  const byName = p.company?.trim() ? await db.company.findUnique({ where: { normalizedName: normalizeCompanyName(p.company) }, select: { id: true, name: true } }) : null;
  if (byName) return { ...byName, why: "name" };
  const byDomain = await companyByEmailDomain(p.email);
  return byDomain ? { ...byDomain, why: "email" } : null;
}

/** Holds an enquiry; the same website sending the same one again (its external_id) is the one already held. */
export async function holdEnquiry(key: { id: string; name: string; createdById: string | null }, p: LeadPayload): Promise<{ id: string; seq: number; again: boolean }> {
  if (p.external_id) {
    const before = await db.websiteEnquiry.findUnique({ where: { captureKeyId_externalId: { captureKeyId: key.id, externalId: p.external_id } }, select: { id: true, seq: true } });
    if (before) return { ...before, again: true };
  }
  const suggested = await suggestCompany(p).catch(() => null);
  const row = await db.websiteEnquiry.create({
    data: { captureKeyId: key.id, payload: p as Prisma.InputJsonValue, externalId: p.external_id || null, suggestedCompanyId: suggested?.id ?? null },
    select: { id: true, seq: true },
  });
  // Whoever made the website's key is told one waits; the review list is where it's decided.
  const tell = key.createdById ?? (await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } }))?.id;
  if (tell) {
    await notifyUser({
      userId: tell,
      type: "LEAD_ASSIGNED",
      title: `A website enquiry waits for review — ${p.name}${p.company ? `, ${p.company}` : ""}`,
      message: [p.email, p.phone, p.message].filter(Boolean).join(" · ").slice(0, 300),
      link: "/leads/enquiries",
    }).catch(() => undefined);
  }
  return { ...row, again: false };
}

export type EnquiryRow = {
  id: string;
  ref: string;
  status: string;
  receivedAt: Date;
  website: string | null;
  payload: LeadPayload;
  suggested: { id: string; name: string; companySeq: number; why: "email" | "name" } | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  leadId: string | null;
  /** The lead it became, by its readable address. */
  leadHref: string | null;
};

export async function listEnquiries(which: "pending" | "decided"): Promise<EnquiryRow[]> {
  const rows = await db.websiteEnquiry.findMany({
    where: which === "pending" ? { status: "PENDING" } : { status: { not: "PENDING" } },
    orderBy: which === "pending" ? { receivedAt: "asc" } : { decidedAt: "desc" },
    take: 200,
    select: { id: true, seq: true, status: true, receivedAt: true, payload: true, suggestedCompanyId: true, decidedById: true, decidedAt: true, decisionNote: true, leadId: true, captureKey: { select: { name: true } } },
  });
  const companyIds = [...new Set(rows.flatMap((r) => (r.suggestedCompanyId ? [r.suggestedCompanyId] : [])))];
  const companies = new Map((companyIds.length ? await db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true, companySeq: true } }) : []).map((c) => [c.id, c]));
  const leadIds = rows.flatMap((r) => (r.leadId ? [r.leadId] : []));
  const leads = new Map((leadIds.length ? await db.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, leadSeq: true } }) : []).map((l) => [l.id, leadPath(l.leadSeq)]));
  const deciderIds = [...new Set(rows.flatMap((r) => (r.decidedById ? [r.decidedById] : [])))];
  const deciders = new Map((deciderIds.length ? await db.user.findMany({ where: { id: { in: deciderIds } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
  return rows.map((r) => {
    const payload = leadPayloadSchema.safeParse(r.payload);
    const p = (payload.success ? payload.data : r.payload) as LeadPayload;
    const company = r.suggestedCompanyId ? companies.get(r.suggestedCompanyId) : undefined;
    return {
      id: r.id,
      ref: enquiryRef(r.seq),
      status: r.status,
      receivedAt: r.receivedAt,
      website: r.captureKey?.name ?? null,
      payload: p,
      suggested: company ? { ...company, why: (p.email && company ? "email" : "name") as "email" | "name" } : null,
      decidedBy: r.decidedById ? (deciders.get(r.decidedById) ?? null) : null,
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
      leadId: r.leadId,
      leadHref: r.leadId ? (leads.get(r.leadId) ?? null) : null,
    };
  });
}

export const pendingEnquiries = () => db.websiteEnquiry.count({ where: { status: "PENDING" } }).catch(() => 0);

export type AcceptChoice = { kind: "existing"; companyId: string } | { kind: "new"; name: string } | { kind: "individual" };

export class EnquiryRefused extends Error {}

/**
 * Accepted: the enquiry goes through the lead capture as a website's would, onto the company chosen. Claimed first, so
 * two people accepting at once make one lead.
 */
export async function acceptEnquiry(id: string, choice: AcceptChoice, userId: string): Promise<IntakeResult> {
  const row = await db.websiteEnquiry.findUnique({ where: { id }, select: { id: true, status: true, payload: true, captureKey: { select: { id: true, name: true, sourceLabel: true, createdById: true } } } });
  if (!row) throw new EnquiryRefused("That enquiry is gone.");
  if (row.status !== "PENDING") throw new EnquiryRefused("Somebody has decided this enquiry already.");
  const parsed = leadPayloadSchema.safeParse(row.payload);
  if (!parsed.success) throw new EnquiryRefused("This enquiry can't be read any more.");
  const p = parsed.data;

  let options: { companyId?: string; companyName?: string } = {};
  if (choice.kind === "existing") {
    const company = await db.company.findUnique({ where: { id: choice.companyId }, select: { id: true } });
    if (!company) throw new EnquiryRefused("Choose a company that's on file.");
    options = { companyId: company.id };
  } else if (choice.kind === "new") {
    const name = choice.name.replace(/\s+/g, " ").trim().slice(0, 160);
    if (name.length < 2) throw new EnquiryRefused("Give the company its name.");
    options = { companyName: name };
  } else {
    options = { companyName: `${p.name} (individual)` };
  }

  const claimed = await db.websiteEnquiry.updateMany({ where: { id, status: "PENDING" }, data: { status: "ACCEPTED", decidedById: userId, decidedAt: new Date() } });
  if (claimed.count === 0) throw new EnquiryRefused("Somebody has decided this enquiry already.");
  const key: IntakeSource = row.captureKey ? { id: row.captureKey.id, name: row.captureKey.name, sourceLabel: row.captureKey.sourceLabel, createdById: row.captureKey.createdById } : { id: null, name: "Website", sourceLabel: null, createdById: userId };
  try {
    const result = await intakeLead(key, p, options);
    const leadId = result.status === "created" || result.status === "duplicate" ? result.leadId : null;
    const note = choice.kind === "existing" ? "Onto a company on file" : choice.kind === "new" ? `As a new company, ${options.companyName}` : "As an individual";
    await db.websiteEnquiry.update({ where: { id }, data: { leadId, decisionNote: note } });
    return result;
  } catch (err) {
    // Not made: it waits again.
    await db.websiteEnquiry.update({ where: { id }, data: { status: "PENDING", decidedById: null, decidedAt: null } });
    throw err;
  }
}

/** Dismissed: spam, a test, somebody not a customer. Nothing is made. */
export async function dismissEnquiry(id: string, userId: string, why: string | null): Promise<void> {
  const done = await db.websiteEnquiry.updateMany({ where: { id, status: "PENDING" }, data: { status: "DISMISSED", decidedById: userId, decidedAt: new Date(), decisionNote: why?.trim().slice(0, 300) || null } });
  if (done.count === 0) throw new EnquiryRefused("Somebody has decided this enquiry already.");
}
