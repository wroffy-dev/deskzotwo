import Papa from "papaparse";
import type { ContactDesignation, EmailCheckStatus, MarketingTopic } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeCompanyName } from "@/lib/company-name";
import { isFreeMailbox, parseEmailAddress } from "@/lib/email-verification";
import { checkEmailAddress } from "@/lib/email-verification-lookup";
import { workspaceClock } from "@/lib/time/workspace";
import { clientSide, vendorSide } from "@/lib/companies/roles";
import { sanitizeCsvCell } from "@/lib/csv";

/**
 * An uploaded list of people for a mass mail.
 *
 * Every row becomes — or is matched to — a contact first. That is the whole point: an unsubscribe
 * is recorded against the person, so it holds for the next campaign and the one after, and the
 * same suppression rules that protect CRM contacts protect these. Nobody is mailed straight from a
 * spreadsheet.
 *
 * Where a row's company comes from, in order: the company column, matched to a company we have or
 * created; the email's domain, matched through a colleague already on file or created under the
 * domain's name; and for a gmail or yahoo address with no company, one shared "Individuals" record
 * rather than a company per person.
 *
 * Consent is recorded for the topics the uploader named, with their note as the evidence — but only
 * where none exists. Somebody who unsubscribed stays unsubscribed, whatever list they turn up on.
 */

export const MAX_LIST_ROWS = 5000;
export const INDIVIDUALS_COMPANY = "Individuals (mailing lists)";

export type ListRow = { email: string; name: string | null; company: string | null; phone: string | null; designation: string | null; line: number };

export type ParsedList = {
  rows: ListRow[];
  invalid: { line: number; value: string; name: string | null; company: string | null }[];
  duplicates: number;
  /** The repeats themselves, for the download of what was left out. */
  duplicateRows: { line: number; value: string; name: string | null; company: string | null }[];
  columns: { email: string | null; name: string | null; company: string | null; phone: string | null; designation: string | null };
  tooMany: boolean;
};

const COLUMN_NAMES: Record<keyof ParsedList["columns"], RegExp> = {
  email: /^(e-?mail|email ?address|e-?mail id|mail)$/i,
  name: /^(name|full ?name|contact ?name|person)$/i,
  company: /^(company|company ?name|organi[sz]ation|organi[sz]ation ?name|business|firm|account)$/i,
  phone: /^(phone|mobile|phone ?number|mobile ?number|contact ?number|whatsapp)$/i,
  designation: /^(designation|title|job ?title|role|position)$/i,
};

/** Reads the CSV and says what it found — nothing is written. */
export function parseListCsv(text: string): ParsedList {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
  const headers = parsed.meta.fields ?? [];
  const find = (key: keyof ParsedList["columns"]) => headers.find((h) => COLUMN_NAMES[key].test(h)) ?? null;
  const columns = { email: find("email"), name: find("name"), company: find("company"), phone: find("phone"), designation: find("designation") };
  // "First name" and "Last name" are joined when there's no single name column.
  const first = headers.find((h) => /^first ?name$/i.test(h)) ?? null;
  const last = headers.find((h) => /^(last ?name|surname)$/i.test(h)) ?? null;

  const rows: ListRow[] = [];
  const invalid: ParsedList["invalid"] = [];
  const duplicateRows: ParsedList["duplicateRows"] = [];
  const seen = new Set<string>();
  const cell = (r: Record<string, string>, col: string | null) => (col ? (r[col] ?? "").trim() || null : null);

  parsed.data.forEach((raw, i) => {
    const line = i + 2; // the header is line 1
    const value = cell(raw, columns.email) ?? "";
    const name = cell(raw, columns.name) ?? ([cell(raw, first), cell(raw, last)].filter(Boolean).join(" ") || null);
    const company = cell(raw, columns.company);
    const address = parseEmailAddress(value);
    if (!address) {
      if (value || Object.values(raw).some((v) => v?.trim())) invalid.push({ line, value, name, company });
      return;
    }
    const email = `${address.local}@${address.domain}`.toLowerCase();
    if (seen.has(email)) {
      duplicateRows.push({ line, value, name, company });
      return;
    }
    seen.add(email);
    rows.push({ email, name, company, phone: cell(raw, columns.phone), designation: cell(raw, columns.designation), line });
  });

  return { rows: rows.slice(0, MAX_LIST_ROWS), invalid, duplicates: duplicateRows.length, duplicateRows, columns, tooMany: rows.length > MAX_LIST_ROWS };
}

