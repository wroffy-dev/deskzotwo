import { directClient } from "@/lib/tenancy/direct-client";

/**
 * Known half-applied migrations, put back before `prisma migrate deploy` runs (src/lib/platform/migrate.ts).
 *
 * A migration that fails is recorded as failed — after which `migrate deploy` refuses every database it is on (P3009)
 * until somebody resolves it by hand. When the cause was a fault in the migration file itself, fixed in a
 * later commit, a deploy should not need a person in a terminal: each repair here recognises its failed
 * row, removes whatever the bad run may have left — only when nothing has been written there since — and
 * marks the row rolled back, so the fixed file then applies cleanly. (On PostgreSQL Prisma ran the failed
 * file in a transaction, so normally there is nothing to remove — check:migration-repairs shows it — but
 * the undo is written for a database where the half survived, and refuses one with rows in it.)
 *
 * 20261201200000_employee_loans (31 Oct 2026): the file also created custom_field_reveals, which
 * 20261129150000_custom_field_secrets_files already makes, so every existing database failed there. Live's
 * canary (the platform's own workspace) failed there, the run stopped, and no other workspace was
 * migrated — the People page then read tables they didn't have yet. Fixed in be2e6f84.
 */

type Repair = { migration: string; undo: string[]; mustBeEmpty: string[] };

const REPAIRS: Repair[] = [
  {
    migration: "20261201200000_employee_loans",
    mustBeEmpty: ["loan_repayments", "employee_loans"],
    undo: [
      `DROP TABLE IF EXISTS "loan_repayments"`,
      `DROP TABLE IF EXISTS "employee_loans"`,
      `ALTER TABLE "payslips" DROP COLUMN IF EXISTS "loanRecovery"`,
      `DROP TYPE IF EXISTS "LoanStatus"`,
      `DROP TYPE IF EXISTS "LoanKind"`,
    ],
  },
];

export { REPAIRS as MIGRATION_REPAIRS };

/** What a repair did on one database — for the run's output. */
export type RepairNote = { migration: string; outcome: "repaired" | "refused"; reason?: string };

/**
 * Puts back every known failed migration on this database. Does nothing on a database without one (a new
 * workspace, one already brought through) — and nothing at all when `_prisma_migrations` isn't there yet.
 * A repair whose tables hold rows is refused, not forced: the failed row stays and the deploy reports it.
 */
export async function repairKnownFailures(databaseUrl: string): Promise<RepairNote[]> {
  const db = directClient(databaseUrl);
  const notes: RepairNote[] = [];
  try {
    const exists = await db.$queryRawUnsafe<{ t: string | null }[]>(`SELECT to_regclass('_prisma_migrations')::text AS t`);
    if (!exists[0]?.t) return notes;
    for (const repair of REPAIRS) {
      const failed = await db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NULL AND rolled_back_at IS NULL`,
        repair.migration,
      );
      if (!failed.length) continue;
      let busy: string | null = null;
      for (const table of repair.mustBeEmpty) {
        const there = await db.$queryRawUnsafe<{ t: string | null }[]>(`SELECT to_regclass($1)::text AS t`, `"${table}"`);
        if (!there[0]?.t) continue;
        const rows = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}"`);
        if ((rows[0]?.n ?? 0) > 0) busy = table;
      }
      if (busy) {
        notes.push({ migration: repair.migration, outcome: "refused", reason: `${busy} has rows` });
        continue;
      }
      await db.$transaction(async (tx) => {
        for (const statement of repair.undo) await tx.$executeRawUnsafe(statement);
        await tx.$executeRawUnsafe(
          `UPDATE "_prisma_migrations" SET rolled_back_at = now() WHERE migration_name = $1 AND finished_at IS NULL AND rolled_back_at IS NULL`,
          repair.migration,
        );
      });
      notes.push({ migration: repair.migration, outcome: "repaired" });
    }
    return notes;
  } finally {
    await db.$disconnect();
  }
}
