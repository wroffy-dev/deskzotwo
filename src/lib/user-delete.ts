import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Deleting an account outright (owner, 31 Oct 2026: for "the added user" — added by mistake, a wrong
 * address, a test). The super admin only, and only an account that owns nothing: switching off stays the
 * answer for everybody who did any work, because people own records and a delete would take them along.
 *
 * "Owns nothing" is asked of the database, not of a list somebody keeps up: every foreign key that points
 * at users (there are over 300) is read from the catalogue and each is counted for this person. A new
 * module's table is covered the day it is added. The only rows that don't count are the account's own —
 * its photo, settings, sign-ins, notifications and the like, which a new account gets without doing any
 * work — and those are removed with it.
 */

/** Tables that belong to the account itself, not to work it did. Removed with it. */
export const ACCOUNT_OWN = new Set([
  "user_photos",
  "notifications",
  "notification_preferences",
  "password_reset_tokens",
  "sign_ins",
  "sign_in_rules",
  "user_devices",
  "app_devices",
  "app_pairings",
  "table_preferences",
  "page_layouts",
  "celebration_seen",
  "conversation_reads",
  "chat_members",
  "chat_presence",
  "user_daily_activity",
  "user_permissions",
  "user_access_levels",
  "user_lead_reach",
  "user_access_policies",
  "user_field_policies",
  "user_unmask_limits",
  "unmask_usage",
  "feedback_quotas",
  "screenshot_allowances",
  "leave_balances",
  "employee_profiles",
  "mail_connections",
  "calendar_accounts",
  "calendar_feeds",
  "signature_outlook",
  "signature_syncs",
  "telephony_agents",
]);

/**
 * Tables kept whatever happens to the account (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.8). The unmasking
 * log names a person by id and name, never by a link to their account, so deleting the account leaves its rows where
 * they are — the archive of who revealed what — and its hash chain unbroken; the database refuses to delete them
 * anyway. Named here so it stays that way should a link ever be added: such a table is neither counted against the
 * delete nor emptied by it.
 */
export const KEPT_WHEN_DELETED = new Set(["unmask_events"]);

type Reference = { table: string; column: string };

let references: Promise<Reference[]> | null = null;

/** Every column that points at users.id, from Postgres's catalogue — once per process (the schema only changes with a deploy). */
function userReferences(client: Pick<Prisma.TransactionClient, "$queryRawUnsafe"> = db): Promise<Reference[]> {
  references ??= client
    .$queryRawUnsafe<Reference[]>(
      `SELECT cl.relname::text AS "table", a.attname::text AS "column"
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
        WHERE con.contype = 'f' AND con.confrelid = 'users'::regclass
        ORDER BY 1, 2`,
    )
    .catch((err) => {
      references = null;
      throw err;
    });
  return references;
}

/** "sales_orders" → "sales orders"; the join tables Prisma makes ("_OrderWatchers") read as what they are. */
export function plainTable(table: string): string {
  const join = /^_(.+)$/.exec(table);
  const name = join ? join[1]!.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() : table.replace(/_/g, " ");
  return name;
}

export type Holding = { table: string; count: number };

/** What this person has that isn't the account's own — empty means they may be deleted. */
export async function userHoldings(userId: string, client: Pick<Prisma.TransactionClient, "$queryRawUnsafe"> = db): Promise<Holding[]> {
  const refs = (await userReferences(client)).filter((r) => !ACCOUNT_OWN.has(r.table) && !KEPT_WHEN_DELETED.has(r.table));
  const byTable = new Map<string, number>();
  for (const ref of refs) {
    const rows = await client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${ref.table}" WHERE "${ref.column}" = $1`, userId);
    const n = rows[0]?.n ?? 0;
    if (n > 0) byTable.set(ref.table, (byTable.get(ref.table) ?? 0) + n);
  }
  return [...byTable].map(([table, count]) => ({ table, count })).sort((a, b) => b.count - a.count);
}

/** Where a reference from another account reads better as what it is ("users" is their manager, locker…). */
const PLAIN: Record<string, string> = { users: "other people's accounts", audit_logs: "history" };

/** The holdings in a phrase: "leads (12), history (3) and 2 more". */
export function holdingsText(holdings: Holding[]): string {
  const shown = holdings.slice(0, 3).map((h) => `${PLAIN[h.table] ?? plainTable(h.table)} (${h.count})`);
  const more = holdings.length - shown.length;
  if (more > 0) shown.push(`${more} more`);
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
}

/** Removes the account's own rows and then the account, in the caller's transaction. Checks nothing — the action does. */
export async function removeAccount(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  for (const ref of (await userReferences(tx)).filter((r) => ACCOUNT_OWN.has(r.table) && !KEPT_WHEN_DELETED.has(r.table))) {
    await tx.$executeRawUnsafe(`DELETE FROM "${ref.table}" WHERE "${ref.column}" = $1`, userId);
  }
  await tx.user.delete({ where: { id: userId } });
}
