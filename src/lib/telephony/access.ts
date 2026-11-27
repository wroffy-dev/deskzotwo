import { db } from "@/lib/db";
import { callAccess, peopleReached, throughAccount } from "@/lib/authz/access";

/**
 * Who may hear a cloud call, and what a call list shows of one (owner, 26 Oct 2026 — src/lib/telephony).
 *
 *   · A call logged on Calls is heard by whoever may see that call there — its company and whose call it is.
 *   · One that isn't (a number on nobody) by whoever sees the business line's calls: everybody's, or the people
 *     they reach when it was theirs to take.
 *   · Asked of the call list beside its own query, never joined into it, and any failure here is nothing
 *     shown: cloud calling going wrong can't take the Calls list down with it.
 */

/** A recording a person may play, or null. */
export async function hearableRecording(userId: string, telephonyCallId: string): Promise<string | null> {
  const call = await db.telephonyCall.findUnique({ where: { id: telephonyCallId }, select: { recordingUrl: true, callLogId: true, agentUserId: true, requestedByUserId: true } });
  if (!call?.recordingUrl) return null;
  if (call.callLogId) {
    const seen = await db.callLog.count({ where: { AND: [{ id: call.callLogId }, await throughAccount(userId, "view"), await callAccess(userId, "view")] } });
    return seen ? call.recordingUrl : null;
  }
  const reached = await peopleReached(userId, "activities", "view");
  if (reached === null) return call.recordingUrl;
  return [call.agentUserId, call.requestedByUserId].some((id) => !!id && reached.includes(id)) ? call.recordingUrl : null;
}

/** How long after a call its person can still say how it went. */
export const REVIEW_DAYS = 14;

export type CloudExtras = { recordingId: string | null; mayReview: boolean };

/** For the calls a list shows: the recording to play, and whether the viewer may still say how it went. */
export async function cloudExtras(viewerId: string, rows: { id: string; source?: string | null; startedAt: Date; reviewedAt?: Date | null; user: { id: string } }[]): Promise<Map<string, CloudExtras>> {
  const out = new Map<string, CloudExtras>();
  const cloud = rows.filter((r) => r.source === "CLOUD");
  if (cloud.length === 0) return out;
  try {
    const found = await db.telephonyCall.findMany({ where: { callLogId: { in: cloud.map((r) => r.id) } }, select: { id: true, callLogId: true, recordingUrl: true } });
    const byLog = new Map(found.map((f) => [f.callLogId!, f]));
    const fresh = Date.now() - REVIEW_DAYS * 86_400_000;
    for (const r of cloud) {
      const t = byLog.get(r.id);
      out.set(r.id, {
        recordingId: t?.recordingUrl ? t.id : null,
        mayReview: r.user.id === viewerId && !r.reviewedAt && r.startedAt.getTime() > fresh,
      });
    }
  } catch (err) {
    console.error("telephony: couldn't read the calls' recordings", err);
  }
  return out;
}
