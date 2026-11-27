/**
 * team:test:more — the second half of the team test (owner, 9 Nov 2026), on what team:test made: purchase (vendors,
 * processing, the vendor PO, the bill and paying it, fulfilment), a credit note applied, renewals, a project, attendance,
 * salaries and a payroll run, a journal, approvals history, and a service cycle job done from its task.
 *
 * Each step is done by the person whose job it is, and says whether it should go through. Where the built-in roles
 * don't give somebody the right a business would expect them to have, the report says so — that's a finding about the
 * defaults, not a crash. Local database only. Run after `npm run team:test`.
 *
 *   npm run team:test:more
 */
import "dotenv/config";
import Module from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";

let actor = { id: "", name: "", role: "" };
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn, unstable_noStore: () => {} };
  if (request === "next/navigation") return { redirect: (u: string) => { throw new Error(`redirect ${u}`); }, notFound: () => { throw new Error("notFound"); }, useRouter: () => ({}) };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const me = async () => ({ ...actor, email: `${actor.id}@team.test` });
    return { requireUser: me, currentUser: me, getCurrentUser: me, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

type Who = { id: string; name: string; role: string; managerId?: string | null };
type Finding = { phase: string; step: string; who: string; role: string; expected: "works" | "refused"; outcome: "ok" | "refused" | "crashed"; message: string };
const findings: Finding[] = [];
let phase = "";
let done = 0;

async function as<T>(who: Who, step: string, work: () => Promise<unknown>, expected: "works" | "refused" = "works"): Promise<T | null> {
  actor = { id: who.id, name: who.name, role: who.role };
  try {
    const r = (await work()) as { ok?: boolean; data?: T; error?: string } | T;
    if (r && typeof r === "object" && "ok" in (r as object) && typeof (r as { ok: unknown }).ok === "boolean") {
      const res = r as { ok: boolean; data?: T; error?: string };
      if (!res.ok) {
        findings.push({ phase, step, who: who.name, role: who.role, expected, outcome: "refused", message: String(res.error ?? "") });
        return null;
      }
      if (expected === "refused") findings.push({ phase, step, who: who.name, role: who.role, expected, outcome: "ok", message: "went through, though it should have been refused" });
      done += 1;
      return (res.data ?? (true as T)) as T;
    }
    if (expected === "refused") findings.push({ phase, step, who: who.name, role: who.role, expected, outcome: "ok", message: "went through, though it should have been refused" });
    done += 1;
    return (r ?? (true as T)) as T;
  } catch (e) {
    const message = e instanceof Error ? e.message.split("\n").filter(Boolean).slice(-3).join(" ") : String(e);
    findings.push({ phase, step, who: who.name, role: who.role, expected, outcome: "crashed", message: message.slice(0, 400) });
    return null;
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function main() {
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) throw new Error("Local only.");
  const { db } = await import("../src/lib/db");
  const { setTestPlatformMailer } = await import("../src/lib/platform/mailer");
  setTestPlatformMailer(async () => ({ ok: true, id: "test" }) as never);

  const people = await db.user.findMany({ where: { email: { endsWith: "@team.deskzo.test" }, active: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, role: true, managerId: true, employeeProfile: { select: { designation: true } } } });
  if (people.length < 40) throw new Error("Run npm run team:test first: the team isn't there.");
  const superAdmin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true, name: true } });
  const admin: Who = { id: superAdmin.id, name: superAdmin.name, role: "ADMIN" };
  const title = (p: (typeof people)[number]) => p.employeeProfile?.designation ?? "";
  const one = (pred: (p: (typeof people)[number]) => boolean) => people.find(pred)!;
  const all = (role: string) => people.filter((p) => p.role === role);
  const ceo = one((p) => title(p) === "Chief Executive Officer");
  const coo = one((p) => title(p) === "Chief Operating Officer");
  const cfo = one((p) => title(p) === "Finance Director");
  const accountsManager = one((p) => title(p) === "Accounts Manager");
  const accounts = all("ACCOUNTS");
  const purchaseManager = one((p) => title(p) === "Purchase Manager");
  const purchase = all("PURCHASE");
  const hrHead = all("HR_HEAD")[0]!;
  const hrExec = all("HR")[0]!;
  const renewals = all("RENEWAL_SPECIALIST");
  const supportLead = one((p) => title(p) === "Support Lead");
  const support = all("SUPPORT");
  const managers = all("SALES_MANAGER");
  const reps = all("SALES");

  // ── Purchase: vendors, then each approved order processed, its PO, the bill, paying it, fulfilled.
  phase = "A. Purchase";
  const company = await import("../src/actions/company");
  const orders = await import("../src/actions/order");
  const vendorPo = await import("../src/actions/order-vendor-po");
  const docs = await import("../src/actions/trade-document");
  const payable = await import("../src/actions/payable");
  const approvals = await import("../src/actions/document-approval");
  const onlyPurchase = process.argv.includes("--purchase");
  const vendors: string[] = [];
  const VENDORS = [
    { name: "Redington India Ltd (test)", state: "Tamil Nadu", code: "33", city: "Chennai", pin: "600032", gstin: "33AABCR0347P1ZE" },
    { name: "Ingram Micro India Pvt Ltd (test)", state: "Maharashtra", code: "27", city: "Mumbai", pin: "400093", gstin: "27AAACI1195H1ZV" },
    { name: "Savex Technologies Pvt Ltd (test)", state: "Maharashtra", code: "27", city: "Mumbai", pin: "400072", gstin: "27AAACS6585J1ZW" },
  ];
  const { gstinCheckCharacter } = await import("../src/lib/gst-engine");
  for (const v of VENDORS) {
    const g = v.gstin.slice(0, 14) + gstinCheckCharacter(v.gstin.slice(0, 14));
    const existing = await db.company.findFirst({ where: { name: v.name }, select: { id: true } });
    if (existing) {
      vendors.push(existing.id);
      continue;
    }
    const made = await as<{ id: string }>(purchaseManager, "add a distributor (vendor)", () =>
      company.createCompany({ name: v.name, relationshipType: "DISTRIBUTOR", paymentTerms: "NET_30", location: { label: "Head Office", address: "Plot 1, Industrial Estate", city: v.city, state: v.state, country: "India", pincode: v.pin, gstNumber: g, isBilling: true, isShipping: true, gstTreatment: "REGISTERED_REGULAR" } }),
    );
    const id = made?.id ?? (await db.company.findFirst({ where: { name: v.name }, select: { id: true } }))?.id;
    if (id) vendors.push(id);
  }
  const approved = await db.companyProduct.findMany({ where: { orderStatus: "APPROVED", item: { servicePlan: null } }, orderBy: { orderSeq: "asc" }, take: 10, select: { id: true, orderSeq: true, unitPrice: true, quantity: true, addedByUserId: true } });
  const bills: { id: string; total: number }[] = [];
  for (const [i, o] of approved.entries()) {
    const buyer = purchase[i % purchase.length]!;
    const price = Math.max(1, Math.round(Number(o.unitPrice ?? 1000) * 0.82));
    const processed = await as(buyer, "process the order with a distributor's price", () => orders.processOrder({ orderId: o.id, vendorId: vendors[i % vendors.length]!, purchasePrice: price, ourPoNumber: "" }));
    if (!processed) continue;
    const po = await as<{ id: string }>(buyer, "raise the vendor PO for the order", () => vendorPo.createVendorPoForOrder(o.id));
    if (!po) continue;
    let issued = await as(buyer, "issue the vendor PO", () => docs.issueTradeDocument({ id: po.id, generateEInvoice: false }));
    if (!issued) {
      findings.pop(); // A PO needing approval is the setup's rule: go through it, the purchase manager deciding.
      await as(buyer, "submit the vendor PO for approval", () => approvals.submitForApproval({ id: po.id }));
      const byManager = await as(buyer.id === purchaseManager.id ? cfo : purchaseManager, "the purchase manager approves the vendor PO", () => approvals.decideApproval({ id: po.id, approved: true, note: "Price matches the distributor quote" }));
      // Nobody named can approve once the rule's approvers have left: the super admin is the way through.
      if (!byManager) await as(admin, "the super admin approves the vendor PO", () => approvals.decideApproval({ id: po.id, approved: true, note: "Approved by the owner" }));
      issued = await as(buyer, "issue the approved vendor PO", () => docs.issueTradeDocument({ id: po.id, generateEInvoice: false }));
    }
    if (!issued) continue;
    const acc = accounts[i % accounts.length]!;
    const bill = await as<{ id: string }>(acc, "turn the PO into the distributor's bill", () => docs.convertTradeDocument({ id: po.id, target: "BILL" }));
    if (!bill) continue;
    if (await as(acc, "enter (issue) the bill", () => docs.issueTradeDocument({ id: bill.id, generateEInvoice: false }))) {
      const row = await db.tradeDocument.findUnique({ where: { id: bill.id }, select: { total: true } });
      bills.push({ id: bill.id, total: Number(row?.total ?? 0) });
    }
    await as(buyer, "mark the order fulfilled", () => orders.fulfillOrder(o.id));
  }
  for (const [i, b] of bills.entries()) {
    if (i % 3 === 2) continue;
    await as(accounts[i % accounts.length]!, i % 3 === 1 ? "pay part of a bill" : "pay a bill in full", () => payable.recordBillPayment({ billId: b.id, amount: String(i % 3 === 1 ? Math.round(b.total / 2) : b.total), paidOn: today(), method: "BANK_TRANSFER", reference: `NEFT${5000 + i}` }));
  }
  if (bills[0]) await as(accounts[0]!, "pay more than a bill owes", () => payable.recordBillPayment({ billId: bills[0]!.id, amount: String(bills[0]!.total * 3), paidOn: today(), method: "BANK_TRANSFER" }), "refused");
  if (approved[0]) await as(reps[0]!, "a sales rep tries to process an order", () => orders.processOrder({ orderId: approved[approved.length - 1]!.id, vendorId: vendors[0]!, purchasePrice: 10 }), "refused");

  if (onlyPurchase) return report();

  // ── A credit note against an unpaid invoice, applied.
  phase = "B. Credit notes";
  const receivable = await import("../src/actions/receivable");
  const unpaid = await db.tradeDocument.findMany({ where: { docType: "INVOICE", status: "ISSUED", payments: { none: {} } }, take: 2, select: { id: true, total: true } }).catch(() => []);
  for (const inv of unpaid) {
    const note = await as<{ id: string }>(accountsManager, "raise a credit note against an invoice", () => docs.convertTradeDocument({ id: inv.id, target: "CREDIT_NOTE" }));
    if (!note) continue;
    if (!(await as(accountsManager, "issue the credit note", () => docs.issueTradeDocument({ id: note.id, generateEInvoice: false })))) continue;
    await as(accountsManager, "apply the credit note to the invoice", () => receivable.applyCreditNote({ creditNoteId: note.id, invoiceId: inv.id, amount: Number(inv.total) }));
  }
  if (unpaid[0]) await as(reps[0]!, "a sales rep tries to raise a credit note", () => docs.convertTradeDocument({ id: unpaid[0]!.id, target: "CREDIT_NOTE" }), "refused");

  // ── Renewals: the specialist works them; a rep punches one; accounts approves it.
  phase = "C. Renewals";
  const renewal = await import("../src/actions/renewal");
  const stage = await import("../src/actions/renewal-stage");
  const renewalOrder = await import("../src/actions/renewal-order");
  const specialist = renewals[0]!;
  await as(specialist, "a renewals specialist opens the renewals list", () => renewal.listRenewals({ window: "open" }));
  const fulfilled = await db.companyProduct.findMany({ where: { orderStatus: { in: ["FULFILLED", "APPROVED", "PROCESSING"] }, renewedBy: null, item: { servicePlan: null } }, orderBy: { orderSeq: "asc" }, take: 3, select: { id: true, addedByUserId: true, companyId: true } });
  for (const [i, o] of fulfilled.entries()) {
    await as(specialist, "a renewals specialist marks a renewal as negotiating", () => stage.setRenewalStage({ companyProductId: o.id, stage: "NEGOTIATING", note: "Customer asked for a multi-year price" }));
    const rep = people.find((p) => p.id === o.addedByUserId) ?? reps[0]!;
    const made = await as<{ id: string }>(rep, "the account's rep punches the renewal", () => renewalOrder.createRenewalOrder({ companyProductId: o.id, poNumber: `PO/RN/${700 + i}` }));
    if (made) await as(accounts[i % accounts.length]!, "approve the renewal order", () => orders.approveOrder({ orderId: made.id, approved: true, creditOverrideReason: "Existing customer renewal" }));
  }

  // ── A project: the COO sets it up, the support lead runs it.
  phase = "D. Projects";
  const project = await import("../src/actions/project");
  const customer = await db.company.findFirst({ where: { relationshipType: "CLIENT" }, orderBy: { companySeq: "asc" }, select: { id: true } });
  if (customer) {
    const p = await as<{ id: string }>(coo, "set up a Microsoft 365 migration project", () => project.saveProject({ companyId: customer.id, name: "Microsoft 365 migration", description: "Mail, OneDrive and Teams for 120 users", status: "PLANNING", health: "ON_TRACK", startDate: today(), targetEndDate: addDays(today(), 45), managerId: supportLead.id, value: "450000" }));
    if (p) {
      await as(coo, "add an engineer to the project", () => project.addStakeholder({ projectId: p.id, userId: support[1]!.id, role: "TEAM_MEMBER" }));
      await as(supportLead, "add milestones", async () => {
        for (const [i, name] of ["Discovery and inventory", "Pilot of 10 users", "Cut-over weekend", "Hypercare"].entries()) {
          const r = (await project.saveMilestone({ projectId: p.id, name, dueDate: addDays(today(), 7 * (i + 1)), sortOrder: i })) as { ok: boolean; error?: string };
          if (!r.ok) return r;
        }
        return { ok: true };
      });
      const first = await db.projectMilestone.findFirst({ where: { projectId: p.id }, orderBy: { sortOrder: "asc" }, select: { id: true } });
      if (first) await as(supportLead, "tick off the first milestone", () => project.setMilestoneDone(first.id, true));
      await as(supportLead, "post a weekly update", () => project.postUpdate({ projectId: p.id, body: "Inventory done; pilot users picked.", health: "ON_TRACK" }));
      await as(supportLead, "log a risk", () => project.saveRisk({ projectId: p.id, kind: "RISK", title: "Mailbox sizes over 50 GB", severity: "MEDIUM", status: "OPEN", mitigation: "Archive before cut-over" }));
      await as(supportLead, "move the project to In progress", () => project.saveProject({ id: p.id, companyId: customer.id, name: "Microsoft 365 migration", status: "IN_PROGRESS", health: "ON_TRACK", startDate: today(), targetEndDate: addDays(today(), 45), managerId: supportLead.id, value: "450000" }));
      await as(reps[0]!, "a sales rep (not on it) tries to change the project", () => project.postUpdate({ projectId: p.id, body: "x", health: "AT_RISK" }), "refused");
    }
  }

  // ── Attendance: the last five working days, marked by HR; managers mark their own team.
  phase = "E. Attendance";
  const attendance = await import("../src/actions/attendance");
  const days: string[] = [];
  for (let d = addDays(today(), -1); days.length < 5; d = addDays(d, -1)) if (![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) days.push(d);
  for (const [i, p] of people.slice(0, 12).entries()) {
    await as(hrHead, "HR head marks somebody's attendance", () => attendance.markAttendance({ userId: p.id, date: days[i % days.length]!, status: i % 6 === 5 ? "WORK_FROM_HOME" : "PRESENT", checkInAt: "09:4" + (i % 10), checkOutAt: "18:3" + (i % 10) }));
  }
  for (const m of managers) {
    const team = people.filter((p) => p.managerId === m.id).slice(0, 3);
    for (const p of team) await as(m, "a manager marks their own team's attendance", () => attendance.markAttendance({ userId: p.id, date: days[0]!, status: "PRESENT", checkInAt: "09:30", checkOutAt: "18:30" }));
  }

  // ── Salaries and a payroll run: HR head, as a business would expect; the admin if the defaults don't allow it.
  phase = "F. Payroll";
  const payroll = await import("../src/actions/payroll");
  const monthStart = `${today().slice(0, 7)}-01`;
  const payees = people.slice(0, 10);
  for (const [i, p] of payees.entries()) {
    const basic = 30000 + i * 2500;
    const ok = await as(hrHead, "HR head sets a salary structure", () => payroll.saveSalaryStructure({ userId: p.id, effectiveFrom: monthStart, basic, hra: Math.round(basic * 0.4), specialAllowance: 8000, pfApplicable: true, esiApplicable: false, ptApplicable: true }));
    if (!ok) await as(admin, "the admin sets the salary structure instead", () => payroll.saveSalaryStructure({ userId: p.id, effectiveFrom: monthStart, basic, hra: Math.round(basic * 0.4), specialAllowance: 8000, pfApplicable: true, esiApplicable: false, ptApplicable: true }));
  }
  const [y, m] = today().split("-").map(Number) as [number, number];
  const run = (await as<{ id: string; count: number; skipped: string[] }>(hrHead, "HR head runs this month's payroll", () => payroll.runPayroll({ month: m, year: y }))) ?? (await as<{ id: string; count: number; skipped: string[] }>(admin, "the admin runs payroll instead", () => payroll.runPayroll({ month: m, year: y })));
  if (run && typeof run === "object" && "count" in run && run.count < payees.length) findings.push({ phase, step: "payroll pays everybody with a structure", who: "-", role: "-", expected: "works", outcome: "refused", message: `paid ${run.count} of ${payees.length}; skipped ${run.skipped.slice(0, 5).join("; ")}` });

  // ── Books: a journal by accounts.
  phase = "G. Books";
  const ledger = await import("../src/actions/ledger");
  actor = { id: admin.id, name: admin.name, role: "ADMIN" };
  const accountsList = (await ledger.listAccounts({ postableOnly: true }).catch(() => null)) as unknown;
  const rows = (Array.isArray(accountsList) ? accountsList : ((accountsList as { data?: unknown[] } | null)?.data ?? [])) as { id: string; name: string; code?: string }[];
  const rent = rows.find((a) => /rent/i.test(a.name)) ?? rows.find((a) => /expense/i.test(a.name));
  const bank = rows.find((a) => /bank|cash/i.test(a.name));
  if (rent && bank) {
    const journal = { date: today(), narration: "Office rent for the month", lines: [{ accountId: rent.id, debit: "85000", credit: "" }, { accountId: bank.id, debit: "", credit: "85000" }] };
    const ok = await as(accountsManager, "accounts manager posts a journal", () => ledger.createManualJournal(journal));
    if (!ok) await as(cfo, "the finance director posts it instead", () => ledger.createManualJournal(journal));
  } else findings.push({ phase, step: "find a rent and a bank account to post to", who: "-", role: "-", expected: "works", outcome: "refused", message: `found ${rows.length} postable accounts` });

  // ── Approvals history, as the CEO.
  phase = "H. Approvals";
  const history = await import("../src/actions/approval-history");
  const h = await as<{ total: number }>(ceo, "the CEO reads approvals history", () => history.listApprovalHistory({ whose: "everyone" }, { page: 1, pageSize: 50 }));
  if (h && typeof h === "object" && "total" in h && h.total === 0) findings.push({ phase, step: "approvals history shows the quotes and orders approved", who: ceo.name, role: ceo.role, expected: "works", outcome: "refused", message: "history is empty" });

  // ── The AMC's first job, done from its task by the account manager it belongs to.
  phase = "I. Service cycle job";
  const tasks = await import("../src/actions/task");
  const job = await db.serviceJob.findFirst({ where: { taskId: { not: null } }, select: { id: true, task: { select: { id: true, assignedToUserId: true } } } });
  if (!job?.task) findings.push({ phase, step: "the AMC's first job is somebody's task", who: "-", role: "-", expected: "works", outcome: "refused", message: "no job has a task" });
  else {
    const owner = people.find((p) => p.id === job.task!.assignedToUserId);
    if (!owner) findings.push({ phase, step: "the job's task has an owner", who: "-", role: "-", expected: "works", outcome: "refused", message: "unassigned" });
    else {
      await as(owner, "the owner finishes the service job's task", () => tasks.setTaskStatus(job.task!.id, "DONE"));
      const cycles = await import("../src/actions/service-cycles");
      const due = await as<{ rows: { id: string }[] }>(coo, "Work due no longer lists the done job", () => cycles.listDueWork("all", false));
      if (due && due.rows.some((r) => r.id === job.id)) findings.push({ phase, step: "a done job leaves Work due", who: coo.name, role: coo.role, expected: "works", outcome: "refused", message: "still listed" });
    }
  }

  return report();
}

function report() {
  const unexpected = findings.filter((f) => (f.expected === "works") !== (f.outcome === "ok"));
  const out = path.join(process.cwd(), "backups", "manual", `team-test-more-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ done, findings }, null, 2));
  console.log(`\n${done} steps went through; ${unexpected.length} didn't go as expected.`);
  const grouped = new Map<string, { n: number; f: Finding }>();
  for (const f of unexpected) {
    const key = `${f.phase} | ${f.step} | ${f.outcome} | ${f.message.slice(0, 170)}`;
    grouped.set(key, { n: (grouped.get(key)?.n ?? 0) + 1, f });
  }
  for (const [key, { n, f }] of grouped) console.log(`  ${n}× ${key}  (e.g. ${f.who}, ${f.role})`);
  console.log(`\nFull list: ${out}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
