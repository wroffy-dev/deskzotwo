import { stateCodeFromName } from "@/lib/gst-engine";
import type { DeducteeKind } from "./rules";

/**
 * Form 140 — the quarterly TDS statement for payments to residents other than salary (was 26Q) — written as
 * the file the income-tax department prescribes (owner, 26 Oct 2026): Protean's "File Format for Non-Salary TDS
 * File - Form Number 140 (26Q) - Q1 to Q4 (Version 1.1) for Tax Year 2026-27 and onwards", which the FVU (1.2)
 * validates before it is filed. Pure — what goes in is form140.ts's.
 *
 *   · ASCII text, a record a line, every line (the last too) ending CR LF. Fields joined by "^" — one fewer than
 *     the record has — and empty where the format says no value.
 *   · A file header (FH), one batch (BH) with the deductor and the person responsible, then each challan (CD)
 *     followed by the deductions it paid (DD), numbered from 1 within it.
 *   · Amounts to two places; a challan's are whole rupees, written "1000.00"; rates to four; dates DDMMYYYY.
 *   · Certificate-based nil deductions (flag A, no tax) sit under a nil challan, as the format requires.
 */

export type Form140Party = {
  name: string;
  pan: string;
  address: string;
  city: string | null;
  /** Annexure 1's code (not GST's): Maharashtra is 19. */
  stateCode: string | null;
  pincode: string;
  email: string;
  phone: string;
};

export type Form140Deductor = Form140Party & { tan: string; deductorType: string; gstin: string | null };
export type Form140Responsible = Form140Party & { designation: string };

export type Form140Deductee = {
  /** A PAN, or PANNOTAVBL / PANINVALID. */
  pan: string;
  name: string;
  sectionCode: string;
  /** The day the amount was paid or credited — the bill's date. */
  creditedOn: string;
  amountPaid: number;
  taxDeducted: number;
  taxDeposited: number;
  /** Null when nothing was deducted. */
  deductedOn: string | null;
  rate: number;
  /** Annexure 6: A a certificate under s.395, C the higher rate for no PAN. */
  remark: string | null;
  certificateNo: string | null;
  /** Where it came from, for the problems list; not written. */
  docNumber?: string;
};

export type Form140Challan = {
  /** A nil challan, for deductions certificates let go untaxed. */
  nil: boolean;
  bsrCode: string | null;
  challanSerial: string | null;
  paidOn: string | null;
  minorHead: string | null;
  tax: number;
  interest: number;
  fee: number;
  others: number;
  deductees: Form140Deductee[];
};

export type Form140 = {
  /** The tax year by its first calendar year: 2026 for 2026-27. */
  taxYear: number;
  quarter: 1 | 2 | 3 | 4;
  createdOn: string;
  deductor: Form140Deductor;
  responsible: Form140Responsible;
  /** The token number of the last regular statement filed — mandatory once one has been. */
  previousToken: string | null;
  challans: Form140Challan[];
};

export const RETURN_UTILITY = "Deskzo One";

/** Annexure 4's deductor categories a business can be. */
export const DEDUCTOR_TYPES: Record<string, string> = {
  K: "Company",
  M: "Branch or division of a company",
  F: "Firm",
  Q: "Individual or HUF",
  P: "Association of persons",
  T: "Association of persons (trust)",
  B: "Body of individuals",
  J: "Artificial juridical person",
};

/**
 * Each section's code in the statement (Annexure 2). A contractor's depends on who the contractor is: 1023
 * for an individual or HUF, 1024 for anyone else.
 */
export function form140SectionCode(sectionKey: string, kind: DeducteeKind): string | null {
  if (sectionKey === "CONTRACTOR") return kind === "INDIVIDUAL_HUF" ? "1023" : "1024";
  return SECTION_CODES[sectionKey] ?? null;
}

const SECTION_CODES: Record<string, string> = {
  COMMISSION: "1006",
  RENT_PLANT: "1008",
  RENT_LAND: "1009",
  INTEREST: "1022",
  TECHNICAL: "1026",
  PROFESSIONAL: "1027",
  DIRECTOR: "1028",
  GOODS: "1031",
  BENEFIT: "1033",
};

