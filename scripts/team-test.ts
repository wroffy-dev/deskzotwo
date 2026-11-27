/**
 * team:test — a 50-person team working in Deskzo, through the app's own actions, to find bugs (owner, 9 Nov 2026).
 *
 * Each step is done as the person who would do it — a rep adds a customer and a lead, accounts invoices and records
 * the payment, support works a ticket, HR approves leave — so the app's permissions, validation and side effects all
 * run. Every refusal and every crash is written down with who, what and the app's own words; the report groups them.
 * A refusal isn't always a bug (a rep may not approve an order); the report says which step expected what.
 *
 * Local database only. Run it on a workspace reset to its setup (it adds people, so a second run adds more).
 *
 *   npm run team:test                 everything
 *   npm run team:test -- --people     only add the team
 */
import "dotenv/config";
import Module from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";

// ─── Acting as somebody ─────────────────────────────────────────────────────────

let actor: { id: string; name: string; role: string } = { id: "", name: "", role: "" };
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn, unstable_noStore: () => {} };
  if (request === "next/navigation") return { redirect: (u: string) => { throw new Error(`redirect ${u}`); }, notFound: () => { throw new Error("notFound"); }, useRouter: () => ({}) };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const me = async () => ({ ...actor, email: `${actor.id}@team.test`, isSuperAdmin: actor.role === "ADMIN_SUPER" });
    return { requireUser: me, currentUser: me, getCurrentUser: me, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

type Finding = { phase: string; step: string; who: string; role: string; expected: "works" | "refused"; outcome: "ok" | "refused" | "crashed"; message: string };
const findings: Finding[] = [];
let phase = "";
let done = 0;

/** Does `work` as `who`; writes down anything that isn't what was expected. Returns the data, or null. */
async function as<T>(who: Person | Admin, step: string, work: () => Promise<{ ok: boolean; data?: T; error?: string } | T>, expected: "works" | "refused" = "works"): Promise<T | null> {
  actor = { id: who.id, name: who.name, role: who.role };
  try {
    const r = (await work()) as { ok?: boolean; data?: T; error?: string } | T;
    if (r && typeof r === "object" && "ok" in (r as object)) {
      const res = r as { ok: boolean; data?: T; error?: string };
      if (!res.ok) {
        findings.push({ phase, step, who: who.name, role: who.role, expected, outcome: "refused", message: String(res.error ?? "") });
        return null;
      }
      if (expected === "refused") findings.push({ phase, step, who: who.name, role: who.role, expected, outcome: "ok", message: "went through, though it should have been refused" });
      done += 1;
      return (res.data ?? (null as T)) as T;
    }
    done += 1;
    return r as T;
  } catch (e) {
    const message = e instanceof Error ? `${e.message.split("\n").filter(Boolean).slice(-3).join(" ")}` : String(e);
    findings.push({ phase, step, who: who.name, role: who.role, expected, outcome: "crashed", message: message.slice(0, 400) });
    return null;
  }
}

// ─── The team and its customers ───────────────────────────────────────────────

type Admin = { id: string; name: string; role: string };
type Person = Admin & { dept: string; title: string; managerKey?: string; key: string };

const FIRST = ["Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Ayaan", "Krishna", "Ishaan", "Ananya", "Diya", "Saanvi", "Aadhya", "Pari", "Anika", "Navya", "Myra", "Sara", "Kiara", "Rohan", "Kabir", "Dev", "Neha", "Pooja", "Rahul", "Sneha", "Vikram", "Meera", "Karan", "Riya", "Nikhil", "Tanvi", "Manish", "Priya", "Harsh", "Isha", "Yash", "Kavya", "Amit", "Shreya", "Varun", "Divya", "Siddharth", "Nisha", "Gaurav", "Simran", "Akash", "Pallavi", "Tarun"];
const LAST = ["Sharma", "Verma", "Iyer", "Nair", "Reddy", "Patel", "Mehta", "Gupta", "Kapoor", "Joshi", "Das", "Menon", "Rao", "Bose", "Malhotra", "Chopra", "Saxena", "Pillai", "Kulkarni", "Banerjee"];

/** Who's who: [key, department, role, title, manager key]. Fifty people. */
const TEAM: [string, string, string, string, string?][] = [
  ["ceo", "Management", "MANAGEMENT", "Chief Executive Officer"],
  ["coo", "Management", "MANAGEMENT", "Chief Operating Officer", "ceo"],
  ["cfo", "Management", "MANAGEMENT", "Finance Director", "ceo"],
  ["sm1", "Sales", "SALES_MANAGER", "Sales Manager — North", "coo"],
  ["sm2", "Sales", "SALES_MANAGER", "Sales Manager — South", "coo"],
  ...Array.from({ length: 6 }, (_, i): [string, string, string, string, string] => [`rn${i + 1}`, "Sales", "SALES", "Account Executive", "sm1"]),
  ...Array.from({ length: 6 }, (_, i): [string, string, string, string, string] => [`rs${i + 1}`, "Sales", "SALES", "Account Executive", "sm2"]),
  ...Array.from({ length: 6 }, (_, i): [string, string, string, string, string] => [`cl${i + 1}`, "Inside Sales", "CALLING", "Inside Sales Executive", "sm1"]),
  ...Array.from({ length: 4 }, (_, i): [string, string, string, string, string] => [`ps${i + 1}`, "Presales & Solutions", "SALES", "Solutions Consultant", "coo"]),
  ["sl", "Support", "SUPPORT", "Support Lead", "coo"],
  ...Array.from({ length: 7 }, (_, i): [string, string, string, string, string] => [`su${i + 1}`, "Support", "SUPPORT", "Support Engineer", "sl"]),
  ["am", "Accounts", "ACCOUNTS", "Accounts Manager", "cfo"],
  ...Array.from({ length: 3 }, (_, i): [string, string, string, string, string] => [`ac${i + 1}`, "Accounts", "ACCOUNTS", "Accounts Executive", "am"]),
  ["pm", "Purchase", "PURCHASE", "Purchase Manager", "cfo"],
  ...Array.from({ length: 2 }, (_, i): [string, string, string, string, string] => [`pu${i + 1}`, "Purchase", "PURCHASE", "Purchase Executive", "pm"]),
  ["hh", "HR & Admin", "HR_HEAD", "HR Head", "ceo"],
  ["hr1", "HR & Admin", "HR", "HR Executive", "hh"],
  ["rec", "HR & Admin", "RECRUITER", "Recruiter", "hh"],
  ...Array.from({ length: 2 }, (_, i): [string, string, string, string, string] => [`re${i + 1}`, "Sales", "RENEWAL_SPECIALIST", "Renewals Specialist", "sm2"]),
  ...Array.from({ length: 2 }, (_, i): [string, string, string, string, string] => [`pr${i + 1}`, "Inside Sales", "PROFILE", "Data Profiler", "sm1"]),
];

const STATES = [
  { name: "Maharashtra", code: "27", city: "Mumbai", pin: "400069" },
  { name: "Karnataka", code: "29", city: "Bengaluru", pin: "560103" },
  { name: "Delhi", code: "07", city: "New Delhi", pin: "110020" },
  { name: "Tamil Nadu", code: "33", city: "Chennai", pin: "600032" },
  { name: "Telangana", code: "36", city: "Hyderabad", pin: "500081" },
  { name: "Haryana", code: "06", city: "Gurugram", pin: "122002" },
  { name: "West Bengal", code: "19", city: "Kolkata", pin: "700091" },
  { name: "Gujarat", code: "24", city: "Ahmedabad", pin: "380015" },
];
const BUSINESSES = ["Logistics", "Pharma", "Textiles", "Foods", "Infra", "Fintech", "Hospitals", "Retail", "Engineering", "Chemicals", "Motors", "Education", "Media", "Realty", "Solar", "Agro", "Steel", "Packaging", "Travels", "Diagnostics"];
const PREFIX = ["Sunrise", "Apex", "Bluestone", "Greenfield", "Silverline", "Orion", "Vertex", "Pinnacle", "Lotus", "Crescent", "Northstar", "Everest"];

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ─── The run ────────────────────────────────────────────────────────────────────

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error("Local only.");
  const { db } = await import("../src/lib/db");
  const { setTestPlatformMailer } = await import("../src/lib/platform/mailer");
  let mails = 0;
  setTestPlatformMailer(async () => {
    mails += 1;
    return { ok: true, id: `test-${mails}` } as never;
  });
  const { gstinCheckCharacter } = await import("../src/lib/gst-engine");
  const gstin = (code: string) => {
    const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const pan = `${pick(L)}${pick(L)}${pick(L)}C${pick(L)}${String(1000 + Math.floor(rand() * 8999))}${pick(L)}`;
    const first = `${code}${pan}1Z`;
    return first + gstinCheckCharacter(first);
  };

  const superAdmin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true, name: true } });
  const admin: Admin = { id: superAdmin.id, name: superAdmin.name, role: "ADMIN" };

  // ── 1. The team, added by the admin, as the People page does.
  phase = "1. Adding the team";
  const users = await import("../src/actions/user");
  const departments = new Map((await db.department.findMany({ select: { id: true, name: true } })).map((d) => [d.name, d.id]));
  const team = new Map<string, Person>();
  for (const [i, [key, dept, role, title, manager]] of TEAM.entries()) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    const email = `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@team.deskzo.test`;
    const existing = await db.user.findFirst({ where: { email }, select: { id: true } });
    if (existing) {
      team.set(key, { id: existing.id, name, role, dept, title, managerKey: manager, key });
      continue;
    }
    const made = await as(admin, `add ${title} (${role})`, () => users.createUser({ name, email, role, departmentId: departments.get(dept) ?? "", jobTitle: title, phone: `+9198${String(10000000 + i * 137).slice(0, 8)}` }));
    const id = (made as { id?: string } | null)?.id ?? (await db.user.findFirst({ where: { email }, select: { id: true } }))?.id;
    if (id) team.set(key, { id, name, role, dept, title, managerKey: manager, key });
  }
  for (const p of process.argv.includes("--people") ? team.values() : []) {
    if (!p.managerKey) continue;
    const m = team.get(p.managerKey);
    if (m) await as(admin, `set ${p.name}'s manager`, () => users.updateUserAssignment({ id: p.id, role: p.role, departmentId: departments.get(p.dept) ?? null, managerId: m.id }));
  }
  console.log(`team: ${team.size} of ${TEAM.length} added`);
  if (process.argv.includes("--people")) return report(db, mails);

  const people = [...team.values()];
  const byRole = (r: string) => people.filter((p) => p.role === r);
  const reps = [...byRole("SALES").filter((p) => p.key.startsWith("r")), ...byRole("SALES_MANAGER")];
  const accounts = byRole("ACCOUNTS");
  const support = byRole("SUPPORT");
  const managers = byRole("SALES_MANAGER");
  const callers = byRole("CALLING");
  const hr = [...byRole("HR_HEAD"), ...byRole("HR")];
  const items = await db.item.findMany({ where: { active: true }, select: { id: true, name: true, sellingPrice: true, taxRatePercent: true, hsnCode: true, unit: true } });

  // ── 2. Customers, each added by the rep who found them, with a contact.
  phase = "2. Customers and contacts";
  const company = await import("../src/actions/company");
  type Customer = { id: string; name: string; locationId: string; rep: Person; state: (typeof STATES)[number]; gstin: string; contactId: string | null };
  const customers: Customer[] = [];
  const onlyTickets = process.argv.includes("--tickets");
  if (onlyTickets) {
    const byId = new Map(people.map((p) => [p.id, p]));
    for (const c of await db.company.findMany({ where: { relationshipType: "CLIENT" }, orderBy: { companySeq: "asc" }, select: { id: true, name: true, ownerUserId: true, locations: { take: 1, select: { id: true } }, contacts: { take: 1, select: { id: true } } } })) {
      const rep = (c.ownerUserId && byId.get(c.ownerUserId)) || reps[0]!;
      customers.push({ id: c.id, name: c.name, locationId: c.locations[0]?.id ?? "", rep, state: STATES[0]!, gstin: "", contactId: c.contacts[0]?.id ?? null });
    }
  }
  for (let i = 0; i < (onlyTickets ? 0 : 40); i++) {
    const rep = reps[i % reps.length]!;
    const state = STATES[i % STATES.length]!;
    const name = `${PREFIX[i % PREFIX.length]} ${BUSINESSES[(i * 3) % BUSINESSES.length]} ${i % 3 === 0 ? "Pvt Ltd" : i % 3 === 1 ? "LLP" : "Limited"}`;
    const g = gstin(state.code);
    const contactName = `${pick(FIRST)} ${pick(LAST)}`;
    const made = await as(rep, "add a customer", () =>
      company.createCompany({
        name,
        relationshipType: "CLIENT",
        paymentTerms: "ADVANCE",
        source: pick(["LINKEDIN", "REFERRAL", "INBOUND", "OTHER"]),
        website: `https://www.${name.split(" ").slice(0, 2).join("").toLowerCase()}.example`,
        location: { label: "Head Office", address: `${10 + i}, ${pick(["MG Road", "Ring Road", "Tech Park", "Industrial Area"])}`, city: state.city, state: state.name, country: "India", pincode: state.pin, gstNumber: g, isBilling: true, isShipping: true, gstTreatment: "REGISTERED_REGULAR" },
        contacts: [{ name: contactName, designation: pick(["IT_MANAGER", "PURCHASE_MANAGER", "IT_HEAD", "CIO"]), email: `${contactName.toLowerCase().replace(/[^a-z]+/g, ".")}@${name.split(" ")[0]!.toLowerCase()}.example`, phone: `+9197${String(20000000 + i * 911).slice(0, 8)}`, isPrimary: true, receivesDocuments: true }],
      }),
    );
    const c = made as { id: string; contacts?: { id: string }[] } | null;
    if (!c) continue;
    const loc = await db.companyLocation.findFirst({ where: { companyId: c.id }, select: { id: true } });
    customers.push({ id: c.id, name, locationId: loc?.id ?? "", rep, state, gstin: g, contactId: c.contacts?.[0]?.id ?? null });
  }
  console.log(`customers: ${customers.length}`);

  if (onlyTickets) {
    await ticketsPhase();
    return report(db, mails);
  }

  // ── 3. Leads: found, called, qualified, quoted; some won, some lost.
  phase = "3. Leads";
  const lead = await import("../src/actions/lead");
  type Deal = { leadId: string; customer: Customer; item: (typeof items)[number]; qty: number; outcome: "won" | "lost" | "open" };
  const deals: Deal[] = [];
  for (const [i, c] of customers.entries()) {
    const item = items[i % items.length]!;
    const qty = 1 + (i % 12);
    const value = Number(item.sellingPrice) * qty;
    const made = (await as(c.rep, "create a lead", () =>
      lead.createLead({ companyId: c.id, contactId: c.contactId ?? undefined, title: `${item.name} for ${c.name.split(" ").slice(0, 2).join(" ")}`, estimatedValue: value, expectedCloseDate: addDays(today(), 20 + i), source: pick(["WEBSITE", "REFERRAL", "LINKEDIN", "CALLING", "PARTNER"]), requirements: [{ itemId: item.id, quantity: qty }] }),
    )) as { id: string } | null;
    if (!made) continue;
    await as(c.rep, "log a call on the lead", () => lead.logActivity({ leadId: made.id, type: "CALL", notes: `Spoke to the IT head; needs ${qty} × ${item.name} this quarter.` }));
    await as(c.rep, "move the lead to Qualified", () => lead.updateLeadStatus({ leadId: made.id, status: "QUALIFIED" }));
    const outcome: Deal["outcome"] = i % 5 === 4 ? "lost" : i % 5 === 3 ? "open" : "won";
    deals.push({ leadId: made.id, customer: c, item, qty, outcome });
  }

  // ── 4. Quotes for every qualified lead; the won ones invoiced by accounts.
  phase = "4. Quotes and invoices";
  const docs = await import("../src/actions/trade-document");
  const approvals = await import("../src/actions/document-approval");
  const address = (c: Customer) => ({ attention: "Accounts", line1: "Head Office", line2: "", city: c.state.city, state: c.state.name, stateCode: c.state.code, pincode: c.state.pin, country: "India", phone: "" });
  const invoices: { id: string; total: number; customer: Customer }[] = [];
  for (const [i, d] of deals.entries()) {
    const line = { name: d.item.name, itemId: d.item.id, hsnCode: d.item.hsnCode ?? undefined, unit: d.item.unit ?? undefined, quantity: d.qty, unitPrice: Number(d.item.sellingPrice), discountMode: "PERCENT", discountValue: i % 3 === 0 ? 5 : 0, taxRatePercent: Number(d.item.taxRatePercent ?? 18) };
    const quote = (await as(d.customer.rep, "draft a quote", () =>
      docs.createTradeDocument({ docType: "PROPOSAL", companyId: d.customer.id, locationId: d.customer.locationId, issueDate: today(), validUntil: addDays(today(), 30), billing: address(d.customer), shipping: address(d.customer), shippingSameAsBilling: true, placeOfSupplyCode: d.customer.state.code, gstTreatment: "REGISTERED_REGULAR", buyerGstin: d.customer.gstin, leadId: d.leadId, lines: [line] }),
    )) as { id: string } | null;
    if (!quote) continue;
    const first = await as(d.customer.rep, "send (issue) the quote", () => docs.issueTradeDocument({ id: quote.id, generateEInvoice: false }));
    if (!first) {
      findings.pop(); // Needing approval is the setup's rule, not a fault: go through it.
      await as(d.customer.rep, "submit the quote for approval", () => approvals.submitForApproval({ id: quote.id }));
      // Their own manager decides: another team's can't see the quote.
      const approver = (d.customer.rep.managerKey && team.get(d.customer.rep.managerKey)) || team.get("coo")!;
      await as(approver, "approve the quote", () => approvals.decideApproval({ id: quote.id, approved: true, note: "Margins fine" }));
      await as(d.customer.rep, "send (issue) the approved quote", () => docs.issueTradeDocument({ id: quote.id, generateEInvoice: false }));
    }
    await as(d.customer.rep, "move the lead to Proposal sent", () => lead.updateLeadStatus({ leadId: d.leadId, status: "PROPOSAL_SENT" }));
    if (d.outcome === "lost") {
      await as(d.customer.rep, "mark the lead lost", () => lead.updateLeadStatus({ leadId: d.leadId, status: "LOST", lostReason: "Went with a cheaper quote" }));
      continue;
    }
    if (d.outcome === "open") continue;
    await as(d.customer.rep, "mark the lead won", () => lead.updateLeadStatus({ leadId: d.leadId, status: "WON" }));
    const acc = accounts[i % accounts.length]!;
    const inv = (await as(acc, "convert the quote to an invoice", () => docs.convertTradeDocument({ id: quote.id, target: "INVOICE" }))) as { id: string } | null;
    if (!inv) continue;
    const issued = await as(acc, "issue the invoice", () => docs.issueTradeDocument({ id: inv.id, generateEInvoice: false }));
    if (issued) {
      const row = await db.tradeDocument.findUnique({ where: { id: inv.id }, select: { total: true } });
      invoices.push({ id: inv.id, total: Number(row?.total ?? 0), customer: d.customer });
    }
    // A rep can't issue an invoice for themselves only if the role says so — try it, and say what happened.
    if (i === 0) await as(d.customer.rep, "a rep tries to issue an invoice", async () => {
      const again = (await docs.createTradeDocument({ docType: "INVOICE", companyId: d.customer.id, locationId: d.customer.locationId, issueDate: today(), billing: address(d.customer), shipping: address(d.customer), shippingSameAsBilling: true, placeOfSupplyCode: d.customer.state.code, gstTreatment: "REGISTERED_REGULAR", buyerGstin: d.customer.gstin, lines: [line] })) as { ok: boolean; data?: { id: string }; error?: string };
      return again.ok ? docs.issueTradeDocument({ id: again.data!.id, generateEInvoice: false }) : again;
    }, "refused");
  }
  console.log(`invoices issued: ${invoices.length}`);

  // ── 5. Orders for the won deals, approved by a sales manager — and one a rep tries to approve.
  phase = "5. Orders";
  const orders = await import("../src/actions/order");
  for (const [i, d] of deals.filter((x) => x.outcome === "won").entries()) {
    const made = (await as(d.customer.rep, "punch an order", () =>
      orders.createOrder({ companyId: d.customer.id, locationId: d.customer.locationId, itemId: d.item.id, quantity: d.qty, unitPrice: Number(d.item.sellingPrice), poNumber: `PO/${2026}/${1000 + i}`, startDate: today(), endDate: addDays(today(), 364), handoff: "NOW" }),
    )) as { id: string } | null;
    if (!made) continue;
    if (i === 0) await as(d.customer.rep, "a rep tries to approve their own order", () => orders.approveOrder({ orderId: made.id, approved: true }), "refused");
    const approver = accounts[i % accounts.length]!;
    await as(approver, "approve the order (accounts)", () => orders.approveOrder({ orderId: made.id, approved: true, creditOverrideReason: "Known customer, PO in hand" }));
    if (i === 1) await as(managers[0]!, "a sales manager tries to approve an order", () => orders.approveOrder({ orderId: made.id, approved: true }), "refused");
  }

  // ── 6. Payments: most paid in full, some part, one overpaid.
  phase = "6. Payments";
  const receivable = await import("../src/actions/receivable");
  for (const [i, inv] of invoices.entries()) {
    const acc = accounts[(i + 1) % accounts.length]!;
    if (i % 4 === 3) continue;
    const amount = i % 4 === 2 ? Math.round(inv.total / 2) : inv.total;
    await as(acc, i % 4 === 2 ? "record a part payment" : "record a payment in full", () => receivable.recordInvoicePayment({ invoiceId: inv.id, amount, paidOn: today(), method: pick(["BANK_TRANSFER", "UPI", "CHEQUE"]), reference: `UTR${100000 + i}` }));
  }
  if (invoices[0]) await as(accounts[0]!, "record more than the invoice owes", () => receivable.recordInvoicePayment({ invoiceId: invoices[0]!.id, amount: invoices[0]!.total + 5000, paidOn: today(), method: "BANK_TRANSFER" }), "refused");

  // ── 7. Support tickets, worked by the support team.
  await ticketsPhase();
  async function ticketsPhase() {
  phase = "7. Tickets";
  const ticket = await import("../src/actions/ticket");
  for (let i = 0; i < 25; i++) {
    const c = customers[i % customers.length]!;
    const agent = support[i % support.length]!;
    const opener = i % 5 === 0 ? c.rep : agent;
    const made = (await as(opener, i % 5 === 0 ? "a rep logs a ticket for their customer" : "open a ticket", () => ticket.createTicket({ companyId: c.id, contactId: c.contactId ?? undefined, title: pick(["Outlook not syncing", "VPN drops every hour", "Licence not assigned", "Printer offline", "Firewall blocking ERP", "Backup job failed"]), description: "Customer called in; logged on the call.", ticketType: "PRODUCT_SUPPORT", priority: pick(["LOW", "MEDIUM", "HIGH", "URGENT"]), assignedToUserId: agent.id }))) as { id: string } | null;
    if (!made) continue;
    await as(agent, "reply on the ticket", () => ticket.addTicketComment({ ticketId: made.id, body: "Checked remotely; reset the profile. Please confirm it works." }));
    await as(agent, "move it to In progress", () => ticket.updateTicketStatus({ ticketId: made.id, status: "IN_PROGRESS" }));
    if (i % 3 !== 2) await as(agent, "resolve the ticket", () => ticket.updateTicketStatus({ ticketId: made.id, status: "RESOLVED" }));
  }
  }

  // ── 8. Tasks: managers give work, people finish it.
  phase = "8. Tasks";
  const task = await import("../src/actions/task");
  for (let i = 0; i < 40; i++) {
    const c = customers[i % customers.length]!;
    const to = i % 2 === 0 ? c.rep : support[i % support.length]!;
    const by = i % 2 === 0 ? (to.managerKey ? team.get(to.managerKey)! : team.get("coo")!) : team.get("sl")!;
    const made = (await as(by, "give somebody a task", () => task.createTask({ title: pick(["Send the revised quote", "Call back about renewal", "Collect the signed PO", "Share the onboarding checklist", "Visit for the site survey"]), dueDate: addDays(today(), (i % 10) - 3), assignedToUserId: to.id, companyId: c.id, priority: pick(["LOW", "MEDIUM", "HIGH"]), steps: ["Prepare", "Do it", "Update the record"] }))) as { id: string } | null;
    if (!made) continue;
    if (i % 3 === 0) await as(to, "finish the task", () => task.setTaskStatus(made.id, "DONE"));
    else if (i % 7 === 0) await as(to, "ask for help on the task", () => task.setTaskStatus(made.id, "NEED_HELP", "Waiting on the customer's IT team"));
  }

  // ── 9. Calls by inside sales, with callbacks.
  phase = "9. Calls";
  const call = await import("../src/actions/call");
  for (let i = 0; i < 30; i++) {
    const c = customers[i % customers.length]!;
    const by = i % 5 === 0 ? callers[i % callers.length]! : c.rep;
    await as(by, i % 5 === 0 ? "inside sales logs a call on a customer not assigned to them" : "log a call",  () => call.logCall({ companyId: c.id, phoneNumber: `+9197${String(30000000 + i).slice(0, 8)}`, outcome: pick(["CONNECTED", "NO_ANSWER", "BUSY", "CALLBACK_REQUESTED"]), direction: "OUTBOUND", durationSeconds: 60 + i * 13, notes: "Asked about their renewal dates.", followUpAt: i % 3 === 0 ? `${addDays(today(), 2)}T11:00` : undefined, contactId: c.contactId ?? undefined }));
  }

  // ── 10. Visits by the reps.
  phase = "10. Visits";
  const visit = await import("../src/actions/visit");
  for (let i = 0; i < 15; i++) {
    const c = customers[i % customers.length]!;
    const made = (await as(c.rep, "plan a visit", () => visit.createVisit({ companyId: c.id, scheduledFor: `${today()}T${String(10 + (i % 7)).padStart(2, "0")}:00`, purpose: pick(["INTRO_MEETING", "PRODUCT_DEMO", "PAYMENT_FOLLOW_UP", "ORDER_COLLECTION"]), contactId: c.contactId ?? undefined, locationId: c.locationId }))) as { id: string } | null;
    if (!made) continue;
    await as(c.rep, "check in at the visit", () => visit.checkInVisit(made.id));
    await as(c.rep, "complete the visit", () => visit.completeVisit({ id: made.id, outcome: "Met the IT head; demo done, quote to follow." }));
  }

  // ── 11. Expenses: claimed by reps, decided by HR.
  phase = "11. Expenses";
  const expense = await import("../src/actions/expense");
  for (let i = 0; i < 12; i++) {
    const rep = reps[i % reps.length]!;
    const made = (await as(rep, "claim an expense", () => expense.createExpense({ amount: 250 + i * 75, spentOn: addDays(today(), -(i % 6)), category: pick(["TRAVEL", "FUEL", "MEALS", "TOLL_PARKING"]), paymentMode: "UPI", description: "Customer visit", companyId: customers[i % customers.length]!.id, submit: true }))) as { id: string } | null;
    if (!made || !hr[0]) continue;
    await as(hr[i % hr.length]!, i % 4 === 3 ? "reject an expense" : "approve an expense", () => expense.decideExpense({ id: made.id, approved: i % 4 !== 3, note: i % 4 === 3 ? "No receipt" : undefined }));
  }

  // ── 12. Leave: applied for, decided by the manager.
  phase = "12. Leave";
  const leave = await import("../src/actions/leave");
  const types = await db.leaveType.findMany({ where: { active: true }, select: { id: true, code: true } });
  for (let i = 0; i < 10 && types.length; i++) {
    const who = people[(i * 5 + 7) % people.length]!;
    const monday = addDays(today(), 7 + ((8 - new Date(`${today()}T00:00:00Z`).getUTCDay()) % 7));
    const from = addDays(monday, i % 4);
    const made = (await as(who, "apply for leave", () => leave.applyForLeave({ typeId: types[i % types.length]!.id, fromDate: from, toDate: addDays(from, i % 3), reason: "Family function" }))) as { id: string } | null;
    if (!made) continue;
    const boss = who.managerKey ? team.get(who.managerKey) : undefined;
    if (boss) await as(boss, "decide a team member's leave", () => leave.decideLeave({ id: made.id, approve: i % 4 !== 0, note: i % 4 === 0 ? "Quarter-end, please move it" : undefined }));
  }

  // ── 13. A service cycle sold through an item.
  phase = "13. Service cycles";
  const cycles = await import("../src/actions/service-cycles");
  const coo = team.get("coo")!;
  const health = items.find((x) => /health check/i.test(x.name));
  const plan = (await as(admin, "make a service plan", () => cycles.saveTemplate({ name: "Managed IT – AMC", months: 12, steps: [{ name: "Quarterly health check visit", firstAfterMonths: 0, everyMonths: 3, showDaysBefore: 14, checklist: ["Backups", "Firewall", "Endpoints"] }] }))) as { seq: number } | null;
  if (plan && health) {
    const t = await cycles.getTemplate(plan.seq);
    await as(admin, "point the item at the plan", () => cycles.setItemServicePlan(health.id, t!.id));
    const c = customers[1]!;
    const o = (await as(c.rep, "punch an order for the AMC", () => orders.createOrder({ companyId: c.id, locationId: c.locationId, itemId: health.id, quantity: 4, unitPrice: Number(health.sellingPrice), startDate: today(), endDate: addDays(today(), 364), handoff: "NOW" }))) as { id: string } | null;
    if (o) await as(accounts[0]!, "approve the AMC order", () => orders.approveOrder({ orderId: o.id, approved: true, creditOverrideReason: "AMC" }));
    const started = await db.serviceCycle.count({ where: { orderId: o?.id ?? "none" } });
    if (o && started !== 1) findings.push({ phase, step: "the approved AMC order starts its cycle", who: managers[0]!.name, role: "SALES_MANAGER", expected: "works", outcome: "refused", message: `${started} cycles started` });
    await as(coo, "a COO looks at Work due", () => cycles.listDueWork("month", false));
  }

  return report(db, mails);
}

async function report(db: { user: { count(): Promise<number> }; company: { count(): Promise<number> }; lead: { count(): Promise<number> }; tradeDocument: { count(): Promise<number> }; task: { count(): Promise<number> } }, mails: number) {
  const counts = await Promise.all([db.user.count(), db.company.count(), db.lead.count(), db.tradeDocument.count(), db.task.count()]);
  const unexpected = findings.filter((f) => (f.expected === "works") !== (f.outcome === "ok"));
  const out = path.join(process.cwd(), "backups", "manual", `team-test-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ done, mails, counts: { users: counts[0], companies: counts[1], leads: counts[2], documents: counts[3], tasks: counts[4] }, findings }, null, 2));
  console.log(`\n${done} steps went through; ${unexpected.length} didn't go as expected; ${mails} platform mails held back.`);
  console.log(`people ${counts[0]}, companies ${counts[1]}, leads ${counts[2]}, documents ${counts[3]}, tasks ${counts[4]}`);
  const grouped = new Map<string, { n: number; f: Finding }>();
  for (const f of unexpected) {
    const key = `${f.phase} | ${f.step} | ${f.outcome} | ${f.message.slice(0, 160)}`;
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
