import { cache } from "react";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, UnmaskResult } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { resolveUserPermissions } from "@/lib/authz/resolve";
import { resolveStoredFieldPolicies } from "@/lib/authz/fields";
import { FIELD_ENTITIES } from "@/lib/authz/field-policy";
import { workspaceClock } from "@/lib/time/workspace";
import { requestFacts } from "@/lib/access/request";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";

/**
 * The daily unmask limit: how many distinct records one person may unmask in one business day.
 *
 * ## What counts
 *
 * A record, once a day. The first time somebody reveals a lead's or a contact's masked fields that day, one
 * unit is used and an `UnmaskUsage` row says so; revealing its email, phone and company together is still that
 * one unit, and showing it again — a reload, the back button, another tab — finds the row and uses nothing. A
 * different record is another unit. When the units are gone, a record not yet unmasked that day stays masked,
 * and its screen says why. The day is the workspace's, on its own clock (Settings › Organisation › Time zone),
 * so it turns over at the workspace's midnight.
 *
 * ## One reveal for every kind of record (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.5)
 *
 * `revealRecord(userId, entity, recordId, fields, reason?)` is the one way in: leads and contacts go through it,
 * and companies (wave B) will too, with nothing to add to the schema — the usage and the log are keyed by
 * `entity` and `recordId`. `leadId` is still written as it was (`contact:<id>` for a contact) for anything that
 * reads the old shape.
 *
 *   · A reveal covers the fields it revealed and no others (audit C.3.6). A field somebody is granted unmask for
 *     later the same day stays masked until they reveal again — a new event, at no extra unit for that record.
 *   · Revealing a lead reveals its contact for the day too, at no unit of its own (audit H.5): the caller names
 *     it as `family`, and it is logged as a row of its own with its entity, id and fields.
 *   · The person may say why (`reason`), which is kept on the log row.
 *
 * ## The default limit (audit M-10)
 *
 * Somebody granted unmask with no limit of their own and none on their role gets the workspace's default
 * (`UnmaskSettings`, 25 a day when nothing is stored) instead of no limit. "No limit" is still possible, but only
 * as an explicit choice: a person's own, a role's, or the default itself set that way.
 *
 * ## Why it is a lock, a count and an insert in one transaction
 *
 * Two requests at the same moment must not both see "49 of 50 used" and both take the fiftieth. Each
 * attempt takes a transaction-scoped advisory lock on the person and the day before it counts, so the
 * check and the write for one person and day happen one at a time — the seat-cap pattern in
 * src/actions/forms.ts. The unique (person, day, entity, record) index is the second line: a repeat can never
 * write a second row, whatever happens above it. The log row is written in the same transaction, so a
 * unit is never used without the attempt being recorded.
 *
 * ## The log is a hash chain (audit H.4.8, the in-app part)
 *
 * Every `UnmaskEvent` row carries its place (`seq`), the hash of the row before and its own: sha256 of that
 * previous hash and the row's canonical JSON (`canonicalEvent`). It is computed inside the insert's transaction
 * under one log-wide lock, so two reveals at the same moment can't both take the same place and fork the chain
 * (and the unique `seq` refuses it if they did). `verifyUnmaskChain` walks it and names the first row that
 * doesn't hold. A database trigger refuses UPDATE, DELETE and TRUNCATE. What the chain can't show by itself — the
 * newest rows removed, or the whole chain rewritten by somebody who owns the database — needs the log tables
 * owned by a separate database role, which is operations' part and not done here.
 *
 * ## What it doesn't decide
 *
 * Whether somebody may unmask a field at all is field access (src/lib/authz/fields.ts), and which
 * records they reach is the record engine (src/lib/authz/access.ts). Both are asked again on every
 * request: a usage row from this morning shows nothing to somebody whose access was taken away since.
 */

/** The largest limit an admin may set — a typo guard, not a business rule. */
export const MAX_DAILY_UNMASK_LIMIT = 10_000;

/** The workspace's default daily limit when nothing is stored (owner, 5 Nov 2026 — audit M-10). */
export const DEFAULT_DAILY_UNMASK_LIMIT = 25;
export const UNMASK_SETTINGS_ID = "global";

/** What can be revealed: a lead, a contact, and (wave B) a company. */
export const REVEAL_ENTITIES = ["leads", "contacts", "companies"] as const;
export type RevealEntity = (typeof REVEAL_ENTITIES)[number];

