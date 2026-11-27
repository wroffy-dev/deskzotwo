"use server";

import { revalidatePath } from "next/cache";
import { tooLong } from "@/lib/validation/text";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { currentTenant } from "@/lib/tenancy/resolve";
import { can } from "@/lib/authz/resolve";
import { canSeeCompany, companyScope } from "@/lib/authz/company-scope";
import { canViewContacts, seesResellerContactDetails } from "@/lib/authz/contact-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { toPlain } from "@/lib/serialize";
import { parseRecordRef } from "@/lib/record-url";
import { formatCompanyId } from "@/lib/order-id";
import { companyPath } from "@/lib/record-links";
import { normalizeCompanyName } from "@/lib/company-name";
import { isFreeMailbox } from "@/lib/email-verification";
import { checkTerms, recordDecision } from "@/lib/credit/guard";
import { assessCompanies, cacheAssessments } from "@/lib/credit/load";
import { companyFamily, domainOf, duplicatePairs, pairKey, phoneKey, type DuplicateCandidate } from "@/lib/companies/duplicates";
import { executeMerge, MergeRefused, planMerge, type MergePlan } from "@/lib/companies/merge";
import { BULK_NEVER_FROM_DUPLICATE, BULK_PER_CALL, BULK_PER_DAY, bulkBatch, bulkConfirmMatches, bulkVerdict, keeperOf, type BulkSubject } from "@/lib/companies/bulk-merge";
import { companyMasker } from "@/lib/companies/masking";
import { DUPLICATE_GROUPS, groupOf, zohoInvoicesFirst, type DuplicateGroup } from "@/lib/companies/duplicate-groups";
import { companyOrigins } from "@/lib/companies/origins";
import { maskedInLists } from "@/lib/contacts/masking";
import type { ActionResult } from "@/actions/company";

/**
 * Merging duplicate companies, and the list of likely duplicates — see src/lib/companies/merge.ts
 * for what a merge does and src/lib/companies/duplicates.ts for how duplicates are found.
 *
 * All of it needs `companies.merge`, and only ever between companies the person can already see:
 * a merge must not be a way to reach an account through a duplicate of it.
 */

const NOT_ALLOWED = "You can't merge companies.";

async function companyByRef(segment: string) {
  const ref = parseRecordRef(segment);
  return db.company.findUnique({
    where: ref.kind === "seq" ? { companySeq: ref.seq } : { id: ref.id },
    select: { id: true, companySeq: true, name: true, ownerUserId: true, relationshipType: true },
  });
}

/** A company this person may see, by COM number or id — null for "not there" and "not yours" alike. */
async function visibleCompany(userId: string, segment: string) {
  const company = await companyByRef(segment);
  return company && (await canSeeCompany(userId, company)) ? company : null;
}

export type MergeScreen = {
  plan: MergePlan;
  /** Which choices this person may make — the screen says so rather than failing at the end. */
  may: { reassign: boolean; overrideCredit: boolean };
};

/**
 * The merge screen for a pair, or the one company when the other hasn't been picked yet. `keep` is
 * the company that stays.
 */
export async function getMergeScreen(keepRef: string, dropRef: string): Promise<ActionResult<MergeScreen>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };
  const [keep, drop] = await Promise.all([visibleCompany(user.id, keepRef), visibleCompany(user.id, dropRef)]);
  if (!keep || !drop) return { ok: false, error: "Company not found." };
  // As this person may see both companies and their people (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.3;
  // src/lib/companies/merge.ts): the pairs are still found on the real values, the screen shows them masked.
  const plan = await planMerge(keep.id, drop.id, user.id);
  if (!plan) return { ok: false, error: "Company not found." };

  const [reassign, overrideCredit, seesContacts, seesRestricted] = await Promise.all([
    can(user.id, "accounts.reassign"),
    hasEffectivePermission(user.id, "credit.override"),
    canViewContacts(user.id),
    seesResellerContactDetails(user.id),
  ]);
  // The same rule as the company page: without contacts.view nobody's details show, and a reseller's
  // end customer's show only with contacts.viewRestricted. The pairs are still listed, by name.
  const restricted = (await db.company.count({ where: { id: { in: [keep.id, drop.id] }, managedByResellerId: { not: null } } })) > 0;
  if (!seesContacts || (restricted && !seesRestricted)) {
    for (const s of [plan.keep, plan.drop]) s.contacts = s.contacts.map((c) => ({ ...c, email: null, phone: null }));
    plan.contactPairs = plan.contactPairs.map((p) => ({ ...p, reason: p.reason.startsWith("Same email") ? "Same email" : p.reason.replace(/ …\d+/, "") }));
  }
  return { ok: true, data: toPlain({ plan, may: { reassign, overrideCredit } }) };
}