/** GST's state codes (src/lib/gst-engine.ts) to the statement's (Annexure 1), which number the states otherwise. */
const STATE_CODES: Record<string, string> = {
  "01": "14", "02": "13", "03": "26", "04": "06", "05": "34", "06": "12", "07": "09", "08": "27", "09": "31",
  "10": "05", "11": "28", "12": "03", "13": "23", "14": "20", "15": "22", "16": "30", "17": "21", "18": "04",
  "19": "32", "20": "35", "21": "24", "22": "33", "23": "18", "24": "11", "26": "07", "27": "19", "29": "15",
  "30": "10", "31": "17", "32": "16", "33": "29", "34": "25", "35": "01", "36": "36", "37": "02", "38": "37",
};

/** A state, by its GST code or its name, as the statement codes it; null for one it doesn't know. */
export function form140StateCode(state: { gstCode?: string | null; name?: string | null }): string | null {
  const gst = state.gstCode && STATE_CODES[state.gstCode] ? state.gstCode : stateCodeFromName(state.name);
  return gst ? (STATE_CODES[gst] ?? null) : null;
}

/** A tax year's quarter as days: Q1 April–June … Q4 January–March. */
export function quarterRange(taxYear: number, quarter: number): { from: string; to: string } {
  const startMonth = [4, 7, 10, 1][quarter - 1]!;
  const year = quarter === 4 ? taxYear + 1 : taxYear;
  const from = `${year}-${String(startMonth).padStart(2, "0")}-01`;
  const to = new Date(Date.UTC(year, startMonth + 2, 0)).toISOString().slice(0, 10);
  return { from, to };
}

/** The tax year and quarter a day falls in. */
export function quarterOf(day: string): { taxYear: number; quarter: 1 | 2 | 3 | 4 } {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  if (month <= 3) return { taxYear: year - 1, quarter: 4 };
  return { taxYear: year, quarter: (Math.floor((month - 4) / 3) + 1) as 1 | 2 | 3 };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Q2 (July–September 2026), tax year 2026-27". */
export function quarterLabel(taxYear: number, quarter: number): string {
  const { from, to } = quarterRange(taxYear, quarter);
  const name = (day: string) => MONTHS[Number(day.slice(5, 7)) - 1];
  return `Q${quarter} (${name(from)}–${name(to)} ${to.slice(0, 4)}), tax year ${taxYear}-${String((taxYear + 1) % 100).padStart(2, "0")}`;
}

/** When a quarter's statement is due: 31 July, 31 October, 31 January, 31 May. */
export function statementDueOn(taxYear: number, quarter: number): string {
  return [`${taxYear}-07-31`, `${taxYear}-10-31`, `${taxYear + 1}-01-31`, `${taxYear + 1}-05-31`][quarter - 1]!;
}

// ─── Writing fields ──────────────────────────────────────────────────────────────────────────────

// Accents, curly quotes and long dashes, by character code so the source stays plain ASCII.
const MARKS = /\p{M}/gu;
const charClass = (...codes: number[]) => new RegExp(`[${String.fromCharCode(...codes)}]`, "g");
const SINGLE_QUOTES = charClass(0x2018, 0x2019);
const DOUBLE_QUOTES = charClass(0x201c, 0x201d);
const DASHES = charClass(0x2013, 0x2014);

/** Text as the file takes it: ASCII only (accents dropped), no "^", no line breaks, single spaces. */
export function asciiText(text: string | null | undefined): string {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(MARKS, "")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\^/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const cut = (text: string | null | undefined, max: number) => asciiText(text).slice(0, max).trim();
const money = (n: number) => (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
const whole = (n: number) => `${Math.round(n)}.00`;
const ddmmyyyy = (day: string) => `${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(0, 4)}`;
const digitsOf = (phone: string) => phone.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "").slice(-10);

/** An address over the format's 25-character lines, broken between words. */
export function addressLines(address: string, lines = 4, width = 25): string[] {
  const words = asciiText(address).split(" ").filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) line = next;
    else {
      if (line) out.push(line);
      line = word.slice(0, width);
    }
  }
  if (line) out.push(line);
  return Array.from({ length: lines }, (_, i) => out[i] ?? "");
}

const record = (fields: string[], count: number, type: string) => {
  if (fields.length !== count) throw new Error(`A ${type} record has ${count} fields, not ${fields.length}.`);
  return fields.join("^");
};

