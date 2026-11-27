import { db } from "@/lib/db";
import { indiaClock } from "@/lib/time/zone";
import { rateText, sectionByKey, sectionOf, TDS_SECTIONS } from "./sections";
import { deducteeKind, deducteeKindLabels, noPanRate, tdsAdvice, taxYearStart, validPan, type DeducteeKind, type TdsAdvice, type TdsCertificateFacts, type TdsSection } from "./rules";

/**
 * What TDS advice reads from the books (src/lib/tds/rules.ts): a vendor's PAN, its usual section, the
 * certificate it holds, and its bills so far this tax year. A bill counts under a section when it was deducted
 * under it, or — deducted under nothing — when it is the vendor's usual section: a bill below the limit
 * deducts nothing and names no section, and still counts towards the limit.
 */

const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (key: string) => new Date(`${key}T00:00:00Z`);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const nextYear = (start: string) => `${Number(start.slice(0, 4)) + 1}-04-01`;

type Bill = { id: string; issueDate: Date; taxableValue: number; withholdingAmount: number; withholdingSection: string | null };

async function yearBills(companyId: string, onDay: string, excludeDocumentId?: string | null): Promise<Bill[]> {
  const start = taxYearStart(onDay);
  const rows = await db.tradeDocument.findMany({
    where: {
      companyId,
      docType: "BILL",
      status: { notIn: ["DRAFT", "CANCELLED"] },
      issueDate: { gte: asDate(start), lt: asDate(nextYear(start)) },
      ...(excludeDocumentId ? { id: { not: excludeDocumentId } } : {}),
    },
    select: { id: true, issueDate: true, taxableValue: true, withholdingAmount: true, withholdingSection: true },
  });
  return rows.map((r) => ({ ...r, taxableValue: Number(r.taxableValue), withholdingAmount: Number(r.withholdingAmount) }));
}

/** The section a bill counts under: its own, else the vendor's usual one when the bill deducted nothing. */
function countsUnder(bill: Bill, usual: string | null): string | null {
  if (bill.withholdingSection?.trim()) return sectionOf(bill.withholdingSection)?.key ?? null;
  return bill.withholdingAmount === 0 ? usual : null;
}

export type VendorTdsFacts = {
  pan: string | null;
  kind: DeducteeKind;
  usualSectionKey: string | null;
};

export async function vendorTdsFacts(companyId: string): Promise<VendorTdsFacts | null> {
  const [company, usual] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: { panNumber: true } }),
    db.vendorTds.findUnique({ where: { companyId }, select: { sectionKey: true } }).catch(() => null),
  ]);
  if (!company) return null;
  const pan = validPan(company.panNumber);
  return { pan, kind: deducteeKind(pan), usualSectionKey: usual?.sectionKey ?? null };
}

/**
 * The advice for a bill to this vendor: under the section given, else its usual one; null when neither is a
 * known section. `excludeDocumentId` leaves out the bill being edited, so it isn't counted twice.
 */
export async function billTdsAdvice(input: {
  companyId: string;
  sectionKey?: string | null;
  amount: number;
  day: string;
  excludeDocumentId?: string | null;
}): Promise<{ section: TdsSection; advice: TdsAdvice; facts: VendorTdsFacts; yearSoFar: number } | null> {
  const facts = await vendorTdsFacts(input.companyId);
  if (!facts) return null;
  const section = sectionByKey(input.sectionKey) ?? sectionOf(input.sectionKey ?? "") ?? sectionByKey(facts.usualSectionKey);
  if (!section) return null;
  const bills = (await yearBills(input.companyId, input.day, input.excludeDocumentId)).filter((b) => countsUnder(b, facts.usualSectionKey) === section.key);
  const yearSoFar = round2(bills.reduce((t, b) => t + b.taxableValue, 0));
  const deductedSoFar = round2(bills.reduce((t, b) => t + (b.withholdingAmount < 0 ? -b.withholdingAmount : 0), 0));

  const certificate = await db.tdsCertificate
    .findFirst({
      where: { companyId: input.companyId, sectionKey: section.key, validFrom: { lte: asDate(input.day) }, validTo: { gte: asDate(input.day) } },
      orderBy: { validTo: "desc" },
      select: { certificateNo: true, ratePercent: true, amountLimit: true, validFrom: true, validTo: true },
    })
    .catch(() => null);
  let certificateFacts: TdsCertificateFacts | null = null;
  if (certificate) {
    const from = day(certificate.validFrom);
    const to = day(certificate.validTo);
    const used = bills.filter((b) => day(b.issueDate) >= from && day(b.issueDate) <= to && b.withholdingAmount < 0).reduce((t, b) => t + b.taxableValue, 0);
    certificateFacts = {
      certificateNo: certificate.certificateNo,
      ratePercent: Number(certificate.ratePercent),
      amountLimit: certificate.amountLimit === null ? null : Number(certificate.amountLimit),
      usedSoFar: round2(used),
      validFrom: from,
      validTo: to,
    };
  }

  const advice = tdsAdvice({ section, pan: facts.pan, certificate: certificateFacts, amount: input.amount, yearSoFar, deductedSoFar, day: input.day });
  return { section, advice, facts, yearSoFar };
}

