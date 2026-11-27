/** Data Scope's two lead ticks, in words and keys — for the client as well (src/lib/authz/lead-reach.ts reads and checks them). */

export type LeadReachKey = "owned" | "made";
export const LEAD_REACH_KEYS: readonly LeadReachKey[] = ["owned", "made"];
export const LEAD_REACH_LABEL: Record<LeadReachKey, string> = { owned: "Leads they own", made: "Leads they made" };

export type LeadReachView = {
  /** What applies. */
  effective: { owned: boolean; made: boolean };
  /** The role's answer — what a person follows with nothing of their own. */
  role: { owned: boolean; made: boolean };
  /** A person's own answers, null where they follow their role; null for a role. */
  own: { owned: boolean | null; made: boolean | null; reason: string | null } | null;
};
