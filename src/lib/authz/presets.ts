import type { Role } from "@/lib/roles";
import { PERMISSIONS, type PermissionKey } from "@/lib/permissions";
import { DOCUMENT_PERMISSIONS, replacedBy } from "@/lib/documents/permission-keys";

/**
 * Ready-made access profiles, so setting somebody up is one click rather than forty.
 *
 * ## Why these are code and not rows
 *
 * A preset is a *recommendation* — "this is what an accounts executive normally needs" — and it has
 * to be versioned with the application, because every release that adds a capability has to decide
 * which job functions ought to get it. Stored as data, presets silently rot: a new permission ships,
 * no preset mentions it, and the preset that claimed to describe a job function quietly stops doing
 * so. `check:rbac` asserts every key is named by at least one preset, which turns that rot into a
 * failing build.
 *
 * Applying a preset writes ordinary `RolePermission` rows. Nothing about a role is "bound" to a
 * preset afterwards — an admin who then tweaks two cells has a role that has drifted from its
 * preset, and the screen shows that drift rather than pretending it hasn't happened. Presets are a
 * starting point, not a cage.
 */

export type RolePreset = {
  key: string;
  label: string;
  description: string;
  /** Which Role this preset is offered for. A preset for a role nobody holds is noise. */
  role: Role;
  /** Everything this profile grants. Anything not listed is explicitly switched off. */
  permissions: readonly PermissionKey[];
};

/**
 * Note what is deliberately absent from every non-admin preset: `permissions.manage`,
 * `users.assignRole`, `settings.manage`, `security.manage` and `impersonation.use`. Those are the
 * keys that let their holder rewrite the rules, and they are granted one at a time by a person, not
 * handed out by a profile.
 */
/**
 * What of an account every profile may see — all of it, as before these existed.
 *
 * Applying a preset switches off anything it does not list, so a preset without these would take
 * the Contacts, Orders, Payments… tabs away from whoever it was applied to. They are in every
 * profile; narrowing one is a decision for the role afterwards, in Users & access.
 */
const ACCOUNT_VIEWS = [
  "contacts.view",
  // Split from View contacts and View payments on 2 Nov 2026 (owner); a preset keeps them together.
  "contacts.directory",
  "commissions.view",
  "statements.view",
  "leads.view",
  // Opening leads came with viewing them until 1 Nov 2026; a preset keeps the two together.
  "leads.create",
  "orders.view",
  // Split from View orders on 26 Nov 2026 (owner); a preset keeps them together.
  "subscriptions.view",
  "renewals.view",
  "payments.view",
  "documents.view",
  "projects.view",
  "calls.view",
  "visits.view",
  "tickets.view",
  "emails.view",
] as const satisfies readonly PermissionKey[];

/**
 * The account views without the money: no payments, receivables or statements, and no quotes or
 * invoices. For the people who build and call the records rather than sell against them (owner,
 * 9 Oct 2026) — the profiler and the calling agent.
 */
const ACCOUNT_VIEWS_WITHOUT_MONEY = ACCOUNT_VIEWS.filter((k) => k !== "payments.view" && k !== "documents.view" && k !== "statements.view" && k !== "commissions.view");

/**
 * What every profile carries besides the account views — tools anybody's job can use. The AI copilot
 * only ever sees and does what the person using it already can, so it widens nothing.
 */
const EVERY_PROFILE = ["copilot.use"] as const satisfies readonly PermissionKey[];

