import { controlDb } from "@/lib/platform/control-db";
import { tenantBySlug } from "@/lib/tenancy/registry";
import { runAsTenant } from "@/lib/tenancy/resolve";
import { SLUG_PATTERN } from "@/lib/workspace-names";
import type { Standing } from "@/lib/billing/lifecycle";

/**
 * Deskzo sells with Deskzo (owner, 18 Nov 2026 — "deskzo sales team would also need a crm so how do we manage this?"):
 * one of the platform's own workspaces — Deskzo's — is the sales team's CRM, and the platform feeds it what only the
 * platform sees: a contact-form enquiry from deskzo.com, a new workspace signed up, and each change in how a workspace
 * stands with billing (trial, paying, past due, ending, lapsed). Demo bookings need nothing here: deskzo.com's pop-up
 * books straight into that workspace (src/lib/platform/site-booking.ts).
 *
 * What goes across is the sign-up's own contact and the plan's state only — never anything from inside a customer's
 * workspace. Set in the console (Settings › Sales CRM; `sales.crm.workspace` among the platform's settings). Nothing
 * here may stop what called it: every failure is logged and swallowed.
 */

const WORKSPACE_KEY = "sales.crm.workspace";
const leadKey = (tenantId: string) => `sales.crm.lead:${tenantId}`;
const standingKey = (tenantId: string) => `sales.crm.standing:${tenantId}`;

