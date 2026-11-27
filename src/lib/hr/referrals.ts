import type { CandidateStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Employee referrals' shared parts (owner, 31 Oct 2026 — src/actions/referrals.ts). What the referrer is told of their
 * candidate is the step, never HR's notes or the offer.
 */

export const REFERRAL_WORDS: Record<CandidateStatus, string> = {
  PROSPECT: "Being considered",
  OFFERED: "Offered a role",
  ACCEPTED: "Accepted the offer",
  JOINED: "Joined",
  DECLINED: "Closed",
  WITHDRAWN: "Closed",
};

/** Tells whoever referred a candidate that they've moved on. Server only; never fails the change that called it. */
export async function tellReferrer(candidateId: string, status: CandidateStatus): Promise<void> {
  try {
    const c = await db.candidate.findUnique({ where: { id: candidateId }, select: { name: true, referredById: true } });
    if (!c?.referredById) return;
    await notifyUser({
      userId: c.referredById,
      type: "REFERRAL_UPDATED",
      title: `${c.name}, whom you referred: ${REFERRAL_WORDS[status].toLowerCase()}`,
      message: status === "JOINED" ? "Thank you — they've joined." : "Thanks for the referral; HR has it in hand.",
      link: "/people/referrals",
    });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
}