export const ROLE_PRESETS: RolePreset[] = [
  // ─── Sales ──────────────────────────────────────────────────────────────────────────────────
  {
    key: "sales-executive",
    label: "Sales executive",
    description: "Works leads and orders for their own accounts. Cannot approve their own paperwork or see anybody else's numbers.",
    role: "SALES",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "meetings.schedule",
      // Not targets.viewAll (owner, 9 Oct 2026): it is the manager's — everybody's targets, and the whole
      // company's pipeline on the dashboard. A sales executive sees their own, as the description says.
      "vault.use","products.edit", "tickets.create", "feedback.request", "marketing.viewAll",
      ...replacedBy("documents.issue"), "certificates.issue",
      "documents.send",
      // A ready-written email or WhatsApp after a call, by hand (owner, 11 Nov 2026).
      "messages.send",
      // Their own event invitations and requirement assessments.
      "forms.create",
      // Their own accounts and leads, to a colleague — never somebody else's.
      "accounts.handOffOwn",
      // Chasing what their clients owe, and logging what they said (off by default; this profile turns it on).
      "collections.followUp",
      // Website chats and WhatsApp in the Customer inbox (owner, 24 Oct 2026).
      "inbox.view",
      // What their contacts did on the website (owner, 6 Nov 2026).
      "website.activity"],
  },
  {
    key: "sales-manager",
    label: "Sales manager",
    description: "A sales executive plus the team view: their reports' visits, expenses and targets, the ability to set targets, and handing a departing rep's accounts to somebody else.",
    // Its own role since 9 Oct 2026: executives and managers sharing Sales meant a role setting
    // could never give managers more, so the difference lived in personal grants nobody could see.
    role: "SALES_MANAGER",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "activities.viewAll", "meetings.schedule",
      // Everything a sales executive has, so moving to this role never takes anything away.
      "vault.use",
      "products.edit",
      "products.delete",
      // A manager hands leads to their team; a rep does not hand leads to a manager.
      "leads.assign",
      "accounts.reassign",
      "accounts.handOffOwn",
      "tickets.create",
      // Their team's collections, and the broken promises the team is told about.
      "collections.followUp",
      // Their team's call recordings (owner, 9 Nov 2026).
      "calls.listen",
      // Apollo lookups, which spend the workspace's credits (owner, 14 Nov 2026).
      "companies.enrich",
      ...replacedBy("documents.issue"), "certificates.issue",
      "documents.send",
      // A ready-written email or WhatsApp after a call, by hand (owner, 11 Nov 2026).
      "messages.send",
      // A manager may pull back a document a rep raised in error; an executive may not.
      ...replacedBy("documents.void"), "certificates.withdraw",
      "feedback.request",
      "feedback.viewAll",
      "marketing.viewAll",
      "marketing.send",
      "forms.create",
      // How much a deal at each stage counts in the forecast — the sales manager knows the pipeline best.
      "forecast.manage",
      // Which wins the floor celebrates, and how loudly.
      "wins.manage",
      "companies.manageCategories",
      // Tidying the book — folding a duplicate account into the real one.
      "companies.merge",
      "targets.manage",
      "targets.viewAll",
      "visits.viewAll",
      "workspace.manageAny",
      "performance.view",
      "notes.broadcast",
      "people.handover",
      "fields.seeRestricted",
      // The stages leads move through (owner, 2 Oct 2026).
      "pipeline.manage",
      // The Customer inbox, their reps' own WhatsApp numbers too.
      "website.activity",
      "inbox.view",
      "inbox.viewAll",
    ],
  },
  // ─── Calling / profiling ────────────────────────────────────────────────────────────────────
  {
    key: "calling-agent",
    label: "Calling agent",
    description: "Works a calling list and logs outcomes. Deliberately narrow — this is the profile with the widest access to contact details and the least need for anything else.",
    role: "CALLING",
    // leads.assign: a qualified call is handed to the salesperson who will work it.
    permissions: [...ACCOUNT_VIEWS_WITHOUT_MONEY, ...EVERY_PROFILE, "tickets.create", "companies.viewAll", "leads.assign", "inbox.view", "messages.send"],
  },
  {
    key: "data-profiler",
    label: "Data profiler",
    description: "Builds and cleans the company and contact records that everything else runs on.",
    role: "PROFILE",
    permissions: [...ACCOUNT_VIEWS_WITHOUT_MONEY, ...EVERY_PROFILE, "tickets.create", "companies.viewAll"],
  },
  // ─── Support ────────────────────────────────────────────────────────────────────────────────
  {
    key: "support-agent",
    label: "Support agent",
    description: "Handles tickets for customers under contract, and sees the IT asset estate. Adding, assigning and moving assets — licence keys included — is the support lead's.",
    role: "SUPPORT",
    // Not assets.manage (owner, 9 Oct 2026): it includes seeing licence keys, so it is the lead's.
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "meetings.schedule",
      "visitors.view",
      "vault.use","tickets.create", "assets.viewAll", "feedback.request", "contacts.viewRestricted", "companies.viewAll", "inbox.view"],
  },
  {
    key: "project-manager",
    label: "Project manager",
    description:
      "Runs delivery projects end to end. Note what is absent: opening a customer's stored credentials is its own key, granted one person at a time rather than by a job title.",
    role: "SUPPORT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "meetings.schedule", "companies.viewAll", "projects.manage", "tickets.create", "tasks.delete", "cycles.view"],
  },
  {
    key: "delivery-head",
    label: "Delivery head",
    description:
      "Every project rather than only their own, plus the credential store. This is the profile that can read a customer's passwords — give it to as few people as the work allows.",
    role: "MANAGEMENT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "activities.viewAll", "meetings.schedule",
      "companies.viewAll",
      "projects.manage",
      "projects.viewAll",
      "projects.credentials",
      "performance.view",
      "cycles.view",
      "cycles.manage",
    ],
  },
  {
    key: "support-lead",
    label: "Support lead",
    description: "A support agent plus deleting anybody's tasks, IT asset management, the full feedback picture, and team performance.",
    role: "SUPPORT",
    // Not tickets.delete (owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-3): deleting a ticket is the super
    // admin's alone, so the key decides nothing, and a profile listing it said otherwise.
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "activities.viewAll", "meetings.schedule",
      "visitors.view",
      "companies.viewAll",
      "tickets.create",
      "tasks.delete",
      "assets.manage",
      "assets.viewAll",
      "feedback.request",
      "feedback.viewAll",
      "contacts.viewRestricted",
      "performance.view",
      "inbox.view",
      "inbox.viewAll",
      "cycles.view",
      "cycles.manage",
    ],
  },
  // ─── Accounts ───────────────────────────────────────────────────────────────────────────────
  {
    key: "accounts-executive",
    label: "Accounts executive",
    description: "Records money in and out and approves orders against payment terms. No access to salaries.",
    role: "ACCOUNTS",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "meetings.schedule",
      "vault.use",
      "companies.viewAll",
      "payments.record",
      "payments.manage",
      "orders.approve",
      ...replacedBy("documents.issue"), "certificates.issue",
      // Credit and debit notes are accounts' (owner, 2 Nov 2026) — not in the sales presets.
      ...replacedBy("documents.notes"),
      "documents.send",
      ...replacedBy("purchase.raiseOrders"),
      "ledger.viewReports",
      "expenses.reimburse",
      "expenses.viewAll",
      "revenue.viewReports",
      "close.work",
      // The rebate behind a negative call — a manager sees it; an executive does not (owner, 1 Oct 2026).
      "rebates.view",
      // Finance → Accounts (owner, 22 Oct 2026): stock in and between warehouses, and vouchers drafted for approval.
      "inventory.view",
      "inventory.receive",
      "inventory.transfer",
      "vouchers.create",
    ],
  },
  {
    key: "accounts-manager",
    label: "Accounts manager",
    description: "The full finance function short of payroll — including deletions, expense approval and the tax reports.",
    role: "ACCOUNTS",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "meetings.schedule",
      "companies.viewAll",
      "payments.record",
      "payments.delete",
      "payments.manage",
      "orders.approve",
      "credit.override",
      "ledger.viewReports",
      ...replacedBy("documents.issue"), "certificates.issue",
      ...replacedBy("documents.notes"),
      "documents.send",
      ...replacedBy("documents.void"), "certificates.withdraw",
      ...replacedBy("purchase.raiseOrders"),
      // A vendor nothing has happened with (owner, 3 Nov 2026 — Phase 2 permission fixes): the delete this profile's
      // description promises, beside Delete payments, for the payables side it runs.
      "vendors.delete",
      "expenses.approve",
      "expenses.reimburse",
      "expenses.viewAll",
      "expenses.export",
      "incentives.approve",
      "performance.view",
      // The three that made this preset's own description a lie: it claims the full finance
      // function short of payroll, while the journal, the chart of accounts and the year-end
      // close were all admin-only and undelegatable.
      "ledger.post",
      "ledger.manageAccounts",
      "books.close",
      "data.exportFinance",
      "data.importFinance",
      "purchase.reconcile",
      "revenue.viewReports",
      "revenue.manage",
      "close.work",
      "close.manage",
      "rebates.view",
      "rebates.manage",
      "fields.seeRestricted",
      // Finance → Accounts (owner, 22 Oct 2026): the whole of inventory and vouchers, and the settings.
      "inventory.view",
      "inventory.receive",
      "inventory.transfer",
      "inventory.adjust",
      "inventory.approveAdjustments",
      "inventory.manage",
      "vouchers.create",
      "vouchers.approve",
      "accounts.configure",
    ],
  },
  // ─── Purchase ───────────────────────────────────────────────────────────────────────────────
  {
    key: "purchase-executive",
    label: "Purchase executive",
    description: "Sources approved orders, sets vendor and cost, and marks them fulfilled.",
    role: "PURCHASE",
    // This role held nothing at all before, because it was missing from the role list the
    // permission screen renders from — see src/lib/roles.ts.
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "meetings.schedule",
      "vault.use","orders.process", ...replacedBy("purchase.raiseOrders"), "products.edit", "tickets.create", "companies.viewAll", "data.exportCatalog", "data.importCatalog",
      // Whoever places the order with the distributor is who should be checking its monthly bill.
      "purchase.reconcile",
      // And the rebate and deal price the distributor agreed to, to buy at.
      "rebates.view",
      // Goods in against the orders they placed, and between warehouses (Finance → Accounts, owner, 22 Oct 2026).
      "inventory.view",
      "inventory.receive",
      "inventory.transfer"],
  },
  // ─── People & HR ────────────────────────────────────────────────────────────────────────────
  // The HR and Recruiter roles (owner, 8 Oct 2026). Neither sees customers: no account views here.
  {
    key: "hr-executive",
    label: "HR executive",
    description: "Day-to-day HR: people records, everyone's attendance and leave, approving leave, hiring, and handing over a leaver's work. No payroll and no user accounts — those are the HR manager's.",
    role: "HR",
    permissions: [...EVERY_PROFILE, "meetings.schedule",
      "hr.manage",
      "hr.viewAll",
      "hr.approveLeave",
      "hr.approveExpenses",
      // Approving everyone's claims for HR, so seeing them all (owner, 18 Nov 2026).
      "expenses.viewAll",
      "hr.approveAttendanceExceptions",
      "hr.printAttendance",
      "hiring.manage",
      "people.handover",
      "engagement.manage",
      "visitors.view",
      "data.exportPeople",
    ],
  },
  {
    key: "hr-manager",
    label: "HR manager",
    description: "An HR executive plus payroll, user accounts (and reading Users, where they are added), anonymous feedback, expense approvals and bulk employee imports. Note that payroll is not inheritable — a manager of this person does not get it.",
    role: "HR",
    permissions: [...EVERY_PROFILE, "meetings.schedule",
      "hr.manage",
      "hr.viewAll",
      "hr.approveLeave",
      "hr.approveExpenses",
      "hr.approveAttendanceExceptions",
      "hr.printAttendance",
      "hiring.manage",
      "people.handover",
      "engagement.manage",
      "engagement.readFeedback",
      "visitors.view",
      "visitors.manage",
      "payroll.manage",
      "users.manage",
      "expenses.approve",
      "expenses.viewAll",
      "performance.view",
      "vault.use",
      "data.exportPeople",
      "data.importPeople",
      // Read-only, and what opens Staff & roles: adding a staff account takes this and `users.manage`
      // together, so without it "user accounts" was a key with no screen (9 Oct 2026).
      "permissions.view",
    ],
  },
  {
    /**
     * The head of the HR function, as a role of its own (owner, 9 Oct 2026) — like Sales manager, so
     * the head's extra reach is a role setting rather than personal grants nobody can see. Everything
     * the HR manager has, so moving up never takes anything away, plus what heading the function adds:
     * company-wide notices, who holds which laptop (exit clearance), and the company's own guides.
     *
     * Deliberately not here: reimbursing expenses (HR approves, Accounts pays out), locking people out
     * (granted to a person where the workspace's process gives HR its exits), and the keys that
     * rewrite access — never handed out by a profile.
     */
    key: "hr-head",
    label: "HR head",
    description: "Heads HR: everything an HR manager has — people records, hiring, payroll, leave, user accounts, anonymous feedback, expense approvals, employee imports — plus company-wide notices, every IT asset (for exit clearance), the company's own guides, and reading Users so they can add staff accounts. Payroll and anonymous feedback are not inheritable.",
    role: "HR_HEAD",
    permissions: [...EVERY_PROFILE, "meetings.schedule",
      "hr.manage",
      "hr.viewAll",
      "hr.approveLeave",
      "hr.approveExpenses",
      "hr.approveAttendanceExceptions",
      "hr.printAttendance",
      "hiring.manage",
      "people.handover",
      "engagement.manage",
      "engagement.readFeedback",
      "visitors.view",
      "visitors.manage",
      "payroll.manage",
      "users.manage",
      "expenses.approve",
      "expenses.viewAll",
      "performance.view",
      "vault.use",
      "data.exportPeople",
      "data.importPeople",
      "notes.broadcast",
      "assets.viewAll",
      "help.manage",
      // Read-only, and what opens Staff & roles: without it "user accounts" is a key with no screen —
      // adding a staff account takes this and `users.manage` together.
      "permissions.view",
    ],
  },
  {
    key: "recruiter",
    label: "Recruiter",
    description: "Runs hiring — candidates, their status, intake links, offer letters and documents — without opening employee records. HR converts a hired candidate into an employee.",
    role: "RECRUITER",
    permissions: [...EVERY_PROFILE, "meetings.schedule", "hiring.manage"],
  },
  // ─── Everyone else ──────────────────────────────────────────────────────────────────────────
  {
    key: "employee",
    label: "Employee (self-service)",
    description:
      "A new joiner's starting point (owner, 1 Nov 2026): their own HR page, attendance, leave and payslips, expense claims, tasks, calendar, notes and chat — nothing of the business's records. Add what the job needs, or switch to a fuller profile, once they settle in.",
    role: "EMPLOYEE",
    // Nothing of the business's: every page it opens is the person's own, and those need no permission. The copilot,
    // as on every profile, only sees and does what they already can.
    permissions: [...EVERY_PROFILE],
  },
  // ─── Renewals ───────────────────────────────────────────────────────────────────────────────
  {
    key: "renewal-specialist",
    label: "Renewal specialist",
    description: "Keeps every customer's subscriptions renewed: sees all accounts, raises and emails renewal proposals, updates renewal stages and dates, and follows up what is owed. Doesn't process purchases or approve orders.",
    role: "RENEWAL_SPECIALIST",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "meetings.schedule",
      "companies.viewAll",
      ...replacedBy("documents.issue"), "certificates.issue",
      "documents.send",
      "products.edit",
      "collections.followUp",
      "tickets.create",
      "feedback.request",
    ],
  },
  // ─── Management ─────────────────────────────────────────────────────────────────────────────
  {
    key: "operations-manager",
    label: "Operations manager",
    description: "Sees across the company and approves most things, but holds nothing that changes who can do what.",
    role: "MANAGEMENT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "activities.viewAll", "meetings.schedule",
      "companies.viewAll",
      "accounts.reassign",
      "credit.override",
      "products.edit",
      "products.delete",
      "catalog.manage",
      "payments.record",
      "payments.manage",
      "orders.approve",
      "orders.process",
      // Temporary (owner, 23 Nov 2026): entering the old CRM's orders — src/actions/past-order.ts.
      "orders.recordPast",
      ...replacedBy("documents.issue"), "certificates.issue",
      ...replacedBy("documents.notes"),
      "documents.send",
      ...replacedBy("documents.void"), "certificates.withdraw",
      ...replacedBy("purchase.raiseOrders"),
      // Signs off any kind of document waiting for approval, where Settings › Document approvals asks for it.
      ...DOCUMENT_PERMISSIONS.filter((d) => d.key.startsWith("docs.approve")).map((d) => d.key),
      "purchase.reconcile",
      // Beside the other deletes this profile holds (products, tasks) — a vendor nothing has happened with (Phase 2).
      "vendors.delete",
      "portal.manage",
      "tickets.create",
      // Not tickets.delete: it decides nothing (audit L-3), as on the support lead above.
      "tasks.delete",
      "contacts.viewRestricted",
      "expenses.approve",
      "expenses.viewAll",
      "expenses.export",
      "visits.viewAll",
      "workspace.manageAny",
      "performance.view",
      "assets.manage",
      "assets.viewAll",
      "feedback.request",
      "feedback.viewAll",
      "marketing.viewAll",
      "targets.manage",
      "targets.viewAll",
      "incentives.manage",
      "activity.viewAll",
      "permissions.view",
      "data.exportCrm",
      "data.exportCatalog",
      "notes.broadcast",
      // Backend rebates, and the say on selling below cost (owner, 1 Oct 2026).
      "rebates.view",
      "rebates.manage",
      "orders.approveLoss",
      // The workspace's own fields, and the restricted ones among them (owner, 2 Oct 2026).
      "fields.manage",
      "fields.seeRestricted",
      "fields.revealSecrets",
      "companies.changeRole",
      "pipeline.manage",
      "booking.manage",
      "cards.manage",
      "signatures.manage",
      // Putting the wins board on the office TVs (owner, 17 Oct 2026: Management and Admin).
      "wins.tv",
      // Finance → Accounts (owner, 22 Oct 2026): stock across warehouses, and the second signature on
      // adjustments and vouchers.
      "inventory.view",
      "inventory.receive",
      "inventory.transfer",
      "inventory.approveAdjustments",
      "vouchers.approve",
    ],
  },
  {
    key: "marketing-manager",
    label: "Marketing manager",
    description: "Runs campaigns and journeys end to end, including approving a send.",
    role: "MANAGEMENT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "meetings.schedule",
      "companies.viewAll",
      "marketing.manage",
      "marketing.send",
      "marketing.approve",
      "marketing.viewAll",
      "forms.create",
      "forms.manageAll",
      "feedback.request",
      "feedback.viewAll",
      "contacts.viewRestricted",
      "targets.viewAll",
      "data.exportCrm",
      "data.importCrm",
    ],
  },
  {
    key: "vault-custodian",
    label: "Vault custodian",
    description:
      "Can open any stored credential, including ones nobody shared. Every such reveal is recorded as an override and reported to the record's owner — accountable access, not silent access. One or two people, no more.",
    role: "MANAGEMENT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "meetings.schedule", "vault.use", "vault.viewAll", "vault.manageTags"],
  },
  {
    key: "auditor",
    label: "Auditor (read-only)",
    description: "Sees everything and changes nothing — the activity log, the permission review screens, and company-wide figures. Grants no ability to act.",
    role: "MANAGEMENT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "activities.viewAll", "activity.viewAll", "activity.export", "permissions.view", "expenses.viewAll", "expenses.export", "visits.viewAll", "performance.view", "hr.viewAll", "assets.viewAll", "feedback.viewAll", "marketing.viewAll", "targets.viewAll", "companies.viewAll", "data.exportCrm", "data.exportFinance", "inventory.view"],
  },
];

