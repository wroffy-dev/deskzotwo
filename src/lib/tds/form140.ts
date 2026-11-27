import { db } from "@/lib/db";
import { RAISED_IN_DESKZO } from "@/lib/documents/imported";
import { getOrganisation } from "@/lib/organisation";
import { indiaClock } from "@/lib/time/zone";
import { challanCin, challanSectionNumber } from "./challan-rules";
import { form140Problems, form140SectionCode, form140StateCode, form140Text, quarterLabel, quarterRange, type Form140, type Form140Challan, type Form140Deductee } from "./form140-format";
import { deducteeKind, noPanRate, validPan } from "./rules";
import { sectionByKey, sectionOf } from "./sections";

/**
 * A quarter's Form 140 from the books (owner, 26 Oct 2026; the file's format is form140-format.ts):
 *
 *   · **Who deducted**: the organisation (Settings › Organisation) — name, PAN, address, email, phone — and
 *     the TDS statement details: TAN, what kind of deductor, the person responsible.
 *   · **What was deducted**: every vendor bill dated in the quarter with TDS on it, under the challan that paid
 *     it. A bill on no challan stops the file: the statement says each deduction was deposited, and where.
 *   · **How**: its section's code (a contractor's by who the contractor is); the PAN, or PANNOTAVBL — then flag C,
 *     the higher rate; a lower rate under a certificate the vendor held — flag A and its number. A bill a nil
 *     certificate let go untaxed is reported too, under a nil challan.
 *   · **Goods** (194Q) deduct only on what is over ₹50 lakh: the amount reported is that part, so the rate holds.
 *   · **The previous statement**: once one has been filed, the next quotes its token number — kept here when it
 *     is entered, or typed for one filed elsewhere.
 *
 * Bills brought over from another system (src/lib/documents/imported.ts) were reported from there, as the TDS
 * page's figures leave them out.
 */

const asDate = (key: string) => new Date(`${key}T00:00:00Z`);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export type TdsSettingsValues = {
  tan: string;
  deductorType: string;
  responsibleName: string;
  responsibleDesignation: string;
  responsiblePan: string;
  responsibleAddress: string;
  responsibleCity: string;
  responsibleState: string;
  responsiblePincode: string;
  responsibleEmail: string;
  responsiblePhone: string;
};

/** The statement details as kept; empty strings for what isn't yet. Null where the table isn't there yet. */
export async function tdsSettings(): Promise<TdsSettingsValues | null> {
  try {
    const row = await db.tdsSettings.findUnique({ where: { id: "global" } });
    return {
      tan: row?.tan ?? "",
      deductorType: row?.deductorType ?? "K",
      responsibleName: row?.responsibleName ?? "",
      responsibleDesignation: row?.responsibleDesignation ?? "",
      responsiblePan: row?.responsiblePan ?? "",
      responsibleAddress: row?.responsibleAddress ?? "",
      responsibleCity: row?.responsibleCity ?? "",
      responsibleState: row?.responsibleState ?? "",
      responsiblePincode: row?.responsiblePincode ?? "",
      responsibleEmail: row?.responsibleEmail ?? "",
      responsiblePhone: row?.responsiblePhone ?? "",
    };
  } catch {
    return null;
  }
}

/** The token number of the last statement filed before this quarter, and which quarter it was. */
async function previousFiled(taxYear: number, quarter: number) {
  const rows = await db.tdsStatement.findMany({ where: { formNumber: "140", tokenNumber: { not: null } }, select: { taxYear: true, quarter: true, tokenNumber: true } });
  const before = rows.filter((r) => r.taxYear * 4 + r.quarter < taxYear * 4 + quarter).sort((a, b) => b.taxYear * 4 + b.quarter - (a.taxYear * 4 + a.quarter));
  return before[0] ? { token: before[0].tokenNumber!, label: quarterLabel(before[0].taxYear, before[0].quarter) } : null;
}

export type Form140Summary = { challans: number; deductees: number; deducted: number; label: string; from: string; to: string };

