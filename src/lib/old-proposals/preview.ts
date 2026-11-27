import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { formerNameIndex } from "@/lib/companies/former-names";
import { legalNameKey, normalizeCompanyName } from "@/lib/company-name";
import { db } from "@/lib/db";
import { workDomain } from "@/lib/lead-capture/domain-match";
import { notMigratedYet } from "@/lib/not-migrated";
import { nameWords, sameCompany, yearLabel, type OldProposal } from "./read";

/**
 * What bringing the Excel proposals in would do (owner, 25 Nov 2026 — "Yes, build preview"): every proposal matched to a
 * company here, or not, and what would become of it. Reads only. Nothing is written, not even the file: what is uploaded
 * is looked at and let go.
 *
 * A company is taken as the same only by its name — as it is, in another legal form, or one it went by before. A contact's
 * own address, or a work domain that one company alone has, is a suggestion for somebody to look at.
 *
 * All of them come in (owner, 25 Nov 2026: "i want all these to be imported"): where the company isn't here it is made,
 * once however many proposals it has. One that may be a company here waits for somebody to say; one brought already is
 * passed over.
 */

export class OldProposalsRefused extends Error {}

/** A name to make a company by, the same however it was spaced or its legal form written: one company for all its proposals. */
export const companyKeyOf = (name: string): string => nameWords(name).join("") || legalNameKey(name) || normalizeCompanyName(name);

export const OLD_PROPOSALS_LIMITS = { packed: 3 * 1024 * 1024, unpacked: 40 * 1024 * 1024, proposals: 20_000 };

const text = (max: number) => z.string().max(max);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const line = z.object({ item: text(600), quantity: z.number().nullable(), rate: z.number().nullable(), amount: z.number().nullable() });
const proposal = z.object({
  key: text(400),
  ref: text(200),
  year: text(10),
  date: day.nullable(),
  company: text(400),
  alsoNamed: z.array(text(400)).max(10),
  contact: text(400),
  phone: text(40),
  email: text(300),
  address: text(2000),
  madeBy: text(200),
  product: text(600),
  status: z.enum(["WON", "LOST", "PENDING", "OTHER", "UNKNOWN"]),
  remarks: text(2000),
  left: z.boolean(),
  lines: z.array(line).max(500),
  total: z.number().nullable(),
  files: z.array(text(600)).max(200),
  // A file prepared before the papers were: none.
  attachments: z.array(text(600)).max(500).default([]),
  joined: z.enum(["REFERENCE", "DATE", "SHEET_ONLY", "FILE_ONLY"]),
  issues: z.array(text(1000)).max(20),
}) satisfies z.ZodType<OldProposal, unknown>;
const prepared = z.object({
  version: z.literal(1),
  made: text(40),
  proposals: z.array(proposal).max(OLD_PROPOSALS_LIMITS.proposals),
  unread: z.array(z.object({ file: text(600), why: text(300) })).max(20_000),
  otherFiles: z.number().int().min(0),
});

/** The prepared file, opened within its limits and checked. */
export function openPrepared(bytes: Buffer): z.infer<typeof prepared> {
  if (bytes.length > OLD_PROPOSALS_LIMITS.packed) throw new OldProposalsRefused("That file is bigger than a prepared one can be.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(bytes, { maxOutputLength: OLD_PROPOSALS_LIMITS.unpacked }).toString("utf8"));
  } catch {
    throw new OldProposalsRefused("That isn't a file prepared for this page. Prepare the folder first, then choose the .json.gz it made.");
  }
  const read = prepared.safeParse(parsed);
  if (!read.success) throw new OldProposalsRefused("That isn't a file prepared for this page, or an older one. Prepare the folder again.");
  return read.data;
}

export type OldOutcome = "BRING" | "CREATE" | "LOOK" | "HERE";
export type PreviewRow = {
  key: string;
  ref: string;
  year: string;
  date: string | null;
  company: string;
  contact: string;
  email: string;
  product: string;
  madeBy: string;
  status: OldProposal["status"];
  total: number | null;
  lines: number;
  files: number;
  papers: number;
  joined: OldProposal["joined"];
  outcome: OldOutcome;
  /** The company here it would go to, or is suggested. */
  to: { seq: number; name: string } | null;
  why: string;
  newContact: boolean;
  left: boolean;
  zoho: string | null;
  issues: string[];
};
export type PreviewResult = {
  made: string;
  total: number;
  versions: number;
  papers: number;
  unread: { total: number; byWhy: { why: string; count: number }[] };
  joined: Record<OldProposal["joined"], number>;
  byStatus: { status: OldProposal["status"]; BRING: number; CREATE: number; LOOK: number; HERE: number }[];
  newCompanies: number;
  newContacts: number;
  contactsLeft: number;
  alreadyZoho: number;
  withIssues: number;
  withTotal: number;
  withLines: number;
  rows: PreviewRow[];
};