/** The records, in order, each as its line without the line end. */
export function form140Records(s: Form140): string[] {
  const lines: string[] = [];
  let line = 0;
  const next = () => String(++line);
  const challans = s.challans;

  lines.push(record([next(), "FH", "NS1", "R", ddmmyyyy(s.createdOn), "1", "D", s.deductor.tan, "1", RETURN_UTILITY, "", "", "", "", "", "", "", ""], 18, "file header"));

  const bh = Array<string>(72).fill("");
  const set = (n: number, value: string) => (bh[n - 1] = value);
  const d = s.deductor;
  const r = s.responsible;
  const dAddress = addressLines(d.address);
  const rAddress = addressLines(r.address);
  set(1, next());
  set(2, "BH");
  set(3, "1");
  set(4, String(challans.length));
  set(5, "140");
  set(9, s.previousToken ?? "");
  set(13, d.tan);
  set(15, d.pan);
  set(16, `${s.taxYear + 1}${String((s.taxYear + 2) % 100).padStart(2, "0")}`);
  set(17, `${s.taxYear}${String((s.taxYear + 1) % 100).padStart(2, "0")}`);
  set(18, `Q${s.quarter}`);
  set(19, cut(d.name, 75));
  set(20, "INDIA");
  dAddress.forEach((part, i) => set(21 + i, part));
  set(25, cut(d.city, 25));
  set(26, d.stateCode ?? "");
  set(27, d.pincode);
  set(28, d.email.trim());
  set(29, "91");
  set(30, digitsOf(d.phone));
  set(32, d.deductorType);
  set(33, cut(r.name, 75));
  set(34, cut(r.designation, 20));
  rAddress.forEach((part, i) => set(35 + i, part));
  set(39, cut(r.city, 25));
  set(40, r.stateCode ?? "");
  set(41, r.pincode);
  set(42, r.email.trim());
  set(43, "INDIA");
  set(44, "91");
  set(45, digitsOf(r.phone));
  set(47, whole(challans.reduce((t, c) => t + challanTotalOf(c), 0)));
  set(52, s.previousToken ? "Y" : "N");
  set(59, r.pan);
  set(69, d.gstin ?? "");
  lines.push(record(bh, 72, "batch header"));

  const quarterEnd = quarterRange(s.taxYear, s.quarter).to;
  challans.forEach((c, i) => {
    const challanNo = String(i + 1);
    const deposited = c.deductees.reduce((t, x) => t + x.taxDeposited, 0);
    const deducted = c.deductees.reduce((t, x) => t + x.taxDeducted, 0);
    lines.push(
      record(
        [
          next(), "CD", "1", challanNo, String(c.deductees.length), c.nil ? "Y" : "N", "",
          whole(c.tax), whole(c.interest), whole(c.fee), whole(c.others), whole(challanTotalOf(c)),
          c.nil ? "" : "C", "", c.nil ? "" : (c.bsrCode ?? ""), "", c.nil ? "" : (c.challanSerial ?? ""), "",
          ddmmyyyy(c.nil || !c.paidOn ? quarterEnd : c.paidOn), "", money(deposited), money(deducted),
          c.nil ? "" : (c.minorHead ?? "200"), whole(c.interest), whole(c.others), "", "", "", "", "",
        ],
        30,
        "challan",
      ),
    );
    c.deductees.forEach((x, j) => {
      lines.push(
        record(
          [
            next(), "DD", "1", String(j + 1), challanNo, "O", "", x.pan, cut(x.name, 75), "", "", "", "", "",
            x.sectionCode, "", "", "Y", ddmmyyyy(x.creditedOn), money(x.amountPaid), "", "", "",
            money(x.taxDeducted), money(x.taxDeposited), "", x.taxDeducted > 0 && x.deductedOn ? ddmmyyyy(x.deductedOn) : "",
            (x.taxDeducted > 0 ? x.rate : 0).toFixed(4), "", "", "", x.remark ?? "", x.certificateNo ?? "",
            "", "", "", "", "", "", "", "", "", "", "", "",
          ],
          45,
          "deductee",
        ),
      );
    });
  });
  return lines;
}

const challanTotalOf = (c: Form140Challan) => Math.round(c.tax) + Math.round(c.interest) + Math.round(c.fee) + Math.round(c.others);

/** The file itself: every record on its own line, each ending CR LF. */
export function form140Text(s: Form140): string {
  return form140Records(s).map((l) => `${l}\r\n`).join("");
}

