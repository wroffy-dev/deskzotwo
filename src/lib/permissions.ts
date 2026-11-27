import type { Role } from "@/lib/roles";
import { DOCUMENT_PERMISSIONS } from "@/lib/documents/permission-keys";

/**
 * Every capability the application knows how to restrict.
 *
 * This registry is the single source of truth: the permission screen renders from it, the
 * resolver refuses any key that is not in it, and `PermissionKey` below is derived from it so a
 * typo becomes a compile error rather than a silently denied check. That last property is not
 * theoretical — `payments.manage` was enforced in three files for months without ever being
 * declared here, which quietly made Fixed Assets, Banking and Tax Reports admin-only with no cell
 * in the matrix an admin could have ticked to notice.
 */
export type PermissionDefinition = {
  key: string;
  label: string;
  description: string;
  /**
   * Roles granted this unless an admin has overridden it. ADMIN is not listed on any entry: an
   * admin holds everything but the super-admin-only keys by default and is now configurable, so their
   * access comes from the resolver rather than from this array. See src/lib/authz/resolve.ts.
   */
  defaultRoles: readonly Role[];
  /** Section in the permission screen. Keys with no group fall under "Other". */
  group?: string;
  /**
   * Whether a manager used to inherit this from somebody who reports to them. Managers no longer
   * inherit anything (src/lib/authz/resolve.ts; retired by prisma/migrations/20261110120000_retire_
   * report_inheritance), so nothing that decides access reads this any more. It stays as the record of
   * which keys were never handed up a reporting line — false for anything where managing the person is
   * not the same as being entitled to the capability, payroll being the clearest case — and check:rbac
   * still holds every super-admin-only and critical key to it.
   */
  delegable?: boolean;
  /**
   * Only a super admin may grant this to anyone, including to an admin. Used for the keys that
   * would let their holder rewrite the access rules themselves. Nobody holds one by default either —
   * not even an admin (owner, 2 Nov 2026 — Phase 1 security fixes, audit M-1): the super admin holds
   * it, and whoever a super admin grants it to, on their role or personally.
   */
  superAdminOnly?: boolean;
  /**
   * Only an admin or the super admin may grant this, to a role or to a person (src/lib/authz/guards.ts) —
   * for a door the owner wants opened by the people at the top and nobody else, however far
   * `permissions.manage` has been handed down.
   */
  adminOnly?: boolean;
  /**
   * The holder may not exercise this on a record they created or own. Separation of duties as a
   * property of the permission rather than a rule each action has to remember.
   */
  selfExcluded?: boolean;
  /** Drives the warning colour in the UI and whether granting it notifies the admins. */
  tier?: "standard" | "sensitive" | "critical";
  /**
   * Held by every role — built-in and custom alike — until it is unticked for one (owner, 8 Oct 2026):
   * the sections. An admin unticking one writes an explicit deny; nothing else takes it away. Presets
   * leave these alone.
   */
  everyone?: boolean;
};