type Found = { id: string; seq: number; name: string };
const STATUSES = ["WON", "LOST", "PENDING", "OTHER", "UNKNOWN"] as const;

/** Vendors that only sell to us, and commission parties, aren't who a proposal went to; those are looked at, not taken. */
const BUYS = new Set(["CLIENT", "RESELLER"]);

export async function previewOldProposals(bytes: Buffer): Promise<PreviewResult> {
  return matchOldProposals(openPrepared(bytes));
}

/** The company's id beside each row, for the import; the page has only its number and name. */
export async function matchOldProposals(file: z.infer<typeof prepared>, ids?: Map<string, string>): Promise<PreviewResult> {
  // Every company's name at once, light rows: a lookup a name would be thousands of queries.
  const companies = await db.company.findMany({ select: { id: true, companySeq: true, name: true, normalizedName: true, relationshipType: true, alsoCustomer: true, website: true } });
  const byId = new Map(companies.map((c) => [c.id, c]));
  const byName = new Map(companies.map((c) => [c.normalizedName, c.id]));
  const byLegal = new Map<string, string | null>();
  for (const c of companies) {
    const key = legalNameKey(c.name);
    // Two with one key: the name can't tell which.
    if (key) byLegal.set(key, byLegal.has(key) ? null : c.id);
  }
  // Names alike but for spacing and legal form ("R K Technologies", "RK Technologies"): not sure enough to take.
  const byWords = new Map<string, string | null>();
  for (const c of companies) {
    const key = nameWords(c.name).join("");
    if (key.length >= 5) byWords.set(key, byWords.has(key) ? null : c.id);
  }
  const brought = new Map<string, string>();
  try {
    for (const r of await db.oldProposal.findMany({ select: { key: true, companyId: true } })) brought.set(r.key, r.companyId);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const former = await formerNameIndex();
  const found = (id: string): Found | null => {
    const c = byId.get(id);
    return c ? { id: c.id, seq: c.companySeq, name: c.name } : null;
  };
  const named = (name: string): { id: string | null; several: boolean; how: string } => {
    const exact = byName.get(normalizeCompanyName(name));
    if (exact) return { id: exact, several: false, how: "Same name" };
    const key = legalNameKey(name);
    const legal = key ? byLegal.get(key) : undefined;
    if (legal) return { id: legal, several: false, how: "Same name in another legal form" };
    if (legal === null) return { id: null, several: true, how: "" };
    const was = former(name);
    return was ? { id: was.id, several: false, how: "A name it went by before" } : { id: null, several: was === null, how: "" };
  };

  // Who has the proposals' addresses here, and which companies have their work domains.
  const emails = [...new Set(file.proposals.map((p) => p.email.toLowerCase()).filter((e) => e.includes("@")))];
  const atEmail = new Map<string, Set<string>>();
  for (let i = 0; i < emails.length; i += 1000) {
    const rows = await db.$queryRaw<{ companyId: string; email: string }[]>`select "companyId", lower("email") as "email" from "contacts" where lower("email") = any(${emails.slice(i, i + 1000)})`;
    for (const r of rows) atEmail.set(r.email, (atEmail.get(r.email) ?? new Set()).add(r.companyId));
  }
  const domains = [...new Set(emails.map(workDomain).filter((d): d is string => !!d))];
  const atDomain = new Map<string, Set<string>>();
  for (let i = 0; i < domains.length; i += 1000) {
    const rows = await db.$queryRaw<{ companyId: string; domain: string }[]>`select distinct "companyId", lower(split_part("email", '@', 2)) as "domain" from "contacts" where lower(split_part("email", '@', 2)) = any(${domains.slice(i, i + 1000)})`;
    for (const r of rows) atDomain.set(r.domain, (atDomain.get(r.domain) ?? new Set()).add(r.companyId));
  }
  const wanted = new Set(domains);
  for (const c of companies) {
    const host = (c.website ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0] ?? "";
    if (host && wanted.has(host)) atDomain.set(host, (atDomain.get(host) ?? new Set()).add(c.id));
  }

  const matched = file.proposals.map((p) => {
    const already = brought.get(p.key);
    if (already) return { p, to: found(already), sure: true, why: "Brought in already" };
    let several = false;
    for (const [i, name] of [p.company, ...p.alsoNamed].entries()) {
      const n = named(name);
      several ||= n.several;
      if (!n.id) continue;
      const c = byId.get(n.id);
      if (!c) continue;
      if (!BUYS.has(c.relationshipType) && !c.alsoCustomer) return { p, to: found(c.id), sure: false, why: "A vendor here, not a customer" };
      // The folder's name, or the file's where the sheet says another: a lead, when the two names aren't alike.
      if (i > 0 && !sameCompany(name, p.company)) return { p, to: found(c.id), sure: false, why: `Filed or written as "${name}"` };
      return { p, to: found(c.id), sure: true, why: i > 0 ? `${n.how}: "${name}"` : n.how };
    }
    const email = p.email.toLowerCase();
    const people = email ? atEmail.get(email) : undefined;
    if (people?.size === 1) return { p, to: found([...people][0]!), sure: false, why: `${email} is a contact there` };
    const domain = workDomain(email);
    const there = domain ? atDomain.get(domain) : undefined;
    if (there?.size === 1) return { p, to: found([...there][0]!), sure: false, why: `Its mail is at ${domain}` };
    const alike = byWords.get(nameWords(p.company).join(""));
    if (alike && BUYS.has(byId.get(alike)!.relationshipType)) return { p, to: found(alike), sure: false, why: "Written almost the same" };
    if (several) return { p, to: null, sure: false, why: "More than one company here has that name" };
    if ((there?.size ?? 0) > 1) return { p, to: null, sure: false, why: `${there!.size} companies here have mail at ${domain}` };
    return { p, to: null, sure: true, why: "" };
  });

  // Whether the old books' archive already has it: a quote of that company, that week, for that much.
  const there = [...new Set(matched.map((x) => x.to?.id).filter((x): x is string => !!x))];
  const quotes = new Map<string, { number: string; date: number; total: number }[]>();
  for (let i = 0; i < there.length; i += 1000) {
    const rows = await db.archivedDocument.findMany({ where: { kind: "QUOTE", companyId: { in: there.slice(i, i + 1000) }, date: { lt: new Date("2022-04-01T00:00:00Z") } }, select: { companyId: true, number: true, date: true, total: true } });
    for (const r of rows) quotes.set(r.companyId!, [...(quotes.get(r.companyId!) ?? []), { number: r.number, date: r.date.getTime(), total: Number(r.total) }]);
  }

  const newCompanies = new Set<string>();
  const newContacts = new Set<string>();
  const left = new Set<string>();
  const rows: PreviewRow[] = matched.map(({ p, to, sure, why }) => {
    const outcome: OldOutcome = brought.has(p.key) ? "HERE" : !sure ? "LOOK" : to ? "BRING" : "CREATE";
    if (to) ids?.set(p.key, to.id);
    const email = p.email.toLowerCase();
    const newContact = !!email && (outcome === "CREATE" || (outcome === "BRING" && !atEmail.get(email)?.has(to!.id)));
    const companyKey = to?.id ?? companyKeyOf(p.company);
    if (outcome === "CREATE") newCompanies.add(companyKey);
    if (newContact) newContacts.add(`${companyKey}|${email}`);
    if (newContact && p.left) left.add(`${companyKey}|${email}`);
    const same = to && p.date && p.total !== null ? (quotes.get(to.id) ?? []).find((q) => Math.abs(q.date - Date.parse(p.date!)) <= 7 * 86_400_000 && Math.abs(q.total - p.total!) <= 1) : undefined;
    return {
      key: p.key,
      ref: p.ref,
      year: yearLabel(p.year),
      date: p.date,
      company: p.company,
      contact: p.contact,
      email: p.email,
      product: p.product,
      madeBy: p.madeBy,
      status: p.status,
      total: p.total,
      lines: p.lines.length,
      files: p.files.length,
      papers: p.attachments.length,
      joined: p.joined,
      outcome,
      to: to ? { seq: to.seq, name: to.name } : null,
      why: outcome === "CREATE" ? "Not in Deskzo" : why,
      newContact,
      left: p.left,
      zoho: same?.number ?? null,
      issues: p.issues,
    };
  });

  const count = (f: (r: PreviewRow) => boolean) => rows.filter(f).length;
  const why = new Map<string, number>();
  for (const u of file.unread) why.set(u.why, (why.get(u.why) ?? 0) + 1);
  return {
    made: file.made,
    total: rows.length,
    versions: rows.reduce((t, r) => t + Math.max(0, r.files - 1), 0),
    papers: rows.reduce((t, r) => t + r.papers, 0),
    unread: { total: file.unread.length, byWhy: [...why].map(([w, n]) => ({ why: w, count: n })).sort((a, b) => b.count - a.count) },
    joined: { REFERENCE: count((r) => r.joined === "REFERENCE"), DATE: count((r) => r.joined === "DATE"), SHEET_ONLY: count((r) => r.joined === "SHEET_ONLY"), FILE_ONLY: count((r) => r.joined === "FILE_ONLY") },
    byStatus: STATUSES.map((status) => {
      const of = (outcome: OldOutcome) => count((r) => r.status === status && r.outcome === outcome);
      return { status, BRING: of("BRING"), CREATE: of("CREATE"), LOOK: of("LOOK"), HERE: of("HERE") };
    }),
    newCompanies: newCompanies.size,
    newContacts: newContacts.size,
    contactsLeft: left.size,
    alreadyZoho: count((r) => !!r.zoho),
    withIssues: count((r) => r.issues.length > 0),
    withTotal: count((r) => r.total !== null),
    withLines: count((r) => r.lines > 0),
    rows,
  };
}
