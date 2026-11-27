import type { ContactDesignation, ItemType, LeadAssignmentStrategy, LeadOverflowMode, LeadSource, Prisma, PrismaClient } from "@prisma/client";
import { db as defaultDb } from "@/lib/db";
import { workspaceClock } from "@/lib/time/workspace";
import { stateCodeFromName } from "@/lib/gst-engine";
import { notMigratedYet } from "@/lib/not-migrated";
import { loadFigures, performanceScores, weightedTurn } from "@/lib/leads/performance";
import { isTransaction, lockLeadIntake, peopleWithRoom } from "@/lib/leads/limits";
import { can } from "@/lib/authz/resolve";
import { accessLevel, mayAccessAccount, reachesPerson, resolveAccess, type AccountFacts } from "@/lib/authz/access";

/**
 * Who a new lead goes to, when nobody chose.
 *
 * ## Rules, in order, first match wins
 *
 * Each `LeadAssignmentRule` has conditions and a way of choosing among a pool of people. The first active
 * rule whose conditions all hold decides. Every condition is "any of these", and an empty one matches
 * anything, so "Microsoft leads in Maharashtra → round robin between Priya and Arjun" is one rule and
 * "everything else → least-loaded across the sales team" is a rule with no conditions, placed last.
 *
 * The conditions: brand, product type and the products themselves; the contact's designation; the source;
 * the customer's category (a sub-category counts for its category too); and where the customer is — the
 * company's main address's country, state, city and PIN code (owner, 26 Oct 2026), a PIN matched by its first
 * digits, so "4000" is a run of Mumbai's.
 *
 * ## Choosing within a rule
 *
 *   ROUND_ROBIN    each person in turn. The position is advanced in one UPDATE … RETURNING, so two
 *                  leads arriving together go to two different people, never both to the same one.
 *   LEAST_LOADED   whoever has the fewest open leads now; ties go to whoever is earlier in the pool.
 *   SPECIFIC_USER  the first person in the pool who can take it.
 *   ACCOUNT_MANAGER the company's own account manager, if it has one who can take it — placed
 *                  first, existing customers stay with the person who already knows them.
 *   PERFORMANCE    a share weighted by how each works their leads — closing, answering, keeping at it
 *                  (src/lib/leads/performance.ts): the better get more, nobody gets none.
 *
 * Somebody deactivated, or on approved leave today when the rule says to skip them, is passed over.
 * A rule whose whole pool is unavailable does not strand the lead — the next matching rule is tried.
 *
 * ## Lead limits and reach (owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6.3 and M-15)
 *
 * Somebody at one of their lead limits (src/lib/leads/limits.ts) is passed over too. When everybody a rule would
 * choose is full, the rule's `overflow` says what next: SKIP tries the next rule and, with nobody left anywhere, the
 * answer is "overflow" — the caller keeps the lead unassigned and tells the managers; REFUSE refuses it. With no limit
 * set nobody is ever full, so none of this changes anything until an admin sets one.
 *
 * Among those with room, people who could open the lead once it is theirs are preferred to people who couldn't (M-15:
 * assigned isn't always accessible — by default a lead is seen as far as its company, so a salesperson given a lead
 * on somebody else's account can't open it). `whoCouldOpen` judges that before the lead exists. Only preferred: when
 * nobody in the pool could open it the rule chooses as it always did, rather than leaving every such lead with nobody.
 *
 * `decideOwner` inside the transaction that writes the lead (pass it as `db`) takes the workspace's lead queue, then
 * locks each matching rule's row before choosing — so ROUND_ROBIN, LEAST_LOADED and PERFORMANCE choose one at a time,
 * each seeing the lead before it, and a create that fails rolls the round-robin position back with it.
 *
 * Matching is pure (`ruleMatches`) so it can be checked without a database.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type AssignmentSignals = {
  brandIds: string[];
  itemTypes: ItemType[];
  designation: ContactDesignation | null;
  source: LeadSource;
  /** As the address picker spells it; compared by GST code, so "Jammu and Kashmir" matches "Jammu & Kashmir". */
  state: string | null;
  /** The company's account manager, if it has one — for ACCOUNT_MANAGER rules. */
  companyOwnerId: string | null;
  /**
   * The rest, filled in from the company by `chooseOwner` when only its id is given — so a caller that knows
   * the company needn't know which of its details the rules look at.
   */
  companyId?: string | null;
  itemIds?: string[];
  country?: string | null;
  city?: string | null;
  pincode?: string | null;
  /** The company's category and, for a sub-category, the category it's under. */
  customerCategoryIds?: string[];
};

