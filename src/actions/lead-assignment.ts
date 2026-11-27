"use server";

import { revalidatePath } from "next/cache";
import { tooLong } from "@/lib/validation/text";
import { z } from "zod";
import type { ContactDesignation, ItemType, LeadSource } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { decideOwner } from "@/lib/leads/assign";
import { loadFigures, performanceScores, type PersonScore } from "@/lib/leads/performance";
import { notMigratedYet } from "@/lib/not-migrated";
import { LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { GST_STATE_CODES, stateCodeFromName } from "@/lib/gst-engine";
import { contactDesignationValues } from "@/lib/validation/company";
import type { ActionResult } from "@/actions/company";

/**
 * The lead assignment rules — see src/lib/leads/assign.ts for how they are applied.
 *
 * Priorities are kept as 10, 20, 30… and rewritten whole on every reorder, so "move up" is always a
 * swap of two neighbours and two rules can never tie on the number that orders them.
 */

const ITEM_TYPES = ["SUBSCRIPTION", "GOOD", "SERVICE"] as const satisfies readonly ItemType[];
const STRATEGIES = ["ROUND_ROBIN", "LEAST_LOADED", "SPECIFIC_USER", "ACCOUNT_MANAGER", "PERFORMANCE"] as const;

async function requireAdmin() {
  // Part of the leads module (owner, 14 Oct 2026) — only where the plan has leads.
  const user = await requireModuleUser("leads");
  return (await hasEffectivePermission(user.id, "settings.manage")) ? user : null;
}

const RULE_FIELDS = {
  id: true,
  name: true,
  priority: true,
  active: true,
  brandIds: true,
  itemTypes: true,
  designations: true,
  sources: true,
  states: true,
  strategy: true,
  userIds: true,
  skipOnLeave: true,
} as const;
// Named, as they're left out of reads that don't (src/lib/tenancy/clients.ts) until every workspace has them.
const NEWER_FIELDS = { countries: true, cities: true, pincodes: true, customerCategoryIds: true, itemIds: true, responseHours: true } as const;
const NEWER_EMPTY = { countries: [] as string[], cities: [] as string[], pincodes: [] as string[], customerCategoryIds: [] as string[], itemIds: [] as string[], responseHours: null as number | null };
/**
 * What a rule does when everybody it gives leads to is at their lead limit (owner, 12 Nov 2026 — Phase 4 lead limits,
 * audit H.6.3): SKIP (the default) tries the next rule and, with nobody left, keeps the lead unassigned and tells the
 * managers; REFUSE turns the lead away. 20261213090000_lead_limits — named, and read apart, as the newer fields are.
 */
const OVERFLOW_MODES = ["SKIP", "REFUSE"] as const;
const NEWEST_FIELDS = { overflow: true } as const;

export async function listAssignmentRules() {
  if (!(await requireAdmin())) return null;
  const order = [{ priority: "asc" as const }, { createdAt: "asc" as const }];
  const [rules, brands, people, categories, items] = await Promise.all([
    db.leadAssignmentRule.findMany({ orderBy: order, select: { ...RULE_FIELDS, ...NEWER_FIELDS, ...NEWEST_FIELDS } }).catch(async (err) => {
      if (!notMigratedYet(err)) throw err;
      const older = await db.leadAssignmentRule.findMany({ orderBy: order, select: { ...RULE_FIELDS, ...NEWER_FIELDS } }).catch(async (again) => {
        if (!notMigratedYet(again)) throw again;
        return (await db.leadAssignmentRule.findMany({ orderBy: order, select: RULE_FIELDS })).map((r) => ({ ...r, ...NEWER_EMPTY }));
      });
      return older.map((r) => ({ ...r, overflow: "SKIP" as const }));
    }),
    db.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true, role: true } }),
    db.customerCategory.findMany({ orderBy: [{ name: "asc" }], select: { id: true, name: true, parentId: true } }),
    db.item.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, sku: true }, take: 3000 }),
  ]);
  return { rules, brands, people, categories, items };
}

export type ScoreRow = PersonScore & { name: string; decided: number; won: number; openLeads: number; givenRecently: number };

/**
 * How each person in a performance rule scores right now, against the others in such rules — for the
 * settings page. Everybody in any active performance rule, compared together.
 */
