/**
 * Storage as the console shows and takes it (storage in the plans, owner 20 Nov 2026 — src/lib/storage/quota.ts).
 *
 * Staff type storage in GB, a fraction allowed ("2.5"); plans and overrides keep whole MB (`Plan.storageMb`,
 * `Tenant.storageOverrideMb`). What a workspace uses is in bytes. Safe in the browser: no server import.
 */

export const MB = 1024 * 1024;
const GB_IN_MB = 1024;
/** The most a limit may be, in MB — the save's own bound (src/lib/platform/plans.ts `limitOf`). */
const MAX_MB = 1_000_000_000;

/**
 * GB as typed, in whole MB: empty is null (no limit on an edition, nothing from an add-on, the plans decide for an
 * override); "2.5" is 2560. Anything else — negative, not a number, too large — is not ok.
 */
export function mbOfGbText(text: string): { ok: true; value: number | null } | { ok: false } {
  const t = String(text ?? "").trim().replace(",", ".");
  if (t === "") return { ok: true, value: null };
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(t)) return { ok: false };
  const mb = Math.round(Number(t) * GB_IN_MB);
  return mb <= MAX_MB ? { ok: true, value: mb } : { ok: false };
}

/**
 * MB as a GB field shows it: 2560 → "2.5", 2048 → "2", null → "". Four decimals at most, trailing zeros gone — enough
 * that the field read back (`mbOfGbText`) is the same whole MB.
 */
export function gbTextOfMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined) return "";
  return String(Number((mb / GB_IN_MB).toFixed(4)));
}

/** An allowance in MB as read: "2 GB", "2.5 GB", "500 MB". */
export function storageAmount(mb: number): string {
  if (mb >= GB_IN_MB) return `${Number((mb / GB_IN_MB).toFixed(2)).toLocaleString("en-IN")} GB`;
  return `${mb.toLocaleString("en-IN")} MB`;
}

/** Bytes as read: "1.4 GB", "350 MB", "4.2 MB" — the way the workspace's own messages put it. */
export function bytesAmount(bytes: number): string {
  if (bytes >= GB_IN_MB * MB) return `${(bytes / (GB_IN_MB * MB)).toFixed(bytes >= 100 * GB_IN_MB * MB ? 0 : 1)} GB`;
  const mb = Math.max(0, bytes / MB);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * A plan's storage as a card or a list reads it. Storage is for the whole workspace, never per person: an edition's is
 * the workspace's; an add-on's or bundle's is for each pack bought. Null: no limit on an edition, nothing from an
 * add-on (null back for the caller to leave the line out).
 */
export function planStorageText(mb: number | null | undefined, kind: "EDITION" | "BUNDLE" | "ADDON" | "INTERNAL"): string | null {
  const addOn = kind === "ADDON" || kind === "BUNDLE";
  if (mb === null || mb === undefined) return addOn ? null : "No storage limit";
  if (mb === 0) return addOn ? null : "No storage";
  return addOn ? `${storageAmount(mb)} of storage for each pack` : `${storageAmount(mb)} of storage for the workspace`;
}

/** What each kind of file is, by the folder it is kept in (src/lib/storage/registry.ts `FILE_COLUMNS`, and the recordings). */
export const STORAGE_KIND_LABELS: Readonly<Record<string, string>> = {
  "archived-documents": "Migrated PDFs (Zoho)",
  "old-proposals": "Old proposals (Excel)",
  "employee-documents": "Employee documents",
  "project-documents": "Project documents",
  "close-attachments": "Month-end close attachments",
  "support-email": "Support email attachments",
  "custom-field-files": "Custom field files",
  "quick-templates": "Template files",
  "smart-list-files": "Smart List files",
  "desk-request-files": "Help desk request files",
  "expense-receipts": "Expense receipts",
  "bill-readings": "Bills read by Arjun",
  "user-photos": "Profile photos",
  "visitor-photos": "Visitor photos",
  celebrations: "Celebration pictures",
  prizes: "Prize pictures",
  "task-attachments": "Task attachments",
  "chat-attachments": "Chat attachments",
  "inbox-files": "Inbox files",
  "marketing-assets": "Marketing assets",
  recordings: "Call recordings",
  other: "Other files",
};

/** A kind's label; one not known here reads as its own name, dashes to spaces. */
export function storageKindLabel(kind: string): string {
  const known = STORAGE_KIND_LABELS[kind];
  if (known) return known;
  const words = kind.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Other files";
}

/** A breakdown as listed: largest first, each with its label and share of the whole. */
export function storageBreakdownRows(breakdown: Record<string, number>): { kind: string; label: string; bytes: number; share: number }[] {
  const total = Object.values(breakdown).reduce((n, b) => n + Math.max(0, b), 0);
  return Object.entries(breakdown)
    .filter(([, bytes]) => bytes > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, bytes]) => ({ kind, label: storageKindLabel(kind), bytes, share: total > 0 ? bytes / total : 0 }));
}