/**
 * The quarter's statement as it stands: the statement itself, what stops it being made (each to fix), what is
 * worth a look but doesn't, and the figures. `previousToken` is one typed for a statement filed elsewhere;
 * without it, the last one kept here.
 */
export async function form140Statement(input: { taxYear: number; quarter: number; previousToken?: string | null; createdOn?: string }) {
  const quarter = Math.min(4, Math.max(1, Math.trunc(input.quarter))) as 1 | 2 | 3 | 4;
  const { taxYear } = input;
  const { from, to } = quarterRange(taxYear, quarter);
  const [y1, m1] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const start = indiaClock.midnight(y1, m1 - 1, 1);
  const end = indiaClock.midnight(y1, m1 + 2, 1);
  const problems: string[] = [];
  const warnings: string[] = [];

  const [settings, org, previous] = await Promise.all([tdsSettings(), getOrganisation(), previousFiled(taxYear, quarter).catch(() => null)]);
  if (!settings) return null;

  // Untaxed bills are read only for vendors a nil certificate covered in the quarter.
  const nilHolders = (
    await db.tdsCertificate.findMany({ where: { ratePercent: 0, validFrom: { lte: asDate(to) }, validTo: { gte: asDate(from) } }, select: { companyId: true } })
  ).map((c) => c.companyId);
  const bills = await db.tradeDocument.findMany({
    where: {
      docType: "BILL",
      status: { notIn: ["DRAFT", "CANCELLED"] },
      issueDate: { gte: start, lt: end },
      ...RAISED_IN_DESKZO,
      AND: [{ OR: [{ withholdingAmount: { lt: 0 } }, ...(nilHolders.length ? [{ withholdingAmount: 0, companyId: { in: nilHolders } }] : [])] }],
    },
    orderBy: [{ issueDate: "asc" }, { docNumber: "asc" }],
    select: {
      id: true, docNumber: true, issueDate: true, taxableValue: true, withholdingAmount: true, withholdingRatePercent: true, withholdingSection: true, withholdingMode: true, companyId: true,
      company: { select: { name: true, panNumber: true } },
      tdsChallanLink: { select: { amount: true, challan: { select: { id: true, sectionKey: true, majorHead: true, minorHead: true, bsrCode: true, challanSerial: true, paidOn: true, tax: true, interest: true, fee: true, others: true } } } },
    },
  });
  const companyIds = [...new Set(bills.map((b) => b.companyId))];
  const [certificates, usual] = await Promise.all([
    db.tdsCertificate.findMany({ where: { companyId: { in: companyIds }, validFrom: { lte: asDate(to) }, validTo: { gte: asDate(from) } }, select: { companyId: true, sectionKey: true, certificateNo: true, ratePercent: true, validFrom: true, validTo: true } }),
    db.vendorTds.findMany({ where: { companyId: { in: companyIds } }, select: { companyId: true, sectionKey: true } }),
  ]);
  const usualOf = new Map(usual.map((u) => [u.companyId, u.sectionKey]));
  const certificateFor = (companyId: string, sectionKey: string, day: string) =>
    certificates.filter((c) => c.companyId === companyId && c.sectionKey === sectionKey && dayOf(c.validFrom) <= day && dayOf(c.validTo) >= day).sort((a, b) => Number(a.ratePercent) - Number(b.ratePercent))[0] ?? null;

  const challans = new Map<string, Form140Challan>();
  const orderOf = new Map<string, string>();
  const nil: Form140Deductee[] = [];
  for (const bill of bills) {
    const day = indiaClock.dateKey(bill.issueDate);
    const tax = round2(-Number(bill.withholdingAmount));
    const taxable = round2(Number(bill.taxableValue));
    const pan = validPan(bill.company.panNumber);
    const panField = pan ?? (bill.company.panNumber?.trim() ? "PANINVALID" : "PANNOTAVBL");
    const kind = deducteeKind(pan);
    const link = bill.tdsChallanLink;

    if (tax === 0) {
      // Untaxed: reported only when a nil certificate the vendor held let it go (flag A, under a nil challan).
      const sectionKey = sectionOf(bill.withholdingSection)?.key ?? usualOf.get(bill.companyId) ?? null;
      const certificate = sectionKey ? certificateFor(bill.companyId, sectionKey, day) : null;
      if (!sectionKey || !certificate || Number(certificate.ratePercent) !== 0 || taxable <= 0) continue;
      const code = form140SectionCode(sectionKey, kind)!;
      nil.push({ pan: panField, name: bill.company.name, sectionCode: code, creditedOn: day, amountPaid: taxable, taxDeducted: 0, taxDeposited: 0, deductedOn: null, rate: 0, remark: "A", certificateNo: certificate.certificateNo, docNumber: bill.docNumber });
      continue;
    }

    if (!link) {
      problems.push(`${bill.docNumber} (${bill.company.name}, ${rupees(tax)} deducted on ${day}) is on no challan — record or link its challan under Deposits.`);
      continue;
    }
    const section = sectionOf(bill.withholdingSection) ?? sectionByKey(link.challan.sectionKey);
    if (!section) {
      problems.push(`${bill.docNumber}'s section isn't one the statement knows.`);
      continue;
    }
    const code = form140SectionCode(section.key, kind)!;
    if (!pan && section.key === "CONTRACTOR") warnings.push(`${bill.docNumber}: ${bill.company.name} has no PAN, so its contract is reported as one with a firm or company (1024), not an individual (1023).`);

    const normal = kind === "INDIVIDUAL_HUF" ? section.rate.individualHuf : section.rate.other;
    const applied = Number(bill.withholdingRatePercent);
    const certificate = pan ? certificateFor(bill.companyId, section.key, day) : null;
    let rate = applied;
    let amountPaid = taxable;
    if (section.excessOnly) {
      // Goods: the tax is on the part over the year's ₹50 lakh — reported as that part, at the section's rate.
      rate = !pan ? noPanRate(section, normal) : certificate ? Number(certificate.ratePercent) : normal;
      amountPaid = rate > 0 ? Math.min(taxable, round2((tax * 100) / rate)) : taxable;
    }
    let remark: string | null = null;
    let certificateNo: string | null = null;
    if (!pan) {
      remark = "C";
      if (rate + 0.0001 < noPanRate(section, normal)) warnings.push(`${bill.docNumber}: ${bill.company.name} has no PAN, but was deducted at ${rate}% — the rate without one is ${noPanRate(section, normal)}%.`);
    } else if (rate + 0.0001 < normal) {
      if (certificate && Number(certificate.ratePercent) <= rate + 0.0001) {
        remark = "A";
        certificateNo = certificate.certificateNo;
      } else warnings.push(`${bill.docNumber}: deducted at ${rate}%, less than ${section.oldSection}'s ${normal}%, with no lower deduction certificate on file for ${bill.company.name}.`);
    }

    const c = link.challan;
    const paidOn = dayOf(c.paidOn);
    if (!challans.has(c.id)) {
      orderOf.set(c.id, `${paidOn}|${c.bsrCode}|${c.challanSerial}`);
      challans.set(c.id, {
        nil: false,
        bsrCode: c.bsrCode,
        challanSerial: c.challanSerial,
        paidOn,
        minorHead: c.minorHead,
        tax: Number(c.tax),
        interest: Number(c.interest),
        fee: Number(c.fee),
        others: Number(c.others),
        deductees: [],
      });
    }
    challans.get(c.id)!.deductees.push({
      pan: panField,
      name: bill.company.name,
      sectionCode: code,
      creditedOn: day,
      amountPaid,
      taxDeducted: tax,
      taxDeposited: round2(Number(link.amount)),
      deductedOn: day,
      rate,
      remark,
      certificateNo,
      docNumber: bill.docNumber,
    });
    if (c.sectionKey !== section.key) warnings.push(`${bill.docNumber} is ${section.oldSection} but its challan ${challanCin({ bsrCode: c.bsrCode, paidOn, challanSerial: c.challanSerial })} was paid as ${challanSectionNumber(c.sectionKey)}.`);
  }

  const ordered: Form140Challan[] = [...challans.entries()].sort(([a], [b]) => orderOf.get(a)!.localeCompare(orderOf.get(b)!)).map(([, c]) => c);
  if (nil.length > 0) ordered.push({ nil: true, bsrCode: null, challanSerial: null, paidOn: null, minorHead: null, tax: 0, interest: 0, fee: 0, others: 0, deductees: nil });

  const typedToken = String(input.previousToken ?? "").replace(/\s/g, "");
  const statement: Form140 = {
    taxYear,
    quarter,
    createdOn: input.createdOn ?? indiaClock.today(),
    deductor: {
      tan: settings.tan.trim().toUpperCase(),
      deductorType: settings.deductorType,
      name: org.legalName,
      pan: (org.pan ?? "").trim().toUpperCase(),
      address: [org.addressLine1, org.addressLine2].filter(Boolean).join(", "),
      city: org.city,
      stateCode: form140StateCode({ gstCode: org.stateCode, name: org.state }),
      pincode: (org.pincode ?? "").trim(),
      email: org.email ?? "",
      phone: org.phone ?? "",
      gstin: org.gstin,
    },
    responsible: {
      name: settings.responsibleName,
      designation: settings.responsibleDesignation,
      pan: settings.responsiblePan.trim().toUpperCase(),
      address: settings.responsibleAddress,
      city: settings.responsibleCity || null,
      stateCode: form140StateCode({ name: settings.responsibleState }),
      pincode: settings.responsiblePincode.trim(),
      email: settings.responsibleEmail,
      phone: settings.responsiblePhone,
    },
    previousToken: typedToken || previous?.token || null,
    challans: ordered,
  };
  problems.push(...form140Problems(statement));
  const deductees = ordered.reduce((t, c) => t + c.deductees.length, 0);
  const summary: Form140Summary = {
    challans: ordered.filter((c) => !c.nil).length,
    deductees,
    deducted: round2(ordered.reduce((t, c) => t + c.deductees.reduce((s, d) => s + d.taxDeducted, 0), 0)),
    label: quarterLabel(taxYear, quarter),
    from,
    to,
  };
  return { statement, problems: [...new Set(problems)], warnings: [...new Set(warnings)], summary, previous };
}

