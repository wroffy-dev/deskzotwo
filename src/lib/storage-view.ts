import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { WARN_AT, gb, limitBytesOf } from "@/lib/storage/allowance";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * A workspace's storage as its administrators see it (storage in the plans, owner, 20 Nov 2026 — src/lib/storage/
 * quota.ts): the kinds of file in plain words for Settings › Billing's Storage card, and the notice above every page
 * from 80% full (`WARN_AT`) and at the limit, for whoever manages billing.
 */

/** Each kind of file a workspace keeps (src/lib/storage/registry.ts), as a person would say it. */
export const STORAGE_KIND_WORDS: Record<string, string> = {
  "employee-documents": "HR documents",
  "project-documents": "Project documents",
  "close-attachments": "Month-end close files",
  "expense-receipts": "Expense receipts",
  "task-attachments": "Task files",
  "chat-attachments": "Files in team chat",
  "inbox-files": "Customer inbox files",
  "support-email": "Helpdesk email attachments",
  "custom-field-files": "Files on custom fields",
  "quick-templates": "Message template PDFs",
  "marketing-assets": "Marketing pictures",
  "archived-documents": "Documents brought over from Zoho",
  "old-proposals": "Old proposals brought over",
  "bill-readings": "Bills uploaded to be read",
  "user-photos": "Profile photos",
  "visitor-photos": "Visitor photos",
  celebrations: "Celebration pictures",
  prizes: "Prize pictures",
  recordings: "Call recordings",
};

const OTHER = "Other files";

/** What each kind takes, in plain words, largest first; kinds without words of their own are "Other files" together. */
export function storageBreakdownRows(breakdown: Record<string, number>): { label: string; bytes: number }[] {
  const byLabel = new Map<string, number>();
  for (const [kind, bytes] of Object.entries(breakdown)) {
    if (!(bytes > 0)) continue;
    const label = STORAGE_KIND_WORDS[kind] ?? OTHER;
    byLabel.set(label, (byLabel.get(label) ?? 0) + bytes);
  }
  return [...byLabel.entries()].map(([label, bytes]) => ({ label, bytes })).sort((a, b) => (a.label === OTHER ? 1 : b.label === OTHER ? -1 : b.bytes - a.bytes));
}

/** How full, as a whole percentage — never 100 until it is full, never past it. */
export function percentFull(usedBytes: number, limitBytes: number): number {
  if (limitBytes <= 0 || usedBytes >= limitBytes) return 100;
  return Math.min(99, Math.floor((usedBytes / limitBytes) * 100));
}

export type StorageNotice = { tone: "warning" | "danger"; text: string; percent: number };

/** The notice for administrators: from 80% full, and at the limit; null below, or without a limit. */
export function storageNoticeOf(status: { usedBytes: number; limitBytes: number | null }): StorageNotice | null {
  const { usedBytes, limitBytes } = status;
  if (limitBytes === null) return null;
  const percent = percentFull(usedBytes, limitBytes);
  if (percent >= 100) {
    return { tone: "danger", percent, text: `Storage is full — new files can't be saved (${gb(usedBytes)} of ${gb(limitBytes)} used). Everything already saved still opens. Add storage to carry on.` };
  }
  if (limitBytes > 0 && usedBytes / limitBytes < WARN_AT) return null;
  return { tone: "warning", percent, text: `Storage is ${percent}% full (${gb(usedBytes)} of ${gb(limitBytes)} used). Add storage before it fills — at the limit, new files can't be saved.` };
}

// The banner is read on every page, so what the workspace uses is read from the control plane at most once a minute
// per workspace, as the platform's announcements are (src/lib/platform/announcements.ts). Without a limit, not at all.
const NOTICE_TTL_MS = 60_000;
const usedCache = new Map<string, { at: number; usedBytes: number }>();

/**
 * The notice for the current workspace — one control-plane row, cached for a minute. Null without a control plane,
 * without a limit, under 80%, or when the control plane can't be read: a page never waits on it or fails for it.
 */
export async function workspaceStorageNotice(tenant: Pick<Tenant, "id" | "entitlements">, now = Date.now()): Promise<StorageNotice | null> {
  const limitBytes = limitBytesOf(tenant);
  if (limitBytes === null || !controlConfigured()) return null;
  try {
    let hit = usedCache.get(tenant.id);
    if (!hit || now - hit.at >= NOTICE_TTL_MS || now < hit.at) {
      const row = await controlDb().tenant.findUnique({ where: { id: tenant.id }, select: { storageUsedBytes: true } });
      hit = { at: now, usedBytes: Number(row?.storageUsedBytes ?? 0) };
      usedCache.set(tenant.id, hit);
    }
    return storageNoticeOf({ usedBytes: hit.usedBytes, limitBytes });
  } catch (err) {
    console.warn(`[storage] the storage notice couldn't be read: ${err instanceof Error ? err.message.split("\n").pop() : String(err)}`);
    return null;
  }
}

/**
 * Where Settings › Billing sends an administrator to add storage: the plan form on that page that sells the Extra
 * storage add-on — buying a plan, a Razorpay change from the next renewal, or the next period by bank transfer — or,
 * when it has no price here or no form takes it (paid at Stripe, or looked after by staff), asking for it. Null
 * without a limit: there is nothing to add.
 */
export type StorageBuy = { kind: "form"; anchor: "choose-plan" | "change-plan" | "next-period"; startsOn: string | null } | { kind: "ask" };

export function storageBuy(input: { limited: boolean; onSale: boolean; mayBuy: boolean; changeFrom: string | null; byTransfer: boolean }): StorageBuy | null {
  if (!input.limited) return null;
  if (!input.onSale) return { kind: "ask" };
  if (input.mayBuy) return { kind: "form", anchor: "choose-plan", startsOn: null };
  if (input.changeFrom) return { kind: "form", anchor: "change-plan", startsOn: input.changeFrom };
  if (input.byTransfer) return { kind: "form", anchor: "next-period", startsOn: null };
  return { kind: "ask" };
}

/** A plan form's starting point with one more pack of `planKey` in it (`?add=storage`). */
export function withOneMore<I extends "MONTH" | "YEAR">(initial: { interval: I; items: { planKey: string; quantity: number }[] } | null, planKey: string): { interval: I | "MONTH"; items: { planKey: string; quantity: number }[] } {
  if (!initial) return { interval: "MONTH", items: [{ planKey, quantity: 1 }] };
  const has = initial.items.some((i) => i.planKey === planKey);
  return { interval: initial.interval, items: has ? initial.items.map((i) => (i.planKey === planKey ? { ...i, quantity: i.quantity + 1 } : i)) : [...initial.items, { planKey, quantity: 1 }] };
}
