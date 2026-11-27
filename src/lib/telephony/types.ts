/**
 * Cloud telephony (owner, 26 Oct 2026 — src/lib/telephony): what a provider reports about a call, in Deskzo's
 * words, whichever provider it came from. CallerDesk first (src/lib/telephony/callerdesk.ts).
 */

export type ReportedCall = {
  /** The provider's id for the call. */
  providerCallId: string;
  /** CallerDesk's campaign id — a click-to-call's, carried on its report. */
  campaignId: string | null;
  /** A call still ringing or talking: no end, no outcome. */
  live: boolean;
  direction: "INBOUND" | "OUTBOUND";
  customerNumber: string;
  virtualNumber: string | null;
  agentNumber: string | null;
  agentName: string | null;
  /** The provider's own word for how it ended. */
  status: string | null;
  answered: boolean;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number;
  talkSeconds: number;
  ringSeconds: number | null;
  recordingUrl: string | null;
  callGroup: string | null;
  keyPressed: string | null;
};

export type TelephonyMember = { memberId: string; name: string; number: string; active: boolean };

/** Credits left out of the plan's, each kind the provider counts apart; null where it doesn't say. */
export type TelephonyBalance = { calls: { left: number; total: number } | null; clickToCall: { left: number; total: number } | null; endsAt: Date | null };

/** The plan ends within this many days: worth saying. */
export const PLAN_ENDING_DAYS = 7;

/**
 * Whether a balance is worth telling somebody about, and in what words — null when it isn't. Low is under a
 * tenth of the plan's, or under 50 where the plan's size isn't known.
 */
export function balanceWarning(balance: TelephonyBalance, now = new Date()): string | null {
  const low = (b: { left: number; total: number } | null) => !!b && (b.total > 0 ? b.left < b.total / 10 : b.left < 50);
  const parts: string[] = [];
  if (balance.calls && low(balance.calls)) parts.push(`${Math.max(0, balance.calls.left)} call credits left`);
  if (balance.clickToCall && low(balance.clickToCall)) parts.push(`${Math.max(0, balance.clickToCall.left)} click-to-call credits left`);
  if (balance.endsAt) {
    const days = Math.ceil((balance.endsAt.getTime() - now.getTime()) / 86_400_000);
    if (days <= 0) parts.push("the plan has ended");
    else if (days <= PLAN_ENDING_DAYS) parts.push(`the plan ends in ${days} day${days === 1 ? "" : "s"}`);
  }
  return parts.length ? `CallerDesk is running low: ${parts.join("; ")}. Top up in CallerDesk before calls stop going through.` : null;
}

export class TelephonyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The provider answered, and said no — a key it doesn't know, a number not on the account. */
    readonly refused = false,
  ) {
    super(message);
    this.name = "TelephonyError";
  }
}

export const PROVIDER_NAMES = { CALLERDESK: "CallerDesk" } as const;
