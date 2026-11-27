import type { MsmeCategory } from "@prisma/client";

/**
 * The MSME vendor rules that hold no data (src/lib/payables/msme.ts has the rest) — safe in the browser: the Udyam
 * number's shape, the categories, and the words for where a bill stands against the 45-day limit.
 */

/** Within this many days of the last day, a bill is "due soon". */
export const MSME_SOON_DAYS = 7;

/** UDYAM-XX-00-0000000: the state's two letters, the district's two digits, seven digits. */
export const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;

export const MSME_CATEGORY_LABELS: Record<MsmeCategory, string> = { MICRO: "Micro", SMALL: "Small", MEDIUM: "Medium" };

export const MSME_CATEGORIES: MsmeCategory[] = ["MICRO", "SMALL", "MEDIUM"];

/** As people type it — spaces gone, upper case. */
export function normaliseUdyam(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, "").toUpperCase();
}

/** Why an Udyam number won't do; null when it will. */
export function udyamRefusal(raw: unknown): string | null {
  const value = normaliseUdyam(raw);
  if (!value) return "Enter the Udyam registration number.";
  if (!UDYAM_PATTERN.test(value)) return "An Udyam number looks like UDYAM-MH-19-0012345.";
  return null;
}

/** Whether the 45-day limit applies: micro and small only. */
export function heldToLimit(category: MsmeCategory | null | undefined): boolean {
  return category === "MICRO" || category === "SMALL";
}

export type MsmeStanding = {
  /** The last day to pay, yyyy-mm-dd. */
  payBy: string;
  /** Days from today to it: negative once it has passed. */
  daysLeft: number;
  state: "ok" | "soon" | "late";
  /** The bill's own due date is later than the Act allows — 45 days from the bill. */
  dueBeyondLimit: boolean;
  /** No due date on the bill: the Act's 15 days applies. */
  noDueDate: boolean;
};

export type MsmeBillRow = {
  id: string;
  docNumber: string | null;
  companyId: string;
  companySeq: number;
  vendorName: string;
  category: MsmeCategory;
  issueDate: string;
  /** Still to pay, in rupees at the bill's own rate. */
  balance: number;
  currency: string;
  /** Still to pay, as the bill is written. */
  balanceAsWritten: number;
} & MsmeStanding;

/** The words for a standing — the same on a bill, a vendor and Payables. */
export function standingWords(s: MsmeStanding): string {
  if (s.state === "late") return `${-s.daysLeft} day${s.daysLeft === -1 ? "" : "s"} past the MSME limit`;
  if (s.daysLeft === 0) return "Last day to pay is today";
  return `${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"} left to pay`;
}