export type RuleShape = {
  id: string;
  name: string;
  brandIds: string[];
  itemTypes: ItemType[];
  designations: ContactDesignation[];
  sources: LeadSource[];
  states: string[];
  countries?: string[];
  cities?: string[];
  pincodes?: string[];
  customerCategoryIds?: string[];
  itemIds?: string[];
  responseHours?: number | null;
  strategy: LeadAssignmentStrategy;
  userIds: string[];
  skipOnLeave: boolean;
  /** What to do when everybody it would choose is full; SKIP where the column isn't there yet. */
  overflow?: LeadOverflowMode;
};

export const STRATEGY_LABELS: Record<LeadAssignmentStrategy, string> = {
  ROUND_ROBIN: "round robin",
  LEAST_LOADED: "fewest open leads",
  SPECIFIC_USER: "named person",
  ACCOUNT_MANAGER: "account manager",
  PERFORMANCE: "performance share",
};

const anyOf = <T>(wanted: T[] | undefined, has: T[]) => !wanted || wanted.length === 0 || has.some((h) => wanted.includes(h));
const word = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

export function ruleMatches(rule: RuleShape, s: AssignmentSignals): boolean {
  const stateCode = s.state ? stateCodeFromName(s.state) : null;
  const ruleCodes = rule.states.map((st) => stateCodeFromName(st)).filter((c): c is string => c !== null);
  // An address with no country is India's — the app's own default — so "India" rules still match it.
  const country = word(s.country) || (s.state || s.city || s.pincode ? "india" : "");
  const pin = digits(s.pincode);
  return (
    anyOf(rule.brandIds, s.brandIds) &&
    anyOf(rule.itemTypes, s.itemTypes) &&
    anyOf(rule.itemIds, s.itemIds ?? []) &&
    anyOf(rule.designations, s.designation ? [s.designation] : []) &&
    anyOf(rule.sources, [s.source]) &&
    anyOf(rule.customerCategoryIds, s.customerCategoryIds ?? []) &&
    anyOf(rule.countries?.map(word), country ? [country] : []) &&
    anyOf(ruleCodes, stateCode ? [stateCode] : []) &&
    anyOf(rule.cities?.map(word), s.city ? [word(s.city)] : []) &&
    (!rule.pincodes?.length || (!!pin && rule.pincodes.some((p) => digits(p) && pin.startsWith(digits(p)))))
  );
}

/** Who in the pool can take a lead right now, in pool order. */
async function available(db: Db, rule: RuleShape, now: Date, companyOwnerId: string | null, exclude: string[]): Promise<string[]> {
  // An account-manager rule's pool is one person, and it is the company's, not the rule's.
  const candidates = (rule.strategy === "ACCOUNT_MANAGER" ? (companyOwnerId ? [companyOwnerId] : []) : rule.userIds).filter((id) => !exclude.includes(id));
  if (candidates.length === 0) return [];
  const active = await db.user.findMany({ where: { id: { in: candidates }, active: true }, select: { id: true } });
  let ids = candidates.filter((id) => active.some((u) => u.id === id));
  if (rule.skipOnLeave && ids.length) {
    // Leave dates are calendar days, stored as dates; today is the workspace's today, not the server's.
    const today = (await workspaceClock()).calendarDate(now);
    const away = await db.leaveRequest.findMany({
      where: { userId: { in: ids }, status: "APPROVED", fromDate: { lte: today }, toDate: { gte: today } },
      select: { userId: true },
    });
    ids = ids.filter((id) => !away.some((a) => a.userId === id));
  }
  return ids;
}

