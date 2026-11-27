"use server";

import { revalidatePath } from "next/cache";
import { tooLong } from "@/lib/validation/text";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { refuseWhileViewingAs } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { renewalConfig, type RenewalConfig } from "@/lib/renewal-lapse";
import { PEOPLE_ONLY } from "@/lib/people";
import { isFreeMailbox } from "@/lib/email-verification";
import { notifyUser } from "@/lib/notify";
import { TEAM_COPIES_MAX } from "@/lib/renewal-team-copies";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Renewals (owner, 26 Oct 2026 — src/lib/renewal-lapse.ts): after how many days a subscription nobody
 * renewed or marked is marked Lost. And (30 Oct 2026 — src/lib/renewal-watch-rules.ts) who is reminded before it ends
 * and when, who is told when nobody has started it, how far ahead the renewal task is raised, and Monday's list.
 * `settings.manage`, as the catalogue gates the page, where Renewals is on.
 */

const DENIED = "Only somebody who manages settings can change how renewals are handled.";

export async function renewalSettingsView(): Promise<ActionResult<RenewalConfig>> {
  const user = await requireModuleUser("renewals");
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: DENIED };
  return { ok: true, data: await renewalConfig() };
}

const days = (what: string) => z.number().int().min(1, `${what}: at least a day`).max(365, `${what}: a year at most`);

const schema = z.object({
  /** Null: never mark them Lost by themselves. */
  lapseLostAfterDays: days("Marked Lost").nullable(),
  // The rest are left as they are when not sent.
  reminderDays: z.array(days("A reminder")).max(8, "Eight reminders at most").optional(),
  escalateManagerDays: days("Their manager told").nullable().optional(),
  escalateAdminDays: days("The admins told").nullable().optional(),
  taskLeadDays: days("The renewal task").nullable().optional(),
  weeklyList: z.boolean().optional(),
  /** Who hears about a renewal nobody looks after (owner, 30 Oct 2026); empty, every admin. Left as it is when not sent. */
  nobodyRecipientIds: z.array(z.string().max(100, tooLong(100)).min(1)).max(25, "Twenty-five people at most").optional(),
  /** Days before its end the customer is reminded by itself (owner, 30 Oct 2026); empty, never. */
  customerReminderDays: z.array(days("A customer reminder")).max(6, "Six customer reminders at most").optional(),
  /** Copied on it (owner, 13 Nov 2026): addresses, and the renewal's manager. Left as they are when not sent. */
  customerReminderCc: z.array(z.string().trim().toLowerCase().email("Copy to: a valid email address each").max(200)).max(10, "Ten addresses to copy at most").optional(),
  customerReminderCcManager: z.boolean().optional(),
  /** Copied on the team's renewal reminder emails (owner, 23 Nov 2026). Left as they are when not sent. */
  teamReminderCc: z.array(z.string().trim().toLowerCase().email("Copy the team's reminders to: a valid email address each").max(200)).max(TEAM_COPIES_MAX, "Ten addresses to copy the team's reminders to at most").optional(),
});

/**
 * Security audit round three, 14 Nov 2026 (low, "renewal reminders can be CC'd to any outside address"): a copy of every
 * customer's renewal reminder — their name, what they pay, when it ends — could be sent to any address at all. Now an
 * address must be a person working here, or at a domain the workspace's own people use (not Gmail and the like). The
 * workspace has no separately verified mail domain, so its people's addresses are what say which domains are its own.
 * Returns the addresses that are neither.
 */
async function outsideAddresses(emails: string[]): Promise<string[]> {
  const people = await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, select: { email: true } });
  const exact = new Set(people.map((p) => p.email.trim().toLowerCase()));
  const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  const own = new Set([...exact].map(domainOf).filter((d) => d && !isFreeMailbox(d)));
  return emails.filter((e) => !exact.has(e) && !own.has(domainOf(e)));
}

