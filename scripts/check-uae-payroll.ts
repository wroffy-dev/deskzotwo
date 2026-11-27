/**
 * check:uae-payroll — UAE payroll (owner, 15 Nov 2026 — src/lib/uae, src/actions/uae-payroll.ts).
 *
 *   1. The rules, pure: a UAE IBAN read and checked, its bank found among the top 10 by its three digits; the WPS salary
 *      file — EDR per person, EVP only with variable pay, the SCR control line last, its total, the file's name, every
 *      problem named; gratuity — none under a year, 21 days a year then 30, the two-year cap; a month's pay for the days.
 *   2. Through the real actions as a UAE workspace, in March 2031 (no attendance there): the WPS setup, one person's
 *      pay, your own pay refused, the month worked out, overtime typed, locked, the salary file made; UAE leave added;
 *      an Indian workspace refused. Its own rows removed in a finally; what was there before put back.
 *   3. The books, the payslip and the reminders (owner, 15 Nov 2026): locking posts the wages (salaries against what's
 *      owed), unlocking reverses them, locking again posts afresh; marking paid posts the payment once and can't be
 *      undone; the printed payslip for the person (once locked) and payroll, nobody else; an expired visa raised once
 *      as a reminder to payroll, 60/30/7 days before and once expired. Its journal entries removed in the finally.
 *
 *   npm run check:uae-payroll
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";
import { legacyTenant } from "../src/lib/tenancy/registry";
import { runAsTenant } from "../src/lib/tenancy/resolve";
import type { Tenant } from "../src/lib/tenancy/state";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { ...real, requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/actions/module" || request.endsWith("actions/module")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, isModuleEnabled: async () => true };
  }
  // The local workspace's plan may not have Payroll; the module's own door is checked elsewhere (check:module-guards).
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { ...real, requireModuleUser: user, requireModuleAccess: user, moduleAvailableForTenant: async () => true };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

/** A UAE IBAN with its check digits worked out: bank (3 digits) and account (16). */
function makeIban(bank: string, account: string): string {
  const digits = `${bank}${account}` + "1014" + "00"; // "AE" → 10 14, check digits 00 for working out
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return `AE${String(98 - rest).padStart(2, "0")}${bank}${account}`;
}