export function isRevealEntity(value: unknown): value is RevealEntity {
  return typeof value === "string" && (REVEAL_ENTITIES as readonly string[]).includes(value);
}

/** The `leadId` column's value for a record — what it held before `entity`/`recordId`, still written for back-compat. */
export function legacyUnmaskKey(entity: RevealEntity, recordId: string): string {
  if (entity === "leads") return recordId;
  return `${entity === "contacts" ? "contact" : "company"}:${recordId}`;
}

export type UnmaskLimitSource =
  | { via: "superAdmin" }
  | { via: "userLimit"; reason: string | null; expiresAt: Date | null }
  | { via: "roleLimit"; role: string }
  /** Nothing set on them or their role. `workspaceDefault`: the workspace's default applies, as they may unmask something. */
  | { via: "none"; workspaceDefault?: boolean };

/** A person's limit: a number of records a day, or null for no limit. */
export type UnmaskLimit = { dailyLimit: number | null; source: UnmaskLimitSource };

export type UnmaskDefault = { dailyLimit: number | null; stored: boolean; updatedAt: Date | null; updatedById: string | null };

/** The workspace's default daily limit: what is stored, or 25 when nothing is (or the table isn't there yet). */
export const workspaceUnmaskDefault = cache(async (): Promise<UnmaskDefault> => {
  try {
    const row = await db.unmaskSettings.findUnique({ where: { id: UNMASK_SETTINGS_ID }, select: { defaultDailyLimit: true, updatedAt: true, updatedById: true } });
    if (row) return { dailyLimit: row.defaultDailyLimit, stored: true, updatedAt: row.updatedAt, updatedById: row.updatedById };
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return { dailyLimit: DEFAULT_DAILY_UNMASK_LIMIT, stored: false, updatedAt: null, updatedById: null };
});

/**
 * Whether any field of any record type may be unmasked by this person, as the rules are stored — the switch off or
 * on. Someone who can unmask nothing has nothing to count, and keeps "no limit" as before: an admin who sees every
 * field in the clear still sets any role's limit (src/actions/field-access.ts holds a grant to the granter's own).
 */
async function mayUnmaskAnything(userId: string): Promise<boolean> {
  for (const entity of FIELD_ENTITIES) {
    const resolved = await resolveStoredFieldPolicies(userId, entity);
    for (const f of resolved.fields.values()) if (f.policy.view && f.policy.unmask) return true;
  }
  return false;
}

const limitOf = cache(async (userId: string): Promise<UnmaskLimit> => {
  const resolved = await resolveUserPermissions(userId);
  if (resolved.isSuperAdmin) return { dailyLimit: null, source: { via: "superAdmin" } };
  try {
    const own = await db.userUnmaskLimit.findUnique({
      where: { userId },
      select: { limited: true, dailyLimit: true, reason: true, expiresAt: true },
    });
    if (own && (own.expiresAt === null || own.expiresAt.getTime() > Date.now())) {
      return { dailyLimit: own.limited ? own.dailyLimit : null, source: { via: "userLimit", reason: own.reason, expiresAt: own.expiresAt } };
    }
    if (resolved.role) {
      // A role's row with no number is "no limit", chosen by whoever set it.
      const forRole = await db.roleUnmaskLimit.findUnique({ where: { role: resolved.role }, select: { dailyLimit: true } });
      if (forRole) return { dailyLimit: forRole.dailyLimit, source: { via: "roleLimit", role: resolved.role } };
    }
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  // Nothing set on them or their role (owner, 5 Nov 2026 — audit M-10): the workspace's default, not "no limit".
  if (await mayUnmaskAnything(userId)) return { dailyLimit: (await workspaceUnmaskDefault()).dailyLimit, source: { via: "none", workspaceDefault: true } };
  return { dailyLimit: null, source: { via: "none" } };
});

/** One person's daily unmask limit, and where it comes from. */
export async function unmaskLimitFor(userId: string): Promise<UnmaskLimit> {
  return limitOf(userId);
}

/** Today, as the business day the limit counts in: YYYY-MM-DD on the workspace's clock. */
export async function businessDate(at: Date = new Date()): Promise<string> {
  return (await workspaceClock()).dateKey(at);
}

export type UnmaskUsageStatus = {
  businessDate: string;
  used: number;
  /** Null for no limit. */
  limit: number | null;
  /** Null for no limit. */
  remaining: number | null;
};

/** Units used: records revealed today on their own — not those that came with another's reveal. */
const UNITS = { includedWith: null } as const;

/** How many records one person has unmasked today, against their limit — the counter the screens show. */
export async function unmaskUsageToday(userId: string): Promise<UnmaskUsageStatus> {
  const [day, limit] = await Promise.all([businessDate(), limitOf(userId)]);
  let used = 0;
  try {
    used = await db.unmaskUsage.count({ where: { userId, businessDate: day, ...UNITS } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return { businessDate: day, used, limit: limit.dailyLimit, remaining: limit.dailyLimit === null ? null : Math.max(0, limit.dailyLimit - used) };
}

/**
 * The fields this person revealed of one record today, or null when they revealed nothing of it. A reveal covers
 * these and no others (audit C.3.6): what a masker shows in the clear is the fields it may unmask among them.
 */
export const revealedFieldsToday = cache(async (userId: string, entity: RevealEntity, recordId: string): Promise<Set<string> | null> => {
  try {
    const day = await businessDate();
    const row = await db.unmaskUsage.findUnique({
      where: { userId_businessDate_entity_recordId: { userId, businessDate: day, entity, recordId } },
      select: { fields: true },
    });
    return row ? new Set(row.fields) : null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
});

/** The same for records shown together: record id → the fields revealed today; one not revealed is absent. */
export async function revealedFieldsAmong(userId: string, entity: RevealEntity, recordIds: string[]): Promise<Map<string, Set<string>>> {
  if (recordIds.length === 0) return new Map();
  try {
    const day = await businessDate();
    const rows = await db.unmaskUsage.findMany({ where: { userId, businessDate: day, entity, recordId: { in: recordIds } }, select: { recordId: true, fields: true } });
    return new Map(rows.map((r) => [r.recordId, new Set(r.fields)]));
  } catch (err) {
    if (notMigratedYet(err)) return new Map();
    throw err;
  }
}

/** Whether this person revealed anything of this lead today. Kept for callers of the 3 Nov 2026 shape. */
export const revealedToday = cache(async (userId: string, leadId: string): Promise<boolean> => (await revealedFieldsToday(userId, "leads", leadId)) !== null);

/**
 * Which of these keys — a lead's id, or `contact:<id>` — this person revealed anything of today. Kept for callers of
 * the 3 Nov 2026 shape; new code asks `revealedFieldsAmong`, which also says which fields.
 */
export async function revealedTodayAmong(userId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  try {
    const day = await businessDate();
    const rows = await db.unmaskUsage.findMany({ where: { userId, businessDate: day, leadId: { in: keys } }, select: { leadId: true } });
    return new Set(rows.map((r) => r.leadId));
  } catch (err) {
    if (notMigratedYet(err)) return new Set();
    throw err;
  }
}

/** Where an attempt came from, for its log row. Never anything typed into a field. */
export type UnmaskRequestMeta = { requestId: string; ip: string | null; userAgent: string | null; tenantId: string | null };

export async function unmaskRequestMeta(): Promise<UnmaskRequestMeta> {
  const [facts, tenant, given] = await Promise.all([requestFacts(), currentTenantOrNull(), forwardedRequestId()]);
  return {
    requestId: given ?? randomUUID(),
    ip: facts.ip,
    // A user agent is the browser's own string; capped so a crafted one can't fill the log.
    userAgent: facts.userAgent ? facts.userAgent.slice(0, 400) : null,
    tenantId: tenant?.id ?? null,
  };
}

/** A request id the proxy in front of the app set, when it set one that looks like an id. */
async function forwardedRequestId(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const id = (await headers()).get("x-request-id");
    return id && /^[A-Za-z0-9._:-]{8,128}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The longest reason kept: a short note, not a document. */
export const MAX_STATED_REASON = 200;

/** What the person typed as their reason, tidied: one line, capped, and nothing at all when blank. */
export function statedReasonOf(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const text = reason.replace(/\s+/g, " ").trim().slice(0, MAX_STATED_REASON);
  return text || null;
}

/** Who asked about which record, for a refusal's log row. */
export type UnmaskSubject = {
  userId: string;
  userName: string;
  impersonatedByUserId: string | null;
  entity: RevealEntity;
  /** Whatever the caller sent for a record that couldn't be found; capped when logged. */
  recordId: string;
  /** The record as the screens name it — a lead's number, "Contact at <company>". */
  ref: string | null;
};

export type UnmaskAttempt = {
  result: UnmaskResult;
  consumed: boolean;
  usage: UnmaskUsageStatus;
  /** The fields this attempt revealed that weren't already today: all of them the first time, the newly granted ones after. */
  revealed: string[];
};

/** Another record revealed with this one, at no unit of its own — a lead's contact (audit H.5). */
export type RevealFamilyMember = { entity: RevealEntity; recordId: string; fields: string[]; ref?: string | null };

export type RevealOptions = {
  /** How the log names the record: a lead's number, "Contact at <company>". */
  ref?: string | null;
  /** Records revealed with this one when it is revealed (or already was today) — each logged as a row of its own. */
  family?: RevealFamilyMember[];
  /** The person's name for the log; read from their account when not given. */
  userName?: string;
  meta?: UnmaskRequestMeta;
};

async function nameOf(userId: string): Promise<string> {
  return (await db.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "";
}

const capId = (id: string) => id.trim().slice(0, 64);

/**
 * Reveals one record's fields for one person for the rest of the day — the one reveal every kind of record goes
 * through (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.5). Takes a unit if this is the record's first
 * reveal today and one is left; reveals fields granted since this morning's reveal at no unit (audit C.3.6); reveals
 * `options.family` with it at no unit (audit H.5); and logs every one of those, chained, in the same transaction.
 *
 * The caller has already decided which fields this person may unmask on this record (`fields`, never empty), that
 * they reach it, and that nobody is viewing as them — this only counts and records. It returns no values.
 */
export async function revealRecord(
  userId: string,
  entity: RevealEntity,
  recordId: string,
  fields: string[],
  reason?: string | null,
  options: RevealOptions = {},
): Promise<UnmaskAttempt> {
  if (!isRevealEntity(entity)) throw new Error(`revealRecord: "${String(entity)}" isn't a record type that can be revealed.`);
  const keys = [...new Set(fields)];
  if (keys.length === 0) throw new Error("revealRecord: no fields to unmask.");
  const id = capId(recordId);
  if (!id) throw new Error("revealRecord: no record.");
  const [day, limit, meta, userName] = await Promise.all([businessDate(), limitOf(userId), options.meta ?? unmaskRequestMeta(), options.userName ?? nameOf(userId)]);
  const who = { businessDate: day, tenantId: meta.tenantId, userId, userName, impersonatedByUserId: null, statedReason: statedReasonOf(reason), requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent };
  const tag = `${entity}:${id}`;

  const outcome = await db.$transaction(async (tx) => {
    // One attempt at a time per person and day: the count below and the insert after it can't be
    // split by a request arriving in between.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`unmask:${userId}:${day}`}))`;

    const already = await tx.unmaskUsage.findUnique({
      where: { userId_businessDate_entity_recordId: { userId, businessDate: day, entity, recordId: id } },
      select: { id: true, fields: true },
    });
    const used = await tx.unmaskUsage.count({ where: { userId, businessDate: day, ...UNITS } });

    let result: UnmaskResult;
    let consumed = false;
    let usedAfter = used;
    let logged = keys;
    let revealed: string[] = [];
    let note: string | null = null;
    if (already) {
      const more = keys.filter((k) => !already.fields.includes(k));
      if (more.length === 0) {
        result = "REPEAT";
      } else {
        // Granted since this morning's reveal (audit C.3.6): revealed now, logged now, no second unit for the record.
        await tx.unmaskUsage.update({ where: { id: already.id }, data: { fields: [...already.fields, ...more] } });
        result = "ALLOWED";
        logged = more;
        revealed = more;
        note = "More fields of a record already unmasked today — no unit used.";
      }
    } else if (limit.dailyLimit !== null && used >= limit.dailyLimit) {
      result = "QUOTA_EXHAUSTED";
      note = `Daily limit of ${limit.dailyLimit} reached.`;
    } else {
      await tx.unmaskUsage.create({ data: { userId, businessDate: day, entity, recordId: id, leadId: legacyUnmaskKey(entity, id), fields: keys } });
      result = "ALLOWED";
      consumed = true;
      usedAfter = used + 1;
      revealed = keys;
    }

    await appendUnmaskEvent(tx, {
      ...who,
      entity,
      recordId: id,
      leadId: legacyUnmaskKey(entity, id),
      leadRef: options.ref ?? null,
      fields: logged,
      result,
      consumed,
      usedToday: usedAfter,
      dailyLimit: limit.dailyLimit,
      reason: note,
    });

    // One reveal, one record family (audit H.5): what came with it, for the day, at no unit of its own.
    if (result === "ALLOWED" || result === "REPEAT") {
      for (const member of options.family ?? []) {
        const memberKeys = [...new Set(member.fields)];
        const memberId = capId(member.recordId);
        if (!isRevealEntity(member.entity) || memberKeys.length === 0 || !memberId || (member.entity === entity && memberId === id)) continue;
        const had = await tx.unmaskUsage.findUnique({
          where: { userId_businessDate_entity_recordId: { userId, businessDate: day, entity: member.entity, recordId: memberId } },
          select: { id: true, fields: true },
        });
        const more = had ? memberKeys.filter((k) => !had.fields.includes(k)) : memberKeys;
        if (more.length === 0) continue;
        if (had) await tx.unmaskUsage.update({ where: { id: had.id }, data: { fields: [...had.fields, ...more] } });
        else await tx.unmaskUsage.create({ data: { userId, businessDate: day, entity: member.entity, recordId: memberId, leadId: legacyUnmaskKey(member.entity, memberId), fields: more, includedWith: tag } });
        await appendUnmaskEvent(tx, {
          ...who,
          entity: member.entity,
          recordId: memberId,
          leadId: legacyUnmaskKey(member.entity, memberId),
          leadRef: member.ref ?? null,
          fields: more,
          result: "ALLOWED",
          consumed: false,
          usedToday: usedAfter,
          dailyLimit: limit.dailyLimit,
          reason: `With ${options.ref ?? tag} — no unit used.`.slice(0, 200),
        });
      }
    }
    return { result, consumed, used: usedAfter, revealed };
  });

  return {
    result: outcome.result,
    consumed: outcome.consumed,
    revealed: outcome.revealed,
    usage: {
      businessDate: day,
      used: outcome.used,
      limit: limit.dailyLimit,
      remaining: limit.dailyLimit === null ? null : Math.max(0, limit.dailyLimit - outcome.used),
    },
  };
}

/**
 * Logs a refused attempt — no reach, no permission to unmask, or while viewing as somebody. Nothing is
 * counted. Never throws: a refusal is answered whether or not its log row could be written.
 */
export async function logUnmaskDenied(subject: UnmaskSubject, fields: string[], reason: string, meta: UnmaskRequestMeta, statedReason?: string | null): Promise<void> {
  try {
    const day = await businessDate();
    const id = capId(subject.recordId);
    await db.$transaction((tx) =>
      appendUnmaskEvent(tx, {
        businessDate: day,
        tenantId: meta.tenantId,
        userId: subject.userId,
        userName: subject.userName,
        impersonatedByUserId: subject.impersonatedByUserId,
        entity: subject.entity,
        recordId: id,
        leadId: legacyUnmaskKey(subject.entity, id),
        leadRef: subject.ref,
        fields,
        result: "DENIED",
        consumed: false,
        usedToday: null,
        dailyLimit: null,
        reason,
        statedReason: statedReasonOf(statedReason),
        requestId: meta.requestId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      }),
    );
  } catch (err) {
    console.error("[unmask] could not log a refused attempt:", err instanceof Error ? err.message : err);
  }
}

// ─── The chain ─────────────────────────────────────────────────────────────────────────────────────

/** The `prevHash` of the first row. */
export const UNMASK_CHAIN_GENESIS = "0".repeat(64);

/** A log row's content: everything the hash covers but its place in the chain. */
export type UnmaskEventFields = {
  businessDate: string;
  tenantId: string | null;
  userId: string;
  userName: string;
  impersonatedByUserId: string | null;
  entity: string;
  recordId: string;
  leadId: string;
  leadRef: string | null;
  fields: string[];
  result: UnmaskResult;
  consumed: boolean;
  usedToday: number | null;
  dailyLimit: number | null;
  reason: string | null;
  statedReason: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
};

type ChainedRow = UnmaskEventFields & { seq: number; at: Date };

const text = (value: string | null | undefined): string | null => (value === null || value === undefined ? null : String(value));
const count = (value: number | null | undefined): string | null => (value === null || value === undefined ? null : String(value));

/**
 * A row as the text its hash is taken of: a JSON array of strings and nulls in a fixed order. The migration that
 * chained the rows already there (prisma/migrations/20261205090000_unmask_entity_chain) writes exactly this with
 * Postgres's `to_json(text[])`, so keep the two in step.
 */
export function canonicalEvent(row: ChainedRow): string {
  return JSON.stringify([
    "unmask_events/1",
    String(row.seq),
    row.at.toISOString(),
    row.businessDate,
    text(row.tenantId),
    row.userId,
    row.userName,
    text(row.impersonatedByUserId),
    row.entity,
    row.recordId,
    row.leadId,
    text(row.leadRef),
    JSON.stringify(row.fields ?? []),
    row.result,
    row.consumed ? "true" : "false",
    count(row.usedToday),
    count(row.dailyLimit),
    text(row.reason),
    text(row.statedReason),
    text(row.requestId),
    text(row.ip),
    text(row.userAgent),
  ]);
}

/** sha256 of the previous row's hash and this row's canonical JSON, hex. */
export function chainHash(prevHash: string, row: ChainedRow): string {
  return createHash("sha256").update(prevHash + canonicalEvent(row), "utf8").digest("hex");
}

/**
 * Writes one log row at the end of the chain, inside the caller's transaction. A lock of its own (the two-key
 * advisory lock is a key space apart from the per-person one above, which is always taken first) makes every
 * writer wait for the one before to commit, so each reads the true end of the chain; the unique `seq` refuses a
 * fork if anything slipped past it.
 */
export async function appendUnmaskEvent(tx: Prisma.TransactionClient, fields: UnmaskEventFields): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('unmask_events'), 0)`;
  const tip = await tx.unmaskEvent.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, hash: true } });
  // `at` is set here, to the millisecond the column keeps, so the hash covers exactly what is stored.
  const row: ChainedRow = { ...fields, seq: (tip?.seq ?? 0) + 1, at: new Date() };
  const prevHash = tip?.hash ?? UNMASK_CHAIN_GENESIS;
  await tx.unmaskEvent.create({ data: { ...row, prevHash, hash: chainHash(prevHash, row) } });
}

export type UnmaskChainReport = {
  intact: boolean;
  /** Rows checked and found in order. */
  rows: number;
  /** The first row that doesn't hold, and why; null when every row does. */
  broken: { id: string; seq: number; at: Date; userName: string; why: string } | null;
};

/**
 * Walks the whole log in order and checks each row: its place follows the one before, it names that row's hash,
 * and its own hash is what its content gives. The first row that fails is the answer — everything after it is
 * unproven. Reads in pages, so a long log doesn't sit in memory at once.
 */
export async function verifyUnmaskChain(client: Pick<PrismaClient, "unmaskEvent"> = db): Promise<UnmaskChainReport> {
  let prev = UNMASK_CHAIN_GENESIS;
  let expected = 1;
  let rows = 0;
  try {
    for (;;) {
      const page = await client.unmaskEvent.findMany({ where: { seq: { gte: expected } }, orderBy: { seq: "asc" }, take: 2000 });
      if (page.length === 0) break;
      for (const row of page) {
        const broken = (why: string): UnmaskChainReport => ({ intact: false, rows, broken: { id: row.id, seq: row.seq, at: row.at, userName: row.userName, why } });
        if (row.seq !== expected) return broken(expected === row.seq - 1 ? `Row ${expected} is missing before it.` : `Rows ${expected}–${row.seq - 1} are missing before it.`);
        if (row.prevHash !== prev) return broken("It doesn't follow on from the row before it.");
        if (chainHash(prev, row) !== row.hash) return broken("It was changed after it was written.");
        prev = row.hash;
        expected += 1;
        rows += 1;
      }
    }
  } catch (err) {
    if (notMigratedYet(err)) return { intact: true, rows: 0, broken: null };
    throw err;
  }
  return { intact: true, rows, broken: null };
}