/** A job title as typed, onto the few the CRM records. Anything unrecognised is Other. */
export function designationFrom(title: string | null): ContactDesignation {
  const t = (title ?? "").toLowerCase();
  if (/\bcio\b|chief information/.test(t)) return "CIO";
  if (/\bceo\b|chief executive|founder/.test(t)) return "CEO";
  if (/\bcto\b|chief tech|head of it|it head|head it|head - it/.test(t)) return "IT_HEAD";
  if (/director|\bmd\b|managing|partner|owner|proprietor/.test(t)) return "DIRECTOR";
  if (/purchase|procure|buyer|sourcing/.test(t)) return "PURCHASE_MANAGER";
  if (/\bit\b|system|network|infra|admin/.test(t)) return "IT_MANAGER";
  if (/\bhr\b|human resource|people|talent/.test(t)) return "HR";
  return "OTHER";
}

/** A domain as a company name: "sales.acme.co.in" → "acme.co.in". Good enough to be found and renamed. */
export function companyNameFromDomain(domain: string): string {
  const parts = domain.toLowerCase().split(".");
  const secondLevel = parts.length >= 3 && /^(co|com|net|org|gov|ac|edu|res|gen|firm|ind)$/.test(parts[parts.length - 2]!);
  return parts.slice(secondLevel ? -3 : -2).join(".");
}

// ─── Checking a list before it comes in (owner, 1 Nov 2026) ───────────────────────────────────────

/** Why a row was left out of a list. */
export type RejectReason = "FORMAT" | "DUPLICATE" | "INVALID" | "BOUNCED" | "CUSTOMER";

export const REJECT_LABELS: Record<RejectReason, string> = {
  FORMAT: "Not an email address",
  DUPLICATE: "Repeated in the file",
  INVALID: "Address doesn't work",
  BOUNCED: "Bounced or complained before",
  CUSTOMER: "An existing customer, left out",
};

export type Reject = { line: number; email: string; name: string | null; company: string | null; reason: RejectReason; detail: string };

/** Who the people already in Deskzo are, by the company each belongs to. */
export type Existing = { total: number; customers: number; vendors: number; staff: number; others: number };

export type ListCheck = {
  rows: number;
  /** Addresses that work — shared inboxes and free mailboxes too (owner: those may be marketed to). */
  good: number;
  /** A company's shared inbox or a free mailbox: counted within `good`, said apart. */
  shared: number;
  /** The domain couldn't be looked up just now — they come in, and are checked again before a send. */
  unknown: number;
  invalid: number;
  format: number;
  duplicates: number;
  bounced: number;
  /** Already unsubscribed from the topics picked: they come in, and stay unsubscribed. */
  unsubscribed: number;
  existing: Existing;
  tooMany: boolean;
};

type Checked = {
  parsed: ParsedList;
  /** Each address's check; UNCHECKED where its domain couldn't be looked up just now. */
  verdict: Map<string, { status: EmailCheckStatus; detail: string }>;
  bounced: Map<string, string>;
  customerEmails: Set<string>;
  contactByEmail: Map<string, string>;
  check: ListCheck;
};

/** Every address checked, a few at a time — each domain is looked up once (src/lib/email-verification-lookup.ts caches it). */
async function verdicts(emails: string[]): Promise<Checked["verdict"]> {
  const out: Checked["verdict"] = new Map();
  const queue = [...emails];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let email = queue.shift(); email; email = queue.shift()) {
        const outcome = await checkEmailAddress(email);
        out.set(email, { status: outcome.status, detail: outcome.detail });
      }
    }),
  );
  return out;
}

/**
 * The list as it would come in, with nothing written: each address checked, those that bounced or complained before,
 * who is already in Deskzo (a customer's contact, a vendor's, one of the team's own), and who had unsubscribed.
 */