export type VendorYearRow = { section: TdsSection; taxable: number; deducted: number; overLimit: boolean; shortfall: number };

/**
 * One vendor's tax year, section by section, from its bills: what it was billed, what was deducted, whether a
 * limit was crossed, and what should have been deducted and wasn't. A certificate the vendor held in the year
 * for a section is taken at its rate, so a nil certificate owes nothing.
 */
function yearRowsOf(bills: Bill[], facts: VendorTdsFacts, certificateRates: ReadonlyMap<string, number>): VendorYearRow[] {
  const rows: VendorYearRow[] = [];
  for (const section of TDS_SECTIONS) {
    const mine = bills.filter((b) => countsUnder(b, facts.usualSectionKey) === section.key);
    if (mine.length === 0) continue;
    const taxable = round2(mine.reduce((t, b) => t + b.taxableValue, 0));
    const deducted = round2(mine.reduce((t, b) => t + (b.withholdingAmount < 0 ? -b.withholdingAmount : 0), 0));
    const overYear = section.yearLimit !== null && taxable > section.yearLimit;
    const overSingle = section.singleLimit !== null && mine.some((b) => b.taxableValue > section.singleLimit!);
    const unlimited = section.yearLimit === null && section.singleLimit === null;
    const overLimit = overYear || overSingle || unlimited;
    const normal = facts.kind === "INDIVIDUAL_HUF" ? section.rate.individualHuf : section.rate.other;
    const certificate = certificateRates.get(section.key);
    const rate = !facts.pan ? noPanRate(section, normal) : certificate !== undefined ? Math.min(certificate, normal) : normal;
    // What TDS was owed on: the part over the year's limit (goods); the whole year once its limit is crossed, or
    // when the section has none; else only the single payments over the single limit.
    const base =
      section.excessOnly && section.yearLimit !== null
        ? Math.max(0, taxable - section.yearLimit)
        : overYear || unlimited
          ? taxable
          : mine.filter((b) => b.taxableValue > (section.singleLimit ?? Infinity)).reduce((t, b) => t + b.taxableValue, 0);
    const shortfall = overLimit ? Math.max(0, round2((base * rate) / 100 - deducted)) : 0;
    rows.push({ section, taxable, deducted, overLimit, shortfall });
  }
  return rows;
}

/** The lowest rate of each section's certificates a vendor held at any time in the tax year. */
async function yearCertificateRates(companyIds: string[], onDay: string): Promise<Map<string, Map<string, number>>> {
  const start = taxYearStart(onDay);
  const rows = await db.tdsCertificate
    .findMany({
      where: { companyId: { in: companyIds }, validFrom: { lt: asDate(nextYear(start)) }, validTo: { gte: asDate(start) } },
      select: { companyId: true, sectionKey: true, ratePercent: true },
    })
    .catch(() => []);
  const byCompany = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const rates = byCompany.get(r.companyId) ?? new Map<string, number>();
    rates.set(r.sectionKey, Math.min(rates.get(r.sectionKey) ?? Infinity, Number(r.ratePercent)));
    byCompany.set(r.companyId, rates);
  }
  return byCompany;
}