const mergeSchema = z.object({
  keepId: z.string().max(100, tooLong(100)).min(1),
  dropId: z.string().max(100, tooLong(100)).min(1),
  choices: z.record(z.string().max(100, tooLong(100)), z.enum(["keep", "drop"])).default({}),
  combine: z.array(z.string().max(100, tooLong(100))).max(2000).default([]),
  /** The duplicate's name, typed — there is no undo. */
  confirmName: z.string().max(200, tooLong(200)),
});

export async function mergeCompanies(input: unknown): Promise<ActionResult<{ ref: string }>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };
  const parsed = mergeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { keepId, dropId, choices, combine, confirmName } = parsed.data;

  const [keep, drop] = await Promise.all([
    db.company.findUnique({ where: { id: keepId } }),
    db.company.findUnique({ where: { id: dropId } }),
  ]);
  if (!keep || !drop || !(await canSeeCompany(user.id, keep)) || !(await canSeeCompany(user.id, drop))) {
    return { ok: false, error: "Company not found — it may have been merged already." };
  }
  if (normalizeCompanyName(confirmName) !== normalizeCompanyName(drop.name)) {
    return { ok: false, error: `Type "${drop.name}" exactly to confirm — it is the company that will be removed.` };
  }

  // Choices that are changes in their own right need the right to make them on their own.
  const takes = (key: string) => choices[key] === "drop";
  if ((takes("ownerUserId") && drop.ownerUserId !== keep.ownerUserId) || (takes("assignedToUserId") && drop.assignedToUserId !== keep.assignedToUserId)) {
    if (!(await can(user.id, "accounts.reassign"))) return { ok: false, error: "Keeping the other company's account manager or caller is reassigning the account, which you can't do. Keep this one's." };
  }
  if (takes("creditLimit") && String(drop.creditLimit) !== String(keep.creditLimit) && !(await hasEffectivePermission(user.id, "credit.override"))) {
    return { ok: false, error: "Only someone who can set credit limits can keep the other company's limit." };
  }
  const keepRef = formatCompanyId(keep.companySeq);
  const dropRef = formatCompanyId(drop.companySeq);
  let termsDecision: Awaited<ReturnType<typeof checkTerms>> | null = null;
  if (takes("paymentTerms") && drop.paymentTerms !== keep.paymentTerms) {
    termsDecision = await checkTerms({
      userId: user.id,
      companyId: keep.id,
      relationshipType: keep.relationshipType,
      terms: drop.paymentTerms,
      previousTerms: keep.paymentTerms,
      reason: `Kept from ${dropRef} ${drop.name} when it was merged into ${keepRef}.`,
      subject: "Default terms",
    });
    if (!termsDecision.ok) return { ok: false, error: termsDecision.error };
  }

  let outcome: Awaited<ReturnType<typeof executeMerge>>;
  try {
    outcome = await executeMerge({ keepId, dropId, choices, combine, userId: user.id });
  } catch (err) {
    if (err instanceof MergeRefused) return { ok: false, error: err.message };
    throw err;
  }

  const movedCount = outcome.moved.reduce((t, m) => t + m.count, 0);
  const merged = await db.company.findUnique({ where: { id: keep.id }, select: { name: true, companySeq: true, ownerUserId: true } });
  const label = merged?.name ?? keep.name;
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "Company", entityId: drop.id, entityLabel: `${dropRef} ${drop.name} — merged into ${keepRef}` });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: keep.id, entityLabel: `${label} — ${dropRef} ${drop.name} merged into it, ${movedCount} records moved` });
  if (termsDecision?.ok && termsDecision.decision) await recordDecision({ userId: user.id, companyId: keep.id, kind: "TERMS", ...termsDecision.decision });

  // The rating came from half the payment history; work it out again from all of it now.
  await cacheAssessments(await assessCompanies([keep.id])).catch((err) => console.error("re-rating after merge failed", err));

  // Whoever looked after the duplicate hears where it went — it has vanished from their list.
  const told = new Set([user.id]);
  for (const person of [drop.ownerUserId, drop.assignedToUserId, merged?.ownerUserId]) {
    if (!person || told.has(person)) continue;
    told.add(person);
    await notifyUser({
      userId: person,
      type: "ACCOUNT_MANAGER_ASSIGNED",
      title: `${dropRef} ${drop.name} was merged into ${keepRef} ${label}`,
      message: `${dropRef} was a duplicate of ${keepRef}. Its contacts, leads, orders, invoices, tickets and everything else are under ${label} now, and its old links open it.`,
      link: companyPath(keep.companySeq),
    });
  }

  revalidatePath("/companies");
  revalidatePath("/customers");
  revalidatePath("/vendors");
  revalidatePath("/resellers");
  revalidatePath("/commission-parties");
  revalidatePath("/companies/duplicates");
  revalidatePath(`/companies/${keepRef}`);
  return { ok: true, data: { ref: keepRef } };
}