async function checkList(csvText: string, topics: MarketingTopic[]): Promise<Checked | { error: string }> {
  const parsed = parseListCsv(csvText);
  if (!parsed.columns.email) return { error: "No email column — the first row should name the columns, one of them Email." };
  if (parsed.rows.length === 0) return { error: "No valid email addresses in that file." };
  const emails = parsed.rows.map((r) => r.email);

  const [verdict, existing, suppressed, staff] = await Promise.all([
    verdicts(emails),
    db.$queryRaw<{ id: string; email: string; companyId: string }[]>`
      SELECT id, lower(email) AS email, "companyId" FROM contacts WHERE lower(email) = ANY(${emails}::text[])`,
    db.suppression.findMany({ where: { scope: "EMAIL", value: { in: emails }, reason: { in: ["HARD_BOUNCE", "COMPLAINT", "INVALID"] } }, select: { value: true, reason: true } }),
    db.$queryRaw<{ email: string }[]>`SELECT lower(email) AS email FROM users WHERE lower(email) = ANY(${emails}::text[])`,
  ]);
  const contactByEmail = new Map(existing.map((c) => [c.email, c.id]));
  const companyIds = [...new Set(existing.map((c) => c.companyId))];
  const [customerCompanies, vendorCompanies] = companyIds.length
    ? await Promise.all([
        db.company.findMany({ where: { AND: [{ id: { in: companyIds } }, await clientSide(), { products: { some: {} } }] }, select: { id: true } }),
        db.company.findMany({ where: { AND: [{ id: { in: companyIds } }, await vendorSide()] }, select: { id: true } }),
      ])
    : [[], []];
  const customerIds = new Set(customerCompanies.map((c) => c.id));
  const vendorIds = new Set(vendorCompanies.map((c) => c.id));
  const staffEmails = new Set(staff.map((s) => s.email));
  const customerEmails = new Set(existing.filter((c) => customerIds.has(c.companyId)).map((c) => c.email));
  const bounced = new Map(suppressed.map((s) => [s.value, s.reason === "COMPLAINT" ? "They marked an earlier email as spam." : s.reason === "HARD_BOUNCE" ? "Mail to it bounced before." : "It failed the address check on an earlier list."]));

  const unsubscribed = contactByEmail.size
    ? await db.contactConsent.findMany({ where: { contactId: { in: [...contactByEmail.values()] }, channel: "EMAIL", topic: { in: topics }, status: "UNSUBSCRIBED" }, select: { contactId: true }, distinct: ["contactId"] })
    : [];

  let good = 0;
  let shared = 0;
  let unknown = 0;
  let invalid = 0;
  for (const email of emails) {
    if (bounced.has(email)) continue;
    const v = verdict.get(email)!;
    if (v.status === "INVALID") invalid += 1;
    else if (v.status !== "VALID" && v.status !== "RISKY") unknown += 1;
    else {
      good += 1;
      if (v.status === "RISKY") shared += 1;
    }
  }
  const existingCounts: Existing = { total: existing.length, customers: 0, vendors: 0, staff: 0, others: 0 };
  for (const c of existing) {
    if (staffEmails.has(c.email)) existingCounts.staff += 1;
    else if (customerIds.has(c.companyId)) existingCounts.customers += 1;
    else if (vendorIds.has(c.companyId)) existingCounts.vendors += 1;
    else existingCounts.others += 1;
  }
  return {
    parsed,
    verdict,
    bounced,
    customerEmails,
    contactByEmail,
    check: {
      rows: parsed.rows.length,
      good,
      shared,
      unknown,
      invalid,
      format: parsed.invalid.length,
      duplicates: parsed.duplicates,
      bounced: bounced.size,
      unsubscribed: unsubscribed.length,
      existing: existingCounts,
      tooMany: parsed.tooMany,
    },
  };
}

/** The upload's first step: what the list holds, checked, and nothing written. */
export async function previewMarketingList(input: { csvText: string; topics: MarketingTopic[] }): Promise<{ ok: true; data: ListCheck } | { ok: false; error: string }> {
  const checked = await checkList(input.csvText, input.topics);
  if ("error" in checked) return { ok: false, error: checked.error };
  return { ok: true, data: checked.check };
}