export async function assignmentScores(): Promise<ScoreRow[] | null> {
  if (!(await requireAdmin())) return null;
  const rules = await db.leadAssignmentRule.findMany({ where: { active: true, strategy: "PERFORMANCE" }, select: { userIds: true } });
  const pool = [...new Set(rules.flatMap((r) => r.userIds))];
  if (pool.length === 0) return [];
  const figures = await loadFigures(db, pool).catch((err) => {
    if (notMigratedYet(err)) return null;
    throw err;
  });
  if (!figures) return [];
  const scores = performanceScores([...figures.values()]);
  const names = new Map((await db.user.findMany({ where: { id: { in: pool } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return pool
    .map((id) => {
      const f = figures.get(id)!;
      return { ...scores.get(id)!, name: names.get(id) ?? "—", decided: f.decided, won: f.won, openLeads: f.openLeads, givenRecently: f.givenRecently };
    })
    .sort((a, b) => b.score - a.score);
}

const ruleSchema = z
  .object({
    id: z.string().max(100, tooLong(100)).optional(),
    name: z.string().trim().min(2, "Give the rule a name").max(80),
    active: z.boolean().default(true),
    brandIds: z.array(z.string().max(100)).max(1000).default([]),
    itemTypes: z.array(z.enum(ITEM_TYPES)).max(100).default([]),
    designations: z.array(z.enum(contactDesignationValues)).max(100).default([]),
    sources: z.array(z.enum(LEAD_SOURCE_VALUES)).max(100).default([]),
    states: z.array(z.string().max(100)).max(1000).default([]),
    countries: z.array(z.string().trim().min(2).max(60)).max(50).default([]),
    cities: z.array(z.string().trim().min(2).max(80)).max(200).default([]),
    pincodes: z.array(z.string().trim().max(100, tooLong(100)).regex(/^\d{1,6}$/, "A PIN code is up to six digits — its first few for a run of them")).max(500).default([]),
    customerCategoryIds: z.array(z.string().max(100)).max(1000).default([]),
    itemIds: z.array(z.string().max(100)).max(1000).default([]),
    // Office hours a person has to do something with a lead this rule gave them, before it moves on.
    responseHours: z.number().int().min(1, "At least an hour").max(240, "Ten days of office hours at most").nullable().default(null),
    strategy: z.enum(STRATEGIES),
    userIds: z.array(z.string().max(100)).max(1000).default([]),
    skipOnLeave: z.boolean().default(true),
    overflow: z.enum(OVERFLOW_MODES, { message: "Choose what happens when everybody is at their lead limit" }).default("SKIP"),
  })
  .superRefine((r, ctx) => {
    if (r.strategy !== "ACCOUNT_MANAGER" && r.userIds.length === 0) {
      ctx.addIssue({ code: "custom", path: ["userIds"], message: "Choose at least one person for this rule to assign to." });
    }
    const unknown = r.states.filter((s) => !stateCodeFromName(s));
    if (unknown.length) ctx.addIssue({ code: "custom", path: ["states"], message: `Not a state: ${unknown.join(", ")}` });
  });

export async function saveAssignmentRule(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireAdmin();
  if (!user) return { ok: false, error: "You can't manage lead assignment." };
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid rule" };
  const r = parsed.data;

  // Only people and brands that exist — a rule pointing at nobody would silently skip every lead.
  const [people, brands, categories, items] = await Promise.all([
    db.user.count({ where: { id: { in: r.userIds }, active: true } }),
    db.brand.count({ where: { id: { in: r.brandIds } } }),
    db.customerCategory.count({ where: { id: { in: r.customerCategoryIds } } }),
    db.item.count({ where: { id: { in: r.itemIds } } }),
  ]);
  if (people !== new Set(r.userIds).size) return { ok: false, error: "One of the people chosen is no longer active." };
  if (brands !== new Set(r.brandIds).size) return { ok: false, error: "One of the brands chosen no longer exists." };
  if (categories !== new Set(r.customerCategoryIds).size) return { ok: false, error: "One of the customer categories chosen no longer exists." };
  if (items !== new Set(r.itemIds).size) return { ok: false, error: "One of the products chosen no longer exists." };
  if (r.responseHours && r.strategy === "ACCOUNT_MANAGER") return { ok: false, error: "An account-manager rule has nobody else to move a lead to — leave its response hours empty." };
  // The same place typed twice is one place; the first spelling is kept.
  const tidy = (list: string[]) => [...new Map(list.map((v) => [v.trim().toLowerCase(), v.trim()] as const)).values()].filter(Boolean);

  const data = {
    name: r.name,
    active: r.active,
    brandIds: [...new Set(r.brandIds)],
    itemTypes: [...new Set(r.itemTypes)],
    designations: [...new Set(r.designations)] as ContactDesignation[],
    sources: [...new Set(r.sources)] as LeadSource[],
    // Stored as the picker spells them, so the form shows them back exactly.
    states: [...new Set(r.states.map((s) => GST_STATE_CODES[stateCodeFromName(s)!]!))],
    countries: tidy(r.countries),
    cities: tidy(r.cities),
    pincodes: [...new Set(r.pincodes)],
    customerCategoryIds: [...new Set(r.customerCategoryIds)],
    itemIds: [...new Set(r.itemIds)],
    responseHours: r.responseHours,
    strategy: r.strategy,
    userIds: r.strategy === "ACCOUNT_MANAGER" ? [] : [...new Set(r.userIds)],
    skipOnLeave: r.skipOnLeave,
  };

  let id: string;
  if (r.id) {
    const updated = await db.leadAssignmentRule.update({ where: { id: r.id }, data, select: { id: true } }).catch(() => null);
    if (!updated) return { ok: false, error: "That rule no longer exists." };
    id = updated.id;
  } else {
    // New rules go last: a catch-all added later must not jump ahead of the specific rules.
    const last = await db.leadAssignmentRule.aggregate({ _max: { priority: true } });
    const created = await db.leadAssignmentRule.create({ data: { ...data, priority: (last._max.priority ?? 0) + 10, createdById: user.id }, select: { id: true } });
    id = created.id;
  }
  // Its overflow mode apart, so a workspace not migrated to 20261213090000_lead_limits yet still saves the rest — and
  // is told, rather than the choice dropped in silence, when REFUSE was asked for.
  try {
    await db.leadAssignmentRule.update({ where: { id }, data: { overflow: r.overflow }, select: { id: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    if (r.overflow !== "SKIP") return { ok: false, error: "This workspace is still being updated, so the rule was saved without refusing leads. Try again in a few minutes." };
  }

  await recordAudit({ userId: user.id, action: r.id ? "UPDATE" : "CREATE", entityType: "LeadAssignmentRule", entityId: id, entityLabel: r.name });
  revalidatePath("/settings/lead-assignment");
  return { ok: true, data: { id } };
}

export async function deleteAssignmentRule(id: string): Promise<ActionResult<null>> {
  const user = await requireAdmin();
  if (!user) return { ok: false, error: "You can't manage lead assignment." };
  const rule = await db.leadAssignmentRule.findUnique({ where: { id }, select: { name: true } });
  if (!rule) return { ok: true, data: null };
  await db.leadAssignmentRule.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "LeadAssignmentRule", entityId: id, entityLabel: rule.name });
  revalidatePath("/settings/lead-assignment");
  return { ok: true, data: null };
}

export async function moveAssignmentRule(id: string, direction: "up" | "down"): Promise<ActionResult<null>> {
  const user = await requireAdmin();
  if (!user) return { ok: false, error: "You can't manage lead assignment." };
  const rules = await db.leadAssignmentRule.findMany({ orderBy: [{ priority: "asc" }, { createdAt: "asc" }], select: { id: true } });
  const at = rules.findIndex((r) => r.id === id);
  const to = direction === "up" ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= rules.length) return { ok: true, data: null };
  [rules[at], rules[to]] = [rules[to]!, rules[at]!];
  await db.$transaction(async (tx) => {
    for (const op of rules.map((r, i) => tx.leadAssignmentRule.update({ where: { id: r.id }, data: { priority: (i + 1) * 10 } }))) await op;
  });
  revalidatePath("/settings/lead-assignment");
  return { ok: true, data: null };
}

const previewSchema = z.object({
  brandIds: z.array(z.string().max(100)).max(1000).default([]),
  itemTypes: z.array(z.enum(ITEM_TYPES)).max(100).default([]),
  designation: z.enum(contactDesignationValues).optional().or(z.literal("")),
  source: z.enum(LEAD_SOURCE_VALUES).default("WEBSITE"),
  state: z.string().max(200, tooLong(200)).optional().or(z.literal("")),
  country: z.string().trim().max(60).optional().or(z.literal("")),
  city: z.string().trim().max(80).optional().or(z.literal("")),
  pincode: z.string().trim().max(12).optional().or(z.literal("")),
  customerCategoryId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  itemId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
});

/**
 * Who a lead like this would go to — without assigning anything.
 *
 * A dry run: round-robin positions are read, not advanced, so testing the rules does not skip
 * anybody's turn. Account-manager rules are passed over, since a test lead belongs to no account.
 */
export async function previewAssignment(input: unknown): Promise<ActionResult<{ person: string | null; rule: string | null; full?: string | null; refused?: string | null }>> {
  if (!(await requireAdmin())) return { ok: false, error: "You can't manage lead assignment." };
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const p = parsed.data;
  const decided = await decideOwner(
    {
      brandIds: p.brandIds,
      itemTypes: p.itemTypes,
      designation: p.designation || null,
      source: p.source,
      state: p.state || null,
      country: p.country || null,
      city: p.city || null,
      pincode: p.pincode || null,
      itemIds: p.itemId ? [p.itemId] : [],
      // A sub-category counts for the category it's under, as a real lead's company does.
      customerCategoryIds: p.customerCategoryId
        ? [p.customerCategoryId, (await db.customerCategory.findUnique({ where: { id: p.customerCategoryId }, select: { parentId: true } }))?.parentId].filter((id): id is string => !!id)
        : [],
      companyOwnerId: null,
    },
    { dryRun: true },
  );
  // Lead limits (owner, 12 Nov 2026 — Phase 4, audit H.6): say when it would be kept unassigned, or refused, because everybody was full.
  if (decided.kind === "overflow") return { ok: true, data: { person: null, rule: null, full: decided.note } };
  if (decided.kind === "refused") return { ok: true, data: { person: null, rule: null, refused: decided.reason } };
  if (decided.kind !== "chosen") return { ok: true, data: { person: null, rule: null } };
  const person = await db.user.findUnique({ where: { id: decided.userId }, select: { name: true } });
  return { ok: true, data: { person: person?.name ?? null, rule: decided.note } };
}