export function presetsForRole(role: Role): RolePreset[] {
  return ROLE_PRESETS.filter((p) => p.role === role);
}

export function getPreset(key: string): RolePreset | undefined {
  return ROLE_PRESETS.find((p) => p.key === key);
}

/**
 * How far a role has drifted from a preset.
 *
 * Shown next to the preset button so applying one is an informed choice rather than a gamble —
 * "this will switch on 3 and switch off 1" is the sentence somebody needs before clicking, and its
 * absence is why bulk-apply buttons go unused.
 */
export function presetDiff(
  preset: RolePreset,
  current: Record<string, boolean>,
): { willGrant: PermissionKey[]; willRevoke: PermissionKey[]; unchanged: number } {
  const wanted = new Set<string>(preset.permissions);
  const willGrant: PermissionKey[] = [];
  const willRevoke: PermissionKey[] = [];
  let unchanged = 0;

  for (const def of PERMISSIONS) {
    // Sections are a role's own choice, held by every role until unticked — no preset touches them.
    if (def.everyone) continue;
    const shouldHave = wanted.has(def.key);
    const has = current[def.key] === true;
    if (shouldHave && !has) willGrant.push(def.key as PermissionKey);
    else if (!shouldHave && has) willRevoke.push(def.key as PermissionKey);
    else unchanged += 1;
  }
  return { willGrant, willRevoke, unchanged };
}