export type ImportSummary = {
  listId: string;
  rows: number;
  /** Rows that came onto the list. */
  imported: number;
  invalid: number;
  duplicates: number;
  tooMany: boolean;
  matchedContacts: number;
  createdContacts: number;
  createdCompanies: number;
  consentRecorded: number;
  /** On the list, but they had already unsubscribed — they stay unsubscribed. */
  alreadyUnsubscribed: number;
  checked: { valid: number; risky: number; invalid: number; unknown: number };
  /** Rows left out, by why — the list's page hands them back as a CSV. */
  rejected: Record<RejectReason, number>;
  /** Addresses that failed the check, now on the suppression list. */
  suppressed: number;
};

/**
 * Imports the list, after checking it as the preview did. Left out — and kept for the download: rows that aren't an
 * address, repeats, addresses that don't work (also put on the suppression list, so no later list or contact mails
 * them), those that bounced or complained before, and existing customers when `leaveOutCustomers`. Shared inboxes and
 * free mailboxes come in (owner, 1 Nov 2026: they may be marketed to). `ownerUserId` becomes the account manager of any
 * company this creates — the person who brought these people in.
 */
export async function importMarketingList(input: {
  userId: string;
  name: string;
  fileName: string | null;
  csvText: string;
  consentNote: string;
  topics: MarketingTopic[];
  leaveOutCustomers?: boolean;
}): Promise<{ ok: true; data: ImportSummary } | { ok: false; error: string }> {
  const checked = await checkList(input.csvText, input.topics);
  if ("error" in checked) return { ok: false, error: checked.error };
  const { parsed, verdict, bounced, customerEmails } = checked;

  // ── What stays out, and why ─────────────────────────────────────────────────────────────
  const rejects: Reject[] = [
    ...parsed.invalid.map((r) => ({ line: r.line, email: r.value, name: r.name, company: r.company, reason: "FORMAT" as const, detail: r.value ? "Not an email address — check it for a typo or a stray space." : "No email address on the row." })),
    ...parsed.duplicateRows.map((r) => ({ line: r.line, email: r.value, name: r.name, company: r.company, reason: "DUPLICATE" as const, detail: "The same address appears earlier in the file." })),
  ];
  const kept: ListRow[] = [];
  for (const r of parsed.rows) {
    const v = verdict.get(r.email)!;
    if (bounced.has(r.email)) rejects.push({ line: r.line, email: r.email, name: r.name, company: r.company, reason: "BOUNCED", detail: bounced.get(r.email)! });
    else if (v.status === "INVALID") rejects.push({ line: r.line, email: r.email, name: r.name, company: r.company, reason: "INVALID", detail: v.detail });
    else if (input.leaveOutCustomers && customerEmails.has(r.email)) rejects.push({ line: r.line, email: r.email, name: r.name, company: r.company, reason: "CUSTOMER", detail: "Already a customer's contact — left out, as asked." });
    else kept.push(r);
  }
  if (kept.length === 0) return { ok: false, error: "Nobody on that list can be mailed — every row was left out. Download the check to see why." };

  // ── Contacts already on file, by address, whatever case it was typed in ────────────────
  const keptEmails = new Set(kept.map((r) => r.email));
  const contactByEmail = new Map([...checked.contactByEmail].filter(([email]) => keptEmails.has(email)));
  const matchedContacts = contactByEmail.size;
  const fresh = kept.filter((r) => !contactByEmail.has(r.email));
  // ── Companies for the new ones ──────────────────────────────────────────────────────────
  const companyFor = new Map<string, string>(); // row email → company id
  let createdCompanies = 0;

  // A colleague already on file tells us the company for a domain better than the domain's name does.
  const domains = [...new Set(fresh.filter((r) => !r.company && !isFreeMailbox(r.email.split("@")[1]!)).map((r) => r.email.split("@")[1]!))];
  const colleagues = domains.length
    ? await db.$queryRaw<{ domain: string; companyId: string }[]>`
        SELECT DISTINCT ON (split_part(lower(email), '@', 2)) split_part(lower(email), '@', 2) AS domain, "companyId"
          FROM contacts WHERE split_part(lower(email), '@', 2) = ANY(${domains}::text[])`
    : [];
  const companyByDomain = new Map(colleagues.map((c) => [c.domain, c.companyId]));

  // Names only for the rows no colleague answers for — a company made for nobody is clutter.
  const byName = new Map<string, string>(); // normalised name → display name
  for (const r of fresh) {
    const domain = r.email.split("@")[1]!;
    if (!r.company && companyByDomain.has(domain)) continue;
    const name = r.company ?? (isFreeMailbox(domain) ? INDIVIDUALS_COMPANY : companyNameFromDomain(domain));
    byName.set(normalizeCompanyName(name), name);
  }

  const known = await db.company.findMany({ where: { normalizedName: { in: [...byName.keys()] } }, select: { id: true, normalizedName: true } });
  const companyByName = new Map(known.map((c) => [c.normalizedName, c.id]));
  const toCreate = [...byName.entries()].filter(([norm]) => !companyByName.has(norm));
  if (toCreate.length) {
    const created = await db.company.createManyAndReturn({
      data: toCreate.map(([normalizedName, name]) => ({
        name,
        normalizedName,
        relationshipType: "CLIENT" as const,
        stage: "PROSPECT" as const,
        source: "OTHER" as const,
        createdById: input.userId,
        ownerUserId: input.userId,
      })),
      skipDuplicates: true,
      select: { id: true, normalizedName: true },
    });
    createdCompanies = created.length;
    for (const c of created) companyByName.set(c.normalizedName, c.id);
    // Anything skipped as a duplicate was created by somebody else a moment ago — look it up.
    const stillMissing = toCreate.map(([n]) => n).filter((n) => !companyByName.has(n));
    if (stillMissing.length) {
      for (const c of await db.company.findMany({ where: { normalizedName: { in: stillMissing } }, select: { id: true, normalizedName: true } })) companyByName.set(c.normalizedName, c.id);
    }
  }
  for (const r of fresh) {
    const domain = r.email.split("@")[1]!;
    const viaColleague = !r.company ? companyByDomain.get(domain) : undefined;
    const name = r.company ?? (isFreeMailbox(domain) ? INDIVIDUALS_COMPANY : companyNameFromDomain(domain));
    companyFor.set(r.email, viaColleague ?? companyByName.get(normalizeCompanyName(name))!);
  }

  // ── The new contacts ────────────────────────────────────────────────────────────────────
  const createdContacts = fresh.length
    ? await db.contact.createManyAndReturn({
        data: fresh.map((r) => ({
          companyId: companyFor.get(r.email)!,
          name: r.name ?? r.email.split("@")[0]!,
          email: r.email,
          phone: r.phone,
          designation: designationFrom(r.designation),
          isPrimary: false,
        })),
        select: { id: true, email: true },
      })
    : [];
  for (const c of createdContacts) contactByEmail.set(c.email!.toLowerCase(), c.id);
  const contactIds = kept.map((r) => contactByEmail.get(r.email)).filter((id): id is string => !!id);

  // ── The list, and the consent it carries ───────────────────────────────────────────────
  // The day on the workspace's calendar, not UTC's.
  const today = (await workspaceClock()).today();
  const list = await db.marketingList.create({
    data: {
      name: input.name,
      fileName: input.fileName,
      consentNote: input.consentNote,
      topics: input.topics,
      createdById: input.userId,
      members: { createMany: { data: contactIds.map((contactId) => ({ contactId })), skipDuplicates: true } },
    },
    select: { id: true },
  });
  // Only where there is no row: an UNSUBSCRIBED row is left exactly as it is.
  const consent = await db.contactConsent.createMany({
    data: contactIds.flatMap((contactId) =>
      input.topics.map((topic) => ({
        contactId,
        channel: "EMAIL" as const,
        topic,
        status: "SUBSCRIBED" as const,
        source: "IMPORT" as const,
        evidence: `On the list "${input.name}"${input.fileName ? ` (${input.fileName})` : ""}, uploaded ${today}: ${input.consentNote}`.slice(0, 1000),
        capturedById: input.userId,
      })),
    ),
    skipDuplicates: true,
  });
  const alreadyUnsubscribed = await db.contactConsent.count({
    where: { contactId: { in: contactIds }, channel: "EMAIL", topic: { in: input.topics }, status: "UNSUBSCRIBED" },
  });

  // ── Each address's verdict on its contact, so the send can trust it — the check just made, not another ─────
  const contacts = await db.contact.findMany({ where: { id: { in: contactIds }, email: { not: null } }, select: { id: true, email: true, emailCheckedValue: true } });
  const checkedCounts = { valid: 0, risky: 0, invalid: 0, unknown: 0 };
  for (const c of contacts) {
    const v = verdict.get(c.email!.toLowerCase());
    if (!v || c.emailCheckedValue === c.email) continue;
    await db.contact.update({
      where: { id: c.id },
      data: { emailStatus: v.status, emailCheckDetail: v.detail, emailCheckMethod: "AUTOMATIC", emailCheckedValue: c.email, emailCheckedAt: new Date(), emailCheckedByUserId: input.userId },
    });
    checkedCounts[v.status === "VALID" ? "valid" : v.status === "RISKY" ? "risky" : v.status === "INVALID" ? "invalid" : "unknown"] += 1;
  }

  // ── The addresses that don't work: on the suppression list, and on any contact already holding them ──────
  const failing = rejects.filter((r) => r.reason === "INVALID");
  const suppressed = failing.length
    ? await db.suppression.createMany({
        data: failing.map((r) => ({ scope: "EMAIL" as const, value: r.email, reason: "INVALID" as const, note: `List “${input.name}”: ${r.detail}`.slice(0, 500), createdById: input.userId })),
        // One already there — a bounce, an unsubscribe — says more than this does, and stays as it is.
        skipDuplicates: true,
      })
    : { count: 0 };
  for (const r of failing) {
    const id = checked.contactByEmail.get(r.email);
    if (id) await db.contact.update({ where: { id }, data: { emailStatus: "INVALID", emailCheckDetail: r.detail, emailCheckMethod: "AUTOMATIC", emailCheckedValue: r.email, emailCheckedAt: new Date(), emailCheckedByUserId: input.userId } });
  }

  // ── What was left out, kept for the download ──────────────────────────────────────────────────────────────
  if (rejects.length) {
    await db.marketingListReject.createMany({
      data: rejects.map((r) => ({ listId: list.id, line: r.line, email: r.email.slice(0, 320), name: r.name?.slice(0, 200) ?? null, company: r.company?.slice(0, 200) ?? null, reason: r.reason, detail: r.detail.slice(0, 500) })),
    });
  }
  const rejected = { FORMAT: 0, DUPLICATE: 0, INVALID: 0, BOUNCED: 0, CUSTOMER: 0 } as Record<RejectReason, number>;
  for (const r of rejects) rejected[r.reason] += 1;

  return {
    ok: true,
    data: {
      listId: list.id,
      rows: parsed.rows.length,
      imported: contactIds.length,
      invalid: parsed.invalid.length,
      duplicates: parsed.duplicates,
      tooMany: parsed.tooMany,
      matchedContacts,
      createdContacts: createdContacts.length,
      createdCompanies,
      consentRecorded: consent.count,
      alreadyUnsubscribed,
      checked: checkedCounts,
      rejected,
      suppressed: suppressed.count,
    },
  };
}

/** A list's left-out rows as a CSV, for the uploader to fix and upload again. */
export async function listRejectsCsv(listId: string): Promise<{ name: string; csv: string } | null> {
  const list = await db.marketingList.findUnique({ where: { id: listId }, select: { name: true, rejects: { orderBy: { line: "asc" }, select: { line: true, email: true, name: true, company: true, reason: true, detail: true } } } });
  if (!list) return null;
  const rows = list.rejects.map((r) => ({
    Line: String(r.line),
    Email: sanitizeCsvCell(r.email),
    Name: sanitizeCsvCell(r.name ?? ""),
    Company: sanitizeCsvCell(r.company ?? ""),
    Reason: REJECT_LABELS[r.reason as RejectReason] ?? r.reason,
    Detail: sanitizeCsvCell(r.detail),
  }));
  const fields = ["Line", "Email", "Name", "Company", "Reason", "Detail"] as const;
  return { name: list.name, csv: Papa.unparse({ fields: [...fields], data: rows.map((r) => fields.map((f) => r[f])) }) };
}
