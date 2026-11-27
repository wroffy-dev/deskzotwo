"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type InsuranceKind } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { PEOPLE_ONLY } from "@/lib/people";
import { workspaceClock } from "@/lib/time/workspace";
import { dateOnly, toKey } from "@/lib/hr/calendar";
import { dependentsOrRefusal, policyState, type Dependent } from "@/lib/hr/insurance-rules";
import type { ActionResult } from "@/actions/company";
import { clipOrNull, TEXT_MAX } from "@/lib/text/bounded";

/**
 * Group insurance (owner, 31 Oct 2026: Deskzo People as a complete HRMS — Kredily's Insurance).
 *
 * HR (`hr.manage`) records the policies the company holds — insurer, number, cover, the period, the claims line — and
 * who is on each, with their member (e-card) number. Each member sees their own cover and keeps the family on it up
 * to date while the policy runs; HR sees and sends the list to the insurer.
 */

const DAY_ISO = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = "/people/insurance";
const KINDS: InsuranceKind[] = ["HEALTH", "ACCIDENT", "LIFE", "OTHER"];
const n = (v: Prisma.Decimal | null) => (v === null ? null : Number(v));

async function isHr(userId: string) {
  return hasEffectivePermission(userId, "hr.manage");
}

async function todayKey() {
  return toKey((await workspaceClock()).calendarDate(new Date()));
}

export type PolicyView = {
  id: string;
  name: string;
  kind: InsuranceKind;
  insurer: string;
  policyNumber: string;
  sumInsured: number | null;
  validFrom: string;
  validTo: string;
  helpline: string | null;
  notes: string | null;
  archived: boolean;
  state: "UPCOMING" | "ACTIVE" | "EXPIRED";
};
export type MemberView = { id: string; userId: string; name: string; memberNumber: string | null; sumInsured: number | null; dependents: Dependent[] };
export type MyCover = PolicyView & { memberId: string; memberNumber: string | null; cover: number | null; dependents: Dependent[]; canEditFamily: boolean };

type PolicyRow = { id: string; name: string; kind: InsuranceKind; insurer: string; policyNumber: string; sumInsured: Prisma.Decimal | null; validFrom: Date; validTo: Date; helpline: string | null; notes: string | null; archived: boolean };
const policyView = (p: PolicyRow, today: string): PolicyView => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  insurer: p.insurer,
  policyNumber: p.policyNumber,
  sumInsured: n(p.sumInsured),
  validFrom: toKey(p.validFrom),
  validTo: toKey(p.validTo),
  helpline: p.helpline,
  notes: p.notes,
  archived: p.archived,
  state: policyState(toKey(p.validFrom), toKey(p.validTo), today),
});
const POLICY_SELECT = { id: true, name: true, kind: true, insurer: true, policyNumber: true, sumInsured: true, validFrom: true, validTo: true, helpline: true, notes: true, archived: true } as const;
const asDependents = (v: unknown): Dependent[] => (Array.isArray(v) ? (v as Dependent[]) : []);

/** People › Insurance: my own cover, and — for HR — every policy with its members. */
export async function insurancePage(): Promise<{ hr: boolean; mine: MyCover[]; policies: (PolicyView & { members: MemberView[] })[]; people: { id: string; name: string }[] }> {
  const user = await requireModuleAccess("hr");
  const hr = await isHr(user.id);
  const today = await todayKey();
  const mine = await db.insuranceMember.findMany({
    where: { userId: user.id, policy: { archived: false } },
    orderBy: { policy: { validTo: "desc" } },
    select: { id: true, memberNumber: true, sumInsured: true, dependents: true, policy: { select: POLICY_SELECT } },
  });
  const [policies, people] = hr
    ? await Promise.all([
        db.insurancePolicy.findMany({
          orderBy: [{ archived: "asc" }, { validTo: "desc" }],
          select: { ...POLICY_SELECT, members: { orderBy: { user: { name: "asc" } }, select: { id: true, userId: true, memberNumber: true, sumInsured: true, dependents: true, user: { select: { name: true } } } } },
        }),
        db.user.findMany({
          where: { ...PEOPLE_ONLY, active: true, OR: [{ employeeProfile: { is: null } }, { employeeProfile: { exitedOn: null } }] },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        }),
      ])
    : [[], []];
  return toPlain({
    hr,
    mine: mine.map((m) => {
      const p = policyView(m.policy, today);
      return { ...p, memberId: m.id, memberNumber: m.memberNumber, cover: n(m.sumInsured) ?? p.sumInsured, dependents: asDependents(m.dependents), canEditFamily: p.state !== "EXPIRED" };
    }),
    policies: policies.map((p) => ({
      ...policyView(p, today),
      members: p.members.map((m) => ({ id: m.id, userId: m.userId, name: m.user.name, memberNumber: m.memberNumber, sumInsured: n(m.sumInsured), dependents: asDependents(m.dependents) })),
    })),
    people,
  });
}

