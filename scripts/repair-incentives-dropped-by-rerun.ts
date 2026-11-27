/**
 * Security audit round three, 14 Nov 2026 (R3-03): finds incentive earnings a payroll recalculation dropped, and — with
 * --apply — puts them back to approved so the next payroll run pays them.
 *
 * Before the fix, recalculating a draft run deleted its payslips; an earning on one was left "Paid" with no payslip
 * (the relation is SetNull), and the next run takes only approved earnings, so it was never paid. An earning paid
 * outside payroll ("Pay" on the Incentives page) looks the same in the table — Paid, a paid date, no payslip — so the
 * two can't be told apart by their columns, and a migration can't repair them blindly: putting back one that really
 * was paid by hand would pay it twice. What tells them apart is the audit trail: a hand payment records
 * "<name> — <label> — paid" against the earning; one paid through payroll records nothing of its own.
 *
 * So this lists every Paid earning with no payslip, says which have a hand payment on record, and with --apply puts
 * back only those without one. Read the list first — an earning paid by hand before the audit trail existed, or whose
 * audit row was purged, would be listed as dropped. Runs against the workspace in .env (DATABASE_URL).
 *
 *   npx tsx scripts/repair-incentives-dropped-by-rerun.ts            # list only
 *   npx tsx scripts/repair-incentives-dropped-by-rerun.ts --apply    # and put the dropped ones back to approved
 */
import "dotenv/config";
import { directClient } from "../src/lib/tenancy/direct-client";

const db = directClient();
const apply = process.argv.includes("--apply");

async function main() {
  const stranded = await db.incentiveEarning.findMany({
    where: { status: "PAID", payslipId: null },
    orderBy: { paidAt: "asc" },
    select: { id: true, label: true, amount: true, paidAt: true, toDate: true, user: { select: { name: true } } },
  });
  if (stranded.length === 0) {
    console.log("No Paid incentive earning without a payslip — nothing to repair.");
    return;
  }
  const byHand = new Set(
    (
      await db.auditLog.findMany({
        where: { entityType: "IncentiveEarning", entityId: { in: stranded.map((e) => e.id) }, entityLabel: { contains: "— paid" } },
        select: { entityId: true },
      })
    ).map((a) => a.entityId),
  );
  const dropped = stranded.filter((e) => !byHand.has(e.id));
  console.log(`${stranded.length} Paid earning(s) with no payslip: ${stranded.length - dropped.length} paid by hand (on record), ${dropped.length} likely dropped by a payroll recalculation.\n`);
  for (const e of stranded) {
    const kind = byHand.has(e.id) ? "paid by hand — left alone" : "DROPPED — would go back to approved";
    console.log(`  ${e.id}  ${e.user.name} — ${e.label} — ₹${Number(e.amount).toLocaleString("en-IN")} — for ${e.toDate.toISOString().slice(0, 10)}, marked paid ${e.paidAt?.toISOString().slice(0, 10) ?? "?"} — ${kind}`);
  }
  if (!apply) {
    console.log("\nNothing changed. Check the list with payroll, then run again with --apply.");
    return;
  }
  const result = await db.incentiveEarning.updateMany({
    where: { id: { in: dropped.map((e) => e.id) }, status: "PAID", payslipId: null },
    data: { status: "APPROVED", paidAt: null },
  });
  console.log(`\n${result.count} earning(s) put back to approved; the next payroll run pays them.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
