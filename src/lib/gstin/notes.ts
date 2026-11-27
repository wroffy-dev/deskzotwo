import type { GstTreatment } from "@prisma/client";
import { GSTIN_PATTERN, GST_STATE_CODES, hasValidGstinChecksum, panOfGstin, stateCodeFromName } from "@/lib/gst-engine";

/**
 * A customer's or vendor's GSTIN, checked before they're onboarded (owner, 25 Oct 2026).
 *
 * Two kinds of check. These are the ones that need nobody: a GSTIN carries its own answers — its first two
 * digits are its state, the next ten its holder's PAN, the last a check character over the other fourteen —
 * so a mistyped character, a GSTIN from another state's office, or another company's GSTIN shows as it is
 * typed. The other kind asks the GST system itself (src/lib/gstin/lookup.ts) whether it is active and whose.
 *
 * Notes, never refusals: GSTINs typed years ago still save, and the person sees what's wrong while they can
 * still ask the customer. Pure, so the form says it as you type and the server says the same thing.
 */

const REGISTERED: readonly GstTreatment[] = ["REGISTERED_REGULAR", "REGISTERED_COMPOSITION", "SEZ", "DEEMED_EXPORT"];

export const normalizeGstin = (value: string | null | undefined) => (value ?? "").toUpperCase().replace(/\s+/g, "");

/** Whether a GSTIN is worth asking the GST system about: its shape and its check character are right. */
export const lookupReady = (gstin: string) => GSTIN_PATTERN.test(gstin) && hasValidGstinChecksum(gstin);

export function gstinNotes(input: {
  gstin: string | null | undefined;
  /** The address's state, as the form holds it — a name such as "Maharashtra". */
  state?: string | null;
  /** The company's PAN, when it has one on file. */
  companyPan?: string | null;
  treatment?: GstTreatment | string | null;
}): string[] {
  const gstin = normalizeGstin(input.gstin);
  const treatment = input.treatment as GstTreatment | null | undefined;
  if (!gstin) {
    return treatment && REGISTERED.includes(treatment) ? ["A registered business has a GSTIN — add it, or change the GST treatment."] : [];
  }
  if (gstin.length !== 15) return [`A GSTIN is 15 characters; this is ${gstin.length}.`];
  if (!GSTIN_PATTERN.test(gstin)) return ["That isn't the shape of a GSTIN: two digits for the state, the PAN, then three characters, like 27AABCW1234F1ZV."];

  const notes: string[] = [];
  if (!hasValidGstinChecksum(gstin)) notes.push("Its last character doesn't check out, so one character is mistyped. Compare it with their GST certificate.");
  const code = gstin.slice(0, 2);
  const registeredIn = GST_STATE_CODES[code];
  if (!registeredIn) notes.push(`${code} isn't a GST state code.`);
  const addressCode = stateCodeFromName(input.state);
  if (registeredIn && addressCode && addressCode !== code) {
    notes.push(`It's registered in ${registeredIn} (${code}), but this address is in ${GST_STATE_CODES[addressCode] ?? input.state}. A GSTIN belongs to one state: use their GSTIN for this address's state.`);
  }
  const pan = panOfGstin(gstin);
  const companyPan = (input.companyPan ?? "").trim().toUpperCase();
  if (pan && companyPan && pan !== companyPan) notes.push(`The PAN inside it (${pan}) isn't the company's PAN on file (${companyPan}). It may be another company's GSTIN.`);
  if (treatment === "UNREGISTERED" || treatment === "CONSUMER") notes.push("A GSTIN means a registered business: check the GST treatment.");
  if (treatment === "OVERSEAS") notes.push("An overseas party has no Indian GSTIN: check the GST treatment.");
  return notes;
}

// ── What the GST system says ──

export const GSTIN_STATUSES = ["ACT", "CNL", "INA", "PRO", "NOT_FOUND"] as const;
export type GstinStatus = (typeof GSTIN_STATUSES)[number];

export const gstinStatusLabels: Record<GstinStatus, string> = {
  ACT: "Active",
  CNL: "Cancelled",
  INA: "Inactive",
  PRO: "Provisional",
  NOT_FOUND: "Not found",
};

export const gstinStatusTone: Record<GstinStatus, "green" | "red" | "amber"> = {
  ACT: "green",
  CNL: "red",
  INA: "red",
  PRO: "amber",
  NOT_FOUND: "red",
};

/** What each status means for doing business with them — the line under the badge. */
export const gstinStatusMeaning: Record<GstinStatus, string> = {
  ACT: "Registered and active.",
  CNL: "Cancelled: tax on bills they raise can't be claimed as credit, and they're invoiced as unregistered until they give a new GSTIN.",
  INA: "Inactive in the GST system: ask them before invoicing or buying under it.",
  PRO: "Provisional: not yet a final registration. Ask for the final GSTIN.",
  NOT_FOUND: "The GST system has no such GSTIN: one character is probably wrong.",
};

export const isGstinStatus = (value: unknown): value is GstinStatus => (GSTIN_STATUSES as readonly unknown[]).includes(value);

/** The GST treatment a taxpayer type points to, where it points to one. */
export function treatmentForTaxpayerType(type: string | null | undefined): GstTreatment | null {
  const t = (type ?? "").trim().toUpperCase();
  if (t === "REG" || t === "REGULAR") return "REGISTERED_REGULAR";
  if (t === "COM" || t === "COMPOSITION") return "REGISTERED_COMPOSITION";
  if (t === "SEZ" || t === "SED" || t === "SEZ UNIT" || t === "SEZ DEVELOPER") return "SEZ";
  return null;
}

/** A check as the screens show it. */
export type GstinCheckView = {
  gstin: string;
  status: GstinStatus;
  legalName: string | null;
  tradeName: string | null;
  address: string | null;
  stateCode: string | null;
  pincode: string | null;
  taxpayerType: string | null;
  blocked: boolean;
  /** "nic" for the GST system; "mock" when the workspace's e-invoicing is the local stand-in. */
  source: string;
  /** ISO time of the check. */
  checkedAt: string;
};