async function pick(db: Db, rule: RuleShape, pool: string[], now: Date, dryRun = false): Promise<string> {
  if (rule.strategy === "SPECIFIC_USER" || rule.strategy === "ACCOUNT_MANAGER") return pool[0]!;

  if (rule.strategy === "LEAST_LOADED") {
    const loads = await db.lead.groupBy({
      by: ["ownerUserId"],
      where: { ownerUserId: { in: pool }, status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } },
      _count: true,
    });
    const load = (id: string) => loads.find((l) => l.ownerUserId === id)?._count ?? 0;
    return pool.reduce((best, id) => (load(id) < load(best) ? id : best), pool[0]!);
  }

  if (rule.strategy === "PERFORMANCE") {
    // A share by the figures — nothing to move, so a preview is the real answer.
    const figures = await loadFigures(db, pool, now).catch((err) => {
      // The history isn't there yet (a workspace mid-migration): an even share, which is round robin's spirit.
      if (notMigratedYet(err)) return null;
      throw err;
    });
    if (!figures) return pool[0]!;
    return weightedTurn(pool, figures, performanceScores([...figures.values()]));
  }

  // A preview reads the position without moving it — testing the rules must not skip anybody's turn.
  if (dryRun) {
    const current = await db.leadAssignmentRule.findUnique({ where: { id: rule.id }, select: { rrCursor: true } });
    return pool[(current?.rrCursor ?? 0) % pool.length]!;
  }
  const [row] = await db.$queryRaw<{ rrCursor: number }[]>`
    UPDATE "lead_assignment_rules" SET "rrCursor" = "rrCursor" + 1 WHERE "id" = ${rule.id} RETURNING "rrCursor"`;
  const turn = ((row?.rrCursor ?? 1) - 1) % pool.length;
  return pool[turn]!;
}

const RULE_SELECT = {
  id: true,
  name: true,
  brandIds: true,
  itemTypes: true,
  designations: true,
  sources: true,
  states: true,
  strategy: true,
  userIds: true,
  skipOnLeave: true,
} as const;
const NEWER = { countries: true, cities: true, pincodes: true, customerCategoryIds: true, itemIds: true, responseHours: true } as const;
/** 20261213090000_lead_limits. */
const NEWEST = { overflow: true } as const;

/**
 * The active rules in order. The newer conditions are named, as a workspace mid-migration hasn't them yet —
 * there the rules are read without them, and match as they did before. Inside a transaction a failed read would end
 * it, so there the catalogue is asked which columns exist instead.
 */
