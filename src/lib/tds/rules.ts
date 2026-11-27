/**
 * TDS on what a company pays its vendors (owner, 25 Oct 2026): which rate a bill deducts at, and whether it
 * should deduct at all yet. Pure — the bill form says it as you type, and the TDS page and the suite say the
 * same thing. The sections, their rates and limits are in sections.ts; this is how they're applied:
 *
 *   · **Who the vendor is**, from the fourth character of its PAN: P an individual, H a HUF — the lower rate
 *     where a section has one — and anything else a company, firm or other body.
 *   · **No PAN** (or one that isn't a PAN): the higher rate the law sets for a deductee without one (noPanRate).
 *   · **A lower deduction certificate** the vendor holds for the section, valid on the bill's date and not yet
 *     used up: its rate, on what it still covers.
 *   · **The yearly limits.** Until a vendor's payments under a section cross its limits for the tax year
 *     (April to March), nothing is deducted. The bill that crosses an aggregate limit deducts on the whole
 *     year's — the earlier bills' TDS is owed with it — except where the law taxes only the part over the
 *     limit (purchase of goods).
 *
 * Advice, never a refusal: the person raising the bill sees the rate and why, and can type another.
 */

export type DeducteeKind = "INDIVIDUAL_HUF" | "OTHER";

export type TdsSection = {
  /** Stored on a bill as its section. Stable: never renamed once used. */
  key: string;
  /** What the payment is, in plain words. */
  label: string;
  /** Where it is in the Income-tax Act, 2025. */
  reference: string;
  /** The 1961 Act's section, which everybody still says. */
  oldSection: string;
  rate: { individualHuf: number; other: number };
  /** Without the deductee's PAN, at least this (s.397(2)(b)(i)): 20%, or 5% for purchase of goods. */
  noPanMinimum: number;
  /** No TDS while a single payment is at most this (null: no such limit). */
  singleLimit: number | null;
  /** … and the tax year's total to the vendor at most this (null: no such limit). */
  yearLimit: number | null;
  /** TDS only on what the year's total goes over `yearLimit`, not on all of it. */
  excessOnly?: boolean;
};

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The rate for a deductee without a PAN (s.397(2)(b)(i), the old 206AA): the highest of the section's rate and
 * the floor — 20%, or 5% for purchase of goods. Not twice the rate: that is TCS's rule.
 */
export const noPanRate = (section: Pick<TdsSection, "noPanMinimum">, normalRate: number) => Math.max(normalRate, section.noPanMinimum);

/** The PAN, when it is one. */
export function validPan(value: string | null | undefined): string | null {
  const pan = (value ?? "").trim().toUpperCase();
  return PAN.test(pan) ? pan : null;
}

/** An individual (P) or a HUF (H), by the fourth character of the PAN; everyone else is "other". */
export function deducteeKind(pan: string | null | undefined): DeducteeKind {
  const valid = validPan(pan);
  return valid && (valid[3] === "P" || valid[3] === "H") ? "INDIVIDUAL_HUF" : "OTHER";
}

export const deducteeKindLabels: Record<DeducteeKind, string> = {
  INDIVIDUAL_HUF: "an individual or HUF",
  OTHER: "a company, firm or other body",
};

/** The tax year a day falls in, as its first day: "2026-04-01" for any day from April 2026 to March 2027. */
export function taxYearStart(day: string): string {
  const year = Number(day.slice(0, 4));
  return Number(day.slice(5, 7)) >= 4 ? `${year}-04-01` : `${year - 1}-04-01`;
}

export type TdsCertificateFacts = {
  certificateNo: string;
  ratePercent: number;
  /** The most it covers; null when it names no limit. */
  amountLimit: number | null;
  /** What earlier bills under it have already used. */
  usedSoFar: number;
  validFrom: string;
  validTo: string;
};

export type TdsAdvice = {
  /** Whether this bill should deduct. */
  due: boolean;
  /** The rate to deduct at, as a percent of the bill's taxable value. */
  rate: number;
  /** What the rate is based on. */
  basis: "NORMAL" | "NO_PAN" | "CERTIFICATE" | "BELOW_LIMIT";
  /** One plain line on why. */
  note: string;
  /** TDS the year's earlier bills should have deducted and didn't, owed now the limit is crossed. */
  shortfall: number;
  /** The amount the rate applies to, where it isn't the whole bill (the part over a limit, or a certificate's last). */
  base: number;
};

const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * The advice for one bill. `amount` is its taxable value; `yearSoFar` the taxable value of the vendor's earlier
 * bills this tax year under the section, `deductedSoFar` the TDS they deducted.
 */
