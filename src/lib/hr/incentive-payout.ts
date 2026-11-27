import { db } from "@/lib/db";

/**
 * Marking incentive earnings as gone out on a payslip.
 *
 * This lives in `src/lib/` and **not** in `src/actions/incentive.ts`, and the reason is the whole
 * point of the file.
 *
 * Every export from a `"use server"` module is a client-callable endpoint. This function previously
 * sat in one with no `requireUser()` at all — so any signed-in user could mark any incentive
 * earning PAID against any payslip id, bypassing `incentives.approve`, the permission whose own
 * description says nobody may decide their own. Worse, because it never resolved a session, a
 * server-action POST aimed at one of the public route prefixes (`/review`, `/forms`, `/track` — see
 * `PUBLIC_PREFIXES` in src/proxy.ts) reached it with no account at all.
 *
 * The guard was on the caller: `runPayroll` checks `payroll.manage` and then calls this. That is
 * the classic shape of the bug — a helper written for one trusted caller, exported from a module
 * where "exported" silently means "published". Moving it here makes the callable surface match the
 * intent, which is a stronger fix than adding a check, because it cannot be reintroduced by
 * somebody re-exporting it later.
 */
export async function attachToPayslips(pairs: { earningId: string; payslipId: string }[], client: Pick<typeof db, "incentiveEarning"> = db) {
  for (const pair of pairs) {
    await client.incentiveEarning.update({
      where: { id: pair.earningId },
      data: { status: "PAID", paidAt: new Date(), payslipId: pair.payslipId },
    });
  }
}

/**
 * Security audit round three, 14 Nov 2026 (R3-03): recalculating a draft run deleted its payslips, and the earnings on
 * them were left "Paid" with no payslip (the relation is SetNull) — the next run takes only approved ones, so the
 * incentive was gone from pay, the bank file, the books and TDS. The rerun now puts this run's earnings back to
 * approved, in its own transaction and before the payslips go, and attaches them again to the payslips it writes.
 */
export async function releaseRunEarnings(runId: string, client: Pick<typeof db, "incentiveEarning"> = db) {
  return client.incentiveEarning.updateMany({
    where: { status: "PAID", payslip: { runId } },
    data: { status: "APPROVED", paidAt: null, payslipId: null },
  });
}