export async function savePolicy(input: {
  id?: string;
  name: string;
  kind: string;
  insurer: string;
  policyNumber: string;
  sumInsured?: number | null;
  validFrom: string;
  validTo: string;
  helpline?: string;
  notes?: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleAccess("hr");
  if (!(await isHr(user.id))) return { ok: false, error: "Only HR can record insurance." };
  const name = String(input?.name ?? "").trim();
  const insurer = String(input.insurer ?? "").trim();
  const policyNumber = String(input.policyNumber ?? "").trim();
  if (name.length < 2 || name.length > 100) return { ok: false, error: "Name the policy — for example “Group health 2026–27”." };
  if (insurer.length < 2) return { ok: false, error: "Say who the insurer is." };
  if (policyNumber.length < 2 || policyNumber.length > 60) return { ok: false, error: "Give the policy number." };
  const kind = KINDS.includes(input.kind as InsuranceKind) ? (input.kind as InsuranceKind) : null;
  if (!kind) return { ok: false, error: "Choose what the policy covers." };
  if (!DAY_ISO.test(String(input.validFrom)) || !DAY_ISO.test(String(input.validTo))) return { ok: false, error: "Choose the days the policy runs from and to." };
  if (input.validTo < input.validFrom) return { ok: false, error: "The policy ends before it starts." };
  const sum = input.sumInsured === null || input.sumInsured === undefined || String(input.sumInsured) === "" ? null : Number(input.sumInsured);
  if (sum !== null && (!Number.isFinite(sum) || sum <= 0)) return { ok: false, error: "The cover is an amount above nothing — or leave it empty." };
  const data = {
    name,
    kind,
    insurer,
    policyNumber,
    sumInsured: sum === null ? null : new Prisma.Decimal(sum),
    validFrom: dateOnly(input.validFrom),
    validTo: dateOnly(input.validTo),
    helpline: String(input.helpline ?? "").trim() || null,
    notes: String(input.notes ?? "").trim() || null,
  };
  const saved = input.id ? await db.insurancePolicy.update({ where: { id: String(input.id) }, data, select: { id: true } }) : await db.insurancePolicy.create({ data, select: { id: true } });
  await recordAudit({ userId: user.id, action: input.id ? "UPDATE" : "CREATE", entityType: "InsurancePolicy", entityId: saved.id, entityLabel: `Insurance policy ${name} (${policyNumber})` });
  revalidatePath(PAGE);
  return { ok: true, data: { id: saved.id } };
}

export async function archivePolicy(id: string, archived: boolean): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  if (!(await isHr(user.id))) return { ok: false, error: "Only HR can change insurance." };
  const p = await db.insurancePolicy.findUnique({ where: { id: String(id ?? "") }, select: { id: true, name: true } });
  if (!p) return { ok: false, error: "That policy no longer exists." };
  await db.insurancePolicy.update({ where: { id: p.id }, data: { archived: !!archived } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "InsurancePolicy", entityId: p.id, entityLabel: `Insurance policy ${p.name} ${archived ? "archived" : "brought back"}` });
  revalidatePath(PAGE);
  return { ok: true, data: null };
}