export function tdsAdvice(input: {
  section: TdsSection;
  pan: string | null | undefined;
  certificate: TdsCertificateFacts | null;
  amount: number;
  yearSoFar: number;
  deductedSoFar: number;
  day: string;
}): TdsAdvice {
  const { section, amount } = input;
  const pan = validPan(input.pan);
  const kind = deducteeKind(pan);
  const normal = kind === "INDIVIDUAL_HUF" ? section.rate.individualHuf : section.rate.other;
  const yearTotal = round2(input.yearSoFar + amount);

  // The limits: below both, nothing yet.
  const overSingle = section.singleLimit !== null && amount > section.singleLimit;
  const overYear = section.yearLimit !== null && yearTotal > section.yearLimit;
  const limited = section.singleLimit !== null || section.yearLimit !== null;
  if (limited && !overSingle && !overYear) {
    const limits = [
      section.singleLimit !== null ? `${rupees(section.singleLimit)} a payment` : null,
      section.yearLimit !== null ? `${rupees(section.yearLimit)} in the year` : null,
    ].filter(Boolean);
    return {
      due: false,
      rate: 0,
      basis: "BELOW_LIMIT",
      note: `No TDS yet: ${rupees(yearTotal)} to this vendor under ${section.oldSection} this tax year, within ${limits.join(" and ")}.`,
      shortfall: 0,
      base: 0,
    };
  }

  // What the rate applies to: the whole bill, or — goods — only the part over the year's limit.
  const base = section.excessOnly && section.yearLimit !== null ? round2(Math.min(amount, yearTotal - section.yearLimit)) : amount;

  // The rate: no PAN, a certificate, or the section's.
  let rate = normal;
  let basis: TdsAdvice["basis"] = "NORMAL";
  let note = `${section.oldSection} (${section.label.toLowerCase()}): ${normal}% for ${deducteeKindLabels[kind]}.`;
  const cert = input.certificate;
  const certLeft = cert ? (cert.amountLimit === null ? Infinity : round2(cert.amountLimit - cert.usedSoFar)) : 0;
  if (!pan) {
    rate = noPanRate(section, normal);
    basis = "NO_PAN";
    note = `No valid PAN on file for this vendor, so ${section.oldSection} deducts at ${rate}% instead of ${normal}%. Add its PAN to deduct at the normal rate.`;
  } else if (cert && input.day >= cert.validFrom && input.day <= cert.validTo && certLeft > 0) {
    // What the certificate still covers at its rate, the rest at the section's: one rate over the base.
    rate = certLeft >= base ? cert.ratePercent : round2((certLeft * cert.ratePercent + (base - certLeft) * normal) / base);
    basis = "CERTIFICATE";
    note =
      certLeft === Infinity
        ? `Lower deduction certificate ${cert.certificateNo}: ${cert.ratePercent}% until ${cert.validTo}.`
        : certLeft >= base
          ? `Lower deduction certificate ${cert.certificateNo}: ${cert.ratePercent}% until ${cert.validTo}; ${rupees(round2(certLeft - base))} of it left after this bill.`
          : `Lower deduction certificate ${cert.certificateNo} covers only ${rupees(certLeft)} more: deduct ${cert.ratePercent}% on that and ${normal}% on the rest.`;
  }

  // Crossing a year's limit that wasn't crossed before: the earlier bills' TDS is owed now (not for goods).
  let shortfall = 0;
  const crossedNow = section.yearLimit !== null && input.yearSoFar <= section.yearLimit && overYear && !section.excessOnly;
  if (crossedNow) {
    shortfall = Math.max(0, round2((input.yearSoFar * rate) / 100 - input.deductedSoFar));
    if (shortfall > 0) {
      note += ` This bill takes the year past ${rupees(section.yearLimit!)}, so TDS of ${rupees(shortfall)} on the earlier ${rupees(input.yearSoFar)} is owed with it.`;
    }
  }
  if (section.excessOnly && base < amount) note += ` Only ${rupees(base)} of this bill is over the year's ${rupees(section.yearLimit!)}, and TDS is on that part.`;
  return { due: true, rate, basis, note, shortfall, base };
}

/**
 * The rate box's value for a bill whose TDS is on part of it: that part's TDS as a share of the whole bill, to
 * two places (what a bill stores). Off by a few paise at most, which the note's amount shows exactly.
 */
export function effectiveRate(advice: TdsAdvice, amount: number): number {
  if (!advice.due || amount <= 0) return 0;
  if (advice.base >= amount) return advice.rate;
  return Math.round(((advice.rate * advice.base) / amount) * 100) / 100;
}