// ─── The duplicates list ─────────────────────────────────────────────────────

export type DuplicateRow = {
  strength: "strong" | "likely";
  reasons: string[];
  /**
   * Merged with the rest in one go (src/lib/companies/bulk-merge.ts): a strong match with no business on either. Else
   * "business" — orders, documents, payments or ledger entries on one — or "likely", a weaker match: a person's.
   */
  bulk: true | "business" | "likely";
  /** The one suggested to keep first: more history under it, else the older record. */
  companies: {
    id: string;
    ref: string;
    name: string;
    kind: string;
    place: string | null;
    manager: string | null;
    records: number;
    /** Where it came from (src/lib/companies/origins.ts): Zoho Books, the old CRM, both, or neither (made in Deskzo). */
    fromZoho: boolean;
    fromOldCrm: boolean;
    /** Zoho Books invoices under it — the one with them is suggested to keep. */
    zohoInvoices: number;
  }[];
};

/** Business on a company: any of these, and merging it is a person's decision (src/lib/companies/bulk-merge.ts). */
const BUSINESS_RELATIONS = [
  "products", "vendorOrders", "quotedOrders", "pendingVendorOrders", "ordersAsEndCustomer", "tradeDocuments", "payments",
  "journalEntries", "journalLines", "accountVouchers", "vendorCredits", "vendorStatements", "stockDocuments", "expenses",
  "revenueSchedules", "accountingSchedules", "tdsCertificates", "commissionsPaid", "rebatesPayable",
] as const;

/**
 * Of these companies, the ones with any business on them — one query of "is there any" a few thousand at a time, rather
 * than counting each kind for every company in the book (46,000 of them, owner's workspace, 13 Nov 2026). Documents kept
 * from an old system count too, by the company Deskzo has them under.
 */
async function withBusiness(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const any = BUSINESS_RELATIONS.map((r) => ({ [r]: { some: {} } })) as Prisma.CompanyWhereInput[];
  for (let i = 0; i < ids.length; i += 5000) {
    const chunk = ids.slice(i, i + 5000);
    const [busy, archived] = await Promise.all([
      db.company.findMany({ where: { id: { in: chunk }, OR: any }, select: { id: true } }),
      db.archivedDocument.findMany({ where: { companyId: { in: chunk } }, distinct: ["companyId"], select: { companyId: true } }).catch(() => []),
    ]);
    for (const c of busy) out.add(c.id);
    for (const a of archived) if (a.companyId) out.add(a.companyId);
  }
  return out;
}

/**
 * Every likely pair among the companies this person can see, with what's under each — the list and the bulk merge
 * read the same.
 */
