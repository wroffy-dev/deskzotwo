/**
 * Employee ID cards (owner, 31 Oct 2026 — People › ID cards): what one looks like, client-safe. The card is the standard
 * CR80 size, upright as an office badge on a lanyard is worn; printed on A4 to cut out (front and back on facing pages,
 * the back mirrored so they meet when printed both sides) or one side a page for an ID card printer.
 */

export const CARD_W_MM = 54;
export const CARD_H_MM = 85.6;

export type IdCardDesign = {
  /** Hex; null takes the workspace's brand colour. */
  accentColor: string | null;
  showDepartment: boolean;
  showBloodGroup: boolean;
  showEmergencyContact: boolean;
  showJoinedOn: boolean;
  showWorkPhone: boolean;
  showEmail: boolean;
  showSignature: boolean;
  /** The line on the back above the address; null is the default wording. */
  backNote: string | null;
};

export const DEFAULT_DESIGN: IdCardDesign = {
  accentColor: null,
  showDepartment: true,
  showBloodGroup: true,
  showEmergencyContact: true,
  showJoinedOn: false,
  showWorkPhone: false,
  showEmail: false,
  showSignature: true,
  backNote: null,
};

/** The line on the back when none is set. */
export const defaultBackNote = (company: string) => `This card is the property of ${company}. If found, please return it to the address below.`;

export const BACK_NOTE_MAX = 200;

/** A colour safe to put in a style: six-digit hex, or null. */
export function safeHex(value: string | null | undefined): string | null {
  const v = value?.trim() ?? "";
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}

/** Black or white, whichever reads on this background. */
export function inkOn(hex: string): "#ffffff" | "#111111" {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return luminance > 0.4 ? "#111111" : "#ffffff";
}

/** One card's details, as the print and the preview draw them — only what the design shows is filled. */
export type IdCardData = {
  userId: string;
  name: string;
  photoDataUrl: string | null;
  initials: string;
  employeeCode: string | null;
  designation: string | null;
  department: string | null;
  bloodGroup: string | null;
  joinedOn: string | null;
  workPhone: string | null;
  email: string | null;
  emergency: { name: string | null; phone: string; relation: string | null } | null;
  /** The QR code, as an image, that opens the card's check page. */
  qrDataUrl: string;
};

/** Who issued the cards: the company's name, logo, address and signatory, the same on every card. */
export type IdCardIssuer = {
  company: string;
  logoDataUrl: string | null;
  address: string;
  phone: string | null;
  signatureDataUrl: string | null;
  accent: string;
};

/** A card with only what the design shows. */
export function applyDesign(card: IdCardData, design: IdCardDesign): IdCardData {
  return {
    ...card,
    department: design.showDepartment ? card.department : null,
    bloodGroup: design.showBloodGroup ? card.bloodGroup : null,
    joinedOn: design.showJoinedOn ? card.joinedOn : null,
    workPhone: design.showWorkPhone ? card.workPhone : null,
    email: design.showEmail ? card.email : null,
    emergency: design.showEmergencyContact ? card.emergency : null,
  };
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase() || "?";
}

/** The ids a print link carries, each a cuid, at most this many at once. */
export const MAX_CARDS = 200;

export function parseCardIds(raw: string | null | undefined): string[] {
  const ids = (raw ?? "").split(",").map((s) => s.trim()).filter((s) => /^[a-z0-9]{10,40}$/.test(s));
  return [...new Set(ids)].slice(0, MAX_CARDS);
}

/** A4 holds three across and three down, with room to cut between them. */
export const PER_SHEET = 9;
export const SHEET_COLUMNS = 3;

/**
 * The backs of one sheet, in the order they print: each row turned round, so a sheet printed on both sides (flipped on
 * its long edge) puts every back behind its own front. A short last row is padded so its backs land under their fronts.
 */
export function backsOrder<T>(fronts: T[]): (T | null)[] {
  const out: (T | null)[] = [];
  for (let i = 0; i < fronts.length; i += SHEET_COLUMNS) {
    const row: (T | null)[] = fronts.slice(i, i + SHEET_COLUMNS);
    while (row.length < SHEET_COLUMNS) row.push(null);
    out.push(...row.reverse());
  }
  return out;
}

export function sheetsOf<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += PER_SHEET) out.push(items.slice(i, i + PER_SHEET));
  return out;
}