/** The file, when nothing stops it, and a note that it was made. */
export async function form140File(input: { taxYear: number; quarter: number; previousToken?: string | null }, userId: string) {
  const got = await form140Statement(input);
  if (!got) return { ok: false as const, problems: ["This workspace's database is still to be updated for TDS statements."] };
  if (got.problems.length > 0) return { ok: false as const, problems: got.problems };
  const { statement } = got;
  const text = form140Text(statement);
  await db.tdsStatement.upsert({
    where: { formNumber_taxYear_quarter: { formNumber: "140", taxYear: statement.taxYear, quarter: statement.quarter } },
    create: { formNumber: "140", taxYear: statement.taxYear, quarter: statement.quarter, generatedAt: new Date(), generatedById: userId },
    update: { generatedAt: new Date(), generatedById: userId },
  });
  const ty = `${statement.taxYear}-${String((statement.taxYear + 1) % 100).padStart(2, "0")}`;
  return { ok: true as const, fileName: `${statement.deductor.tan}_Form140_${ty}_Q${statement.quarter}.txt`, text, summary: got.summary, warnings: got.warnings };
}

/** What the TDS page shows of a quarter's statement: the figures, what stops it, and what was filed. */
export async function form140Overview(taxYear: number, quarter: number) {
  try {
    const got = await form140Statement({ taxYear, quarter });
    if (!got) return null;
    const row = await db.tdsStatement.findUnique({ where: { formNumber_taxYear_quarter: { formNumber: "140", taxYear, quarter } }, select: { generatedAt: true, tokenNumber: true, filedOn: true } });
    return {
      taxYear,
      quarter,
      summary: got.summary,
      problems: got.problems,
      warnings: got.warnings,
      previous: got.previous,
      generatedAt: row?.generatedAt?.toISOString() ?? null,
      tokenNumber: row?.tokenNumber ?? null,
      filedOn: row?.filedOn ? dayOf(row.filedOn) : null,
    };
  } catch {
    return null;
  }
}
