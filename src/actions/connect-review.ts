"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { companyScope } from "@/lib/authz/company-scope";
import { companyNamedLike } from "@/lib/companies/by-name";
import { createCompany, type ActionResult } from "@/actions/company";
import { companyInList, smartListsReady } from "@/lib/smart-lists/membership";
import { CONTACT_MODES, LIMITS, staffComments, type ContactMode, type RowComment } from "@/lib/connect/working";
import { notMigratedYet } from "@/lib/not-migrated";
import { noticeComment, noticeSuggestionDecided } from "@/lib/connect/notices";

/**
 * Deskzo Connect, working together — the staff side (owner, 20 Nov 2026 — phase 3, src/lib/connect/working.ts):
 *
 *   · **Suggestions** from guests wait here. A company suggested is linked to one the workspace has, made as a new one
 *     (through createCompany, with its duplicate and credit rules), or declined with a reason the guest sees. A guest is
 *     never told whether the company existed — only "added" or "not added". Reviewed by whoever may edit the list.
 *   · **Comments** on a row: shared with the list's guests, or internal — internal ones never reach a guest.
 *   · **How the account owner is shown** to guests (name; name and email; or name, email and work phone): whoever
 *     manages guests (`workspace.manageAny`).
 */

const GONE = "That suggestion has been dealt with already.";