async function duplicatesFor(userId: string) {
  const user = { id: userId };
  const [companies, dismissals] = await Promise.all([
    db.company.findMany({
      where: await companyScope(user.id),
      select: {
        id: true,
        companySeq: true,
        name: true,
        relationshipType: true,
        managedByResellerId: true,
        panNumber: true,
        website: true,
        owner: { select: { name: true } },
        locations: { select: { gstNumber: true, city: true, isPrimary: true } },
        contacts: { select: { email: true, phone: true } },
        _count: { select: { contacts: true, leads: true, products: true, tradeDocuments: true, payments: true, tickets: true } },
      },
    }),
    db.companyDuplicateDismissal.findMany({ select: { companyAId: true, companyBId: true } }),
  ]);

  const candidates: DuplicateCandidate[] = companies.map((c) => {
    const domains = new Set<string>();
    const site = c.website ? domainOf(c.website) : null;
    if (site) domains.add(site);
    for (const x of c.contacts) {
      const d = x.email ? domainOf(x.email) : null;
      if (d && !isFreeMailbox(d)) domains.add(d);
    }
    return {
      id: c.id,
      name: c.name,
      family: companyFamily(c.relationshipType),
      managedByResellerId: c.managedByResellerId,
      gstins: [...new Set(c.locations.map((l) => l.gstNumber?.trim().toUpperCase()).filter((g): g is string => !!g))],
      pan: c.panNumber?.trim().toUpperCase() || null,
      domains: [...domains],
      phones: [...new Set(c.contacts.map((x) => (x.phone ? phoneKey(x.phone) : null)).filter((p): p is string => !!p))],
    };
  });

  // The pairs are found on the real values, here on the server; what the list says of them is what this person may see
  // (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.1/H.4.3): a GSTIN, PAN or city as the companies policy shows
  // it in a list, and a shared email domain or phone's last four left unsaid where the website or a contact's address,
  // or the number, is masked for them (src/lib/companies/masking.ts, src/lib/contacts/masking.ts) — as the merge screen
  // already does for somebody without contacts.view. The reasons named them all in full.
  const [shown, people] = await Promise.all([companyMasker(user.id, "list"), maskedInLists(user.id)]);

  const every = duplicatePairs(candidates, new Set(dismissals.map((d) => pairKey(d.companyAId, d.companyBId))));

  // Business looked up only for companies in a strong pair: a weaker one is a person's either way.
  const busy = await withBusiness([...new Set(every.filter((p) => p.strength === "strong").flatMap((p) => [p.aId, p.bId]))]);
  // Where each came from, and its Zoho Books invoices — the one with them is kept (owner, 14 Nov 2026).
  const origins = await companyOrigins();
  const subjects = new Map<string, BulkSubject>(
    companies.map((c) => [
      c.id,
      { id: c.id, companySeq: c.companySeq, business: busy.has(c.id) ? 1 : 0, records: Object.values(c._count).reduce((t, n) => t + n, 0), zohoInvoices: origins.of(c.id).zohoInvoices },
    ]),
  );
  const byId = new Map(companies.map((c) => [c.id, c]));
  return { companies, every, subjects, byId, shown, people, origins };
}

/** Likely duplicates among the companies this person can see, strongest first. */
/**
 * `q`: only pairs where either company's name or reference has these words (owner, 13 Nov 2026: "why isn't this
 * duplicate showing" — the list stopped at 300, and the browser's find can't see past a page). `page` and
 * `pageSize`: a page of what's left, the likeliest first. Left out, the first page of every pair.
 */
export async function listDuplicates(
  params: { q?: string; page?: number; pageSize?: number; group?: string; noOrders?: boolean } = {},
): Promise<
  ActionResult<{
    rows: DuplicateRow[];
    scanned: number;
    total: number;
    page: number;
    pageSize: number;
    /** Pairs the bulk merge would take. */
    bulk: number;
    /** Every pair in each group, and those where neither company has an order, invoice or payment. */
    counts: Record<DuplicateGroup, { all: number; noOrders: number }>;
    group: DuplicateGroup | null;
    noOrders: boolean;
  }>
> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };
  const { companies, every, subjects, byId, shown, people, origins } = await duplicatesFor(user.id);
  const reasonAsSeen = (reason: string) => {
    if (!shown.active && !people.email && !people.phone) return reason;
    const gstin = /^Same GSTIN (.+)$/.exec(reason);
    if (gstin) return `Same GSTIN ${shown.location({ gstNumber: gstin[1]! }).gstNumber}`;
    const pan = /^Same PAN (.+)$/.exec(reason);
    if (pan) return `Same PAN ${shown.present("pan", pan[1]!) ?? ""}`;
    if (reason.startsWith("Same email domain") && (people.email || shown.flags.website)) return "Same email domain";
    if (reason.startsWith("Same phone number") && people.phone) return "Same phone number";
    return reason;
  };

  const records = (c: (typeof companies)[number]) => subjects.get(c.id)!.records;

  // Which of the four groups each pair is in (src/lib/companies/duplicate-groups.ts, as the panel above counts them), and
  // whether either company has money on it — an order (its own, or one a reseller placed for it), a sales or purchase
  // document, or a payment (owner, 14 Nov 2026: "how do I identify what all records fall under these … companies with
  // no orders are no risk to merge"). `group` and `noOrders` narrow the list to them.
  const gstinsOf = (id: string) => [
    ...new Set((byId.get(id)?.locations ?? []).map((l) => l.gstNumber?.trim().toUpperCase()).filter((g): g is string => !!g)),
  ];
  const boughtFor = new Set(
    (await db.companyProduct.groupBy({ by: ["endCustomerId"], where: { endCustomerId: { not: null } } })).map((r) => r.endCustomerId!),
  );
  const hasMoney = (c: (typeof companies)[number]) => c._count.products + c._count.tradeDocuments + c._count.payments > 0 || boughtFor.has(c.id);
  const noMoney = (p: (typeof every)[number]) => !hasMoney(byId.get(p.aId)!) && !hasMoney(byId.get(p.bId)!);
  const counts = Object.fromEntries(DUPLICATE_GROUPS.map((g) => [g, { all: 0, noOrders: 0 }])) as Record<DuplicateGroup, { all: number; noOrders: number }>;
  const grouped = every.map((p) => {
    const g = groupOf(p, gstinsOf);
    const free = noMoney(p);
    counts[g].all += 1;
    if (free) counts[g].noOrders += 1;
    return { p, g, free };
  });
  const group = (DUPLICATE_GROUPS as readonly string[]).includes(String(params.group ?? "")) ? (params.group as DuplicateGroup) : null;
  const noOrders = params.noOrders === true;
  const pool = grouped.filter((x) => (!group || x.g === group) && (!noOrders || x.free)).map((x) => x.p);

  const summary = (c: (typeof companies)[number]) => {
    const primary = c.locations.find((l) => l.isPrimary) ?? c.locations[0];
    return {
      id: c.id,
      ref: formatCompanyId(c.companySeq),
      name: c.name,
      kind: c.relationshipType.charAt(0) + c.relationshipType.slice(1).toLowerCase().replace(/_/g, " "),
      place: primary ? shown.location({ city: primary.city }).city : null,
      manager: c.owner?.name ?? null,
      records: records(c),
      fromZoho: origins.of(c.id).zoho,
      fromOldCrm: origins.of(c.id).oldCrm,
      zohoInvoices: origins.of(c.id).zohoInvoices,
    };
  };
  // Searched by name or reference — either company of the pair, every word, in any order, any capitals.
  const words = String(params.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const matches = (c: (typeof companies)[number]) => {
    const text = `${c.name} ${formatCompanyId(c.companySeq)}`.toLowerCase();
    return words.every((w) => text.includes(w));
  };
  const pairs = words.length ? pool.filter((p) => matches(byId.get(p.aId)!) || matches(byId.get(p.bId)!)) : pool;
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(params.pageSize) || 50)));
  const lastPage = Math.max(1, Math.ceil(pairs.length / pageSize));
  const page = Math.min(lastPage, Math.max(1, Math.floor(Number(params.page) || 1)));
  const rows = pairs.slice((page - 1) * pageSize, page * pageSize).map((p) => {
    const [a, b] = [byId.get(p.aId)!, byId.get(p.bId)!];
    // The one with Zoho Books invoices first — suggested to keep — else more under it, else the older (owner, 14 Nov 2026).
    // Both with them (owner, 18 Nov 2026: "when both have Zoho invoices, show which to keep"): the one with more of them,
    // then the same rules. A pair that merges with the rest shows the one the bulk merge keeps (keeperOf), whatever this says.
    const zoho = zohoInvoicesFirst(subjects.get(a.id)!, subjects.get(b.id)!);
    const [za, zb] = [subjects.get(a.id)!.zohoInvoices ?? 0, subjects.get(b.id)!.zohoInvoices ?? 0];
    const verdict = bulkVerdict(p, subjects.get(a.id)!, subjects.get(b.id)!);
    const aFirst = verdict.ok
      ? keeperOf(subjects.get(a.id)!, subjects.get(b.id)!).keep.id === a.id
      : zoho !== 0
        ? zoho < 0
        : za !== zb
          ? za > zb
          : records(a) !== records(b)
            ? records(a) > records(b)
            : a.companySeq < b.companySeq;
    return { strength: p.strength, reasons: p.reasons.map(reasonAsSeen), bulk: verdict.ok ? (true as const) : verdict.why, companies: (aFirst ? [a, b] : [b, a]).map(summary) };
  });
  const bulk = every.filter((p) => bulkVerdict(p, subjects.get(p.aId)!, subjects.get(p.bId)!).ok).length;
  return { ok: true, data: toPlain({ rows, scanned: companies.length, total: pairs.length, page, pageSize, bulk, counts, group, noOrders }) };
}

