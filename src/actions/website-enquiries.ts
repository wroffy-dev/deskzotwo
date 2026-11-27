"use server";

import { leadCapacityError } from "@/lib/leads/limits";
import { LeadRuleRefused } from "@/lib/leads/intake-owner";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/authz/resolve";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { EnquiryRefused, acceptEnquiry, dismissEnquiry, holdsWebsiteEnquiries, listEnquiries, pendingEnquiries, type AcceptChoice, type EnquiryRow } from "@/lib/lead-capture/review";
import type { ActionResult } from "@/actions/company";

/**
 * Website enquiries held for review (owner, 9 Nov 2026 — src/lib/lead-capture/review.ts): decided by whoever may assign
 * leads; held or not as an admin chooses on Settings › Lead capture API.
 */

async function reviewer() {
  const user = await requireModuleAccess("leads");
  return (await can(user.id, "leads.assign")) ? user : null;
}

export async function listWebsiteEnquiries(which: "pending" | "decided"): Promise<{ rows: EnquiryRow[]; held: boolean } | null> {
  if (!(await reviewer())) return null;
  const [rows, held] = await Promise.all([listEnquiries(which), holdsWebsiteEnquiries()]);
  return { rows, held };
}

/** How many wait, for the Leads page's button — none shown to somebody who can't decide them. */
export async function waitingEnquiries(): Promise<number> {
  if (!(await reviewer())) return 0;
  return pendingEnquiries();
}

export async function acceptWebsiteEnquiry(id: string, choice: AcceptChoice): Promise<ActionResult<{ leadId: string | null }>> {
  const user = await reviewer();
  if (!user) return { ok: false, error: "Deciding website enquiries needs the right to assign leads." };
  try {
    const result = await acceptEnquiry(String(id), choice, user.id);
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "WebsiteEnquiry", entityId: String(id), entityLabel: `Accepted ${choice.kind === "existing" ? "onto a company on file" : choice.kind === "new" ? `as ${choice.name}` : "as an individual"}` });
    revalidatePath("/leads");
    return { ok: true, data: { leadId: result.status === "created" || result.status === "duplicate" ? result.leadId : null } };
  } catch (err) {
    if (err instanceof EnquiryRefused) return { ok: false, error: err.message };
    // The plan's lead cap, or a rule set to refuse when everybody is full (Phase 4 lead limits): said, not a 500.
    const full = leadCapacityError(err);
    if (full) return { ok: false, error: full.message };
    if (err instanceof LeadRuleRefused) return { ok: false, error: err.message };
    throw err;
  }
}

export async function dismissWebsiteEnquiry(id: string, why?: string): Promise<ActionResult<null>> {
  const user = await reviewer();
  if (!user) return { ok: false, error: "Deciding website enquiries needs the right to assign leads." };
  try {
    await dismissEnquiry(String(id), user.id, why ?? null);
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "WebsiteEnquiry", entityId: String(id), entityLabel: `Dismissed${why ? ` — ${why}` : ""}` });
    revalidatePath("/leads");
    return { ok: true, data: null };
  } catch (err) {
    if (err instanceof EnquiryRefused) return { ok: false, error: err.message };
    throw err;
  }
}

/** The admin's choice, on Settings › Lead capture API: hold website enquiries for review, or make leads at once. */
export async function enquiryHoldSetting(): Promise<{ hold: boolean; waiting: number } | null> {
  const user = await requireModuleUser("leads");
  if (!(await can(user.id, "settings.manage"))) return null;
  return { hold: await holdsWebsiteEnquiries(), waiting: await pendingEnquiries() };
}

export async function setEnquiryHold(hold: boolean): Promise<ActionResult<null>> {
  const user = await requireModuleUser("leads");
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "You can't change settings." };
  await db.leadReviewSettings.upsert({ where: { id: "default" }, create: { id: "default", holdWebsite: !!hold, updatedById: user.id }, update: { holdWebsite: !!hold, updatedById: user.id } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LeadReviewSettings", entityId: "default", entityLabel: hold ? "Website enquiries held for review" : "Website enquiries become leads at once" });
  revalidatePath("/settings/lead-capture");
  return { ok: true, data: null };
}