export async function saveRenewalSettings(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("renewals");
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: DENIED };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the days." };
  const { lapseLostAfterDays, nobodyRecipientIds, customerReminderDays, customerReminderCc, customerReminderCcManager, teamReminderCc, ...watch } = parsed.data;
  const ccEmails = customerReminderCc ? [...new Set(customerReminderCc)] : undefined;
  if (ccEmails?.length) {
    const outside = await outsideAddresses(ccEmails);
    if (outside.length) {
      return { ok: false, error: `Customer reminders can be copied only to people working here, or to an address at your own company's domain. ${outside.slice(0, 3).join(", ")}${outside.length > 3 ? "…" : ""} ${outside.length === 1 ? "isn't" : "aren't"}.` };
    }
  }
  // The team's reminders name the customer, what they have and when it ends: the same rule as the customer's copies.
  const teamCc = teamReminderCc ? [...new Set(teamReminderCc)] : undefined;
  if (teamCc?.length) {
    const outside = await outsideAddresses(teamCc);
    if (outside.length) {
      return { ok: false, error: `The team's renewal reminders can be copied only to people working here, or to an address at your own company's domain. ${outside.slice(0, 3).join(", ")}${outside.length > 3 ? "…" : ""} ${outside.length === 1 ? "isn't" : "aren't"}.` };
    }
  }
  const customerDays = customerReminderDays ? [...new Set(customerReminderDays)].sort((a, b) => b - a) : undefined;
  // Only people working here now: an id typed in, or somebody since switched off, isn't kept.
  const nobodyPeople = nobodyRecipientIds?.length
    ? await db.user.findMany({ where: { id: { in: [...new Set(nobodyRecipientIds)] }, active: true, ...PEOPLE_ONLY }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];
  if (nobodyRecipientIds && nobodyPeople.length !== new Set(nobodyRecipientIds).size) return { ok: false, error: "Choose people who are working here now." };
  if (watch.reminderDays) watch.reminderDays = [...new Set(watch.reminderDays)].sort((a, b) => b - a);
  const watchMigrated = (await renewalConfig()).watchMigrated;
  const watchFields = watchMigrated ? watch : {};
  if (watchMigrated) {
    await db.renewalSettings.upsert({
      where: { id: "default" },
      create: { id: "default", lapseLostAfterDays, ...watchFields, updatedById: user.id },
      update: { lapseLostAfterDays, ...watchFields, updatedById: user.id },
      select: { id: true },
    });
  } else {
    // Still waiting for 20261130150000_renewal_watch: only what it has a column for. Not an upsert — Prisma writes a
    // list's default (`reminderDays`) into every insert itself, and the column isn't there yet.
    const { count } = await db.renewalSettings.updateMany({ where: { id: "default" }, data: { lapseLostAfterDays, updatedById: user.id } });
    if (count === 0) {
      await db.$executeRaw`INSERT INTO "renewal_settings" ("id", "lapseLostAfterDays", "updatedById", "updatedAt") VALUES ('default', ${lapseLostAfterDays}, ${user.id}, now()) ON CONFLICT ("id") DO UPDATE SET "lapseLostAfterDays" = EXCLUDED."lapseLostAfterDays", "updatedById" = EXCLUDED."updatedById", "updatedAt" = now()`;
    }
  }
  const config = await renewalConfig();
  if (nobodyRecipientIds && config.nobodyMigrated) {
    await db.renewalSettings.updateMany({ where: { id: "default" }, data: { nobodyRecipientIds: nobodyPeople.map((p) => p.id) } });
  }
  if (customerDays && config.customerMigrated) {
    await db.renewalSettings.updateMany({ where: { id: "default" }, data: { customerReminderDays: customerDays } });
  }
  const copying = config.customerCopies.migrated && (ccEmails !== undefined || customerReminderCcManager !== undefined);
  // R3 low: who is copied, as it was — the super admin is told when the list of addresses changes.
  const ccBefore = copying && ccEmails ? ((await db.renewalSettings.findUnique({ where: { id: "default" }, select: { customerReminderCc: true } }).catch(() => null))?.customerReminderCc ?? []) : null;
  if (copying) {
    await db.renewalSettings.updateMany({
      where: { id: "default" },
      data: { ...(ccEmails ? { customerReminderCc: ccEmails } : {}), ...(customerReminderCcManager !== undefined ? { customerReminderCcManager } : {}) },
    });
  }
  // Left as they are when not sent, and before 20261223500000_renewal_team_cc.
  const teamSaved = config.teamCopies.migrated && teamCc ? teamCc : null;
  const teamCcBefore = teamSaved ? config.teamCopies.emails : null;
  if (teamSaved) await db.renewalSettings.updateMany({ where: { id: "default" }, data: { teamReminderCc: teamSaved } });
  const said = [lapseLostAfterDays ? `a subscription not renewed is marked Lost ${lapseLostAfterDays} days after it ends` : "a subscription not renewed is never marked Lost by itself"];
  if ("reminderDays" in watchFields && watchFields.reminderDays) said.push(watchFields.reminderDays.length ? `reminders ${watchFields.reminderDays.join(", ")} days before` : "no reminders");
  if ("escalateManagerDays" in watchFields) said.push(watchFields.escalateManagerDays ? `manager told ${watchFields.escalateManagerDays} days before if not started` : "manager never told");
  if ("escalateAdminDays" in watchFields) said.push(watchFields.escalateAdminDays ? `admins told ${watchFields.escalateAdminDays} days before` : "admins never told");
  if ("taskLeadDays" in watchFields) said.push(watchFields.taskLeadDays ? `renewal task ${watchFields.taskLeadDays} days ahead` : "no renewal task");
  if ("weeklyList" in watchFields) said.push(watchFields.weeklyList ? "Monday's list on" : "Monday's list off");
  if (copying) {
    const copies = [...(customerReminderCcManager ? ["the renewal manager"] : []), ...(ccEmails ?? [])];
    said.push(copies.length ? `customer reminders copied to ${copies.join(", ")}` : "customer reminders copied to nobody");
  }
  if (teamSaved) said.push(teamSaved.length ? `the team's reminders copied to ${teamSaved.join(", ")}` : "the team's reminders copied to nobody");
  if (customerDays && config.customerMigrated) said.push(customerDays.length ? `customers reminded ${customerDays.join(", ")} days before` : "customers not reminded by themselves");
  if (nobodyRecipientIds && config.nobodyMigrated) said.push(nobodyPeople.length ? `renewals nobody looks after go to ${nobodyPeople.map((p) => p.name).join(", ")}` : "renewals nobody looks after go to every admin");
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "RenewalSettings", entityId: "default", entityLabel: `Renewals: ${said.join("; ")}` });
  if (ccBefore && ccEmails && [...ccBefore].sort().join(",") !== [...ccEmails].sort().join(",")) {
    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true } });
    if (superAdmin && superAdmin.id !== user.id) {
      await notifyUser({
        userId: superAdmin.id,
        type: "SECURITY_ALERT",
        title: "Who customer renewal reminders are copied to changed",
        message: `${user.name ?? "Somebody"} changed it from ${ccBefore.length ? ccBefore.join(", ") : "nobody"} to ${ccEmails.length ? ccEmails.join(", ") : "nobody"}.`,
        link: "/settings/renewals",
      });
    }
  }
  if (teamCcBefore && teamSaved && [...teamCcBefore].sort().join(",") !== [...teamSaved].sort().join(",")) {
    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true } });
    if (superAdmin && superAdmin.id !== user.id) {
      await notifyUser({
        userId: superAdmin.id,
        type: "SECURITY_ALERT",
        title: "Who the team's renewal reminders are copied to changed",
        message: `${user.name ?? "Somebody"} changed it from ${teamCcBefore.length ? teamCcBefore.join(", ") : "nobody"} to ${teamSaved.length ? teamSaved.join(", ") : "nobody"}.`,
        link: "/settings/renewals",
      });
    }
  }
  revalidatePath("/settings/renewals");
  return { ok: true, data: null };
}