// ─── What the file needs ─────────────────────────────────────────────────────────────────────────

const TAN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const EMAIL = /^[^\s@^]+@[^\s@^]+\.[^\s@^]+$/;
const hasLetters = (text: string) => /[A-Za-z0-9]/.test(text);

/** What stops the file from being made, or the FVU from passing it — each said plainly. */
export function form140Problems(s: Form140): string[] {
  const problems: string[] = [];
  const d = s.deductor;
  const r = s.responsible;
  if (!TAN.test(d.tan)) problems.push("The company's TAN — ten characters, as ABCD12345E — is needed in the statement details.");
  if (!PAN.test(d.pan)) problems.push("The company's PAN is needed in Settings › Organisation.");
  if (!hasLetters(asciiText(d.name))) problems.push("The company's legal name is needed in Settings › Organisation.");
  if (!hasLetters(asciiText(d.address))) problems.push("The company's address is needed in Settings › Organisation.");
  if (!d.stateCode) problems.push("The company's state is needed in Settings › Organisation.");
  if (!/^\d{6}$/.test(d.pincode)) problems.push("The company's PIN code is needed in Settings › Organisation.");
  if (!EMAIL.test(d.email.trim()) && !EMAIL.test(r.email.trim())) problems.push("An email address — the company's, in Settings › Organisation, or the responsible person's.");
  if (digitsOf(d.phone).length !== 10) problems.push("The company's phone number, ten digits, is needed in Settings › Organisation.");
  if (!DEDUCTOR_TYPES[d.deductorType]) problems.push("Choose what kind of deductor the company is in the statement details.");
  if (!hasLetters(asciiText(r.name))) problems.push("The name of the person responsible for deducting is needed in the statement details.");
  if (!hasLetters(asciiText(r.designation))) problems.push("The responsible person's designation is needed in the statement details.");
  if (!PAN.test(r.pan)) problems.push("The responsible person's PAN is needed in the statement details.");
  if (!hasLetters(asciiText(r.address))) problems.push("The responsible person's address is needed in the statement details.");
  if (!r.stateCode) problems.push("The responsible person's state is needed in the statement details.");
  if (!/^\d{6}$/.test(r.pincode)) problems.push("The responsible person's PIN code is needed in the statement details.");
  if (!EMAIL.test(r.email.trim())) problems.push("The responsible person's email is needed in the statement details.");
  if (digitsOf(r.phone).length !== 10) problems.push("The responsible person's phone number, ten digits, is needed in the statement details.");
  if (s.previousToken !== null && !/^\d{15}$/.test(s.previousToken)) problems.push("The previous statement's token number is fifteen digits.");

  const { from, to } = quarterRange(s.taxYear, s.quarter);
  if (!s.challans.some((c) => c.deductees.length > 0)) problems.push(`Nothing to report: no TDS deducted from vendors in ${quarterLabel(s.taxYear, s.quarter)}.`);
  for (const c of s.challans) {
    if (!c.nil) {
      const name = `Challan ${c.bsrCode ?? "?"}/${c.challanSerial ?? "?"}`;
      if (!/^\d{7}$/.test(c.bsrCode ?? "") || !/^\d{5}$/.test(c.challanSerial ?? "") || !c.paidOn) problems.push(`${name} needs its BSR code, serial and date.`);
      if ([c.tax, c.interest, c.fee, c.others].some((n) => !Number.isInteger(n))) problems.push(`${name} has paise in its amounts; a challan is paid in whole rupees.`);
      const owed = c.deductees.reduce((t, x) => t + x.taxDeposited, 0) + c.interest + c.fee + c.others;
      if (challanTotalOf(c) + 0.005 < owed) problems.push(`${name} paid less than the deductions on it and its interest and fees come to.`);
    }
    for (const x of c.deductees) {
      const what = x.docNumber ?? x.name;
      if (x.creditedOn < from || x.creditedOn > to) problems.push(`${what} is dated outside the quarter.`);
      if (!(x.amountPaid > 0)) problems.push(`${what} has no amount paid or credited.`);
      if (x.remark === "A" && !/^[A-Z0-9]{10}([A-Z0-9]{5})?$/.test(x.certificateNo ?? "")) problems.push(`${what} was deducted under a certificate whose number isn't 10 or 15 letters and digits.`);
    }
  }
  return problems;
}
