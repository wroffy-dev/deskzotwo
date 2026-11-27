import type { TdsSection } from "./rules";

/**
 * The TDS sections a company deducts under when it pays residents other than its staff (owner, 25 Oct 2026;
 * salary is payroll's, src/lib/hr/tds.ts). Each with what the Income-tax Act, 2025 calls it — the 1961 Act's
 * section number, which everybody still says, beside it — its rates and its limits for a tax year.
 *
 * Kept here, one table, because the law moves: a Finance Act changes a rate or a limit, and this is the one
 * place that changes. A key is stored on every bill deducted under it, so a key is never renamed; a section
 * the law drops stays, for the bills that used it.
 *
 * SECTIONS_AS_OF says when the table was last checked against the law.
 */
export const SECTIONS_AS_OF = "25 Oct 2026 — the Income-tax Act, 2025 as in force from 1 April 2026";

// No PAN: the highest of the section's rate and 20% — 5% for purchase of goods (s.397(2)(b)(i)).
export const TDS_SECTIONS: TdsSection[] = [
  {
    key: "CONTRACTOR",
    label: "Payment to a contractor",
    reference: "s.393(1) Table Sl. 6(i)",
    oldSection: "194C",
    rate: { individualHuf: 1, other: 2 },
    noPanMinimum: 20,
    singleLimit: 30_000,
    yearLimit: 1_00_000,
  },
  {
    key: "TECHNICAL",
    label: "Fees for technical services, call centre, film royalty",
    reference: "s.393(1) Table Sl. 6(iii)",
    oldSection: "194J(a)",
    rate: { individualHuf: 2, other: 2 },
    noPanMinimum: 20,
    singleLimit: null,
    yearLimit: 50_000,
  },
  {
    key: "PROFESSIONAL",
    label: "Professional fees, royalty",
    reference: "s.393(1) Table Sl. 6(iii)",
    oldSection: "194J(b)",
    rate: { individualHuf: 10, other: 10 },
    noPanMinimum: 20,
    singleLimit: null,
    yearLimit: 50_000,
  },
  {
    key: "DIRECTOR",
    label: "Director's fees and commission",
    reference: "s.393(1) Table Sl. 6(iii)",
    oldSection: "194J(ba)",
    rate: { individualHuf: 10, other: 10 },
    noPanMinimum: 20,
    singleLimit: null,
    yearLimit: null,
  },
  // Rent's limit is ₹50,000 for a month or part of one; a bill is taken as a month's rent.
  {
    key: "RENT_PLANT",
    label: "Rent of plant, machinery or equipment",
    reference: "s.393(1) Table Sl. 2(ii)(a)",
    oldSection: "194I(a)",
    rate: { individualHuf: 2, other: 2 },
    noPanMinimum: 20,
    singleLimit: 50_000,
    yearLimit: null,
  },
  {
    key: "RENT_LAND",
    label: "Rent of land, building or furniture",
    reference: "s.393(1) Table Sl. 2(ii)(b)",
    oldSection: "194I(b)",
    rate: { individualHuf: 10, other: 10 },
    noPanMinimum: 20,
    singleLimit: 50_000,
    yearLimit: null,
  },
  {
    key: "COMMISSION",
    label: "Commission or brokerage",
    reference: "s.393(1) Table Sl. 1(ii)",
    oldSection: "194H",
    rate: { individualHuf: 2, other: 2 },
    noPanMinimum: 20,
    singleLimit: null,
    yearLimit: 20_000,
  },
  {
    key: "INTEREST",
    label: "Interest other than on securities",
    reference: "s.393(1) Table Sl. 5(iii)",
    oldSection: "194A",
    rate: { individualHuf: 10, other: 10 },
    noPanMinimum: 20,
    singleLimit: null,
    yearLimit: 10_000,
  },
  // Only a buyer whose turnover passed ₹10 crore last year deducts this; the seller's TCS applies otherwise.
  {
    key: "GOODS",
    label: "Purchase of goods",
    reference: "s.393(1) Table Sl. 8(ii)",
    oldSection: "194Q",
    rate: { individualHuf: 0.1, other: 0.1 },
    noPanMinimum: 5,
    singleLimit: null,
    yearLimit: 50_00_000,
    excessOnly: true,
  },
  {
    key: "BENEFIT",
    label: "Benefit or perquisite of a business",
    reference: "s.393(1) Table Sl. 8(iv)",
    oldSection: "194R",
    rate: { individualHuf: 10, other: 10 },
    noPanMinimum: 20,
    singleLimit: null,
    yearLimit: 20_000,
  },
];

const byKey = new Map(TDS_SECTIONS.map((s) => [s.key, s]));

export function sectionByKey(key: string | null | undefined): TdsSection | null {
  return key ? (byKey.get(key) ?? null) : null;
}

/**
 * The section a bill's stored text names: a key, or the 1961 number somebody typed before the list
 * ("194C", "194 J", "194J(b)"). Null when it names none of them.
 */
export function sectionOf(text: string | null | undefined): TdsSection | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const exact = byKey.get(raw);
  if (exact) return exact;
  const compact = raw.toUpperCase().replace(/[\s.]/g, "").replace(/^SEC(TION)?/, "");
  const number = (s: TdsSection) => s.oldSection.toUpperCase().replace(/\s/g, "");
  const exactly = TDS_SECTIONS.find((s) => number(s) === compact);
  if (exactly) return exactly;
  // "194J(b)": the longest number it starts with, so "194IA" isn't read as "194I".
  return [...TDS_SECTIONS].sort((a, b) => number(b).length - number(a).length).find((s) => compact.startsWith(number(s))) ?? null;
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** A section's rates and limits in one line, for a picker's hint and a vendor's card. */
export function rateText(section: TdsSection): string {
  const { individualHuf, other } = section.rate;
  const rates = individualHuf === other ? `${other}%` : `${individualHuf}% for an individual or HUF, ${other}% otherwise`;
  const limits = [section.singleLimit !== null ? `${rupees(section.singleLimit)} a payment` : null, section.yearLimit !== null ? `${rupees(section.yearLimit)} in the tax year` : null].filter(Boolean);
  if (limits.length === 0) return rates;
  return section.excessOnly ? `${rates}, on what goes over ${limits.join(" and ")}` : `${rates}; none until over ${limits.join(" or ")}`;
}
