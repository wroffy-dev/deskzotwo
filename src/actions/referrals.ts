"use server";

import { revalidatePath } from "next/cache";
import type { CandidateStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { toPlain } from "@/lib/serialize";
import { peopleHolding } from "@/lib/orders/handoff";
import type { ActionResult } from "@/actions/company";

/**
 * Employee referrals (owner, 31 Oct 2026: Deskzo People as a complete HRMS — Kredily's Referrals).
 *
 * Anybody can refer somebody for a role: they become a candidate in Hiring, "via Referral", with who referred them,
 * and whoever runs hiring is told. The referrer sees their referrals and the step each has reached — not HR's notes or
 * the offer — and is told as it moves on (src/lib/hr/referrals.ts). Somebody already in Hiring isn't added twice.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGE = "/people/referrals";

export type MyReferral = { id: string; name: string; designation: string | null; status: CandidateStatus; referredOn: Date };

export async function myReferrals(): Promise<MyReferral[]> {
  const user = await requireModuleAccess("hr");
  const rows = await db.candidate.findMany({ where: { referredById: user.id }, orderBy: { createdAt: "desc" }, select: { id: true, name: true, designation: true, status: true, createdAt: true } });
  return toPlain(rows.map((r) => ({ id: r.id, name: r.name, designation: r.designation, status: r.status, referredOn: r.createdAt })));
}

export async function referCandidate(input: { name: string; email: string; phone?: string; designation?: string; note?: string }): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleAccess("hr");
  const name = String(input?.name ?? "").trim().replace(/\s+/g, " ");
  const email = String(input.email ?? "").trim().toLowerCase();
  const phone = String(input.phone ?? "").trim() || null;
  const designation = String(input.designation ?? "").trim() || null;
  const note = String(input.note ?? "").trim();
  if (name.length < 2 || name.length > 100) return { ok: false, error: "Give their full name." };
  if (!EMAIL.test(email)) return { ok: false, error: "Give their email address." };
  if (note.length < 10) return { ok: false, error: "Say why they'd be good — a line or two." };
  if (note.length > 2000) return { ok: false, error: "Keep it under 2,000 characters." };

  const [already, employee] = await Promise.all([
    db.candidate.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } }),
    db.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } }),
  ]);
  const referrer = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { name: true } });
  /**
   * Security audit, 11 Nov 2026 (SEC-66): somebody already in Hiring, or with a login here, gets the same answer as a
   * new referral — "is this person applying here?" isn't any colleague's to find out by typing an email. Nobody is
   * added twice: HR hears of a referral for a candidate it has, and one for a colleague is simply not kept.
   */
  if (employee || already) {
    if (already && !employee) {
      for (const id of await peopleHolding("hiring.manage", [user.id])) {
        await notifyUser({ userId: id, type: "REFERRAL_SUBMITTED", title: `${referrer.name} referred ${name}`, message: "Already in Hiring — nothing new was added.", link: `/people/hiring/${already.id}` });
      }
    }
    return { ok: true, data: { id: "" } };
  }

  const created = await db.candidate.create({
    data: { name, email, phone, designation, source: "Referral", referredById: user.id, notes: `Referred by ${referrer.name}: ${note}` },
    select: { id: true },
  });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Candidate", entityId: created.id, entityLabel: `${name} referred by ${referrer.name}` });
  for (const id of await peopleHolding("hiring.manage", [user.id])) {
    await notifyUser({ userId: id, type: "REFERRAL_SUBMITTED", title: `${referrer.name} referred ${name}`, message: designation ? `For ${designation}.` : note.slice(0, 140), link: `/people/hiring/${created.id}` });
  }
  revalidatePath(PAGE);
  revalidatePath("/people/hiring");
  return { ok: true, data: { id: created.id } };
}