export async function activeRules(db: Db = defaultDb): Promise<RuleShape[]> {
  const order = [{ priority: "asc" as const }, { createdAt: "asc" as const }];
  const read = (select: typeof RULE_SELECT & Partial<typeof NEWER & typeof NEWEST>) => db.leadAssignmentRule.findMany({ where: { active: true }, orderBy: order, select });
  if (isTransaction(db)) {
    const [has] = await db.$queryRaw<{ newer: boolean; newest: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'lead_assignment_rules' AND column_name = 'responseHours') AS "newer",
             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'lead_assignment_rules' AND column_name = 'overflow') AS "newest"`;
    return read({ ...RULE_SELECT, ...(has?.newer ? NEWER : {}), ...(has?.newest ? NEWEST : {}) });
  }
  for (const select of [{ ...RULE_SELECT, ...NEWER, ...NEWEST }, { ...RULE_SELECT, ...NEWER }]) {
    try {
      return await read(select);
    } catch (err) {
      if (!notMigratedYet(err)) throw err;
    }
  }
  return read(RULE_SELECT);
}

/** The company's details the rules look at, where the caller gave only its id. */
async function withCompany(db: Db, s: AssignmentSignals): Promise<AssignmentSignals> {
  if (!s.companyId || (s.customerCategoryIds !== undefined && s.city !== undefined)) return s;
  const company = await db.company.findUnique({
    where: { id: s.companyId },
    select: {
      customerCategory: { select: { id: true, parentId: true } },
      locations: { where: { isPrimary: true }, select: { country: true, state: true, city: true, pincode: true }, take: 1 },
    },
  });
  const place = company?.locations[0];
  return {
    ...s,
    customerCategoryIds: s.customerCategoryIds ?? [company?.customerCategory?.id, company?.customerCategory?.parentId].filter((id): id is string => !!id),
    country: s.country ?? place?.country ?? null,
    state: s.state ?? place?.state ?? null,
    city: s.city ?? place?.city ?? null,
    pincode: s.pincode ?? place?.pincode ?? null,
  };
}

export type ChooseOptions = {
  /** The transaction that will write the lead — pass it, so the choice and the lead commit or roll back together. */
  db?: Db;
  now?: Date;
  dryRun?: boolean;
  /** Only this rule — a lead moving on for want of an answer stays with the rule that gave it. */
  onlyRuleId?: string;
  /** People not to give it to — those who've had it already. */
  exclude?: string[];
  /**
   * Who could open the lead once it is theirs (`whoCouldOpen`), or null for "can't judge". Worked out here when not
   * given — except inside a transaction, where it would read through the global client (src/lib/leads/limits.ts says
   * why that is avoided): there, work it out first and pass it, or nobody is preferred for it.
   */
  mayOpen?: Set<string> | null;
};

/**
 * What the rules decide for a new lead (owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6.3):
 *
 *   chosen    somebody, by a rule.
 *   none      no rule matched, or nobody in a matching rule could take it today (deactivated, on leave) — as before
 *             limits existed; the caller falls back as it always did.
 *   overflow  every matching rule's people are at their lead limits, and none said REFUSE: keep the lead with nobody,
 *             and tell the managers (wave 2's notifications). `full` is who was passed over.
 *   refused   a rule whose people are all full says REFUSE: refuse the lead with `reason`.
 */
export type OwnerDecision =
  | { kind: "chosen"; userId: string; ruleId: string; note: string }
  | { kind: "none" }
  | { kind: "overflow"; ruleId: string; note: string; full: string[] }
  | { kind: "refused"; ruleId: string; reason: string };

export async function decideOwner(signals: AssignmentSignals, options: ChooseOptions = {}): Promise<OwnerDecision> {
  const db = options.db ?? defaultDb;
  const now = options.now ?? new Date();
  const inTransaction = isTransaction(db);
  // The workspace's queue first, then rules, then people — the one order every transaction takes them in.
  if (inTransaction && !options.dryRun) await lockLeadIntake(db);
  const rules = (await activeRules(db)).filter((r) => !options.onlyRuleId || r.id === options.onlyRuleId);
  if (rules.length === 0) return { kind: "none" };
  const full = await withCompany(db, signals);
  const mayOpen = options.mayOpen !== undefined ? options.mayOpen : inTransaction ? null : await whoCouldOpen(full, { rules });

  let overflowed: { rule: RuleShape; full: string[] } | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, full)) continue;
    // One choice at a time by this rule: whoever comes next sees this lead's owner, and its turn.
    if (inTransaction && !options.dryRun) await db.$executeRaw`SELECT 1 FROM "lead_assignment_rules" WHERE "id" = ${rule.id} FOR UPDATE`;
    const pool = await available(db, rule, now, full.companyOwnerId, options.exclude ?? []);
    if (pool.length === 0) continue;
    const withRoom = await peopleWithRoom(pool, { db });
    if (withRoom.length === 0) {
      if (rule.overflow === "REFUSE") {
        return { kind: "refused", ruleId: rule.id, reason: `Everybody the assignment rule “${rule.name}” gives leads to is at their lead limit, and the rule refuses a lead rather than leave it with nobody.` };
      }
      overflowed ??= { rule, full: pool };
      continue;
    }
    // M-15: those who could open it, when any could; otherwise as before.
    const seeing = mayOpen ? withRoom.filter((id) => mayOpen.has(id)) : [];
    const userId = await pick(db, rule, seeing.length ? seeing : withRoom, now, options.dryRun);
    return { kind: "chosen", userId, ruleId: rule.id, note: `Rule “${rule.name}” — ${STRATEGY_LABELS[rule.strategy]}` };
  }
  if (overflowed) {
    return { kind: "overflow", ruleId: overflowed.rule.id, full: overflowed.full, note: `Left with nobody — everybody the rule “${overflowed.rule.name}” gives leads to is at their lead limit` };
  }
  return { kind: "none" };
}

/**
 * Who a new lead goes to, when nobody chose: `decideOwner`'s choice, or null — for nobody, whatever the reason. A
 * caller that tells overflow from "no rule" (to keep the lead and notify, or to refuse) asks `decideOwner`.
 */
export async function chooseOwner(signals: AssignmentSignals, options: ChooseOptions = {}): Promise<{ userId: string; note: string; ruleId: string } | null> {
  const decided = await decideOwner(signals, options);
  return decided.kind === "chosen" ? { userId: decided.userId, note: decided.note, ruleId: decided.ruleId } : null;
}

/**
 * Whether this person could open a lead on this account once it was theirs — judged before the lead exists (M-15).
 * Exactly what the lead pages will ask (`leads.view`, then `leadAccess` at view): a level by person (OWN, TEAM, BRANCH,
 * ALL) reaches a lead they own; FOLLOW does too (owner, 26 Nov 2026), as well as those on accounts they reach; NONE never.
 */
async function couldOpenAsOwner(userId: string, account: AccountFacts): Promise<boolean> {
  if (!(await can(userId, "leads.view"))) return false;
  const level = await accessLevel(userId, "leads", "view");
  if (level === "NONE") return false;
  // A lead they own is theirs to open, wherever its account sits — unless their Data Scope says otherwise
  // (src/lib/authz/access.ts `leadsFollowing`).
  if (level === "FOLLOW") return (await resolveAccess(userId)).leadReach.owned || mayAccessAccount(userId, "view", account);
  return reachesPerson(userId, "leads", "view", userId);
}

/**
 * Of the people the matching rules could choose (and the company's account manager), those who could open a lead on
 * this company once it was theirs — or null when there is no company to judge by. Reads through the global client:
 * call it before the transaction, and pass the answer to `decideOwner` as `mayOpen`.
 */
export async function whoCouldOpen(signals: AssignmentSignals, options: { rules?: RuleShape[] } = {}): Promise<Set<string> | null> {
  if (!signals.companyId) return null;
  const company = await defaultDb.company.findUnique({ where: { id: signals.companyId }, select: { id: true, ownerUserId: true, relationshipType: true } });
  if (!company) return null;
  const full = await withCompany(defaultDb, signals);
  const rules = (options.rules ?? (await activeRules())).filter((r) => ruleMatches(r, full));
  const candidates = new Set<string>(rules.flatMap((r) => (r.strategy === "ACCOUNT_MANAGER" ? [] : r.userIds)));
  if (company.ownerUserId) candidates.add(company.ownerUserId);
  const out = new Set<string>();
  for (const id of candidates) if (await couldOpenAsOwner(id, company)) out.add(id);
  return out;
}

/** The signals for a lead that exists — for re-running the rules on it. */
export async function signalsForLead(leadId: string, db: Db = defaultDb): Promise<AssignmentSignals | null> {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: {
      source: true,
      companyId: true,
      contact: { select: { designation: true } },
      company: {
        select: {
          ownerUserId: true,
          customerCategory: { select: { id: true, parentId: true } },
          locations: { where: { isPrimary: true }, select: { country: true, state: true, city: true, pincode: true }, take: 1 },
        },
      },
      requirements: { select: { itemId: true, item: { select: { brandId: true, type: true } } } },
    },
  });
  if (!lead) return null;
  const place = lead.company.locations[0];
  return {
    brandIds: [...new Set(lead.requirements.map((r) => r.item.brandId).filter((b): b is string => !!b))],
    itemTypes: [...new Set(lead.requirements.map((r) => r.item.type))],
    itemIds: [...new Set(lead.requirements.map((r) => r.itemId))],
    designation: lead.contact?.designation ?? null,
    source: lead.source,
    companyId: lead.companyId,
    country: place?.country ?? null,
    state: place?.state ?? null,
    city: place?.city ?? null,
    pincode: place?.pincode ?? null,
    customerCategoryIds: [lead.company.customerCategory?.id, lead.company.customerCategory?.parentId].filter((id): id is string => !!id),
    companyOwnerId: lead.company.ownerUserId,
  };
}
