import type { AccessLevel } from "@prisma/client";
import type { AccessRow } from "@/actions/access-levels";
import type { PersonLevelRow } from "@/actions/person-access";
import type { AccessAction, AccessRecord } from "@/lib/authz/access";
import { LEVEL_WORDS } from "@/lib/authz/level-order";

/**
 * Record reach as the Document Permissions and Data Scope screens read it: one shape for a role's grid
 * (`roleAccessLevels`) and a person's (`personAccessGrid`), so both screens draw, stage and save a
 * cell the same way whoever the subject is.
 *
 * Pure — types, words and converters — so the server pages build the rows and the client screens read
 * them. Every level, action and allowed-level list is the engine's own (src/lib/authz/access.ts).
 */

// The engine's ACCESS_ACTIONS: that module reads the database, so it stays on the server.
export const REACH_ACTIONS = ["view", "edit", "delete", "assign"] as const satisfies readonly AccessAction[];
export const ACTION_LABEL: Record<AccessAction, string> = { view: "View", edit: "Edit", delete: "Delete", assign: "Assign" };

/** Who the screen is about: a role, or one person and the role they hold. */
export type Subject =
  | { type: "role"; key: string; name: string }
  | { type: "user"; id: string; name: string; roleKey: string; roleName: string };

export type SubjectOption = { id: string; name: string; hint?: string };

/** The exception a person carries, when saved with a reason and an end date. */
export type SaveOptions = { reason?: string; expiresAt?: string | null };

export type ReachCell = {
  /** What applies with nothing set here: a role's permissions (derived), or a person's role. */
  base: AccessLevel;
  /** Where `base` comes from, in words. */
  baseWhy: string;
  /** What is stored here — on the role, or for the person alone — or null where it follows `base`. */
  set: AccessLevel | null;
  /** What the engine answers today. */
  effective: AccessLevel;
  /** Why it answers that. */
  why: string;
  /** An action the record doesn't have (nobody deletes a project): drawn as a dash, never stored. */
  absent?: boolean;
};

export type ReachRow = {
  key: AccessRecord;
  label: string;
  /** What "own" means for it. */
  ownMeans: string;
  /** The levels an admin may choose for it — anything else is refused. */
  levels: AccessLevel[];
  actions: AccessAction[];
  cells: Record<AccessAction, ReachCell>;
};

export type ReachChange = { record: string; action: string; level: AccessLevel | null };

/** A role's grid: stored on the role, or derived from the permissions it holds. */
export function reachOfRole(rows: AccessRow[]): ReachRow[] {
  return rows.map((row) => {
    const cells = {} as Record<AccessAction, ReachCell>;
    for (const action of REACH_ACTIONS) {
      const cell = row.cells[action];
      const absent = !row.actions.includes(action);
      const baseWhy = cell.derivedFrom.key
        ? `${cell.derivedFrom.held ? "Holds" : "Doesn't hold"} "${cell.derivedFrom.label}", so ${LEVEL_WORDS[cell.derived].toLowerCase()}.`
        : "Not an action this record has.";
      cells[action] = {
        base: cell.derived,
        baseWhy,
        set: cell.stored,
        effective: cell.stored ?? cell.derived,
        why: absent ? "Not an action this record has." : cell.stored !== null ? "Set on this role." : baseWhy,
        ...(absent ? { absent: true } : {}),
      };
    }
    return { key: row.key, label: row.label, ownMeans: row.ownMeans, levels: row.levels, actions: row.actions, cells };
  });
}

/** A person's grid: their own level, or their role's. */
export function reachOfPerson(rows: PersonLevelRow[], roleName: string): ReachRow[] {
  return rows.map((row) => {
    const cells = {} as Record<AccessAction, ReachCell>;
    for (const action of REACH_ACTIONS) {
      const cell = row.cells[action];
      cells[action] = {
        base: cell.role,
        baseWhy: `Their role (${roleName}) gives ${LEVEL_WORDS[cell.role].toLowerCase()}.`,
        set: cell.own?.level ?? null,
        effective: cell.effective,
        why: cell.why,
        ...(cell.absent ? { absent: true } : {}),
      };
    }
    return { key: row.key, label: row.label, ownMeans: row.ownMeans, levels: row.levels, actions: row.actions, cells };
  });
}

// ─── Words ────────────────────────────────────────────────────────────────────────────────────────

/** A level as a chip words it — short enough for a 66px chip ("As the account" is "Account"). */
export const CHIP_LABEL: Record<AccessLevel, string> = { NONE: "None", OWN: "Own", TEAM: "Team", BRANCH: "Branch", ALL: "All", FOLLOW: "Account" };

/** Narrow to wide, for a legend and a cycle; "As the account" sits beside the order (level-order.ts). */
export const LEVEL_ORDER: readonly AccessLevel[] = ["NONE", "OWN", "TEAM", "BRANCH", "FOLLOW", "ALL"];

/** What a level reaches, in the engine's own words (src/lib/authz/access.ts). */
export function levelMeans(level: AccessLevel, ownMeans?: string): string {
  switch (level) {
    case "NONE":
      return "Nothing.";
    case "OWN":
      return ownMeans && !ownMeans.startsWith("—") ? `Only records where they are ${ownMeans}.` : "Only records whose own person is them.";
    case "TEAM":
      return "Theirs, and those of anybody who reports to them, at any depth.";
    case "BRANCH":
      return "Those of anybody in their branch — for documents and payments, the record's own branch.";
    case "ALL":
      return "Every record.";
    case "FOLLOW":
      return "As far as the account: they reach one exactly when they reach its company.";
  }
}

/** The reach said as one sentence about the subject: "People in Sales can view leads that are theirs or…". */
export function reachSentence(input: {
  who: string;
  action: AccessAction;
  level: AccessLevel;
  row: Pick<ReachRow, "key" | "label" | "ownMeans">;
  /** Leads "as the account" only: Data Scope's two ticks as they apply (src/lib/authz/lead-reach.ts). */
  leadReach?: { owned: boolean; made: boolean } | null;
}): string {
  const { who, action, level, row, leadReach } = input;
  const things = row.label.toLowerCase();
  switch (level) {
    case "NONE":
      return `${who} can't ${action} any ${things}.`;
    case "OWN":
      return `${who} can ${action} only the ${things} where they are ${row.ownMeans}.`;
    case "TEAM":
      return `${who} can ${action} the ${things} that are theirs, or belong to anybody who reports to them at any depth.`;
    case "BRANCH":
      return row.key === "documents" || row.key === "payments"
        ? `${who} can ${action} the ${things} of their branch — the record's own branch, whoever raised it.`
        : `${who} can ${action} the ${things} of anybody in their branch.`;
    case "ALL":
      return `${who} can ${action} every one of the ${things}.`;
    case "FOLLOW": {
      const also = leadReach?.owned && leadReach.made ? "own or made" : leadReach?.owned ? "own" : leadReach?.made ? "made" : null;
      return also
        ? `${who} can ${action} the ${things} of the customers and vendors they reach, and also the ${things} they ${also} and their team's, even on a customer they can't see.`
        : `${who} can ${action} the ${things} of the customers and vendors they reach — exactly as far as the account.`;
    }
  }
}
