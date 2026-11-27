"use server";

import { headers } from "next/headers";
import { db } from "@/lib/db";
import { callerKeyIp, clientIpFrom } from "@/lib/client-ip";
import { withinCallerBudget } from "@/lib/security/caller-budget";
import { tenantKey } from "@/lib/tenancy/cache";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { workspaceClock } from "@/lib/time/workspace";
import { FIELD_KINDS } from "@/lib/cards/fields";
import { loadCard, publicCard, recordCardEvent } from "@/lib/cards/server";
import { boothEvent, liveEventOf } from "@/lib/cards/events-server";
import { recordCardContact } from "@/lib/cards/capture";
import type { ActionResult } from "@/actions/company";

/**
 * A digital card's public page (/c/<handle>), for whoever was handed the card — nobody signed in.
 *
 * The card's address is not a secret: it is printed on a QR code and passed around, so what it opens
 * is only what the card shows, and the one thing it accepts is somebody's own details, given freely.
 *
 *   · No CAPTCHA, as on the public forms: a hidden field and a minimum fill time, and both answer a bot
 *     with the same thanks a person gets.
 *   · Counted in the database rather than by address: at most ten share-backs a card in ten minutes —
 *     sixty on an event's booth form, where a queue at the stand is the point — and sixty a minute
 *     across the workspace — and by the caller's address too, in memory only (RL-03, below). Nothing about who
 *     sent them is kept.
 *   · Saving the card never needs this. Sharing back is offered below it, never in front of it — except
 *     on a booth form, which a team member opened on purpose for visitors to fill in.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9][0-9 ()-]{5,30}$/;

export type ShareBackInput = {
  handle: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  message?: string;
  /** The questions asked — the event's on a booth form, the template's otherwise — by id. */
  answers?: Record<string, string>;
  /** A booth form's event code (/c/<handle>?e=<code>). */
  event?: string;
  /** Hidden field. A real person never fills it in. */
  website?: string;
  /** Milliseconds the form was on screen. */
  elapsedMs?: number;
};

/** Share-backs a minute across the workspace, and how far past it a known caller under its own cap may go (RL-03). */
const SHARE_BACK_PER_MINUTE = 60;
const SHARE_BACK_CEILING_FACTOR = 10;

const BUSY = "A lot of people have shared their details with this card just now. Please try again in a few minutes.";