async function ready(): Promise<boolean> {
  try {
    await db.listSuggestion.findFirst({ select: { id: true } });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

async function canEditList(userId: string, workbook: { ownerUserId: string }) {
  return workbook.ownerUserId === userId || (await hasEffectivePermission(userId, "workspace.manageAny"));
}

function changed(workbookId?: string) {
  revalidatePath("/smart-lists/guests/suggestions");
  revalidatePath("/smart-lists/guests");
  if (workbookId) revalidatePath(`/smart-lists/${workbookId}`);
}

export type ReviewItem = {
  id: string;
  kind: "NEW_COMPANY" | "CORRECTION";
  list: { id: string; name: string };
  guest: { name: string; connection: string };
  name: string | null;
  city: string | null;
  website: string | null;
  gstin: string | null;
  contactName: string | null;
  note: string;
  at: string;
  /** For a correction, the company it is about. */
  company: { id: string; name: string; companySeq: number } | null;
  /** Companies the reviewer may see that look like the one suggested — only the reviewer sees these. */
  matches: { id: string; name: string; why: string }[];
};

const LEGAL = /\b(private|pvt|limited|ltd|llp|inc|incorporated|opc|plc|co|company|corporation|corp)\b\.?/gi;
/** A company name without its legal form and punctuation: "Lakshmi Precast Pvt. Ltd." → "Lakshmi Precast". */
function coreName(name: string | null): string {
  return String(name ?? "").replace(/[.,()&]/g, " ").replace(LEGAL, " ").replace(/\s+/g, " ").trim();
}

const domainOf = (w: string | null) => (w ? w.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? "" : "");

/** Pending suggestions on the lists this person may edit, with what they look like in Companies. */
export async function reviewQueue(): Promise<ReviewItem[] | null> {
  const user = await requireModuleAccess("workspace");
  if (!(await ready())) return null;
  const manageAny = await hasEffectivePermission(user.id, "workspace.manageAny");
  const rows = await db.listSuggestion.findMany({
    where: { status: "PENDING", ...(manageAny ? {} : { workbook: { ownerUserId: user.id } }) },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: {
      id: true,
      kind: true,
      name: true,
      city: true,
      website: true,
      gstin: true,
      contactName: true,
      note: true,
      createdAt: true,
      workbook: { select: { id: true, name: true } },
      guest: { select: { name: true, connection: { select: { name: true } } } },
      company: { select: { id: true, name: true, companySeq: true } },
    },
  });
  const scope = await companyScope(user.id);
  const out: ReviewItem[] = [];
  for (const r of rows) {
    const matches = new Map<string, { id: string; name: string; why: string }>();
    if (r.kind === "NEW_COMPANY") {
      const byName = r.name ? await companyNamedLike(r.name) : null;
      if (byName && (await db.company.count({ where: { AND: [scope, { id: byName.id }] } }))) matches.set(byName.id, { ...byName, why: "same name" });
      const domain = domainOf(r.website);
      if (domain.includes(".")) {
        for (const c of await db.company.findMany({ where: { AND: [scope, { website: { contains: domain, mode: "insensitive" } }] }, take: 3, select: { id: true, name: true } })) matches.set(c.id, { ...c, why: matches.has(c.id) ? "same name and website" : "same website" });
      }
      if (r.gstin && r.gstin.length >= 15) {
        for (const c of await db.company.findMany({ where: { AND: [scope, { locations: { some: { gstNumber: r.gstin } } }] }, take: 3, select: { id: true, name: true } })) matches.set(c.id, { ...c, why: "same GSTIN" });
      }
      // The name without its legal form — "Kestrel Engineering Pvt Ltd" finds "Kestrel Engineering" — never one word of
      // it, which finds every company starting the same way.
      const core = coreName(r.name);
      if (core.length >= 4) {
        for (const c of await db.company.findMany({ where: { AND: [scope, { name: { contains: core, mode: "insensitive" } }] }, orderBy: { name: "asc" }, take: 3, select: { id: true, name: true } })) if (!matches.has(c.id)) matches.set(c.id, { ...c, why: "similar name" });
      }
    }
    out.push({
      id: r.id,
      kind: r.kind,
      list: r.workbook,
      guest: { name: r.guest.name, connection: r.guest.connection.name },
      name: r.name,
      city: r.city,
      website: r.website,
      gstin: r.gstin,
      contactName: r.contactName,
      note: r.note,
      at: r.createdAt.toISOString(),
      company: r.company,
      matches: [...matches.values()].slice(0, 5),
    });
  }
  return out;
}

export async function pendingSuggestionCount(): Promise<number> {
  const q = await reviewQueue().catch(() => null);
  return q?.length ?? 0;
}

async function openSuggestion(userId: string, id: unknown) {
  if (typeof id !== "string" || !id || !(await ready())) return null;
  const s = await db.listSuggestion.findUnique({
    where: { id },
    select: { id: true, kind: true, status: true, name: true, city: true, website: true, note: true, workbook: { select: { id: true, name: true, ownerUserId: true, mode: true } } },
  });
  if (!s || !(await canEditList(userId, s.workbook))) return null;
  return s;
}

async function pin(workbookId: string, companyId: string, userId: string) {
  if (!(await smartListsReady())) return;
  await db.workbookPinnedRow.upsert({ where: { workbookId_companyId: { workbookId, companyId } }, create: { workbookId, companyId, addedByUserId: userId }, update: {}, select: { workbookId: true } });
}

/** Linked to a company the workspace has, and added to the list by hand. */
export async function linkSuggestion(id: string, companyId: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("workspace");
  const s = await openSuggestion(user.id, id);
  if (!s || s.status !== "PENDING" || s.kind !== "NEW_COMPANY") return { ok: false, error: GONE };
  const company = typeof companyId === "string" ? await db.company.findFirst({ where: { AND: [await companyScope(user.id), { id: companyId }] }, select: { id: true, name: true } }) : null;
  if (!company) return { ok: false, error: "That company isn't one you can see." };
  await pin(s.workbook.id, company.id, user.id);
  await db.listSuggestion.update({ where: { id: s.id }, data: { status: "LINKED", companyId: company.id, decidedById: user.id, decidedAt: new Date() }, select: { id: true } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Workbook", entityId: s.workbook.id, entityLabel: `${s.workbook.name}: a guest's suggestion "${s.name}" linked to ${company.name} and added` });
  // The guest hears what became of it (src/lib/connect/notices.ts).
  await noticeSuggestionDecided(s.id);
  changed(s.workbook.id);
  return { ok: true, data: null };
}

/** A new company made from the suggestion — through the ordinary company rules — and added to the list. */
export async function createFromSuggestion(id: string): Promise<ActionResult<{ companyId: string }>> {
  const user = await requireModuleAccess("workspace");
  const s = await openSuggestion(user.id, id);
  if (!s || s.status !== "PENDING" || s.kind !== "NEW_COMPANY" || !s.name) return { ok: false, error: GONE };
  const website = s.website ? (/^https?:\/\//i.test(s.website) ? s.website : `https://${s.website}`) : "";
  const made = await createCompany({
    name: s.name,
    website,
    source: "REFERRAL",
    location: { label: "Head Office", city: s.city ?? "", gstTreatment: "UNREGISTERED", isBilling: true, isShipping: true },
  });
  if (!made.ok) return { ok: false, error: made.error };
  await pin(s.workbook.id, made.data.id, user.id);
  await db.listSuggestion.update({ where: { id: s.id }, data: { status: "CREATED", companyId: made.data.id, decidedById: user.id, decidedAt: new Date() }, select: { id: true } });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Company", entityId: made.data.id, entityLabel: `${s.name} — made from a guest's suggestion for ${s.workbook.name}` });
  // The guest hears what became of it (src/lib/connect/notices.ts).
  await noticeSuggestionDecided(s.id);
  changed(s.workbook.id);
  return { ok: true, data: { companyId: made.data.id } };
}

export async function declineSuggestion(id: string, reason: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("workspace");
  const s = await openSuggestion(user.id, id);
  if (!s || s.status !== "PENDING") return { ok: false, error: GONE };
  const why = String(reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  await db.listSuggestion.update({ where: { id: s.id }, data: { status: "DECLINED", declineReason: why || null, decidedById: user.id, decidedAt: new Date() }, select: { id: true } });
  // The guest hears what became of it (src/lib/connect/notices.ts).
  await noticeSuggestionDecided(s.id);
  changed(s.workbook.id);
  return { ok: true, data: null };
}

/** A correction taken on board — the change itself is made on the company, by hand. */
export async function acceptCorrection(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("workspace");
  const s = await openSuggestion(user.id, id);
  if (!s || s.status !== "PENDING" || s.kind !== "CORRECTION") return { ok: false, error: GONE };
  await db.listSuggestion.update({ where: { id: s.id }, data: { status: "ACCEPTED", decidedById: user.id, decidedAt: new Date() }, select: { id: true } });
  // The guest hears what became of it (src/lib/connect/notices.ts).
  await noticeSuggestionDecided(s.id);
  changed(s.workbook.id);
  return { ok: true, data: null };
}

// ─── Row comments ─────────────────────────────────────────────────────────────

async function openRow(userId: string, workbookId: unknown, companyId: unknown) {
  if (typeof workbookId !== "string" || typeof companyId !== "string" || !(await ready())) return null;
  const wb = await db.workbook.findUnique({ where: { id: workbookId }, select: { id: true, name: true, filters: true, shared: true, ownerUserId: true } });
  if (!wb) return null;
  if (!wb.shared && wb.ownerUserId !== userId && !(await hasEffectivePermission(userId, "workspace.manageAny"))) return null;
  if (!(await companyInList(userId, wb, companyId))) return null;
  return wb;
}

/** The teams (connections) this list is shared with now — a shared comment may go to one of them only. */
async function teamsOf(workbookId: string): Promise<{ id: string; name: string; guests: number }[]> {
  const shares = await db.listShare.findMany({ where: { workbookId, revokedAt: null, OR: [{ until: null }, { until: { gt: new Date() } }] }, select: { guest: { select: { connection: { select: { id: true, name: true } } } } } });
  const teams = new Map<string, { id: string; name: string; guests: number }>();
  for (const s of shares) {
    const c = s.guest.connection;
    const t = teams.get(c.id) ?? { id: c.id, name: c.name, guests: 0 };
    t.guests += 1;
    teams.set(c.id, t);
  }
  return [...teams.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function rowComments(workbookId: string, companyId: string): Promise<{ comments: RowComment[]; guests: number; teams: { id: string; name: string; guests: number }[] } | null> {
  const user = await requireModuleAccess("workspace");
  const wb = await openRow(user.id, workbookId, companyId);
  if (!wb) return null;
  const [comments, teams] = await Promise.all([staffComments(wb.id, companyId), teamsOf(wb.id)]);
  return { comments, guests: teams.reduce((n, t) => n + t.guests, 0), teams };
}

export async function addRowComment(input: { workbookId: string; companyId: string; body: string; shared: boolean; to?: string | null }): Promise<ActionResult<RowComment>> {
  const user = await requireModuleAccess("workspace");
  const wb = await openRow(user.id, input?.workbookId, input?.companyId);
  if (!wb) return { ok: false, error: "That company isn't in this list for you." };
  const body = String(input.body ?? "").trim().slice(0, LIMITS.comment);
  if (!body) return { ok: false, error: "Write something first." };
  // To one team only (owner, 20 Nov 2026): a team this list is shared with now.
  const team = input.shared === true && typeof input.to === "string" && input.to ? (await teamsOf(wb.id)).find((t) => t.id === input.to) ?? null : null;
  if (input.shared === true && input.to && !team) return { ok: false, error: "That team doesn't have this list any more." };
  const row = await db.listRowComment.create({ data: { workbookId: wb.id, companyId: input.companyId, body, authorUserId: user.id, shared: input.shared === true }, select: { id: true, createdAt: true } });
  if (team) await db.listRowCommentAudience.create({ data: { commentId: row.id, connectionId: team.id } });
  // Shared: the guests it's meant for hear of it — at most once a list an hour; an internal one tells nobody.
  if (input.shared === true) await noticeComment(wb.id, user.name ?? "", undefined, undefined, input.companyId, team?.id ?? null);
  return { ok: true, data: { id: row.id, body, author: user.name ?? "You", byGuest: false, shared: input.shared === true, at: row.createdAt.toISOString(), team: team?.name ?? null } };
}

// ─── The contact card's setting ───────────────────────────────────────────────

export async function getContactMode(): Promise<ContactMode> {
  await requireModuleAccess("workspace");
  const { contactMode } = await import("@/lib/connect/working");
  return contactMode();
}

export async function saveContactMode(mode: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("workspace");
  if (!(await hasEffectivePermission(user.id, "workspace.manageAny"))) return { ok: false, error: "Only whoever manages guests can change this." };
  if (!(CONTACT_MODES as readonly string[]).includes(mode)) return { ok: false, error: "Choose one of the three." };
  if (!(await ready())) return { ok: false, error: "This arrives with the workspace's next update." };
  await db.connectSettings.upsert({ where: { id: "global" }, create: { id: "global", ownerContact: mode, updatedById: user.id }, update: { ownerContact: mode, updatedById: user.id }, select: { id: true } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ConnectSettings", entityId: "global", entityLabel: `Connect: guests see the account owner's ${mode === "NAME" ? "name" : mode === "NAME_EMAIL" ? "name and email" : "name, email and phone"}` });
  changed();
  return { ok: true, data: null };
}