async function main() {
  section("1. The rules");
  const banks = await import("../src/lib/uae/wps-banks");
  const mashreq = makeIban("033", "1234567890123456");
  ok("a UAE IBAN as typed, spaces and all, is read", banks.uaeIban(mashreq.replace(/(.{4})/g, "$1 ").toLowerCase()) === mashreq, mashreq);
  ok("  one digit wrong fails its check digits", banks.uaeIban(mashreq.slice(0, -1) + ((Number(mashreq.slice(-1)) + 1) % 10)) === null);
  ok("  the bank by its three digits: Mashreq, 203320101", banks.bankOfIban(mashreq)?.routingCode === "203320101");
  ok("  FAB by NBAD's 035; Emirates NBD by 026", banks.bankOfIban(makeIban("035", "0000000000000001"))?.name.includes("FAB") === true && banks.bankOfIban(makeIban("026", "0000000000000001"))?.routingCode === "302620122");
  ok("ten top banks, each a 9-digit code", banks.TOP_BANKS.length === 10 && banks.WPS_BANKS.every((b) => /^\d{9}$/.test(b.routingCode)));

  const sif = await import("../src/lib/uae/sif");
  const line = { name: "Asha", personId: "12345678901", routingCode: "203320101", iban: mashreq, payStart: "2031-03-01", payEnd: "2031-03-31", fixed: 9000, overtime: 0, otherVariable: 0, unpaidDays: 0 };
  const built = sif.buildSif({
    establishmentId: "965625",
    employerRoutingCode: "802420101",
    month: 3,
    year: 2031,
    created: { year: 2031, month: 4, day: 2, hour: 9, minute: 5, second: 7 },
    reference: "March, pay",
    lines: [line, { ...line, name: "Ravi", personId: "00098765432109", payStart: "2031-03-10", fixed: 4500.5, overtime: 250, otherVariable: 100, unpaidDays: 2 }],
  });
  const rows = built.ok ? built.content.split("\r\n").filter(Boolean) : [];
  ok("the file's name: employer ID to 13, YYMMDD, HHMMSS, .SIF", built.ok && built.fileName === "0000000965625310402090507.SIF", built);
  ok("an EDR line: person ID to 14, routing, IBAN, period, days, fixed, variable, unpaid days", rows[0] === `EDR,00012345678901,203320101,${mashreq},2031-03-01,2031-03-31,31,9000.00,0.00,0`, rows[0]);
  ok("  variable pay brings an EVP line: overtime and the rest in their places", rows[1]?.startsWith("EDR,00098765432109") && rows[1].endsWith(",22,4500.50,350.00,2") && rows[2] === "EVP,00098765432109,203320101,0.00,0.00,0.00,0.00,250.00,100.00,0.00", rows.slice(1, 3));
  ok("  the SCR last: employer, its bank, created, HHMM, MMYYYY, lines, total, AED, reference without commas", rows.length === 4 && rows[3] === "SCR,0000000965625,802420101,2031-04-02,0905,032031,2,13850.50,AED,March  pay", rows[3]);
  const bad = sif.buildSif({ establishmentId: "", employerRoutingCode: "", month: 3, year: 2031, created: { year: 2031, month: 4, day: 2, hour: 9, minute: 5, second: 7 }, lines: [{ ...line, personId: "", iban: "AE12", payEnd: "2031-04-02", fixed: -1 }] });
  ok("every problem at once, each naming who", !bad.ok && bad.problems.length === 6 && bad.problems.some((p) => p.startsWith("Asha: the MOHRE")), bad);

  const gr = await import("../src/lib/uae/gratuity");
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  ok("under a year: nothing", gr.uaeGratuity({ basicMonthly: 6000, joinedOn: d("2030-01-01"), lastDay: d("2030-12-30") }).amount === 0);
  const three = gr.uaeGratuity({ basicMonthly: 6000, joinedOn: d("2027-01-01"), lastDay: d("2029-12-31") });
  ok("three years at 6,000: 21 days a year at 200 a day ≈ 12,600", Math.abs(three.amount - 12600) < 30, three);
  const seven = gr.uaeGratuity({ basicMonthly: 6000, joinedOn: d("2020-01-01"), lastDay: d("2026-12-30") });
  ok("seven years: 5×21 + 2×30 days ≈ 165 days, 33,000", Math.abs(seven.amount - 33000) < 60, seven);
  const thirty = gr.uaeGratuity({ basicMonthly: 6000, joinedOn: d("1995-01-01"), lastDay: d("2024-12-31") });
  ok("thirty years: capped at two years' basic, 144,000", thirty.capped && thirty.amount === 144000, thirty);
  ok("unpaid days come off the service", gr.uaeGratuity({ basicMonthly: 6000, joinedOn: d("2029-01-01"), lastDay: d("2030-01-10"), unpaidDays: 30 }).amount === 0);

  const pay = await import("../src/lib/uae/payroll");
  const c = { basic: 6000, housing: 2000, transport: 700, otherAllowance: 300 };
  ok("a full month: the whole 9,000, overtime on top", JSON.stringify(pay.payFor(c, { monthDays: 30, daysHere: 30, unpaidDays: 0, deductions: 0, overtime: 150, bonus: 0 })) === '{"fixed":9000,"net":9150}');
  ok("  3 unpaid days and a 100 deduction: 9,000 × 27/30 − 100", pay.payFor(c, { monthDays: 30, daysHere: 30, unpaidDays: 3, deductions: 100, overtime: 0, bonus: 0 }).fixed === 8000);
  ok("  joined on the 16th of 30: half", pay.payFor(c, { monthDays: 30, daysHere: 15, unpaidDays: 0, deductions: 0, overtime: 0, bonus: 0 }).fixed === 4500);

  section("2. Through the actions, as a UAE workspace");
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;
  const home = await legacyTenant();
  if (!home) throw new Error("no workspace to act as");
  const uae: Tenant = { ...home, country: "AE" };
  const india: Tenant = { ...home, country: "IN" };
  const person = await db.user.findFirst({ where: { kind: "MEMBER", active: true, id: { not: admin.id } }, select: { id: true, name: true } });
  if (!person) throw new Error("nobody else to pay");

  const settingsBefore = await db.uaeWpsSettings.findUnique({ where: { id: "global" } });
  const personBefore = await db.uaeEmployee.findUnique({ where: { userId: person.id } });
  const runBefore = await db.uaePayrollRun.findUnique({ where: { month_year: { month: 3, year: 2031 } } });
  const leaveBefore = new Set((await db.leaveType.findMany({ where: { code: { startsWith: "UAE_" } }, select: { code: true } })).map((t) => t.code));
  if (runBefore) throw new Error("March 2031 already has a UAE run — remove it first");
  const a = await import("../src/actions/uae-payroll");
  try {
    await runAsTenant(india, async () => {
      const r = await a.uaePayroll();
      ok("an Indian workspace is refused", !r.ok && /UAE/.test(r.error), r);
    });
    await runAsTenant(uae, async () => {
      const setup = await a.saveWpsSetup({ establishmentId: "965625", payingRoutingCode: "802420101", payingIban: "", employerReference: "zz check" });
      ok("the WPS setup saved: Dubai Islamic Bank pays", setup.ok, setup);
      ok("  a bad routing code refused", !(await a.saveWpsSetup({ establishmentId: "1", payingRoutingCode: "12", payingIban: "", employerReference: "" })).ok);
      const mine = await a.saveUaePerson(admin.id, { basic: 1 });
      ok("your own pay is refused", !mine.ok && /own pay/.test(mine.ok ? "" : mine.error));
      const badIban = await a.saveUaePerson(person.id, { basic: 6000, iban: "AE070331234567890123450" });
      ok("an IBAN with wrong check digits is refused", !badIban.ok, badIban);
      const saved = await a.saveUaePerson(person.id, { basic: 6000, housing: 2000, transport: 700, otherAllowance: 300, mohrePersonId: "12345678901", iban: mashreq, visaExpiry: "2000-01-01" });
      ok("their pay, MOHRE ID and IBAN saved", saved.ok, saved);
      const view = await a.uaePayroll();
      const me = view.ok ? view.data.people.find((p) => p.userId === person.id) : null;
      ok("  the page shows them at Mashreq, read from the IBAN", me?.bankName === "Mashreq" && me.basic === 6000, me);
      ok("  an expired visa is listed", view.ok && view.data.expiries.some((e) => e.userId === person.id && e.document === "Residence visa" && e.daysLeft < 0));

      const started = await a.startUaeRun(3, 2031);
      ok("March 2031 worked out", started.ok, started);
      if (!started.ok) return;
      const run = await a.uaeRun(started.data.runId);
      const slip = run.ok ? run.data.slips.find((s) => s.userId === person.id) : null;
      ok("  their payslip: the full 9,000 for 31 days, nothing missing", slip?.fixed === 9000 && slip.monthDays === 31 && slip.missing.length === 0, slip);
      const adj = slip ? await a.adjustUaePayslip(slip.id, { overtime: "250", bonus: "0", deductions: "0", unpaidDays: "0", note: "" }) : null;
      ok("  overtime typed: net 9,250", adj?.ok === true && (await db.uaePayslip.findUniqueOrThrow({ where: { id: slip!.id } })).net.toNumber() === 9250, adj);
      const early = await a.uaeSalaryFile(started.data.runId);
      ok("no file from a draft", !early.ok && /Lock/.test(early.ok ? "" : early.error));
      const lockedRun = await a.setUaeRunLocked(started.data.runId, true);
      ok("locked", lockedRun.ok, lockedRun);
      ok("  a locked payslip can't be changed", !(await a.adjustUaePayslip(slip!.id, { overtime: "1", bonus: "0", deductions: "0", unpaidDays: "0", note: "" })).ok);
      const file = await a.uaeSalaryFile(started.data.runId);
      const lines = file.ok ? file.data.content.split("\r\n").filter(Boolean) : [];
      const mineLine = lines.find((l) => l.startsWith("EDR,00012345678901,"));
      ok("the salary file: their EDR at Mashreq, 9000 fixed and 250 variable", mineLine === `EDR,00012345678901,203320101,${mashreq},2031-03-01,2031-03-31,31,9000.00,250.00,0`, file.ok ? lines : file);
      ok("  an EVP with the overtime, and the SCR at Dubai Islamic Bank for March 2031", lines.some((l) => l === "EVP,00012345678901,203320101,0.00,0.00,0.00,0.00,250.00,0.00,0.00") && /^SCR,0000000965625,802420101,\d{4}-\d{2}-\d{2},\d{4},032031,\d+,[\d.]+,AED,zz check$/.test(lines.at(-1) ?? ""), lines.at(-1));
      ok("  named for the employer ID", file.ok && /^0000000965625\d{12}\.SIF$/.test(file.data.fileName));
      ok("a locked month can't be removed", !(await a.deleteUaeRun(started.data.runId)).ok);

      section("3. The books, the payslip and the reminders");
      const entries = async () => db.journalEntry.findMany({ where: { postingKey: { startsWith: `uae-payroll:${started.data.runId}:` } }, select: { id: true, reversesId: true, reversedBy: { select: { id: true } }, lines: { select: { debit: true, credit: true, account: { select: { code: true, name: true } } } } } });
      const posted = await entries();
      const wage = posted[0];
      const debit = wage?.lines.reduce((t, l) => t + Number(l.debit), 0) ?? 0;
      const credit = wage?.lines.reduce((t, l) => t + Number(l.credit), 0) ?? 0;
      ok("locking posted the wages, balanced, at least this person's 9,250", posted.length === 1 && Math.abs(debit - credit) < 0.01 && debit >= 9250, wage);
      const unlocked = await a.setUaeRunLocked(started.data.runId, false);
      const reversal = await db.journalEntry.findFirst({ where: { reversesId: wage?.id } });
      ok("unlocking reversed them", unlocked.ok && !!reversal, unlocked);
      await a.setUaeRunLocked(started.data.runId, true);
      const again2 = await entries();
      ok("  locking again posts afresh — one entry standing", again2.length === 2 && again2.filter((e) => !e.reversedBy).length === 1);
      const paidMonth = await a.markUaeRunPaid(started.data.runId, "2031-04-01");
      const payment = await db.journalEntry.findUnique({ where: { postingKey: `uae-payroll-paid:${started.data.runId}` }, select: { date: true } });
      ok("marked paid: the payment posted on the day paid", paidMonth.ok && payment?.date.toISOString().slice(0, 10) === "2031-04-01", { paidMonth, payment });
      ok("  a paid month can't be unlocked, or paid twice", !(await a.setUaeRunLocked(started.data.runId, false)).ok && !(await a.markUaeRunPaid(started.data.runId, "2031-04-02")).ok);
      ok("  the salary file still comes from a paid month", (await a.uaeSalaryFile(started.data.runId)).ok);

      const doc = await a.getUaePayslip(slip!.id);
      ok("the payslip for payroll: net 9,250, IBAN's last four only", doc?.net === 9250 && doc.ibanLast4 === mashreq.slice(-4) && doc.bankName === "Mashreq", doc);
      const before = actorId;
      actorId = person.id;
      const own = await a.getUaePayslip(slip!.id);
      ok("  and for the person, the month being paid", own?.id === slip!.id);
      actorId = before;

      const rem = await import("../src/lib/uae/reminders");
      ok("the reminder steps: 60, 30, 7, expired, nothing further off", rem.expiryStep(61) === null && rem.expiryStep(60) === 60 && rem.expiryStep(31) === 60 && rem.expiryStep(30) === 30 && rem.expiryStep(7) === 7 && rem.expiryStep(0) === 7 && rem.expiryStep(-1) === "expired");
      const { workspaceClock } = await import("../src/lib/time/workspace");
      const candidates = await rem.uaeExpiryCandidates(admin.id, new Date(), await workspaceClock());
      const visa = candidates.find((c) => c.dedupeKey.startsWith(`uae-doc:${person.id}:Residence visa:2000-01-01:expired`));
      ok("an expired visa raised for payroll, keyed once", !!visa && /has expired/.test(visa.title), candidates.slice(0, 3));
      const { syncSystemNotifications } = await import("../src/lib/notify");
      await syncSystemNotifications(admin.id, { kinds: new Set(["RENEWAL_EXPIRING"]) });
      await syncSystemNotifications(admin.id, { kinds: new Set(["RENEWAL_EXPIRING"]) });
      ok("  in the bell once, however often the sweep runs", (await db.notification.count({ where: { userId: admin.id, dedupeKey: visa?.dedupeKey } })) === 1);

      const leave = await a.addUaeLeave();
      ok("UAE leave added: annual 30, sick half pay among them", leave.ok && (await db.leaveType.findUnique({ where: { code: "UAE_ANNUAL" } }))?.annualQuota.toNumber() === 30 && !!(await db.leaveType.findUnique({ where: { code: "UAE_SICK_HALF" } })), leave);
      const again = await a.addUaeLeave();
      ok("  a second time adds nothing", again.ok && again.data.length === 0);
    });
  } finally {
    const runIds = (await db.uaePayrollRun.findMany({ where: { month: 3, year: 2031 }, select: { id: true } })).map((r) => r.id);
    for (const id of runIds) {
      const originals = (await db.journalEntry.findMany({ where: { OR: [{ postingKey: { startsWith: `uae-payroll:${id}:` } }, { postingKey: `uae-payroll-paid:${id}` }] }, select: { id: true } })).map((e) => e.id);
      await db.journalEntry.deleteMany({ where: { reversesId: { in: originals } } });
      await db.journalEntry.deleteMany({ where: { id: { in: originals } } });
    }
    await db.notification.deleteMany({ where: { dedupeKey: { startsWith: `uae-doc:${person.id}:` } } });
    await db.uaePayrollRun.deleteMany({ where: { month: 3, year: 2031 } });
    if (personBefore) await db.uaeEmployee.update({ where: { userId: person.id }, data: { ...personBefore, id: undefined } as never });
    else await db.uaeEmployee.deleteMany({ where: { userId: person.id } });
    if (settingsBefore) await db.uaeWpsSettings.update({ where: { id: "global" }, data: settingsBefore });
    else await db.uaeWpsSettings.deleteMany({ where: { id: "global" } });
    await db.leaveType.deleteMany({ where: { code: { startsWith: "UAE_", notIn: [...leaveBefore] }, balances: { none: {} }, requests: { none: {} } } });
  }
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
