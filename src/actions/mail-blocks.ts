"use server";

import { revalidatePath } from "next/cache";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { readBlockValue } from "@/lib/mail-block-rules";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Blocked addresses (owner, 31 Oct 2026 — src/lib/mail-blocks.ts): an address or a whole domain the
 * workspace never mails, or only stops marketing and reminders to. Whoever changes the workspace's settings keeps the
 * list. Each is a `Suppression` row by hand, so Marketing › Suppressions shows it too.
 *
 * A block of an address somebody unsubscribed, bounced or complained from keeps that reason: taking the block off
 * only stops it covering all mail — the customer's own decision stays theirs.
 */

const NOT_AN_ADMIN = "Only somebody who can change the workspace's settings can see or change this.";
const STILL_UPDATING = "This workspace is still being updated to block all mail. Try again in a few minutes.";

export type MailBlockRow = {
  id: string;
  scope: "EMAIL" | "DOMAIN";
  value: string;
  reason: string;
  allMail: boolean;
  note: string | null;
  by: string | null;
  createdAt: Date;
};

async function admin(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NOT_AN_ADMIN };
  return { ok: true, userId: user.id };
}

async function changer(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  return admin();
}

/** The blocks by hand, newest first — and whether this workspace can block all mail yet. */
export async function listMailBlocks(): Promise<ActionResult<{ rows: MailBlockRow[]; allMailReady: boolean }>> {
  const who = await admin();
  if (!who.ok) return who;
  const where = { scope: { in: ["EMAIL", "DOMAIN"] as ("EMAIL" | "DOMAIN")[] } };
  const base = { id: true, scope: true, value: true, reason: true, note: true, createdAt: true, createdBy: { select: { name: true } } } as const;
  let allMailReady = true;
  let rows: { id: string; scope: string; value: string; reason: string; note: string | null; createdAt: Date; createdBy: { name: string } | null; allMail?: boolean }[];
  try {
    // A block by hand, or anything else somebody has blocked from all mail.
    rows = await db.suppression.findMany({ where: { ...where, OR: [{ reason: "MANUAL" }, { allMail: true }] }, orderBy: { createdAt: "desc" }, take: 500, select: { ...base, allMail: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    allMailReady = false;
    rows = await db.suppression.findMany({ where: { ...where, reason: "MANUAL" }, orderBy: { createdAt: "desc" }, take: 500, select: base });
  }
  return {
    ok: true,
    data: {
      allMailReady,
      rows: rows.map((r) => ({ id: r.id, scope: r.scope as "EMAIL" | "DOMAIN", value: r.value, reason: r.reason, allMail: r.allMail === true, note: r.note, by: r.createdBy?.name ?? null, createdAt: r.createdAt })),
    },
  };
}

export async function addMailBlock(input: { scope: string; value: string; allMail: boolean; note?: string }): Promise<ActionResult<{ value: string }>> {
  const who = await changer();
  if (!who.ok) return who;
  const scope = input?.scope === "DOMAIN" ? "DOMAIN" : input?.scope === "EMAIL" ? "EMAIL" : null;
  if (!scope) return { ok: false, error: "Block an address or a domain." };
  const read = readBlockValue(scope, String(input?.value ?? ""));
  if (!read.ok) return read;
  const allMail = input?.allMail === true;
  const note = String(input?.note ?? "").trim().slice(0, 300) || null;
  try {
    await db.suppression.upsert({
      where: { scope_value: { scope, value: read.value } },
      create: { scope, value: read.value, reason: "MANUAL", allMail, note, createdById: who.userId },
      // Already on the list (by hand, or a bounce or an unsubscribe): its reason stays, the reach is what's chosen now.
      update: { allMail, ...(note ? { note } : {}) },
    });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: STILL_UPDATING };
    throw err;
  }
  await recordAudit({
    userId: who.userId,
    action: "CREATE",
    entityType: "Suppression",
    entityId: read.value,
    entityLabel: `${scope === "DOMAIN" ? "Domain" : "Address"} ${read.value} blocked from ${allMail ? "all mail" : "marketing and reminders"}`,
  });
  revalidatePath("/settings/blocked-addresses");
  revalidatePath("/marketing/suppressions");
  return { ok: true, data: { value: read.value } };
}

/** All mail, or marketing and reminders only. */
export async function setMailBlockReach(id: string, allMail: boolean): Promise<ActionResult<null>> {
  const who = await changer();
  if (!who.ok) return who;
  if (typeof id !== "string" || !id) return { ok: false, error: "That block no longer exists." };
  const row = await db.suppression.findUnique({ where: { id }, select: { value: true, scope: true } });
  if (!row || (row.scope !== "EMAIL" && row.scope !== "DOMAIN")) return { ok: false, error: "That block no longer exists." };
  try {
    await db.suppression.update({ where: { id }, data: { allMail: allMail === true } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: STILL_UPDATING };
    throw err;
  }
  await recordAudit({ userId: who.userId, action: "UPDATE", entityType: "Suppression", entityId: row.value, entityLabel: `${row.value} now blocked from ${allMail ? "all mail" : "marketing and reminders only"}` });
  revalidatePath("/settings/blocked-addresses");
  revalidatePath("/marketing/suppressions");
  return { ok: true, data: null };
}

/** Taken off: a block by hand goes; anything else only stops covering all mail. */
export async function removeMailBlock(id: string): Promise<ActionResult<{ kept: boolean }>> {
  const who = await changer();
  if (!who.ok) return who;
  if (typeof id !== "string" || !id) return { ok: false, error: "That block no longer exists." };
  const row = await db.suppression.findUnique({ where: { id }, select: { value: true, scope: true, reason: true } });
  if (!row || (row.scope !== "EMAIL" && row.scope !== "DOMAIN")) return { ok: false, error: "That block no longer exists." };
  const kept = row.reason !== "MANUAL";
  try {
    if (kept) await db.suppression.update({ where: { id }, data: { allMail: false } });
    else await db.suppression.delete({ where: { id } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: STILL_UPDATING };
    throw err;
  }
  await recordAudit({ userId: who.userId, action: kept ? "UPDATE" : "DELETE", entityType: "Suppression", entityId: row.value, entityLabel: kept ? `${row.value} no longer blocked from all mail` : `${row.value} unblocked` });
  revalidatePath("/settings/blocked-addresses");
  revalidatePath("/marketing/suppressions");
  return { ok: true, data: { kept } };
}
