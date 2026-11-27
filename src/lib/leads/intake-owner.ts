import type { Prisma } from "@prisma/client";
import { decideOwner, type AssignmentSignals } from "@/lib/leads/assign";
import { LeadCapacityFull, claimLeadCapacity, leadCapacityError } from "@/lib/leads/limits";

/**
 * Who a lead from outside goes to, under the lead limits (owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6.5): the
 * one decision every intake path makes the same way — the website's capture API and Elementor, cards, booking pages,
 * the inbox, Automate's "Create a lead", public forms, and a won lead carried on into the next pipeline.
 *
 *   · Somebody named (a card's holder, a booking's host, the form's person, the inbox's agent) is given it when they
 *     have room. When they're full, the lead is still made — with nobody, and a note saying why — and the managers are
 *     told. An enquiry is never lost to somebody's limit.
 *   · Nobody named: the assignment rules (`decideOwner`). Everybody full and SKIP: the same, nobody and a note.
 *     REFUSE: the lead is refused (`LeadRuleRefused`), as the rule says.
 *   · The plan's cap (`LeadCapacityFull`, `scope: "workspace"`) is the one refusal of the lead itself, whoever it was
 *     for. HTTP paths answer it with 429.
 *
 * It runs inside the transaction that writes the lead, after anything else that can refuse the request (a rate limit,
 * a full event), so a refused request takes nobody's round-robin turn and nobody's place. What reads through the global
 * client — who could open the lead (`whoCouldOpen`) — is worked out before, and handed in.
 */

export type IntakeOwnerPlan =
  /** Somebody chosen already; `note` is the lead's assignment note when they take it. */
  | { kind: "named"; userId: string; note: string | null }
  /** The assignment rules choose; `fallback` when no rule matches (a form's admin, say), else nobody. */
  | { kind: "rules"; signals: AssignmentSignals; mayOpen: Set<string> | null; fallback?: { userId: string; note: string | null } | null }
  /** Nobody, on purpose — still counted against the plan. */
  | { kind: "nobody"; note: string | null };

export type IntakeOwner = {
  userId: string | null;
  note: string | null;
  /**
   * Kept with nobody because whoever it was for is at their limit (`full`: who, when somebody named was), or everybody
   * the rules would choose is: `reason` says which, for the managers (`overflowReason`).
   */
  overflow: { reason: string; full: string | null } | null;
};

/** A rule whose people are all full says REFUSE: the lead is refused, with the rule's reason. */
export class LeadRuleRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadRuleRefused";
  }
}

/**
 * The owner of a lead about to be written in `tx`, and its room taken (`claimLeadCapacity`, creating — so the plan's cap
 * is counted too). Throws `LeadCapacityFull` only for the plan's cap, and `LeadRuleRefused` for a REFUSE rule.
 * `creating: false` for a lead that isn't new to the workspace (a won lead carried on), as the wave 1 API says.
 */
export async function intakeOwner(tx: Prisma.TransactionClient, plan: IntakeOwnerPlan, options: { creating?: boolean } = {}): Promise<IntakeOwner> {
  const creating = options.creating ?? true;
  let wanted: { userId: string; note: string | null } | null = null;
  let overflow: IntakeOwner["overflow"] = null;
  let note: string | null = null;

  if (plan.kind === "named") wanted = { userId: plan.userId, note: plan.note };
  else if (plan.kind === "nobody") note = plan.note;
  else {
    const decided = await decideOwner(plan.signals, { db: tx, mayOpen: plan.mayOpen });
    switch (decided.kind) {
      case "chosen":
        wanted = { userId: decided.userId, note: decided.note };
        break;
      case "overflow":
        note = decided.note;
        overflow = { reason: decided.note.replace(/^Left with nobody — /, ""), full: null };
        break;
      case "refused":
        throw new LeadRuleRefused(decided.reason);
      case "none":
        wanted = plan.fallback ?? null;
        break;
    }
  }

  if (!wanted) {
    // Nobody: only the plan's cap to count against.
    await claimLeadCapacity(tx, [null], { creating });
    return { userId: null, note, overflow };
  }
  try {
    await claimLeadCapacity(tx, [wanted.userId], { creating });
    return { userId: wanted.userId, note: wanted.note, overflow: null };
  } catch (err) {
    const full = leadCapacityError(err);
    // The plan's cap refuses the lead itself; anything else isn't ours to read.
    if (!full || full.scope === "workspace") throw err;
    // Thrown after the plan's count was taken, from JavaScript, not the database: the transaction goes on, with this
    // lead counted once — it is still made, with nobody.
    const who = (await tx.user.findUnique({ where: { id: wanted.userId }, select: { name: true } }))?.name ?? "the person it was for";
    const why = `${who} is at their limit of ${limitWords(full)}`;
    return { userId: null, note: `Left with nobody — ${why}`.slice(0, 300), overflow: { reason: why, full: wanted.userId } };
  }
}

function limitWords(full: LeadCapacityFull): string {
  const which = full.limit === "open" ? "open leads" : full.limit === "perDay" ? "leads a day" : full.limit === "perMonth" ? "leads a month" : "leads";
  return `${full.max.toLocaleString("en-IN")} ${which}`;
}

// ─── Telling the managers ────────────────────────────────────────────────────────────────────────

type Notifier = (leadIds: string[], reason: string) => Promise<unknown>;
let replaced: Notifier | null = null;

/**
 * For the checks only: what `notifyOverflow` calls instead of the managers' notice, so a check can see who would be
 * told without anybody being. Returns the undo.
 */
export function replaceOverflowNotifier(notifier: Notifier): () => void {
  replaced = notifier;
  return () => {
    if (replaced === notifier) replaced = null;
  };
}

/** The one sentence the managers are told, as createLead words it: `“<title>”: <why>.` */
export function overflowReason(title: string, overflow: { reason: string }): string {
  return `“${title.trim().slice(0, 120)}”: ${overflow.reason}.`;
}

/**
 * Tells the people who manage lead assignment that these leads came in with nobody free to take them — after the
 * transaction that made them commits, never inside it. `notifyLeadOverflow` (src/lib/leads/overflow-notify.ts) does the
 * telling and batches a burst; this only calls it, and a notice that can't be sent never undoes or refuses the lead.
 */
export async function notifyOverflow(leadIds: string[], reason: string): Promise<void> {
  const ids = [...new Set(leadIds.filter(Boolean))];
  if (ids.length === 0) return;
  try {
    if (replaced) {
      await replaced(ids, reason);
      return;
    }
    const notices = (await import("@/lib/leads/overflow-notify")) as { notifyLeadOverflow?: Notifier };
    await notices.notifyLeadOverflow?.(ids, reason);
  } catch (err) {
    console.error("[leads] the managers couldn't be told about leads left with nobody", err instanceof Error ? err.message : err);
  }
}