export async function salesCrmWorkspace(): Promise<string | null> {
  try {
    const row = await controlDb().platformSetting.findUnique({ where: { key: WORKSPACE_KEY }, select: { value: true } });
    const slug = row?.value?.trim() ?? "";
    return SLUG_PATTERN.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

/** Names the workspace the sales team works in — none: nothing goes across. It must be a workspace that is open. */
export async function setSalesCrmWorkspace(slug: string | null, by: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const value = (slug ?? "").trim().toLowerCase();
  if (value) {
    if (!SLUG_PATTERN.test(value)) return { ok: false, error: "A workspace's name: lower-case letters, digits and hyphens, as in its address." };
    const tenant = await tenantBySlug(value);
    if (!tenant || tenant.status !== "ACTIVE") return { ok: false, error: `There's no open workspace called ${value}.` };
  }
  await controlDb().platformSetting.upsert({ where: { key: WORKSPACE_KEY }, create: { key: WORKSPACE_KEY, value: value || null, updatedBy: by }, update: { value: value || null, updatedBy: by } });
  return { ok: true };
}

/** Runs `work` inside the sales CRM's workspace — null when none is set or it isn't open. */
async function inCrm<T>(work: () => Promise<T>): Promise<T | null> {
  const slug = await salesCrmWorkspace();
  if (!slug) return null;
  const tenant = await tenantBySlug(slug);
  if (!tenant || tenant.status !== "ACTIVE") return null;
  return runAsTenant(tenant, work);
}

export type CrmContact = { name: string; email: string; phone?: string | null; company?: string | null };

/**
 * A lead in the sales CRM, as a website enquiry makes one (src/lib/lead-capture/intake.ts): its company and contact
 * found or made, given out by the workspace's own lead rules. The lead's id, or null.
 */
async function openLead(source: string, who: CrmContact, title: string, message: string): Promise<string | null> {
  const { intakeLead, leadPayloadSchema } = await import("@/lib/lead-capture/intake");
  const payload = leadPayloadSchema.safeParse({
    name: who.name,
    email: who.email,
    phone: who.phone || undefined,
    company: who.company || undefined,
    message: message.slice(0, 5000),
    source: "WEBSITE",
  });
  if (!payload.success) return null;
  const made = await intakeLead(
    { id: null, name: source, sourceLabel: source, createdById: null },
    payload.data,
    { leadTitle: title, notifyTitle: title, raisedBy: null, path: "platform" },
  );
  return made.status === "created" || made.status === "duplicate" ? made.leadId : null;
}

/** A deskzo.com contact-form message, as a lead in the sales CRM. */
export async function enquiryToSalesCrm(who: CrmContact & { topic: string; message: string; product?: string | null }): Promise<void> {
  try {
    await inCrm(() =>
      openLead("deskzo.com contact form", who, `deskzo.com — ${who.topic}${who.product ? ` (${who.product})` : ""} — ${who.company || who.name}`, [`Topic: ${who.topic}`, who.product ? `Product: ${who.product}` : null, "", who.message].filter((l) => l !== null).join("\n")),
    );
  } catch (err) {
    console.error(`[sales-crm] an enquiry couldn't go to the sales CRM: ${err instanceof Error ? err.name : "error"}`);
  }
}

/** A new workspace, as a lead in the sales CRM — remembered against the workspace so its billing changes follow it. */
export async function signupToSalesCrm(signup: { tenantId: string; workspace: string; slug: string; owner: CrmContact; product: string | null; plan: string | null; trialEndsAt: Date | null }): Promise<void> {
  try {
    const lines = [
      `Signed up: ${signup.workspace} (${signup.slug})`,
      signup.product ? `Product: ${signup.product}` : null,
      signup.plan ? `Plan: ${signup.plan}` : null,
      signup.trialEndsAt ? `Trial ends: ${signup.trialEndsAt.toISOString().slice(0, 10)}` : null,
    ].filter(Boolean);
    const leadId = await inCrm(() => openLead("Deskzo sign-ups", { ...signup.owner, company: signup.owner.company || signup.workspace }, `Sign-up — ${signup.workspace}`, lines.join("\n")));
    if (leadId) {
      await controlDb().platformSetting.upsert({ where: { key: leadKey(signup.tenantId) }, create: { key: leadKey(signup.tenantId), value: leadId, updatedBy: "platform" }, update: { value: leadId, updatedBy: "platform" } });
    }
  } catch (err) {
    console.error(`[sales-crm] a sign-up couldn't go to the sales CRM: ${err instanceof Error ? err.name : "error"}`);
  }
}

/** How a standing reads on the lead. */
export function standingWords(s: Standing): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  switch (s.kind) {
    case "paid":
      return "Paying";
    case "trial":
      return `On trial, to ${day(s.endsAt)}`;
    case "trial-over":
      return `Trial over, not bought — held on ${day(s.holdAt)}`;
    case "past-due":
      return `A payment failed — held on ${day(s.holdAt)} unless paid`;
    case "ending":
      return `Cancelled — runs to ${day(s.holdAt)}`;
    case "lapsed":
      return "Lapsed — nothing live";
    case "exempt":
      return "On a plan given by hand";
    default:
      return "No plan";
  }
}

/**
 * Each workspace's billing standing, as a note on its sign-up lead when it changed since the last one sent — trial to
 * paying, paying to past due, cancelled, lapsed. Run after the platform's billing pass (src/app/api/platform/tick).
 */
export async function standingsToSalesCrm(standings: { tenantId: string; standing: Standing }[]): Promise<number> {
  if (!standings.length || !(await salesCrmWorkspace())) return 0;
  let sent = 0;
  try {
    const keys = standings.flatMap((s) => [leadKey(s.tenantId), standingKey(s.tenantId)]);
    const rows = await controlDb().platformSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
    const value = new Map(rows.map((r) => [r.key, r.value]));
    const changed = standings.filter((s) => value.get(leadKey(s.tenantId)) && value.get(standingKey(s.tenantId)) !== s.standing.kind);
    if (!changed.length) return 0;
    await inCrm(async () => {
      const { db } = await import("@/lib/db");
      const { automationUserId } = await import("@/lib/automation-user");
      const by = await automationUserId();
      for (const s of changed) {
        const leadId = value.get(leadKey(s.tenantId))!;
        const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true } });
        if (lead) {
          await db.activity.create({ data: { leadId, userId: by, type: "NOTE", notes: `Deskzo: ${standingWords(s.standing)}` } });
          sent += 1;
        }
      }
    });
    for (const s of changed) {
      await controlDb().platformSetting.upsert({ where: { key: standingKey(s.tenantId) }, create: { key: standingKey(s.tenantId), value: s.standing.kind, updatedBy: "platform" }, update: { value: s.standing.kind, updatedBy: "platform" } });
    }
  } catch (err) {
    console.error(`[sales-crm] standings couldn't go to the sales CRM: ${err instanceof Error ? err.name : "error"}`);
  }
  return sent;
}
