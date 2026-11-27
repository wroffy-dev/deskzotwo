"use server";

import { revalidatePath } from "next/cache";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { customerEmailOverview, type CustomerEmailOverview } from "@/lib/customer-emails";
import { setBookingInvite, setProjectStageEmails, setTicketAcknowledgement } from "@/lib/customer-email-settings";
import type { ActionResult } from "@/actions/company";
import { db } from "@/lib/db";
import { MAX_DAILY_LIMIT, addressesAtLimit, customerMailLimit } from "@/lib/customer-mail-cap";

/**
 * Settings › Customer emails (owner, 18 Oct 2026) — src/lib/customer-emails.ts. Whoever changes the
 * workspace's settings reads it and flips its switches; a workflow's own switch is Automate's action.
 */

const NOT_AN_ADMIN = "Only somebody who can change the workspace's settings can see or change this.";
const STILL_UPDATING = "This workspace is still being updated to offer this. Try again in a few minutes.";

export async function getCustomerEmails(): Promise<ActionResult<CustomerEmailOverview>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NOT_AN_ADMIN };
  return { ok: true, data: await customerEmailOverview() };
}

export async function setCustomerEmailSwitch(input: { kind: string; on: boolean }): Promise<ActionResult<{ on: boolean }>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NOT_AN_ADMIN };
  const on = input?.on === true;
  try {
    if (input?.kind === "acknowledge") {
      if (!(await moduleAvailableForTenant("helpdesk"))) return { ok: false, error: "The helpdesk isn't on in this workspace." };
      await setTicketAcknowledgement(on);
      await recordAudit({ userId: user.id, action: "UPDATE", entityType: "SupportMailSettings", entityId: "global", entityLabel: `New tickets by email ${on ? "are" : "aren't"} acknowledged by email` });
    } else if (input?.kind === "booking") {
      if (!(await moduleAvailableForTenant("booking"))) return { ok: false, error: "Booking pages aren't on in this workspace." };
      await setBookingInvite(on, user.id);
      await recordAudit({ userId: user.id, action: "UPDATE", entityType: "CustomerEmailSettings", entityId: "global", entityLabel: `A booking page ${on ? "emails" : "doesn't email"} the guest an invitation` });
    } else if (input?.kind === "projectStages") {
      if (!(await moduleAvailableForTenant("projects"))) return { ok: false, error: "Projects aren't on in this workspace." };
      await setProjectStageEmails(on, user.id);
      await recordAudit({ userId: user.id, action: "UPDATE", entityType: "CustomerEmailSettings", entityId: "global", entityLabel: `A project's customer ${on ? "is" : "isn't"} emailed when a stage changes` });
    } else {
      return { ok: false, error: "That isn't a switch on this page." };
    }
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: STILL_UPDATING };
    throw err;
  }
  revalidatePath("/settings/customer-emails");
  revalidatePath("/settings/support-email");
  return { ok: true, data: { on } };
}

/**
 * The most emails one customer gets in 24 hours (owner, 13 Nov 2026 — src/lib/customer-mail-cap.ts): the limit, and who
 * is at it now. Whoever changes the workspace's settings reads and sets it.
 */
export async function getCustomerMailLimit(): Promise<ActionResult<{ limit: number | null; atLimit: { address: string; count: number }[] }>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NOT_AN_ADMIN };
  return { ok: true, data: { limit: await customerMailLimit(), atLimit: await addressesAtLimit() } };
}

/** Null: no limit. */
export async function setCustomerMailLimit(input: { limit: number | null }): Promise<ActionResult<{ limit: number | null }>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NOT_AN_ADMIN };
  const limit = input?.limit ?? null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > MAX_DAILY_LIMIT)) {
    return { ok: false, error: `The limit: a whole number from 1 to ${MAX_DAILY_LIMIT}, or empty for none.` };
  }
  try {
    await db.customerEmailSettings.upsert({
      where: { id: "global" },
      create: { id: "global", maxPerRecipientPerDay: limit, updatedById: user.id },
      update: { maxPerRecipientPerDay: limit, updatedById: user.id },
      select: { id: true },
    });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: STILL_UPDATING };
    throw err;
  }
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "CustomerEmailSettings",
    entityId: "global",
    entityLabel: limit === null ? "No limit on emails to one customer in 24 hours" : `At most ${limit} email${limit === 1 ? "" : "s"} to one customer in 24 hours`,
  });
  revalidatePath("/settings/customer-emails");
  return { ok: true, data: { limit } };
}