/** A vendor's tax year so far, section by section — for its TDS card. */
export async function vendorTaxYear(companyId: string, onDay: string): Promise<VendorYearRow[]> {
  const facts = await vendorTdsFacts(companyId);
  if (!facts) return [];
  const [bills, certificates] = await Promise.all([yearBills(companyId, onDay), yearCertificateRates([companyId], onDay)]);
  return yearRowsOf(bills, facts, certificates.get(companyId) ?? new Map());
}

export type TdsShortfall = { companyId: string; companySeq: number; companyName: string; section: TdsSection; taxable: number; deducted: number; shortfall: number };

/**
 * Every vendor this tax year with TDS that should have been deducted and wasn't — past a limit, or under a
 * section with none — largest first. One read of the year's bills, for the TDS page.
 */
export async function taxYearShortfalls(onDay: string): Promise<TdsShortfall[]> {
  const start = taxYearStart(onDay);
  const bills = await db.tradeDocument.findMany({
    where: { docType: "BILL", status: { notIn: ["DRAFT", "CANCELLED"] }, issueDate: { gte: asDate(start), lt: asDate(nextYear(start)) } },
    select: { id: true, companyId: true, issueDate: true, taxableValue: true, withholdingAmount: true, withholdingSection: true, company: { select: { name: true, panNumber: true, companySeq: true } } },
  });
  const companyIds = [...new Set(bills.map((b) => b.companyId))];
  if (companyIds.length === 0) return [];
  const [usual, certificates] = await Promise.all([
    db.vendorTds.findMany({ where: { companyId: { in: companyIds } }, select: { companyId: true, sectionKey: true } }).catch(() => []),
    yearCertificateRates(companyIds, onDay),
  ]);
  const usualOf = new Map(usual.map((u) => [u.companyId, u.sectionKey]));
  const out: TdsShortfall[] = [];
  for (const companyId of companyIds) {
    const mine = bills.filter((b) => b.companyId === companyId);
    const pan = validPan(mine[0]!.company.panNumber);
    const facts: VendorTdsFacts = { pan, kind: deducteeKind(pan), usualSectionKey: usualOf.get(companyId) ?? null };
    const rows = yearRowsOf(
      mine.map((b) => ({ id: b.id, issueDate: b.issueDate, taxableValue: Number(b.taxableValue), withholdingAmount: Number(b.withholdingAmount), withholdingSection: b.withholdingSection })),
      facts,
      certificates.get(companyId) ?? new Map(),
    );
    for (const r of rows) {
      if (r.shortfall > 0) out.push({ companyId, companySeq: mine[0]!.company.companySeq, companyName: mine[0]!.company.name, section: r.section, taxable: r.taxable, deducted: r.deducted, shortfall: r.shortfall });
    }
  }
  return out.sort((a, b) => b.shortfall - a.shortfall);
}

/** What a vendor's TDS card shows (src/components/companies/vendor-tds-card.tsx). Null for a company that isn't there. */
export async function vendorTdsCardData(companyId: string) {
  const today = indiaClock.today();
  const [facts, certificates, year] = await Promise.all([
    vendorTdsFacts(companyId),
    // A workspace whose database hasn't these tables yet shows the card without them.
    db.tdsCertificate.findMany({ where: { companyId }, orderBy: { validTo: "desc" } }).catch(() => []),
    vendorTaxYear(companyId, today).catch(() => []),
  ]);
  if (!facts) return null;
  const start = taxYearStart(today);
  return {
    pan: facts.pan,
    kindLabel: facts.pan ? deducteeKindLabels[facts.kind] : "",
    usualSectionKey: facts.usualSectionKey,
    sections: TDS_SECTIONS.map((s) => ({ key: s.key, label: s.label, oldSection: s.oldSection, rates: rateText(s) })),
    certificates: certificates.map((c) => ({
      id: c.id,
      sectionKey: c.sectionKey,
      certificateNo: c.certificateNo,
      ratePercent: Number(c.ratePercent),
      amountLimit: c.amountLimit === null ? null : Number(c.amountLimit),
      validFrom: day(c.validFrom),
      validTo: day(c.validTo),
    })),
    year: year.map((r) => ({ sectionKey: r.section.key, taxable: r.taxable, deducted: r.deducted, overLimit: r.overLimit, shortfall: r.shortfall })),
    taxYearLabel: `${start.slice(0, 4)}-${String((Number(start.slice(2, 4)) + 1) % 100).padStart(2, "0")}`,
  };
}