/** "These two are not the same company" — the list stops offering the pair. */
export async function dismissDuplicate(aId: string, bId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };
  if (typeof aId !== "string" || typeof bId !== "string" || aId === bId) return { ok: false, error: "Pick two companies." };
  const [a, b] = await Promise.all([visibleCompany(user.id, aId), visibleCompany(user.id, bId)]);
  if (!a || !b) return { ok: false, error: "Company not found." };
  const [companyAId, companyBId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  await db.companyDuplicateDismissal.upsert({
    where: { companyAId_companyBId: { companyAId, companyBId } },
    create: { companyAId, companyBId, dismissedById: user.id },
    update: {},
  });
  revalidatePath("/companies/duplicates");
  return { ok: true, data: null };
}

/** Bulk merges in this workspace in the last day, from the audit log (each merge writes one "in a bulk merge" DELETE). */
async function bulkMergedToday(): Promise<number> {
  return db.auditLog.count({ where: { action: "DELETE", entityType: "Company", entityLabel: { contains: "in a bulk merge" }, createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
}

/**
 * What the bulk merge would do, before it does it (security audit round three, 14 Nov 2026 — R3-24): how many pairs
 * it would take, the workspace's name the person types to confirm, and how many it may still merge today.
 */
export async function bulkMergePreview(): Promise<ActionResult<{ count: number; confirmWith: string; perCall: number; leftToday: number }>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };
  const { every, subjects } = await duplicatesFor(user.id);
  const count = every.filter((p) => subjects.has(p.aId) && subjects.has(p.bId) && bulkVerdict(p, subjects.get(p.aId)!, subjects.get(p.bId)!).ok).length;
  return { ok: true, data: { count, confirmWith: (await currentTenant()).name, perCall: BULK_PER_CALL, leftToday: Math.max(0, BULK_PER_DAY - (await bulkMergedToday())) } };
}

/**
 * Merges, in one go, the pairs a person needn't weigh (owner, 13 Nov 2026 — src/lib/companies/bulk-merge.ts): a pair
 * sharing a GSTIN or PAN with no business on either. A batch a press; the page presses again until none are left. Each
 * merge as the merge screen would make it with its suggestions — blanks filled from the duplicate, the people both have
 * combined — except what is a decision of its own (the account manager, the caller, the credit limit, the terms, the
 * name), which stays the kept one's. Audited one by one.
 *
 * Security audit round three, 14 Nov 2026 (R3-24): it was one irreversible click over the whole workspace, name-only
 * matches included. Now a name-only match is left for a person (`sharesTaxId`); the person types the workspace's name
 * (`confirm`, checked here on every batch); at most `BULK_PER_CALL` a press and `BULK_PER_DAY` a day; never while
 * viewing as somebody; and whoever looked after a merged company is told, once a batch with every one of theirs.
 */
export async function bulkMergeDuplicates(
  options: {
    /** The workspace's name, as typed by the person to confirm. */
    confirm?: string;
    /** Only pairs of these companies — a check runs it over its own few, leaving the rest alone. */
    among?: string[];
  } = {},
): Promise<ActionResult<{ merged: number; skipped: { name: string; why: string }[]; left: number }>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const workspace = (await currentTenant()).name;
  if (!bulkConfirmMatches(options?.confirm, workspace)) return { ok: false, error: `Type the workspace's name, "${workspace}", to confirm — a merge can't be undone.` };
  const leftToday = BULK_PER_DAY - (await bulkMergedToday());
  if (leftToday <= 0) return { ok: false, error: `${BULK_PER_DAY} pairs have been merged in bulk in the last day, the most a day takes. The rest can wait until tomorrow, or be merged one by one.` };
  const loaded = await duplicatesFor(user.id);
  const among = Array.isArray(options.among) ? new Set(options.among.filter((x) => typeof x === "string")) : null;
  const every = among ? loaded.every.filter((p) => among.has(p.aId) && among.has(p.bId)) : loaded.every;
  const { subjects, byId } = loaded;
  const batch = bulkBatch(every, subjects, Math.min(BULK_PER_CALL, leftToday));
  // Who looks after each company in the batch, read before any is merged: they're told afterwards.
  const keepers = new Map(
    (await db.company.findMany({ where: { id: { in: batch.flatMap((b) => [b.keepId, b.dropId]) } }, select: { id: true, ownerUserId: true, assignedToUserId: true } })).map((c) => [c.id, [c.ownerUserId, c.assignedToUserId]]),
  );
  const tell = new Map<string, string[]>();
  let merged = 0;
  const skipped: { name: string; why: string }[] = [];
  for (const { keepId, dropId } of batch) {
    const keep = byId.get(keepId)!;
    const drop = byId.get(dropId)!;
    const plan = await planMerge(keepId, dropId);
    if (!plan) continue;
    if (plan.blockers.length) {
      skipped.push({ name: drop.name, why: plan.blockers[0]! });
      continue;
    }
    const choices = Object.fromEntries(plan.fields.map((f) => [f.key, BULK_NEVER_FROM_DUPLICATE.has(f.key) ? "keep" : f.suggested])) as Record<string, "keep" | "drop">;
    try {
      const outcome = await executeMerge({ keepId, dropId, choices, combine: plan.contactPairs.map((p) => p.id), userId: user.id });
      merged += 1;
      const keepRef = formatCompanyId(keep.companySeq);
      const dropRef = formatCompanyId(drop.companySeq);
      const movedCount = outcome.moved.reduce((t, m) => t + m.count, 0);
      await recordAudit({ userId: user.id, action: "DELETE", entityType: "Company", entityId: drop.id, entityLabel: `${dropRef} ${drop.name} — merged into ${keepRef} in a bulk merge` });
      await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: keep.id, entityLabel: `${keep.name} — ${dropRef} ${drop.name} merged into it in a bulk merge, ${movedCount} records moved` });
      for (const person of new Set([...(keepers.get(dropId) ?? []), ...(keepers.get(keepId) ?? [])])) {
        if (!person || person === user.id) continue;
        tell.set(person, [...(tell.get(person) ?? []), `${dropRef} ${drop.name} → ${keepRef} ${keep.name}`]);
      }
    } catch (err) {
      if (err instanceof MergeRefused) skipped.push({ name: drop.name, why: err.message });
      else throw err;
    }
  }
  // One notice a person a batch, listing every merge that touched a company they look after.
  for (const [person, lines] of tell) {
    await notifyUser({
      userId: person,
      type: "ACCOUNT_MANAGER_ASSIGNED",
      title: lines.length === 1 ? `A company you look after was merged: ${lines[0]}` : `${lines.length} companies you look after were merged as duplicates`,
      message: `${user.name ?? "Somebody"} merged duplicates in bulk. ${lines.slice(0, 10).join("; ")}${lines.length > 10 ? `; and ${lines.length - 10} more` : ""}. Everything under each is under the one kept now, and old links open it.`,
      link: "/companies",
    });
  }
  if (merged > 0) {
    revalidatePath("/companies");
    revalidatePath("/customers");
    revalidatePath("/vendors");
    revalidatePath("/companies/duplicates");
  }
  // What's still for the bulk merge, counted again after this batch: a skipped pair is left for a person.
  const left = Math.max(0, every.filter((p) => subjects.has(p.aId) && subjects.has(p.bId) && bulkVerdict(p, subjects.get(p.aId)!, subjects.get(p.bId)!).ok).length - merged - skipped.length);
  return { ok: true, data: { merged, skipped, left } };
}