export const PERMISSION_REGISTRY = [
  {
    key: "products.edit",
    label: "Edit products & subscriptions",
    description:
      "Change the quantity, notes, or renewal dates on a product/subscription already attached to a company or a lead's requirements.",
    defaultRoles: ["MANAGEMENT", "SALES"],
  },
  {
    key: "products.delete",
    label: "Delete products & subscriptions",
    description: "Remove a product/subscription line from a company or a lead's requirements.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "payments.record",
    label: "Record payments",
    description: "Log a payment received against an order, and edit an existing payment's details.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
  },
  {
    key: "payments.delete",
    label: "Delete payments",
    description: "Remove a previously recorded payment.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
  },
  {
    /**
     * This key was already being checked in three places before it existed here — see
     * src/actions/asset.ts, src/actions/bank.ts and src/actions/tax-reports.ts. Because
     * `rolePermits` returns false for a key with no registry entry, the effect was that Fixed
     * Assets, Banking and Tax Reports were silently admin-only for every other role, with no cell
     * in the permission matrix an admin could have ticked to fix it. A permission that is enforced
     * but not declared is invisible, and invisible is indistinguishable from broken.
     */
    key: "payments.manage",
    label: "Manage finance records",
    description:
      "Fixed assets and depreciation, bank accounts and reconciliation, vendors' bank accounts and PAN, and the GST tax reports. Broader than recording a payment — this is the finance function rather than the cashbook.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
  },
  {
    key: "contacts.viewRestricted",
    label: "View reseller-managed contact details",
    description:
      "See the email and phone of a reseller's end customer, which are hidden from everyone else so nobody contacts them behind the reseller's back. Grant only to people who genuinely need to reach them, e.g. for a support escalation.",
    defaultRoles: ["MANAGEMENT", "SUPPORT"],
  },
  {
    key: "tickets.create",
    label: "Create tickets",
    description: "Log a new support ticket against a company.",
    defaultRoles: ["SUPPORT", "SALES", "MANAGEMENT"],
  },
  {
    key: "notes.broadcast",
    label: "Post a note to everyone",
    description:
      "Share a sticky note with the whole company rather than with your own reporting line. A note on everybody's board is an announcement, and an announcement nobody approved is the thing this stops.",
    defaultRoles: ["MANAGEMENT"],
    group: "Sales & customers",
  },
  {
    /**
     * Deleting a ticket is the workspace's super admin's alone (owner, 27 Oct 2026; src/actions/ticket.ts
     * `deleteTicket`), so this key decides nothing. It was granted to Management by default and listed in two
     * presets all the same, which said it did (audit L-3). It stays in the registry so stored rows mean
     * nothing new, but no role is given it and no preset lists it (owner, 3 Nov 2026 — Phase 2 permission
     * fixes), and it says what it is.
     */
    key: "tickets.delete",
    label: "Delete tickets",
    description: "Reserved: deleting a ticket is the workspace's super admin's alone, so holding this changes nothing.",
    defaultRoles: [],
    delegable: false,
  },
  {
    key: "tasks.delete",
    label: "Delete any task",
    description:
      "Delete a task that isn't yours — anyone can already delete a task they created. One somebody else gave them is the giver's to delete.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "performance.view",
    label: "View team performance",
    description: "See active time, records created/edited, and ticket resolution speed for every user.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "expenses.approve",
    label: "Approve or reject expense claims",
    description:
      "Decide any submitted claim, not just your own team's. Everyone can already approve claims from people who report to them — this is the override for covering an absent manager, or for a claimant who has no manager set.",
    defaultRoles: ["MANAGEMENT", "ACCOUNTS"],
    selfExcluded: true,
  },
  {
    key: "expenses.reimburse",
    label: "Mark expenses reimbursed",
    description:
      "Record that an approved claim has actually been paid out, with a payment reference. Separate from approving it — a manager saying yes and accounts paying it are different events.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
  },
  {
    key: "expenses.viewAll",
    label: "View all company expenses",
    description:
      "See every expense in the Expenses module, not just your own and your team's. Needed for company-wide spend reporting.",
    // HR approves everyone's claims, so reads everyone's to begin with (owner, 18 Nov 2026) — a role setting like any other.
    defaultRoles: ["MANAGEMENT", "ACCOUNTS", "HR", "HR_HEAD"],
  },
  {
    key: "expenses.export",
    label: "Export expenses to Excel",
    description:
      "Download the expenses on screen — with the filters and the view chosen — as an Excel file. Only the claims this person can already see; every download is logged.",
    defaultRoles: ["MANAGEMENT", "ACCOUNTS"],
  },
  {
    key: "visits.viewAll",
    label: "View all field visits",
    description: "See every visit logged across the company, rather than just your own and your team's.",
    defaultRoles: ["MANAGEMENT"],
  },
  // Certificates (CRM › Certificates, src/actions/verifiable.ts) borrowed "Raise and issue sales documents" and "Delete or
  // cancel" until those became the per-document grid (owner, 9 Nov 2026); their holders were copied onto these.
  {
    key: "certificates.issue",
    label: "Issue certificates",
    description: "Add a verifiable certificate or document with its QR code, or correct one — CRM › Certificates.",
    defaultRoles: ["SALES", "ACCOUNTS", "MANAGEMENT"],
    group: "Sales & customers",
  },
  {
    key: "certificates.withdraw",
    label: "Withdraw certificates",
    description: "Withdraw a certificate, with a reason, so its public page says it is no longer valid — or put it back.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
    group: "Sales & customers",
  },
  {
    /**
     * Emailing a document to the customer's contacts from your own Outlook — src/actions/document-mail.ts.
     * Separate from issuing: plenty of people raise quotes who should not be the one mailing them, and
     * a mail cannot be called back.
     */
    key: "documents.send",
    label: "Email sales documents to customers",
    description:
      "Email an issued proposal, proforma, tax invoice or credit note to the customer's contacts, as a PDF, from your own connected Outlook mailbox.",
    defaultRoles: ["SALES", "ACCOUNTS", "MANAGEMENT"],
    group: "Sales & customers",
  },
  {
    /**
     * A ready-written email or WhatsApp sent by hand (owner, 11 Nov 2026 — src/lib/quick-messages): after a call, or to
     * introduce a new account manager. Never automatic; to a customer the person can open.
     */
    key: "messages.send",
    label: "Message customers from templates",
    description:
      "Send a customer a ready-written email or WhatsApp message by hand — after a call, from a lead or customer, or to introduce their new account manager. Nothing goes on its own: the person reads it, changes it if they like, and presses Send.",
    defaultRoles: ["SALES", "CALLING", "MANAGEMENT", "SALES_MANAGER"],
    group: "Sales & customers",
  },
  {
    key: "orders.approve",
    label: "Approve or reject orders",
    description: "Review a punched order's payment terms and give (or refuse) the go-ahead to the purchase team.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
    selfExcluded: true,
  },
  {
    // Temporary (owner, 23 Nov 2026): to be taken out of the code once the old CRM's orders are all in — src/actions/past-order.ts.
    key: "orders.recordPast",
    label: "Add past orders (temporary)",
    description:
      "Record an order the customer already has — bought before Deskzo — as done: no approval, purchase step, invoice or notifications. It counts in their history and comes up for renewal; one expiring within 15 days of being entered sends the customer no automatic reminder. Only on customers this person can see.",
    defaultRoles: [],
  },
  {
    key: "orders.process",
    label: "Process orders (purchasing)",
    description: "Set the vendor, purchase price, and our PO on an approved order, and mark it fulfilled.",
    defaultRoles: ["PURCHASE", "MANAGEMENT"],
  },
  {
    key: "orders.approveLoss",
    label: "Approve orders sold below cost",
    description:
      "A negative call — an order whose selling price is below what we pay for it — goes ahead only once somebody holding this approves it, whatever rebate is expected. Approved at a cost: buying it later for more needs approving again. Never on your own order.",
    defaultRoles: ["MANAGEMENT"],
    selfExcluded: true,
    tier: "sensitive",
  },
  {
    key: "rebates.view",
    label: "See backend rebates",
    description:
      "The rebate a distributor or an OEM is to pay back on an order, the net margin after it, the rebate programmes, vendor credits and the rebates report — and entering a rebate when punching or editing an order. Without it, an order shows its deal registration and front margin only.",
    defaultRoles: ["MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Finance",
    tier: "sensitive",
  },
  {
    key: "rebates.manage",
    label: "Manage rebate programmes and vendor credits",
    description:
      "Set up the standing rebate programmes that suggest an order's rebate, record the credit notes and payouts distributors and OEMs send — which post to the books and reduce what we owe them — and write off a rebate that will not come.",
    defaultRoles: ["MANAGEMENT", "ACCOUNTS"],
    group: "Finance",
    tier: "sensitive",
  },
  {
    key: "hr.manage",
    label: "Manage people records",
    description:
      "Create and edit employee records, the holiday calendar, and leave types. This is the HR administrator's permission — it does not by itself reveal anyone's pay.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    /**
     * Hiring, apart from people records (owner, 8 Oct 2026): a recruiter runs candidates without
     * opening every employee's file. "Manage people records" still includes it (src/actions/candidate.ts),
     * and turning a hired candidate into an employee account stays with that permission alone — it
     * creates a login and an employee record. The migration that added this gave it the same answer
     * as "Manage people records" wherever that was set by hand, so nobody gained or lost hiring.
     */
    key: "hiring.manage",
    label: "Run hiring",
    description:
      "Candidates and their progress, intake links, offer and other candidate letters, and candidates' documents. Does not open employee records, and converting a hired candidate into an employee is HR's.",
    defaultRoles: ["MANAGEMENT"],
    group: "People & HR",
    tier: "sensitive",
  },
  {
    /**
     * The file manager (owner, 21 Oct 2026): "only admin and superadmin can allow this to employees".
     * Nobody holds it by role; an admin holds it as they hold everything, and gives it to a person from
     * People › File manager, or to a role.
     */
    key: "files.view",
    label: "Use the file manager",
    description:
      "Open People › File manager to see and download your own payslips, letters (offer, appointment, letter of intent, salary certificate and the rest) and documents — those an admin has switched on. Only an admin or the super admin can give it.",
    defaultRoles: [],
    group: "People & HR",
    delegable: false,
    adminOnly: true,
  },
  {
    key: "visitors.view",
    label: "See the visitor book",
    description:
      "Who has signed in at reception, who is still in the building, and sign them out. Reception, security and HR.",
    defaultRoles: ["MANAGEMENT", "SUPPORT"],
  },
  {
    key: "visitors.manage",
    label: "Set up reception tablets",
    description:
      "Create the kiosk links a reception tablet runs on, and rotate them. A kiosk link needs no login and lists every employee by name and department to whoever opens it — which is what makes this separate from simply reading the book.",
    defaultRoles: ["MANAGEMENT"],
    tier: "sensitive",
  },
  {
    key: "engagement.readFeedback",
    label: "Read anonymous feedback",
    description:
      "See everything sent through the internal anonymous channel. The channel records nothing about who wrote an item, so this grants sight of the text and no way whatsoever to identify its author. HR, directors and admins.",
    defaultRoles: ["MANAGEMENT"],
    tier: "sensitive",
    // Managing somebody does not entitle you to read what people say about them.
    delegable: false,
  },
  {
    key: "engagement.manage",
    label: "Create forms, polls and votes",
    description:
      "Build and publish internal forms, set who they go to, and read the results. Results stay hidden until five people have answered, whoever holds this.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    /**
     * Deskzo Cards. Having a card is not a permission: a card is something the company issues, because
     * the super admin holds every permission and the owner's rule is that nobody has a card until
     * somebody switches it on (10 Oct 2026). This is who does the switching.
     */
    key: "cards.manage",
    label: "Manage digital cards",
    description:
      "Issue digital cards and switch them off, design the company's card templates, and see every card's views, saves and the people who shared their details back. HR and admins.",
    defaultRoles: ["MANAGEMENT", "HR", "HR_HEAD"],
    // Managing the person who runs the cards is not running them.
    delegable: false,
  },
  {
    /** Deskzo Signatures: the company's email signatures, and putting them into everybody's mailbox. */
    key: "signatures.manage",
    label: "Manage email signatures",
    description:
      "Design the company's email signatures, decide who gets which, connect Google Workspace or Zoho Mail, and put the signatures into everybody's mailbox.",
    defaultRoles: ["MANAGEMENT"],
    delegable: false,
  },
  {
    key: "vault.use",
    label: "Use the credential vault",
    description:
      "Store your own logins and open the ones shared with you. Everyone who needs a password from the vault needs this; it grants nothing on records nobody has shared.",
    defaultRoles: ["MANAGEMENT", "SALES", "SUPPORT", "ACCOUNTS", "PURCHASE"],
  },
  {
    key: "vault.viewAll",
    label: "See every vault record",
    description:
      "Open any stored credential, including ones nobody shared. The owner is notified every time this override is used, and it is recorded on the record — so it is visibility, not invisibility. Grant it to as few people as the work allows.",
    defaultRoles: [],
    tier: "critical",
    // Managing somebody is not the same as being entitled to their passwords.
    delegable: false,
  },
  {
    key: "vault.manageTags",
    label: "Manage vault categories",
    description: "Edit the category and access-type lists the vault files credentials under.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "cycles.view",
    label: "See service cycles",
    description: "The work owed across every customer's service cycles — overdue, this month, coming up — and each cycle's timeline. Each job's task is still its own person's.",
    defaultRoles: ["MANAGEMENT", "SUPPORT"],
  },
  {
    key: "cycles.manage",
    label: "Run service cycles",
    description: "Make the plans (the steps and how often each comes round), start a cycle for a customer, change its dates or owner, skip a job, and stop a cycle.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "projects.manage",
    label: "Run projects",
    description:
      "Create and edit projects, milestones, risks, billing stages and the stakeholder list. Seeing a project still requires being on it.",
    defaultRoles: ["MANAGEMENT", "SUPPORT"],
  },
  {
    key: "projects.viewAll",
    label: "See every project",
    description:
      "Projects are visible to their stakeholders only. This overrides that. Grant it sparingly — it exists so the module stays administrable when the last stakeholder on a project leaves, not as a convenience.",
    defaultRoles: ["MANAGEMENT"],
    tier: "sensitive",
  },
  {
    key: "projects.credentials",
    label: "Open stored credentials",
    description:
      "Reveal the passwords and keys stored against a project. Every reveal needs the viewer's own password, is recorded against the credential, and notifies the project manager. Being a stakeholder is not enough on its own.",
    defaultRoles: [],
    // Nobody holds this by default, including Management. It is the one key in this module that
    // hands over somebody else's customer's systems.
    tier: "critical",
    delegable: false,
  },
  {
    key: "people.handover",
    label: "Hand over someone's work",
    description:
      "Move a person's accounts, leads, tickets, open quotes and equipment to colleagues — for a resignation, a long absence or a change of territory. It reassigns live work only: it never touches who created, approved or was paid for anything, and never touches anyone's own HR records.",
    defaultRoles: ["MANAGEMENT"],
    // Sensitive rather than standard: one screen can re-point an entire book of business, and the
    // people affected find out by the work appearing in their queue.
    tier: "sensitive",
  },
  {
    key: "hr.viewAll",
    label: "See everyone's attendance & leave",
    description:
      "View attendance and leave for the whole company rather than just your own and your team's. Managers already see their own reports without this.",
    defaultRoles: ["MANAGEMENT"],
    // Its own description is the argument: a manager already sees their reports. Inheriting this
    // *from* a report would widen that to the whole company, which is the opposite of the intent.
    delegable: false,
  },
  {
    key: "hr.approveLeave",
    label: "Approve leave for anyone",
    description:
      "Decide any leave request, not only those from people who report to you — for whoever covers while a manager is away.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    // HR signs expense claims off (owner, 19 Oct 2026) — or after the reporting manager, as Settings ›
    // People › Expense approvals says. Never one's own claim.
    key: "hr.approveExpenses",
    label: "Approve expense claims (HR)",
    description:
      "Decide the expense claims that come to HR: every claim when HR approves them, or each claim after the reporting manager has, as Settings › People › Expense approvals sets. An approved claim goes to the books and to Accounts to pay.",
    defaultRoles: ["MANAGEMENT", "HR", "HR_HEAD"],
    selfExcluded: true,
  },
  {
    // GPS attendance (owner, 22 Oct 2026): who may let somebody clock in or out away from their office — approve
    // or refuse their request, grant one for them, revoke one not yet used. Never one's own.
    key: "hr.approveAttendanceExceptions",
    label: "Approve attendance location exceptions",
    description:
      "Let somebody clock in or out away from their office's GPS area — approve or refuse their request, grant one for a day, and revoke one not yet used. Never one's own. Every exception is recorded with who decided it and why.",
    defaultRoles: ["MANAGEMENT", "HR", "HR_HEAD"],
    selfExcluded: true,
    tier: "sensitive",
  },
  {
    // Printing the month (owner, 26 Nov 2026 — "make a permission of print attendance"): HR's by default, and an
    // admin's and the super admin's as every key is. It prints only the people its holder already sees on the screen.
    key: "hr.printAttendance",
    label: "Print attendance",
    description:
      "Print a month's attendance from Manage attendance: everybody on one sheet, or a page for each employee, day by day. It prints only the people they can already see there.",
    defaultRoles: ["MANAGEMENT", "HR", "HR_HEAD"],
  },
  {
    key: "payroll.manage",
    label: "Run payroll",
    description:
      "See and set salary structures, run the monthly payroll, and lock it. This is the one permission that exposes what everybody earns — grant it to as few people as the work allows.",
    defaultRoles: [],
    /**
     * Never inherited from a report.
     *
     * The description above says to grant this to as few people as the work allows, and without
     * this flag the resolver handed it to anybody who happened to manage the person who had it —
     * so putting the payroll clerk under a new manager disclosed every salary in the company to
     * that manager, silently, as a side effect of an org-chart edit.
     */
    delegable: false,
  },
  {
    key: "assets.manage",
    label: "Manage IT assets",
    description:
      "Add and edit assets, assign them to people, record movements, and run consignments — for our own estate and for clients we manage. Includes seeing licence keys.",
    // Not Support's by default since 9 Oct 2026 (owner): the licence keys make it the support lead's,
    // given by the "Support lead" preset or a tick on Staff & roles.
    defaultRoles: ["PURCHASE"],
  },
  {
    key: "assets.viewAll",
    label: "See every IT asset",
    description:
      "The whole register, including assets held by other people and estates we manage for clients. Without it, somebody sees what they are holding and nothing else.",
    defaultRoles: ["MANAGEMENT", "SUPPORT", "PURCHASE"],
  },
  {
    key: "feedback.request",
    label: "Ask customers for feedback",
    description:
      "Generate a feedback link for a customer and withdraw one. Anybody can always see what was said about their own work without this.",
    defaultRoles: ["SALES", "SUPPORT", "MANAGEMENT"],
  },
  {
    key: "feedback.viewAll",
    label: "See all customer feedback",
    description:
      "Every response, including scores naming other people. Without it somebody sees feedback about themselves, feedback they asked for, and feedback on the accounts they run.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "marketing.manage",
    label: "Build campaigns",
    description:
      "Create audiences, templates and journeys, and manage the suppression list. Building something is not the same as sending it — that is a separate permission.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "marketing.send",
    label: "Send campaigns",
    description:
      "Actually put a campaign in the queue, start or stop a journey, and run the scheduler by hand. This is the one action in the app that reaches thousands of customers at once and cannot be recalled.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "marketing.approve",
    label: "Approve a large send",
    description:
      "Sign off a campaign above the size set in Settings. Nobody can approve their own, so this has to be held by more than one person for large sends to work at all.",
    defaultRoles: ["MANAGEMENT"],
    selfExcluded: true,
  },
  {
    key: "marketing.viewAll",
    label: "See marketing results",
    description:
      "Campaigns, journeys and what was sent to whom, including why somebody was left out. Read-only without the permissions above.",
    defaultRoles: ["MANAGEMENT", "SALES"],
  },
  {
    key: "access.approveDevices",
    label: "Approve devices",
    description:
      "Approve, reject and revoke the devices people sign in on. Revoking a device ends every session on it. Nobody can approve their own.",
    defaultRoles: [],
    selfExcluded: true,
  },
  {
    key: "access.viewSignIns",
    label: "See where people sign in",
    description:
      "Every sign-in with its network, its approximate location and — for roles that record it — the location the device reported. Personal data about staff: give it to the few who need it.",
    defaultRoles: [],
  },
  {
    key: "forecast.manage",
    label: "Set forecast weights",
    description:
      "Override how much a deal at each stage counts towards the sales forecast. Without an override, each stage counts at the win rate it has actually achieved over the last year.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "wins.manage",
    label: "Run wins, awards and prizes",
    description:
      "Choose which sales moments celebrate themselves and how loudly, run the fortnightly most-active awards, set the prizes for the top sellers and the most active and announce them, and tick off each prize as it is handed over.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    // Owner, 17 Oct 2026: Management and Admin (an admin holds every key).
    key: "wins.tv",
    label: "Put Deskzo on a TV",
    description:
      "Pair a TV with its code so it shows the wins board for a branch or the whole company, rename it, and take it off. A TV shows the board and nothing else — no sign-in, no seat.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "forms.create",
    label: "Build forms",
    description:
      "Create forms — event invitations, requirement assessments, enquiry and survey forms — and own the ones you build. What anybody else may do with a form is decided on the form itself, by its owner.",
    defaultRoles: ["MANAGEMENT", "SALES"],
  },
  {
    key: "forms.manageAll",
    label: "Manage every form",
    description:
      "See, change, share and read the responses of every form, whoever built it — including the answers customers gave. Without it somebody sees only their own forms and the ones shared with them.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "targets.manage",
    label: "Set targets",
    description:
      "Give people and teams numbers to hit, and withdraw them. Anybody can always see their own targets and their team's without this.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "targets.viewAll",
    label: "See everyone's targets",
    description:
      "The whole company's targets and how each is doing. Without it, somebody sees their own and their reports' — which is what a manager needs and what everybody else should have.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "incentives.manage",
    label: "Manage incentive schemes",
    description:
      "Write the schemes that turn targets into money, attach them to targets, and work out what is owed at the end of a period.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "incentives.approve",
    label: "Approve and pay incentives",
    description:
      "Decide what actually goes out — approve, hold, cancel or pay. Nobody can decide their own, whatever permissions they hold.",
    defaultRoles: ["ACCOUNTS"],
    selfExcluded: true,
  },
  {
    key: "activity.viewAll",
    label: "See everyone's activity log",
    description:
      "Every sign-in, export, refused permission and blocked crawler, for the whole company. Without it, somebody sees only their own activity — which everybody can, and should, so the logging is not a secret.",
    // Deliberately not SALES or SUPPORT: who looked at which customer is the kind of thing that
    // gets used to settle an argument about account ownership rather than to investigate a leak.
    defaultRoles: ["MANAGEMENT"],
  },
  {
    /**
     * Whose calls, notes and meetings somebody sees (owner, 8 Oct 2026): their own and their team's
     * (src/lib/authz/scope.ts, the reporting line), unless they hold this. It narrows a customer's and a
     * lead's Activity, the call log and a record's Meetings — on top of the account scope, which still
     * decides which customers are theirs at all.
     *
     * Not `activity.viewAll` above: that is the security log of sign-ins and exports.
     */
    key: "activities.viewAll",
    label: "See everyone's calls, notes & meetings",
    description:
      "The calls, emails, notes, meetings and stage changes everybody logged on a customer or lead, and every call in the call log. Without it, somebody sees what they logged themselves and what the people who report to them logged.",
    defaultRoles: ["MANAGEMENT"],
    group: "Sales & customers",
  },
  {
    key: "activity.export",
    label: "Export the activity log",
    description:
      "Download activity as a file, for an audit or an investigation. Separated from viewing because the export is itself the thing most worth logging.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "permissions.view",
    label: "Review who can do what",
    description:
      "Open the access screens and see any person's effective permissions and where each one comes from. Read-only — it grants nothing itself, which is what makes it safe to hand to an auditor.",
    defaultRoles: ["MANAGEMENT"],
    group: "Administration",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "portal.manage",
    label: "Manage the customer portal",
    description:
      "Switch the customer portal on, decide whether every customer gets one or only chosen ones, choose what a customer can see of their own account, issue and revoke their links, and work through what they have asked for. This decides what people outside the company can read, which is why it is not simply part of managing a customer record.",
    defaultRoles: ["MANAGEMENT"],
    group: "Administration",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "purchase.reconcile",
    label: "Reconcile vendor statements",
    description:
      "Upload a distributor's monthly statement and compare it against what we actually sold — seat counts, unit costs, and subscriptions billed for that no live order covers. Includes clearing an exception once it has been chased, which is why it is not simply given to everyone who can see a purchase order: the value of the list is that the things cleared from it were genuinely resolved.",
    defaultRoles: ["PURCHASE", "ACCOUNTS", "MANAGEMENT"],
    group: "Finance",
    delegable: true,
    tier: "sensitive",
  },
  {
    // Owner, 28 Oct 2026: admins delete vendors, several at once from the Vendors list. Admins hold every key; the
    // super admin always may; anyone else only when given it.
    key: "vendors.delete",
    label: "Delete vendors",
    description:
      "Delete a vendor nothing has happened with — from its page, or several ticked in the Vendors list. One with bills, payments, orders, POs or the like is refused, saying what it has, so the books and the history never lose a vendor they name.",
    defaultRoles: [],
    group: "Orders & fulfilment",
    tier: "sensitive",
  },
  {
    key: "backups.manage",
    label: "Take database backups",
    description:
      "See the backup log and take one on demand. A backup is a complete copy of the system — every order, every password hash, every encrypted secret — so this is the ability to create one, not to carry it away: taking the file off the server needs \"Download a backup\", and putting one back needs \"Restore from a backup\". Neither is included here.",
    defaultRoles: [],
    group: "Administration",
    // Not inherited from managing whoever administers the system. Taking a copy of everything is
    // its own decision.
    delegable: false,
    tier: "critical",
  },
  {
    key: "backups.download",
    label: "Download a backup",
    description:
      "Take a backup off the server as a single sealed file. Held apart from taking one because the two risks are opposite: a backup on the server is a safety net, and a backup on a laptop is the whole business — every customer, every order, every password hash — somewhere nobody is watching. The file is encrypted under a passphrase chosen at download, and every download is recorded against the person who asked for it.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    // Grantable only by a super admin: this is the shortest path from one account to a copy of
    // everything, and it should never arrive as a side effect of somebody tidying up roles.
    superAdminOnly: true,
    tier: "critical",
  },
  {
    key: "backups.restore",
    label: "Restore from a backup",
    description:
      "Replace the entire contents of the database with an uploaded backup file. This is the most destructive thing anybody can do here — it discards every record created since the backup was taken, including the audit log that would say who did it — and it is the one action that can substitute a whole database, users and all. It requires the file's passphrase, a typed confirmation, and it puts the application into maintenance while it runs.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    superAdminOnly: true,
    tier: "critical",
  },
  {
    key: "permissions.manage",
    label: "Change roles and permissions",
    description:
      "Grant and revoke permissions, for a role or for one person. Bounded by what the grantor holds themselves — nobody can hand out access they do not have — and never covers the super-admin-only keys.",
    defaultRoles: [],
    group: "Administration",
    // Never inherited from a report. Managing the person who administers access is not the same
    // as being entitled to administer it.
    delegable: false,
    tier: "critical",
  },
  {
    key: "users.manage",
    label: "Create and edit users",
    description: "Add accounts, change names, departments and reporting lines, deactivate leavers, and reset two-factor.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    tier: "sensitive",
  },
  {
    /**
     * Locking one person out of the CRM — src/lib/access/lock.ts. Locking the whole company is not
     * this key: only the super admin can, because only the super admin is never locked themselves.
     */
    key: "users.lock",
    label: "Lock people out of the CRM",
    description:
      "Lock a person's access with a notice they see instead of the app — they can still sign in, and nothing else — until you lift it or a date you set passes. Not the super admin, and not yourself.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    tier: "critical",
  },
  {
    key: "users.assignRole",
    label: "Change somebody's role",
    description:
      "Move a person between roles. Reserved to a super admin: a role change is the fastest route to escalation, because it grants a whole set of permissions at once rather than one reviewable key.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    superAdminOnly: true,
    tier: "critical",
  },
  {
    key: "settings.manage",
    label: "Change organisation settings",
    description: "Company identity, invoicing and e-invoicing credentials, branding, numbering, and which modules are switched on.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    tier: "critical",
  },
  {
    // Owner, 17 Oct 2026: the workspace owner, and whoever they let pay — an accounts person, say. Only
    // the owner hands it to anybody, an admin included, because it spends money; since 2 Nov 2026 an
    // admin no longer holds it by default either (audit M-1).
    key: "billing.manage",
    label: "Manage the plan and billing",
    description:
      "Choose and pay for the workspace's plan, change or cancel it, ask for a proforma to pay by bank transfer, and keep the billing details its invoices are made out to.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    superAdminOnly: true,
    tier: "critical",
  },
  {
    // Owner, 17 Oct 2026: the public API (src/lib/api). A key acts as the person who makes it — it can
    // never do more than they can — so this is only who may make one for themselves.
    key: "api.manage",
    label: "Make API keys",
    description: "Make keys for the public API that act as you — for Zapier, Make or your own systems — choose what each may touch, and revoke them. A key can never do more than you can.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "security.manage",
    label: "Change the security and DLP policy",
    description: "Sign-in policy, data-loss-prevention settings, crawler blocking and log retention.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    superAdminOnly: true,
    tier: "critical",
  },
  {
    key: "impersonation.use",
    label: "View the app as another user",
    description:
      "Borrow somebody's account to see exactly what they see — only somebody holding nothing beyond what you could give. Every action taken while doing so is attributed to you, and a super admin can never be impersonated.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    superAdminOnly: true,
    tier: "critical",
  },
  {
    key: "catalog.manage",
    label: "Manage brands, families & industries",
    description:
      "The reference lists behind the item and company pickers — brands, their product families, and the industry list. This is editing a list that thousands of records point at rather than the records themselves: renaming a brand renames it on every item at once.",
    defaultRoles: [],
  },
  {
    key: "ledger.post",
    label: "Write and reverse journal entries",
    description:
      "Hand-write a journal — opening balances, depreciation, a correction the documents cannot express — and reverse an existing one. Nothing here edits or deletes a posting: a mistake is corrected by a dated reversal that stays visible, which is what makes a ledger a ledger.",
    defaultRoles: [],
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "ledger.viewReports",
    label: "See the books",
    description:
      "Open the trial balance, profit & loss, balance sheet, any account's ledger and the journal. This is every figure the company has — what it earns, what it owes, what it pays people in aggregate — so it is a narrower question than being able to record a payment.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
    // Not inherited from a report: managing one accountant should not open the company's books.
    delegable: false,
  },
  {
    key: "ledger.manageAccounts",
    label: "Change the chart of accounts",
    description:
      "Add, rename, re-parent, archive and delete ledger accounts. Structural rather than day-to-day: an account's type decides whether its balance lands in the P&L or on the balance sheet, so this reshapes every report at once.",
    defaultRoles: [],
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "books.close",
    label: "Lock periods and close the year",
    description:
      "Set the date before which nothing may be posted, and run the year-end entry that moves profit into reserves. Deliberately not the same permission as posting: whoever writes the entries should not also be able to unlock the period they wrote them into, or the lock has no teeth.",
    defaultRoles: [],
    delegable: false,
    tier: "sensitive",
  },
  // ─── Revenue & Close (the add-on; spec: revenue recognised as earned, and the month-end close) ──
  {
    key: "revenue.viewReports",
    label: "See revenue schedules and deferred revenue",
    description:
      "Open the revenue schedules, the waterfall of revenue still to be recognised, the deferred revenue roll-forward and each customer's revenue. Read-only: nothing here moves money between months.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
    delegable: false,
  },
  {
    key: "revenue.manage",
    label: "Manage revenue recognition",
    description:
      "Approve, edit and cancel revenue schedules, run recognition for a month and open deferred revenue for past invoices. Each of these decides which month's profit an invoice lands in, so a schedule someone made or changed by hand needs a second person to approve it.",
    defaultRoles: [],
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "close.work",
    label: "Work the month-end close",
    description:
      "Tick, annotate and mark not-applicable the month-end checklist's tasks, and explain the month's large movements. Working the checklist doesn't close the month — that also needs “Lock periods and close the year”.",
    defaultRoles: ["ACCOUNTS"],
  },
  {
    key: "close.manage",
    label: "Run the month-end close",
    description:
      "Change the checklist's tasks, set the thresholds for explaining movements, manage prepaid and accrual schedules, and close or reopen a month (with “Lock periods and close the year”).",
    defaultRoles: [],
    delegable: false,
    tier: "sensitive",
  },
  /**
   * Finance → Accounts (owner, 22 Oct 2026): inventory and vouchers. Posting a voucher to the ledger, or reversing
   * one, is `ledger.post` as a hand-written journal is; banking is `payments.manage`; locking a period is
   * `books.close`; downloading a report is `data.exportFinance`.
   */
  {
    key: "inventory.view",
    label: "See stock",
    description:
      "Stock on hand by warehouse and batch, the stock ledger, transfers, adjustments and counts, and the inventory reports — valuation, aging, low stock, slow-moving stock and item profitability.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT", "PURCHASE", "SALES"],
    group: "Finance",
  },
  {
    key: "inventory.receive",
    label: "Receive stock",
    description: "Record goods receipts (GRNs) against purchase orders or on their own, with batches, expiry dates and serial numbers.",
    defaultRoles: ["PURCHASE", "ACCOUNTS", "MANAGEMENT"],
    group: "Finance",
  },
  {
    key: "inventory.transfer",
    label: "Transfer stock",
    description: "Move stock from one warehouse to another — sent, in transit, and received.",
    defaultRoles: ["PURCHASE", "ACCOUNTS", "MANAGEMENT"],
    group: "Finance",
  },
  {
    key: "inventory.adjust",
    label: "Adjust stock",
    description:
      "Correct stock by hand, record a physical count, write off damaged or expired goods, and return goods to a vendor. Every change needs a reason and stays in the stock ledger.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
    group: "Finance",
    tier: "sensitive",
  },
  {
    key: "inventory.approveAdjustments",
    label: "Approve stock adjustments",
    description: "Approve stock adjustments and counts waiting for a second person, where Accounts settings ask for one. Never your own.",
    defaultRoles: ["MANAGEMENT"],
    group: "Finance",
    tier: "sensitive",
    selfExcluded: true,
  },
  {
    key: "inventory.manage",
    label: "Set up inventory",
    description: "Warehouses, units of measure, and which items keep batches, expiry dates and serial numbers.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
    group: "Finance",
  },
  {
    key: "vouchers.create",
    label: "Write vouchers",
    description:
      "Draft payment, receipt, contra and journal vouchers and send them for approval. Posting one to the ledger needs “Write and reverse journal entries”.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
    group: "Finance",
  },
  {
    key: "vouchers.approve",
    label: "Approve vouchers",
    description: "Approve vouchers waiting for a second person, where Accounts settings ask for one. Never your own.",
    defaultRoles: ["MANAGEMENT"],
    group: "Finance",
    tier: "sensitive",
    selfExcluded: true,
  },
  {
    key: "accounts.configure",
    label: "Change Accounts settings",
    description:
      "Inventory accounting (periodic or perpetual), the costing method, negative stock, what moves stock automatically, approvals and voucher numbering. The costing method can't change once stock has been valued.",
    defaultRoles: [],
    group: "Finance",
    delegable: false,
    tier: "sensitive",
  },
  {
    /**
     * Who may see what visitors did on the website (owner, 6 Nov 2026; src/lib/inbox/activity.ts) — their pages, device,
     * location, network and IP address. Its own key because that is more than a lead's details say.
     */
    key: "website.activity",
    label: "See website activity",
    description: "Which pages a visitor opened and when, with their device, browser, location, network and IP address — on a lead's page, and in the Customer inbox's Visitors tab and beside a chat.",
    defaultRoles: ["SALES", "SALES_MANAGER", "MANAGEMENT", "CALLING", "SUPPORT"],
    group: "Sales & customers",
  },
  {
    /**
     * Opening a lead (owner, 1 Nov 2026: "why there is no create lead permission?"). It used to come with
     * viewing leads; now a role can see the pipeline without adding to it — or, the other way round, a
     * support desk can keep it to pass on what it hears (its lead's `sourcedByUserId` is theirs).
     * Every role that held "View leads" holds this from the day it shipped: the defaults match, and
     * migration 20261201370000_leads_create copied every stored view grant and denial onto it.
     * Checked in createLead (the forms, Quick lead, the API) and by Automate's "Create a lead".
     */
    key: "leads.create",
    label: "Create leads",
    description: "Add a lead — New lead, Quick lead, Make a lead from a call, and the API. Only on customers this person can see. Without it the pipeline can still be viewed.",
    // The built-in sales manager and renewal specialist start with "View leads" written as a row; they hold this by default.
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE", "SALES_MANAGER", "RENEWAL_SPECIALIST"],
    group: "Sales & customers",
  },
  {
    /**
     * Choosing who owns a lead when it is created — anybody, not only yourself.
     *
     * `createLead` used to take any owner from anybody, with nothing on the form to set one and
     * nothing on the server to stop a crafted request doing it. Without this a person's new lead is
     * theirs, or goes to the assignment rules; with it they can hand it to a colleague.
     */
    key: "leads.assign",
    label: "Assign leads to others",
    description:
      "Pick the salesperson a new lead goes to. Without this, a new lead is yours if you sell, and otherwise goes to the automatic assignment rules.",
    defaultRoles: ["MANAGEMENT", "CALLING"],
    group: "Sales & customers",
  },
  // ── What of an account somebody may see ─────────────────────────────────────────────────────
  //
  // Each of these governs one kind of record everywhere it appears: the customer page's tab, the
  // module's own pages and the actions behind both. Where a kind of record is its own module, the
  // key is that module's `viewPermission` (src/lib/modules.ts), and `isModuleEnabled` answers "off"
  // to anybody without it — so every page, action and dashboard figure already gated on the module
  // follows the permission with no second check to forget. Contacts and leads are part of the core
  // Companies module, so they are checked where they are read.
  //
  // Every role held all nine by default, so nobody lost anything when they arrived; restricting a
  // role is unticking a box in Users & access. Since 9 Oct 2026 (owner) the profiler and the calling
  // agent hold neither payments nor quotes & invoices by default: they build and call the records, and
  // never needed the money.
  {
    key: "contacts.view",
    label: "View contacts",
    description: "The people at an account — the Contacts tab, their phone numbers and emails on leads and in the calling screen, and adding or editing them.",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Sales & customers",
  },
  {
    // The Contacts directory apart from a customer's Contacts tab (owner, 2 Nov 2026): a role can work the people at
    // its own accounts without browsing everybody's. Copied from View contacts on the day
    // (migration 20261201410000_view_rights_split), so nobody gained or lost anything.
    key: "contacts.directory",
    label: "Open the Contacts directory",
    description: "The Contacts page in the menu — every contact across the accounts this person can see, in one list — and the app's and the API's contact lists. Needs View contacts too. Without it, the people at an account are still on its Contacts tab.",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE", "SALES_MANAGER", "RENEWAL_SPECIALIST"],
    group: "Sales & customers",
  },
  {
    // A customer's Commission tab as its own right (owner, 2 Nov 2026). It showed to anybody who could open the
    // customer while Commission Parties was on, so every role was given it on the day (migration
    // 20261201410000_view_rights_split).
    key: "commissions.view",
    label: "View commission on a customer",
    description: "A customer's Commission tab — the commission parties linked to them, and what is paid out on their orders.",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE", "SALES_MANAGER", "RENEWAL_SPECIALIST"],
    group: "Sales & customers",
  },
  {
    key: "emails.view",
    label: "View emails sent to customers",
    description: "The mail log — every email the ERP sent a customer (renewal and fulfilment notices, campaigns, journeys), with its content and whether it was delivered, opened or bounced. On a customer's Emails tab and the Mail log page, for the accounts this person can see.",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Sales & customers",
  },
  {
    key: "leads.view",
    label: "View leads",
    description: "The lead pipeline — the Leads pages, a customer's Leads tab, pipeline value and activity on the customer page, and lead figures on the dashboard.",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Sales & customers",
  },
  {
    key: "orders.view",
    label: "View orders",
    // Subscriptions and renewals are their own since 26 Nov 2026 (owner: "separate permission for renewal and orders and
    // subscription"); each was copied from this on the day (migration 20261229200000_subscriptions_renewals_view).
    description: "The Orders module — every order, its approval, purchase and fulfilment.",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Orders & fulfilment",
  },
  {
    key: "subscriptions.view",
    label: "View subscriptions",
    description: "A customer's Products & Subscriptions tab — what they have bought, their seats and terms, and whether a customer is still waiting for their first order.",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Orders & fulfilment",
  },
  {
    key: "renewals.view",
    label: "View renewals",
    description: "The Renewals module — what is coming up for renewal, its stages, reminders and proposals — a customer's Renewals tab, and the pro-rata calculator.",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Orders & fulfilment",
  },
  {
    key: "payments.view",
    label: "View payments",
    description: "Money in and owed — the Payments, Receivables and Payables modules, and a customer's Payments and Statement tabs with the billed and outstanding figures.",
    defaultRoles: ["SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Finance",
  },
  {
    // The Statement tab as its own right (owner, 2 Nov 2026): a role can see payments without the statement of
    // account, or be kept from printing and sending one. Copied from View payments on the day
    // (migration 20261201410000_view_rights_split).
    key: "statements.view",
    label: "View statements of account",
    description: "A customer's or vendor's Statement tab — every invoice, payment and note with the running balance — and printing, downloading and emailing it. Needs View payments too.",
    defaultRoles: ["SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE", "SALES_MANAGER", "RENEWAL_SPECIALIST"],
    group: "Finance",
  },
  {
    /**
     * Collections (src/actions/collections.ts): a salesperson chasing what their clients owe. Off for
     * everybody until an admin grants it — per role or per person — because it shows a salesperson
     * money on orders they punched on somebody else's account (owner decision C-D1), which "View
     * payments" alone does not. Accounts log follow-ups through `payments.record` without it.
     */
    key: "collections.followUp",
    label: "Follow up payments on their accounts",
    description:
      "My collections: what is still owed on the accounts they manage (their team's too, for a manager) and on orders they punched on anybody's account, and logging each follow-up — what the client said, a promise to pay by a date, when to call next. A promise that passes unpaid is flagged to them, their manager and accounts. Needs View payments as well.",
    defaultRoles: [],
  },
  {
    key: "credit.override",
    label: "Override credit terms & limits",
    description:
      "Give a customer longer payment terms than their credit rating supports, set or change their credit limit, and approve an order that goes over it. Each time asks for a reason, which is kept against the customer. Without it the rating's suggested terms are the most anybody can give.",
    defaultRoles: ["MANAGEMENT", "ACCOUNTS"],
    group: "Finance",
    tier: "sensitive",
  },
  {
    key: "documents.view",
    label: "View quotes & invoices",
    description: "Proposals, proformas, invoices and purchase documents — their modules, and a customer's Documents tab.",
    defaultRoles: ["SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Finance",
  },
  {
    key: "projects.view",
    label: "View projects",
    description: "The Projects module and a customer's Projects tab. Which projects appear still follows project membership — see \"See every project\".",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Support",
  },
  {
    /**
     * Booking a Teams or Outlook meeting from Deskzo (src/actions/calendar.ts). Every role keeps it
     * until an admin unticks it (owner, 8 Oct 2026): a calling team that books appointments needs it,
     * one that only dials may not. Cancelling a meeting you booked never needs it.
     */
    key: "meetings.schedule",
    label: "Schedule meetings",
    description:
      "Book a Teams or Outlook meeting from a customer, contact, lead, ticket or visit, or from the Calendar, and reschedule one you booked. Without it the Calendar still shows your own diary, and a meeting you booked can still be cancelled.",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Sales & customers",
  },
  {
    key: "calls.listen",
    label: "Listen to call recordings",
    description: "Play the recordings of other people's calls that you can see. Everybody can play their own; every play is written down.",
    defaultRoles: ["MANAGEMENT", "SALES_MANAGER"],
    group: "Sales & customers",
  },
  {
    key: "calls.view",
    label: "View calls",
    description: "The call log — the Calls module and a customer's Calls tab.",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Sales & customers",
  },
  {
    key: "visits.view",
    label: "View visits",
    description: "Customer visits — the Visits module and a customer's Visits tab. Whose visits appear still follows \"See everybody's visits\".",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Sales & customers",
  },
  {
    key: "tickets.view",
    label: "View tickets",
    description: "Support tickets — the Helpdesk module and a customer's Tickets tab.",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Support",
  },
  {
    // The Customer inbox (owner, 24 Oct 2026): website chat and WhatsApp, in one inbox — src/lib/inbox.
    key: "inbox.view",
    label: "Answer customer conversations",
    description:
      "The Customer inbox: read and reply to website chats and WhatsApp messages on the team's shared channels and your own number, take or pass on a conversation, and make a lead or a ticket from one.",
    defaultRoles: ["CALLING", "SALES", "SALES_MANAGER", "SUPPORT", "MANAGEMENT"],
    group: "Support",
  },
  {
    key: "inbox.viewAll",
    label: "See every customer conversation",
    description: "Also the conversations on colleagues' own WhatsApp numbers, which otherwise only they — and whoever a conversation is given to — can read.",
    defaultRoles: ["SALES_MANAGER", "MANAGEMENT"],
    group: "Support",
  },
  {
    /**
     * Moving an account or a lead from one person to another — any the holder can see.
     *
     * The account manager is what the account scope resolves against: whoever holds it sees the
     * company and everything hanging off it. Changing it was open to anybody signed in, and by id, so
     * a salesperson could make themselves account manager of a company they could not see — and
     * thereby see it. This is the line; `accounts.handOffOwn` is the narrower one for handing on
     * only what is already yours.
     */
    key: "accounts.reassign",
    label: "Reassign accounts and leads",
    description:
      "Change the account manager or caller of any account you can see, and the owner of any lead you can see — including leaving one with nobody. Every change is written to the activity log.",
    defaultRoles: ["MANAGEMENT"],
    group: "Sales & customers",
  },
  {
    key: "accounts.handOffOwn",
    label: "Hand off your own accounts and leads",
    description:
      "Pass what is yours to a colleague: an account you manage (its manager and caller), an account you are the caller on (the caller), a lead you own. Always to a person — only someone who can reassign may leave it with nobody.",
    defaultRoles: ["SALES", "MANAGEMENT"],
    group: "Sales & customers",
  },
  {
    key: "workspace.manageAny",
    label: "Act on anyone's saved list",
    description:
      "Edit, delete, assign, open a private one, and start or re-share a calling activity on a list somebody else built. Everyone can already do all of this to their own — this is the override for a list whose owner has left, is away, or built it for a team that now needs it back.",
    defaultRoles: [],
  },
  {
    // Apollo.io (owner, 14 Nov 2026 — src/lib/apollo): each lookup spends the workspace's own Apollo credits.
    key: "companies.enrich",
    label: "Enrich from Apollo or Lusha",
    description:
      "Look companies and people up in Apollo.io or Lusha with the workspace's own account: a company's industry, size and social links, a contact's work email and mobile, and people at a company by their title. Each lookup spends that provider's credits; only blanks are filled without asking.",
    defaultRoles: ["MANAGEMENT", "SALES_MANAGER"],
    group: "Sales & customers",
  },
  {
    key: "companies.manageCategories",
    label: "Manage customer categories",
    description:
      "Create, rename, recolour and remove the customer categories and sub-categories, their icons and their handling notes — how every account is described to everybody. Putting a customer in a category needs only access to that customer.",
    defaultRoles: ["MANAGEMENT"],
    group: "Sales & customers",
  },
  {
    /**
     * The AI copilot — src/lib/copilot/. Everything it looks up it looks up as the person chatting,
     * through the same checks the app's own screens use, so this key decides only whether they may
     * use it at all — never what it can see.
     */
    key: "copilot.use",
    label: "Use Deskzo AI",
    description:
      "Ask questions about your data, get reports, and have tasks, notes, new leads and a change to one lead drafted for you to confirm. It sees and does only what you already can, and counts against a daily allowance.",
    defaultRoles: ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    group: "Administration",
  },
  {
    /**
     * Owner, 23 Nov 2026 — "the tenant admin can see all the chats, and each employee's usage": Settings › AI activity
     * (src/lib/copilot/review.ts). Every reading of somebody's chat is recorded and listed there. No role starts with
     * it: admins and the super admin hold it, and grant it on.
     */
    key: "copilot.review",
    label: "Review everyone's Deskzo AI chats",
    description:
      "See every person's Deskzo AI chats — deleted ones too — and how much each person uses Deskzo AI, on Settings › AI activity. Each chat you open is recorded there, by name.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    tier: "critical",
  },
  {
    /**
     * The company's own guides (articles and videos in the rail) and its company news —
     * src/actions/help.ts. Deskzo's help, videos and What's new come from Deskzo's console, and no
     * workspace permission touches them. Its own key rather than `settings.manage`, because whoever
     * trains people and announces changes is rarely the person who should be editing the GSTIN.
     */
    key: "help.manage",
    label: "Manage your company's guides and news",
    description:
      "Add your company's own help articles and training videos to the rail, and post company news that everybody sees. Deskzo's help and What's new come from Deskzo and are not changed here.",
    defaultRoles: ["MANAGEMENT"],
    group: "Administration",
  },
  {
    /**
     * The workspace's own fields on companies, contacts, leads, orders and products — see
     * src/lib/custom-fields. Adding a required field changes every form those records are entered
     * through, so it is an administrator's decision, not anybody's who can edit a record.
     */
    key: "fields.manage",
    label: "Manage custom fields",
    description:
      "Add the workspace's own fields to companies, contacts, leads, orders and products — text, numbers, dates, dropdowns and more — choose where they appear, which are required, and which are restricted; rename, reorder and retire them.",
    defaultRoles: ["MANAGEMENT"],
    group: "Administration",
  },
  {
    /**
     * A custom field marked restricted — a cost price, a commission rate — is seen and changed only
     * with this. Everyone else never receives its value: the server leaves it out of pages, lists and
     * exports, and a form they save keeps whatever the record already holds.
     */
    key: "fields.seeRestricted",
    label: "See restricted custom fields",
    description:
      "See and change the custom fields marked restricted, wherever they appear — on records, in lists and filters, and in exports. Without it, those fields are not shown at all and saving a record leaves them as they are.",
    defaultRoles: ["MANAGEMENT"],
    group: "Administration",
    tier: "sensitive",
  },
  {
    /**
     * A custom field of the secret kind — a licence key, a subscription key (owner, 29 Oct 2026): anybody who may
     * change the record may set or replace one, but only this reads it back. Each reveal is recorded on the record.
     */
    key: "fields.revealSecrets",
    label: "Reveal secret custom fields",
    description:
      "Reveal the licence keys, subscription keys and other secrets kept in the workspace's secret fields — each reveal recorded on the record. Without it, a secret shows only its last four characters; anyone who may change the record can still set or replace it.",
    defaultRoles: ["MANAGEMENT"],
    group: "Administration",
    tier: "sensitive",
  },
  {
    /**
     * The workspace's own lead stages (Settings → Pipeline, src/lib/pipeline). Everybody who works leads
     * moves them through the stages; shaping the stages is a manager's call, because what a stage
     * counts as decides what reaching it does — a won lead counts towards targets.
     */
    key: "pipeline.manage",
    label: "Manage the sales pipeline",
    description:
      "Add team pipelines and connect them; name the stages a lead moves through, set their order and colours, choose what each counts as — new, qualified, won, lost and so on — and what a lead needs before it moves there; set up the pipelines' automations; retire what is no longer used.",
    defaultRoles: ["MANAGEMENT"],
    group: "Sales & customers",
  },
  {
    /**
     * Booking pages (src/lib/booking): their address, hours, who customers meet. A page is public and
     * puts meetings in people's calendars, so making one is a manager's call.
     */
    key: "booking.manage",
    label: "Manage booking pages",
    description: "Make the public pages customers book meetings on — their address, hours, meeting length and who they meet — and see what has been booked.",
    defaultRoles: ["MANAGEMENT"],
    group: "Sales & customers",
  },
  {
    /**
     * Folding a duplicate company into the one that stays — see src/lib/companies/merge.ts.
     *
     * Not undoable: the duplicate is removed and everything under it now belongs to the other. So it
     * is its own permission rather than part of editing a company, and the merge screen still asks
     * for the duplicate's name to be typed before anything moves.
     */
    key: "companies.merge",
    label: "Merge duplicate companies",
    description:
      "Fold a duplicate company into the one that stays: its contacts, leads, orders, invoices, payments, tickets, visits and everything else move across, matching contacts are combined, and the duplicate is removed — its old links open the company it became. Only between companies you can see, and it can't be undone.",
    defaultRoles: ["MANAGEMENT"],
    group: "Sales & customers",
    tier: "sensitive",
  },
  {
    /**
     * A company's role changed (owner, 29 Oct 2026): a customer made a reseller or a reseller a customer
     * (`changeCustomerKind`), or the other side added or taken off — a customer that's also a vendor, a vendor that's
     * also a customer (`setCompanySecondRole`). Each moves the company between lists and who looks after it, so it is
     * its own permission rather than part of editing a company.
     */
    key: "companies.changeRole",
    label: "Change a company's role",
    description:
      "Make a customer a reseller or a reseller a customer, and add or take off a company's second role — a customer that's also a vendor, a vendor that's also a customer. What was done in its old role stays; it moves between the lists.",
    defaultRoles: ["MANAGEMENT"],
    group: "Sales & customers",
    tier: "sensitive",
  },
  {
    key: "companies.viewAll",
    label: "See every account, not just your own",
    description:
      "Without this, somebody sees only the companies they are account manager for — plus, if they manage people, their reports' accounts. Everything hanging off a company follows the same line: its orders, payments, renewals, leads, tickets, contacts and documents. Grant it to the functions that serve every account rather than own some, such as accounts, purchasing and support.",
    // Everyone except SALES, which reproduces today's behaviour for every other role and narrows
    // only the one the request was about. A sales *manager* holds the SALES role too and stays
    // scoped — their breadth comes from their reporting line, which is the point.
    defaultRoles: ["MANAGEMENT", "ACCOUNTS", "PURCHASE", "SUPPORT", "PROFILE", "CALLING"],
    group: "Sales & customers",
    tier: "sensitive",
  },
  {
    key: "data.exportCrm",
    label: "Export customer data",
    description:
      "Download companies, customers, contacts, tickets, visits, assets, saved lists and the suppression list as a file. Returns only the accounts the person can already see — export never widens visibility, it decides whether what you can see may leave the building.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "data.importCrm",
    label: "Import customer data",
    description:
      "Bring companies, contacts and related records in from a file. Riskier than export: a bad import creates duplicates that are tedious to unpick and silently wrong until somebody notices.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "data.exportFinance",
    label: "Export financial data",
    description:
      "Orders, renewals, payments, expenses, statements of account and the ledger. Orders, renewals and payments are export-only — they are records of processes the system ran, not descriptions that can be handed back to it.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "data.importFinance",
    label: "Import financial data",
    description:
      "The chart of accounts and expense claims. Deliberately narrow: nothing here can create an order, a payment or a journal entry, because those must come through the flows that also write the ledger.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "critical",
  },
  {
    key: "data.exportCatalog",
    label: "Export the catalog",
    description:
      "Products, services and subscriptions with their brands and product families. Prices are what a competitor would most like to have, so this is separate from the rest of the customer data.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "data.importCatalog",
    label: "Import the catalog",
    description:
      "Bulk-load items from a spreadsheet — see public/items-import-template.csv. The most routine import here, and the one most likely to be handed to somebody who is not an admin.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
  },
  {
    key: "data.exportPeople",
    label: "Export employee data",
    description:
      "Employee records, attendance, leave, documents and candidates. Salary figures and bank details are omitted from every export regardless of this permission — see the redaction policy.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "critical",
  },
  {
    key: "data.importPeople",
    label: "Import employee data",
    description:
      "Bring employee records and candidates in from a file, for a bulk onboarding or a migration from another HR system.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "critical",
  },
  {
    key: "data.exportUsers",
    label: "Export user accounts",
    description:
      "Accounts, roles, departments and reporting lines. Never includes password hashes or two-factor secrets, which have no legitimate export.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    superAdminOnly: true,
    tier: "critical",
  },
  {
    key: "data.importUsers",
    label: "Import user accounts",
    description:
      "Create accounts in bulk from a file. Reserved to a super admin: creating accounts is the shortest route to creating one for yourself with a role you were never granted.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    superAdminOnly: true,
    tier: "critical",
  },
  // ─── Sections (owner, 8 Oct 2026) ──────────────────────────────────────────────────────────
  // One per module, in the menu's order and named by its menu group: whether a role sees it in the menu
  // and may open its pages. Every role holds them (`everyone`) until one is unticked for it — so nobody
  // loses a section on the day these arrive. A menu group goes when every module in it is unticked.
  { key: "section.leads", label: "Sales › Leads", description: "See Leads in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.companies", label: "Sales › Companies & Contacts", description: "See Companies & Contacts in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.wins", label: "Sales › Sales Wins", description: "See Sales Wins in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.forecast", label: "Sales › Forecasting", description: "See Forecasting in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.workspace", label: "Prospecting › Smart Lists", description: "See Smart Lists in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.domains", label: "Prospecting › Domain Intel", description: "See Domain Intel in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.calls", label: "Prospecting › Calls", description: "See Calls in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.salesDocuments", label: "Accounts › Sales Documents", description: "See Sales Documents in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.items", label: "Accounts › Items & Inventory", description: "See Items & Inventory in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.orders", label: "Accounts › Orders", description: "See Orders in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.renewals", label: "Orders & Renewals", description: "See Renewals in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.purchaseDocuments", label: "Accounts › Purchase Documents", description: "See Purchase Documents in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.payments", label: "Accounts › Payments", description: "See Payments in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.receivables", label: "Accounts › Receivables", description: "See Receivables in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.payables", label: "Accounts › Payables", description: "See Payables in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.accounting", label: "Accounts › Accounting", description: "See Accounting in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.revenueClose", label: "Accounts › Revenue & Close", description: "See Revenue & Close in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.customerPortal", label: "Support › Customer Portal", description: "See Customer Portal in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.feedback", label: "Support › Customer Feedback", description: "See Customer Feedback in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.helpdesk", label: "Support › Helpdesk / Tickets", description: "See Helpdesk / Tickets in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.inbox", label: "Support › Customer inbox", description: "See Customer inbox in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.projects", label: "Operations › Projects", description: "See Projects in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.visits", label: "Field Visits", description: "See Field Visits in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.expenses", label: "People › Expenses", description: "See Expenses in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.itAssets", label: "IT Assets", description: "See IT Assets in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.contactsLibrary", label: "Sales › Contacts Library", description: "See Contacts Library in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.vendors", label: "Partners › Vendors", description: "See Vendors in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.resellers", label: "Partners › Resellers", description: "See Resellers in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.commissionParties", label: "Partners › Commission Parties", description: "See Commission Parties in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.marketing", label: "Marketing › Marketing Automation", description: "See Marketing Automation in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.forms", label: "Marketing › Forms & Events", description: "See Forms & Events in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.booking", label: "Sales › Booking pages", description: "See Booking pages in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.hr", label: "People › People (HR)", description: "See People (HR) in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.visitors", label: "Front desk › Visitor Management", description: "See Visitor Management in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.engagement", label: "People › Speak Up & Forms", description: "See Speak Up & Forms in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.payroll", label: "People › Payroll", description: "See Payroll in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.notifications", label: "My work › Notifications", description: "See Notifications in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.tasks", label: "My work › Tasks", description: "See Tasks in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.calendar", label: "My work › Calendar", description: "See Calendar in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.desks", label: "My work › Internal help desk", description: "See Help desk in the menu and open its pages — and a desk's own list, for its people. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.notes", label: "My work › Sticky Notes", description: "See Sticky Notes in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.chat", label: "My work › Chat", description: "See Chat in the menu and chat with colleagues. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.cards", label: "Tools › Digital Cards", description: "See Digital Cards in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.signatures", label: "Tools › Email Signatures", description: "See Email Signatures in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.vault", label: "Tools › Credential Vault", description: "See Credential Vault in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.targets", label: "Targets & incentives › Targets", description: "See Targets in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.incentives", label: "Targets & incentives › Incentives", description: "See Incentives in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  { key: "section.reports", label: "Reports", description: "See Reports in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  // Automate had none (owner, 31 Oct 2026 — check:documents-sections): every module is a section a role can be unticked from.
  { key: "section.automate", label: "Automate", description: "See Automate in the menu and open its pages. Untick to hide it from this role.", defaultRoles: [], everyone: true, delegable: false, group: "Sections" },
  // Create, edit, issue, delete, cancel and approve, for each kind of document (src/lib/documents/permission-keys.ts).
  ...DOCUMENT_PERMISSIONS,
] as const satisfies readonly PermissionDefinition[];

/**
 * The literal union of every declared key.
 *
 * Derived from the array rather than written out separately, so the two cannot drift. Threading
 * this type through `can()`, `setRolePermission`, `navPermissions` and `NavItem.permission` is what
 * makes an undeclared key impossible to introduce — through an action, the nav registry or the
 * admin UI alike.
 */
export type PermissionKey = (typeof PERMISSION_REGISTRY)[number]["key"];

/**
 * The same list, widened to the declared type.
 *
 * `as const` above is what makes `PermissionKey` a literal union, but it also narrows every entry
 * to its own exact shape — so an entry that omits `tier` genuinely has no `tier` property and
 * reading one is a type error. Iterate over this when you need the fields; use PERMISSION_REGISTRY
 * only where the literal key types matter.
 */
export const PERMISSIONS: readonly PermissionDefinition[] = PERMISSION_REGISTRY;

const BY_KEY: Map<string, PermissionDefinition> = new Map(PERMISSIONS.map((p) => [p.key, p]));

export function getPermissionDefinition(key: string): PermissionDefinition | undefined {
  return BY_KEY.get(key);
}

/**
 * Whether a role holds this with nothing written for it: every role for a section (`everyone`), the
 * listed built-in roles for the rest. ADMIN is decided by the resolver, not here.
 */
export function heldByDefault(def: PermissionDefinition, role: string): boolean {
  return def.everyone === true || (def.defaultRoles as readonly string[]).includes(role);
}

/** `heldByDefault` by key — false for a key that isn't one. */
export function heldByDefaultKey(key: string, role: string): boolean {
  const def = BY_KEY.get(key);
  return def ? heldByDefault(def, role) : false;
}

/** The section permission of a module (src/lib/modules.ts) — whether a role sees it at all. */
export function sectionPermission(moduleKey: string): string {
  // noun.verb, as every key is: sales_documents → section.salesDocuments.
  return `section.${moduleKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}

export function isPermissionKey(key: string): key is PermissionKey {
  return BY_KEY.has(key);
}

export const PERMISSION_KEYS = PERMISSION_REGISTRY.map((p) => p.key) as PermissionKey[];

/** Section order in the permission screen; anything ungrouped is collected under "Other". */
export const PERMISSION_GROUP_ORDER = [
  "Sections",
  "Sales & customers",
  "Documents",
  "Orders & fulfilment",
  "Finance",
  "Support",
  "Marketing",
  "People & HR",
  "Performance",
  "IT assets",
  "Data import & export",
  "Administration",
  "Other",
] as const;

/**
 * Section by key prefix, so an entry only needs an explicit `group` when the prefix is misleading.
 *
 * A lookup rather than a field on all ~40 entries: the grouping is a property of the namespace, and
 * duplicating it per key is how the two drift apart.
 */
const GROUP_BY_PREFIX: Record<string, string> = {
  products: "Orders & fulfilment",
  orders: "Orders & fulfilment",
  payments: "Finance",
  // Beside View and Record payments, where whoever grants it will look for it.
  collections: "Finance",
  expenses: "Finance",
  contacts: "Sales & customers",
  feedback: "Sales & customers",
  visits: "Sales & customers",
  tickets: "Support",
  tasks: "Support",
  marketing: "Marketing",
  forms: "Marketing",
  forecast: "Sales & customers",
  wins: "Sales & customers",
  access: "Administration",
  hr: "People & HR",
  payroll: "People & HR",
  performance: "Performance",
  targets: "Performance",
  incentives: "Performance",
  assets: "IT assets",
  purchase: "Finance",
  // These five had no prefix entry, so eleven keys — including the credential vault's — were
  // filed under a heading called "Other" on the permission screen.
  vault: "Administration",
  cards: "People & HR",
  signatures: "Marketing",
  visitors: "Support",
  engagement: "People & HR",
  projects: "Orders & fulfilment",
  people: "People & HR",
  activity: "Administration",
  permissions: "Administration",
  users: "Administration",
  settings: "Administration",
  security: "Administration",
  impersonation: "Administration",
  data: "Data import & export",
  catalog: "Orders & fulfilment",
  ledger: "Finance",
  books: "Finance",
  revenue: "Finance",
  close: "Finance",
  workspace: "Sales & customers",
  docs: "Documents",
  certificates: "Sales & customers",
};

export function permissionGroup(def: PermissionDefinition): string {
  if (def.group) return def.group;
  return GROUP_BY_PREFIX[def.key.split(".")[0]!] ?? "Other";
}