export async function shareBackFromCard(input: ShareBackInput): Promise<ActionResult<{ firstName: string }>> {
  if (!(await moduleAvailableForTenant("cards"))) return { ok: false, error: "This card isn't available." };
  const card = await publicCard(String(input.handle ?? ""));
  if (!card || card.state !== "live") return { ok: false, error: "This card isn't taking details just now." };
  const holder = await db.digitalCard.findUnique({ where: { id: card.cardId }, select: { userId: true, user: { select: { name: true } } } });
  if (!holder) return { ok: false, error: "This card isn't taking details just now." };

  // A booth form while its event runs; otherwise the one event the holder is working today, if any.
  const today = (await workspaceClock()).today();
  const booth = await boothEvent(input.event, holder.userId, today);
  if (!booth && !card.shareBack) return { ok: false, error: "This card isn't taking details just now." };
  const event = booth ? { id: booth.id, name: booth.name } : await liveEventOf(holder.userId, today);
  const questions = booth?.questions.length ? booth.questions : card.questions;
  const thanks = { ok: true as const, data: { firstName: card.firstName } };

  // Both bot checks answer with success. Telling a bot it was detected only teaches it.
  if (input.website?.trim()) return thanks;
  if (typeof input.elapsedMs === "number" && input.elapsedMs < 2000) return thanks;

  const name = String(input.name ?? "").trim().slice(0, 120);
  const email = String(input.email ?? "").trim().toLowerCase().slice(0, 200);
  const phone = String(input.phone ?? "").trim().slice(0, 32);
  const company = String(input.company ?? "").trim().slice(0, 160);
  const jobTitle = String(input.jobTitle ?? "").trim().slice(0, 80);
  const message = String(input.message ?? "").trim().slice(0, 1000);
  if (!name) return { ok: false, error: "Your name, please." };
  if (!email && !phone) return { ok: false, error: "An email address or a phone number, so they can reach you." };
  if (email && !EMAIL.test(email)) return { ok: false, error: "That email address doesn't look right." };
  if (phone && !PHONE.test(phone)) return { ok: false, error: "That phone number doesn't look right." };

  // Only the questions the form asks, and every required one answered.
  const answers: { label: string; answer: string }[] = [];
  for (const q of questions) {
    const answer = String(input.answers?.[q.id] ?? "").trim().slice(0, 500);
    if (!answer && q.required) return { ok: false, error: `Please answer: ${q.label}` };
    if (answer) answers.push({ label: q.label, answer });
  }

  /**
   * Security review, 15 Nov 2026 — RL-03: one caller could fill the workspace's sixty a minute and close every card's
   * share-back for everybody. Now a caller is held to its own cap first (by its address, an IPv6 one by its /64; ten in
   * ten minutes, sixty on a booth form, where one tablet at the stand takes the queue's details). Past the workspace
   * cap a caller whose address is known and is under its own still goes through, up to SHARE_BACK_CEILING_FACTOR times
   * it; only a caller whose address isn't known (no cap of its own to hold it to) is refused past the workspace cap.
   */
  let ip: string | null = null;
  try {
    ip = clientIpFrom(await headers());
  } catch {
    ip = null;
  }
  if (ip) {
    const caller = `${await tenantKey()}|card-share-back-caller:${booth ? "booth" : "card"}:${callerKeyIp(ip)}`;
    if (!withinCallerBudget([{ key: caller, max: booth ? 60 : 10 }], 10 * 60_000)) return { ok: false, error: BUSY };
  }

  /**
   * Counted and taken in one transaction, under one lock (owner, 12 Nov 2026 — Phase 4, audit M-17): the share-back's
   * own event is written there, and it is what's counted — so share-backs sent at once queue, and a burst can't all read
   * "under the limit" and all pass. (The contact is written after, by the card's own path; counting contacts, as before,
   * couldn't be done under the lock — and counted the team's own scans as share-backs.)
   */
  const taken = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('deskzo:card-share-back'))`;
    const lately = await tx.cardEvent.count({ where: { cardId: card.cardId, kind: "SHARE_BACK", at: { gte: new Date(Date.now() - 10 * 60_000) } } });
    const everywhere = await tx.cardEvent.count({ where: { kind: "SHARE_BACK", at: { gte: new Date(Date.now() - 60_000) } } });
    if (lately >= (booth ? 60 : 10)) return false;
    if (everywhere >= SHARE_BACK_PER_MINUTE && (!ip || everywhere >= SHARE_BACK_PER_MINUTE * SHARE_BACK_CEILING_FACTOR)) return false;
    await tx.cardEvent.create({ data: { cardId: card.cardId, kind: "SHARE_BACK" } });
    return true;
  });
  if (!taken) return { ok: false, error: BUSY };

  await recordCardContact({
    cardId: card.cardId,
    owner: { id: holder.userId, name: holder.user.name },
    via: booth ? "BOOTH" : "SHARE_BACK",
    event,
    person: { name, email, phone, company, jobTitle, message, answers },
  });
  return thanks;
}

const TAP_KINDS = new Set<string>(FIELD_KINDS.map((k) => k.kind));

/** A link or number on the card was tapped — counted, never more. */
export async function recordCardTap(handle: string, kind: string): Promise<void> {
  if (!TAP_KINDS.has(kind)) return;
  if (!(await moduleAvailableForTenant("cards"))) return;
  const card = await loadCard({ handle: String(handle ?? "") });
  if (!card || card.status !== "ACTIVE") return;
  await recordCardEvent(card.id, "TAP", kind);
}