/** Puts people on a policy — those chosen, or everybody working. Anybody on it already stays as they are. */
export async function addInsuranceMembers(input: { policyId: string; userIds?: string[]; everyone?: boolean }): Promise<ActionResult<{ added: number }>> {
  const user = await requireModuleAccess("hr");
  if (!(await isHr(user.id))) return { ok: false, error: "Only HR can change who is covered." };
  const policy = await db.insurancePolicy.findUnique({ where: { id: String(input?.policyId ?? "") }, select: { id: true, name: true } });
  if (!policy) return { ok: false, error: "That policy no longer exists." };
  const ids = input.everyone
    ? (await db.user.findMany({ where: { ...PEOPLE_ONLY, active: true, OR: [{ employeeProfile: { is: null } }, { employeeProfile: { exitedOn: null } }] }, select: { id: true } })).map((u) => u.id)
    : [...new Set((input.userIds ?? []).map(String))];
  if (ids.length === 0) return { ok: false, error: "Choose who to cover." };
  const known = await db.user.count({ where: { id: { in: ids }, ...PEOPLE_ONLY } });
  if (known !== ids.length) return { ok: false, error: "Somebody chosen isn't one of your people." };
  const made = await db.insuranceMember.createMany({ data: ids.map((userId) => ({ policyId: policy.id, userId })), skipDuplicates: true });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "InsurancePolicy", entityId: policy.id, entityLabel: `${made.count} people added to ${policy.name}` });
  revalidatePath(PAGE);
  return { ok: true, data: { added: made.count } };
}

/** HR's edit of one member: their member number, their own cover, the family; or taking them off. */
export async function saveInsuranceMember(input: { id: string; memberNumber?: string; sumInsured?: number | null; dependents?: unknown; remove?: boolean }): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  if (!(await isHr(user.id))) return { ok: false, error: "Only HR can change who is covered." };
  const m = await db.insuranceMember.findUnique({ where: { id: String(input?.id ?? "") }, select: { id: true, policyId: true, user: { select: { name: true } }, policy: { select: { name: true } } } });
  if (!m) return { ok: false, error: "They're not on that policy any more." };
  if (input.remove) {
    await db.insuranceMember.delete({ where: { id: m.id } });
    await recordAudit({ userId: user.id, action: "DELETE", entityType: "InsurancePolicy", entityId: m.policyId, entityLabel: `${m.user.name} taken off ${m.policy.name}` });
    revalidatePath(PAGE);
    return { ok: true, data: null };
  }
  const sum = input.sumInsured === null || input.sumInsured === undefined || String(input.sumInsured) === "" ? null : Number(input.sumInsured);
  if (sum !== null && (!Number.isFinite(sum) || sum <= 0)) return { ok: false, error: "The cover is an amount above nothing — or leave it empty." };
  const family = input.dependents === undefined ? null : dependentsOrRefusal(input.dependents, await todayKey());
  if (family && !family.ok) return family;
  await db.insuranceMember.update({
    where: { id: m.id },
    data: {
      // (owner, 15 Nov 2026 — input bounds)
      memberNumber: clipOrNull(input.memberNumber, TEXT_MAX.id),
      sumInsured: sum === null ? null : new Prisma.Decimal(sum),
      ...(family ? { dependents: family.dependents } : {}),
    },
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "InsurancePolicy", entityId: m.policyId, entityLabel: `${m.user.name}'s cover on ${m.policy.name} updated` });
  revalidatePath(PAGE);
  return { ok: true, data: null };
}

/** A member's own family on their cover — while the policy hasn't ended. */
export async function saveMyDependents(input: { memberId: string; dependents: unknown }): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  const m = await db.insuranceMember.findUnique({ where: { id: String(input?.memberId ?? "") }, select: { id: true, userId: true, policyId: true, policy: { select: { name: true, validFrom: true, validTo: true, archived: true } } } });
  if (!m || m.userId !== user.id) return { ok: false, error: "That cover isn't yours." };
  const today = await todayKey();
  if (m.policy.archived || policyState(toKey(m.policy.validFrom), toKey(m.policy.validTo), today) === "EXPIRED") return { ok: false, error: "The policy has ended — ask HR." };
  const family = dependentsOrRefusal(input.dependents, today);
  if (!family.ok) return family;
  await db.insuranceMember.update({ where: { id: m.id }, data: { dependents: family.dependents } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "InsurancePolicy", entityId: m.policyId, entityLabel: `Family on ${m.policy.name} updated by the member` });
  revalidatePath(PAGE);
  return { ok: true, data: null };
}
