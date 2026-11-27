# Deskzo feature inventory (state as of 26 Oct 2026)

Sources are files in the repo at `C:\Users\Sachin\Documents\deskzo` (paths relative to it), git commits on `main` (hash and date), and the owner's memory notes at `C:\Users\Sachin\.claude\projects\C--Users-Sachin-Documents-deskzo\memory\` (cited as `memory/<file>.md`). Everything was read, not run: no app, suite or migration was executed. "Built" means the code is on `main`. "Verified" here means only that a `check:*` suite exists. Most outside integrations have only met stand-ins or fakes; that is flagged wherever it applies.

Scale: `prisma/schema.prisma` has 17,067 lines and 358 models. `package.json` has about 230 `check:*` suites. There are 350 commits, from 2026-09-09 to 2026-10-26.

## 1. What modules and products exist?

### Takeaway
Deskzo is sold Zoho-style. There are 14 products (Deskzo One plus 13 standalone apps) and 5 add-ons, built on about 60 modules. One workspace holds any mix of products. Books and People are sold in India only. Companies & Contacts, tasks, notes, chat, saved lists, notifications and Automate come with every product.

### Cited Findings
- **Products and the modules each switches on** — [src/lib/products.ts](src/lib/products.ts)
  - **Deskzo One:** every module.
  - **CRM:** companies, leads, contacts_library, calls, visits, domains, targets, incentives, wins, tasks, notes, resellers, commission_parties, forms, booking.
  - **Pipeline:** a Bigin-like CRM. Companies, leads, contacts_library, calls, forms, booking.
  - **Books** (IN only): items, sales_documents, purchase_documents, payments, receivables, payables, accounting, expenses, vendors.
  - **People** (IN only): hr, payroll, visitors, engagement.
  - **Desk:** helpdesk, customer_portal, feedback.
  - **Inventory:** items, orders, purchase_documents, vendors, it_assets.
  - **Subscriptions:** items, orders, renewals.
  - **Projects:** projects, tasks.
  - **Campaigns:** marketing, forms.
  - **Analytics:** reports, forecast.
  - **Vault:** vault.
  - **Cards:** cards.
  - **Signatures:** signatures.
- **Base modules in every product:** notifications, tasks, notes, chat, workspace (saved lists) and automate. Companies & Contacts is core in every workspace. — [src/lib/products.ts](src/lib/products.ts)
- **Add-ons** — [src/lib/products.ts](src/lib/products.ts)
  - Revenue & Close: Ind AS 115 revenue recognition and the month-end close. Bought with Books; included in One.
  - AI Plus: more AI credits.
  - More people: extra seats.
  - Automate Plus.
  - Customer inbox: website chat with a bot, and WhatsApp. Included in One.
- **Modules registered in [src/lib/modules.ts](src/lib/modules.ts) (785 lines):** leads, companies, items, orders, sales_documents, purchase_documents, renewals, payments, receivables, payables, accounting, revenue_close, workspace, domains (Domain Intel), calls, targets, incentives, it_assets, hr, visitors, engagement (Speak Up & Forms), payroll, contacts_library, vendors, resellers, commission_parties, visits, expenses, automate, notifications (with Approvals), tasks, calendar, notes, chat, marketing, wins, forecast, booking, forms, customer_portal, feedback, projects, vault, cards, signatures, helpdesk, inbox and reports.
- **Dashboard route folders** — `src/app/(dashboard)/`: accounting, activity, approvals, assets, automate, booking-pages, calendar, calls, cards, chat, collections, commission-parties, companies, contacts, customer-portal, customer-requests, customers, dashboard, documents, domains, expenses, feedback, forecast, inbox, incentives, items, leads, logistics, mail-log, marketing, notes, notifications, orders, payables, payments, people, performance, profile, projects, purchase, receivables, renewals, reports, resellers, sales, search, settings (about 60 screens), signatures, speak-up, surveys, targets, tasks, tickets, vault, verifications, visitors, visits, wins, workspace.
- **Other surfaces** — `src/app/`
  - Public pages: book, c (cards), forms, join, kiosk, portal, preferences, review.
  - `/tv`, print routes, and the API.
  - The platform console, CMS, partner programme and public site (deskzo.com).
- **Products are the owner's 2026-10-01 decision.** A workspace holds at most one plan per product, and Deskzo One comes alone. Leads became their own module on 2026-10-14; they are sold only in Pipeline, CRM and One. — [memory/deskzo-product-line.md](memory/deskzo-product-line.md)

### Inferences
- Deskzo One covers about the same ground as Zoho One: CRM, Books, People, Desk, Inventory, Subscriptions, Projects, Campaigns, Analytics, Vault. It adds niche Indian SMB and IT-reseller modules most suites lack: order punching with vendor POs, backend OEM rebates, reseller and commission parties, Domain Intel, IT assets with consignments, visitor management, TV wins boards.

### Gaps
- No per-module list of which pages are behind release flags beyond what is noted below. The notes are inferred from code and memory, not from a running workspace.

## 2. What is actually built in each module, and what is planned, parked or hidden?

### Takeaway
A very wide surface was built in roughly seven weeks (late Sep to late Oct 2026). Nearly every outside integration has only run against stand-ins: Stripe, Razorpay, Cashfree, NIC e-invoice and e-way, Bedrock AI, Google, Microsoft and Zoho calendar and signatures, WhatsApp Cloud. Several big items are plans only: the Tally export, agentic AI, Deskzo Docs/PDF, Instagram and Facebook, Busy and Tally import, and Form 138/24Q.

### Cited Findings

**CRM, leads and Pipeline**
- **Leads:**
  - a coloured board, paged at 50 cards per column (after a load test failed above about 32k leads);
  - field masking with daily unmask limits and unmasking logs;
  - a stage-change note;
  - lead quotation tracking (a Quotation column, filter and board chip, an opt-in stage rule);
  - custom fields in filters, columns, reports, the API and forms;
  - the workspace's own wording.
  — commits 93f9657c, c450fffb, e2bd2494, 6d6efb25, 3010f4a8, c65a30bd
- **Deskzo Pipeline** (2026-10-14, f708cead) — [memory/bigin-like-product-decisions.md](memory/bigin-like-product-decisions.md)
  - several pipelines per workspace, including non-sales "process" pipelines;
  - connected pipelines: a won lead carries on into the next pipeline;
  - stage rules for required fields;
  - automations: assign, and email from the owner's mailbox;
  - booking pages with slot locking; a booking becomes a lead plus a meeting.
- **Also in CRM:**
  - lead capture over the web API (Basic auth) with a Postman collection;
  - lead assignment rules;
  - industry templates: system integrators, real estate, IT services, manufacturing, software resellers;
  - imports from Zoho, HubSpot, Salesforce and Pipedrive exports;
  - leads and deals imported by stage name.
  — commits d3289097, 7e4e62fb, e5ec146b, 6a1c9b4c; [memory/industry-templates-decisions.md](memory/industry-templates-decisions.md)
- **Activity feed** on every lead, customer and vendor, plus a Work activity per person (4b5d7c13).
- **One company, two roles:** a vendor that also buys from us, or a customer we also buy from (f8f439cf).
- **Contacts** can be marked as having left the company.
- **Contact checks:** email and domain verification.
- **Duplicate merge** for companies.
- **Domain Intel:** reads public DNS and the homepage only. It is not an enrichment service. — [docs/ROADMAP.md](docs/ROADMAP.md) "Known gaps"
- **Field visits:** plan a visit, check in and out, write up the outcome, claim travel against it. Phone GPS is captured at check-in and check-out only. — [src/lib/modules.ts](src/lib/modules.ts); 89afabc2
- **Targets, incentives and wins**
  - Targets cover sales value, collections, calls, visits and tickets.
  - Incentive schemes have slabs and are paid through payroll.
  - Wins get a confetti splash and a leaderboard.
  - Wins also show on TV screens: paired by a 6-digit code, with no seat and no sign-in.
  — [src/lib/modules.ts](src/lib/modules.ts); [memory/tv-screens-decisions.md](memory/tv-screens-decisions.md)
- **Forecast** — [src/lib/modules.ts](src/lib/modules.ts)
  - deals weighted by each stage's actual win rate;
  - renewals by each brand's renewal rate;
  - cash expected from each customer's payment habits;
  - warranties ending with no AMC;
  - each salesperson's commit.
- **Orders, the IT-reseller flow** — commits ee17af25, 6cfaa42f, 75ecccb9, 1e9ef794, fa274de6
  - Order punching: sales punches, accounts approves payment terms, purchasing sources the vendor.
  - Order steps, purchase savings, in-hand orders at a distributor price.
  - Backend OEM rebates: deal registrations, negative calls, vendor credits.
  - A one-click vendor PO from an order.
  - Tax invoices raised from orders, grouped by PO.
- **Resellers and commission parties** have their own modules.

**Calling and the phone app**
- **Calls module:** a dial icon on every record, call timing and outcome, a callbacks worklist. Calls › Team report shows first and last call and speed to lead (50e915d5). — [src/lib/modules.ts](src/lib/modules.ts)
- **Calls are logged, not placed.** There is no telephony provider (no Exotel or Knowlarity) and no recordings. Recordings were planned for "phase 3". — [docs/ROADMAP.md](docs/ROADMAP.md); [memory/kylas-style-calling-proposal.md](memory/kylas-style-calling-proposal.md)
- **Android app** (Expo / React Native plus a Kotlin module) — [memory/kylas-style-calling-proposal.md](memory/kylas-style-calling-proposal.md); [memory/native-android-app-decisions.md](memory/native-android-app-decisions.md); [memory/deskzo-phone-app.md](memory/deskzo-phone-app.md)
  - Kylas-style calling: the call log syncs, caller ID, an after-call card, "Ring my phone".
  - Native screens: Today, tasks, approvals, leave, team chat, leads, companies, contacts, search, visits, expenses with receipt photos, meetings.
  - Every other module opens in a WebView fallback, signed in as the phone.
  - Over-the-air updates, self-hosted (21182a01).
  - Current version 0.4.1 (versionCode 7).
  - **Hidden** until `DESKZO_APP_ANDROID_URL` is set.
  - **Push notifications** are built on both server and app, but wait on the owner's Firebase project.
  - **Not on Google Play yet:** the listing and data-safety form are drafted; Play screenshots are still to do.
- **iPhone:** a home-screen web app (PWA), one per workspace, full screen (2d6259be). — [memory/iphone-pwa-decisions.md](memory/iphone-pwa-decisions.md)
  - **Never tried on a real iPhone.**
  - No call sync and no screenshot blocking are possible on iOS.
  - Web push (VAPID) is not built.
  - A native iOS app needs Apple Developer and Expo accounts.

**Books and accounting**
- **Sales documents:** proposals, proformas, GST tax invoices, credit notes, debit notes, delivery challans, e-way bills. Place-of-supply tax handling. A4 print. Cancel reasons. — [src/lib/modules.ts](src/lib/modules.ts)
- **Purchase documents:** purchase orders, vendor bills, and vendor-statement reconciliation from a PDF (the table is rebuilt from word positions; scanned PDFs are refused). — `src/app/(dashboard)/purchase/reconciliation`; ed1d400c
- **Ledger** — [src/lib/modules.ts](src/lib/modules.ts) navItems
  - chart of accounts; vouchers (payment, receipt, contra, journal); journal;
  - trial balance, P&L, balance sheet, cash flow, day book, registers, cash and bank books;
  - fixed assets with depreciation;
  - period lock and year-end "Close the Books";
  - a Company filter on an account's ledger;
  - foreign-currency postings with FX gain or loss.
- **Banking:** bank accounts and bank reconciliation. A `BankStatementLine` model exists. — `src/app/(dashboard)/accounting/banking/page.tsx`; [src/lib/ledger/reconcile.ts](src/lib/ledger/reconcile.ts)
- **Receivables:** — f6e79c96; [memory/payment-recovery-decisions.md](memory/payment-recovery-decisions.md); 0a2ec122; 8993a1ba
  - aging as of any date;
  - customer and vendor balance summaries;
  - statements;
  - customer credit and a credit hold;
  - "My collections" with promise-to-pay tracking;
  - payment recovery: pay-now links on Razorpay and Cashfree (the business's own gateway), reminder schedules, a portal Pay button, MSME interest under s.16 at 3x the RBI rate, DSO and forecast;
  - gateways have **only met fakes**.
- **Inventory engine** (merged 2026-10-21, PR #10) — `prisma/schema.prisma`; da6259be
  - warehouses, units, goods receipts (GRN), stock vouchers, stock reports;
  - batches (`ItemBatch`), serials (`ItemSerial`) and cost layers (`StockCostLayer`);
  - negative stock revalued;
  - HSN/SAC from the GST portal's directory;
  - item categories;
  - "manage as a subscription".
- **Revenue & Close add-on** (2aeb5f0f, 2026-09-29) — [memory/revenue-and-close-add-on.md](memory/revenue-and-close-add-on.md)
  - Ind AS 115 revenue schedules, spread by day;
  - revenue waterfall;
  - prepaids and accruals schedules;
  - a self-checking month-end close checklist.
  - MRR/ARR, AI agents and multi-entity FX revaluation were **left for later**.
- **Opening balances:** imported from a trial balance file. Open invoices, bills and credit notes can be imported. — 13125b82, 37411ff1
- **Mid-year switch from Zoho Books** — [memory/mid-year-switch-plan.md](memory/mid-year-switch-plan.md)
  - Phase 1 (sales, 50db8fd0) and phase 2 (purchases, 09a3a04b) are built.
  - Zoho column names are **guesses until a real Zoho export is tried**.
  - Busy and Tally imports are **parked**.
- **Tally export:** a plan document only, with 9 decisions pending and **nothing built**. Sync with Zoho Books or Busy was **dropped** by the owner. — [memory/tally-export-plan.md](memory/tally-export-plan.md); [memory/no-external-accounting-sync.md](memory/no-external-accounting-sync.md)
- **Shortcut keys** copied from BUSY are used throughout (21cdaaa8).

**HRMS and payroll (Deskzo People)**
- **HR basics:** employee records, self-service ("My HR"), hiring (a `Candidate` model, `/people/hiring`), holidays, leave with accrual, carry-forward and encashment, attendance with regularisation and exceptions, letters with templates and signatures, a file manager, celebrations and wishes, and an exit handover of accounts, leads, tickets and quotes. — [src/lib/modules.ts](src/lib/modules.ts); [docs/hrms-roadmap.md](docs/hrms-roadmap.md) §2
- **Attendance** — ee81f92e, 0264b079, a0287c49, 33b6881b; [docs/hrms-roadmap.md](docs/hrms-roadmap.md) §4
  - GPS clock-in only at the office, with approved exceptions.
  - Biometric push from eSSL/ZKTeco terminals over /iclock with no connector PC, plus a `.dat` import.
  - Office hours, with Late and Left-early marks.
  - Everyone sees their own in and out, by week or month.
- **Short leave:** by the hour, up to 2 h, 2 a month, approved by the manager (6c35edf4). — [memory/short-leave-decisions.md](memory/short-leave-decisions.md)
- **Payroll** — 1dd12ebe, 391143d8, 2bb6b6fe, 98c36f97; [memory/payroll-exit-and-carry-forward-decisions.md](memory/payroll-exit-and-carry-forward-decisions.md)
  - salary structures with a CTC auto-split and custom components;
  - revisions by % or amount, and mid-month revisions split by days;
  - pro-rating for joiners and leavers;
  - full and final settlement: gratuity, encashment, notice recovery;
  - incentives from the CRM paid on the payslip;
  - payroll posted to the ledger.
- **Payroll import from another HRMS** (Kredily, Keka, greytHR headings): salaries, bank and statutory numbers, year-to-date pay (5e29fdec). — [memory/hrms-migration-import-decisions.md](memory/hrms-migration-import-decisions.md)
- **Expense claims:** HR approves, then Accounts pays them back. A receipt is required above a set amount. — 83b6a47b, 89afabc2
- **Visitors:** a reception kiosk tablet with a photo and host alert, plus expected visitors. — [src/lib/modules.ts](src/lib/modules.ts)
- **Engagement:** anonymous Speak Up, and forms and polls with results hidden below 5 answers. — [src/lib/modules.ts](src/lib/modules.ts)
- **Not built** (code search found nothing; roadmap marks them "not built") — [docs/hrms-roadmap.md](docs/hrms-roadmap.md) §6
  - PF ECR file and ESI contribution file;
  - LWF;
  - bank salary-transfer files;
  - loans and advances;
  - comp-off and overtime rules;
  - performance reviews and OKRs;
  - a careers page;
  - multi-level approval chains;
  - a compliance calendar;
  - Form 130 (was Form 16);
  - Form 138 (was 24Q).
  - The TDS card says plainly: Form 138 "isn't made here yet" ([src/components/accounting/tds-statement-card.tsx](src/components/accounting/tds-statement-card.tsx)).
  - There is no employee self-declaration screen for tax; payroll enters declarations on the person's record. — [memory/tds-on-salary-decisions.md](memory/tds-on-salary-decisions.md)

**Cards and email signatures** — [memory/cards-and-signatures-decisions.md](memory/cards-and-signatures-decisions.md); commits 11336312 to ba3ca419, 2026-10-11
- **Cards:** Blinq-style digital business cards at `/c/<name>` with a QR code and "Save contact". Share-backs become leads. Card events: booth forms, scanning visitors' cards, leads counted against the event.
- **Signatures:**
  - templates and rules by person, department, branch and role;
  - sync to Gmail (domain-wide delegation) and Zoho Mail;
  - an Outlook add-in for Microsoft 365, with reply styles and shared mailboxes;
  - banners (8 sample GIFs) and click counting;
  - a free public signature generator on deskzo.com.
- **Parked:** a banner maker, real-service verification against Google, Zoho and Outlook, Outlook Entra SSO, directory fill, an iPhone QR library, wallet passes. **Never tried on the real services.**

**Helpdesk and Customer inbox**
- **Helpdesk tickets:** priority, SLA target, assignment, comments, a support inbox, a support-load view. — [src/lib/modules.ts](src/lib/modules.ts)
- **Tickets by email** at `<slug>@tickets.deskzo.com` through Cloudflare Email Routing (one rule per workspace); unknown senders are filed by their email domain. — [memory/support-email-decisions.md](memory/support-email-decisions.md)
  - Replies go from Deskzo's mail or the company's SMTP.
  - Not built: sending as the company's domain with DKIM, and connecting a customer's own M365 or Google mailbox.
- **Word filter** for chat and tickets, with a Hindi/Hinglish preset (d0892cc5).
- **Customer inbox add-on** (2026-10-24/25: c1a16e11, 05039a92, f5e20ea4, 6175b0d2, 43b31104) — [memory/customer-inbox-decisions.md](memory/customer-inbox-decisions.md)
  - a website chat bubble with a bot of set answers, and optional AI answers through the AI gateway;
  - WhatsApp Cloud API on a shared number and on reps' own;
  - office hours with an away message, round-robin assignment;
  - a visitor panel: location, new or returning, sneak peek at what they type;
  - response-time reports;
  - team tools: notes, saved replies, tags, CSAT, files, blocking;
  - Create lead and Turn into ticket.
  - Instagram and Facebook are **parked**. Staff can't send files yet.
- **Customer portal:** magic-link sign-in; shows what the customer has, expiries, balance with a Pay button, open tickets, and requests. — [src/lib/modules.ts](src/lib/modules.ts)
- **Customer feedback:** one-time links, with an option to offer the public review page. — [src/lib/modules.ts](src/lib/modules.ts)

**Automate** — [memory/deskzo-automate-proposal.md](memory/deskzo-automate-proposal.md); commits 6dd40159 to b531c4e0; [src/lib/automate/limits.ts](src/lib/automate/limits.ts); [src/lib/automate/triggers.ts](src/lib/automate/triggers.ts)
- **The engine:** phases 1 to 8 were all built in 2026-10-17/18. A vertical step-list builder (not a canvas), templates and test runs.
- **Triggers (about 24):** lead created, stage changed, won, lost, quiet; invoice due soon, overdue, paid; order created, approved, fulfilled; ticket created and status change; booking made; form submitted; payment received; person joined; renewal due; conversation started and needs a person; task created and completed; document issued.
- **Actions:** the folder `src/lib/automate/actions` holds create, move, assign and note a lead; create a task; create and update a ticket; send an email; send a document; email a report; schedule a meeting; notify a person; read a record; call an outside API.
- **Flow control and connectors:** approvals, wait for an event, for-each and parallel paths; webhooks in and out; Slack, Teams, WhatsApp and Google Sheets; AI drafting.
- **Plan limits** (active workflows / steps a month / days of run history / connectors):

  | Plan | Workflows | Steps a month | History | Connectors |
  |---|---|---|---|---|
  | Edition | 20 | 1,000 | 30 days | 1 |
  | Deskzo One | 100 | 3,000 | 90 days | 2 |
  | Automate Plus | 100 | 50,000 | 365 days | 3 |
  | Trial | 5 | 1,000 | 7 days | 0 |

- No Zapier app exists yet.

**Team chat, tasks, calendar, notes**
- **Team chat** (368ad259; 2e2204e9): — [memory/team-chat-proposal-deferred.md](memory/team-chat-proposal-deferred.md)
  - WhatsApp-style 1:1 and group chat, kept inside the workspace;
  - read ticks, reactions, pins, retention settings;
  - a super admin can export one chat, with an audit record;
  - also in the phone app.
  - Live updates use a single-process SSE bus, later spread across processes by a cluster hub.
  - Not built: voice notes, calls.
- **Tasks** (bd59144d, a40fcc2e): — [memory/advanced-tasks-decisions.md](memory/advanced-tasks-decisions.md)
  - status, priority, estimate; list or board; stars;
  - checklist, comments, files, time logged;
  - XP tied to Performance, built so it can't be gamed;
  - repeats; reminders.
- **Calendar:** — [memory/calendar-integrations-decisions.md](memory/calendar-integrations-decisions.md); [memory/native-calendar-decisions.md](memory/native-calendar-decisions.md)
  - two-way sync with each person's own Outlook, Google or Zoho calendar (102716da), **never tried against the real providers**;
  - Deskzo's own calendar with emailed invitations and a busy-only subscribe feed (92983080);
  - not built for the native calendar: repeats, RSVPs read back, meeting links.
- **Sticky notes** and **saved lists**.

**Marketing (Campaigns)**
- Campaigns, journeys, templates, audiences, mailing lists, a suppression list, mass mail. Every send is checked for consent. — [src/lib/modules.ts](src/lib/modules.ts)
- Email goes through Resend, SES or SMTP; WhatsApp templates through the Meta Cloud API. — [src/lib/marketing/providers/email.ts](src/lib/marketing/providers/email.ts); [memory/whatsapp-crm-sync-parked.md](memory/whatsapp-crm-sync-parked.md)
- Forms and events: RSVPs and an attendance register.

**Projects, Vault, IT assets, Reports**
- **Projects:** milestones, billing milestones, risks, weekly updates, stakeholders, documents, encrypted credentials (Project* models). — `prisma/schema.prisma`; [src/lib/modules.ts](src/lib/modules.ts)
- **Vault:** company logins encrypted at rest; shares, pins, every reveal logged. — `prisma/schema.prisma`; [src/lib/modules.ts](src/lib/modules.ts)
- **IT assets:** custody, warranty and AMC; consignments that raise challans and e-way bills. — [src/lib/modules.ts](src/lib/modules.ts)
- **Reports and dashboard:** — commits e7ce1d62 to fc63a3e3; 6c7979f0
  - Reporting S1 to S5 (2026-10-23): saved reports, a Report Builder, library, templates, sharing that respects each viewer's role, and an explorer;
  - a redesigned dashboard with KPIs and a widget builder.

**Public API, AI, help**
- **Public API v1** (9814de56) — [memory/public-api-build-progress.md](memory/public-api-build-progress.md)
  - a key acts as the person who made it;
  - covers leads, companies, work and sales;
  - OpenAPI and Postman at deskzo.com/developers;
  - 120 requests a minute; idempotency keys.
  - **Not built:** a users endpoint, delete endpoints, custom-field filters.
- **Deskzo AI** on credits (358e3597) — [memory/ai-gateway-and-credits-decisions.md](memory/ai-gateway-and-credits-decisions.md); [memory/copilot-data-safety-and-private-ai.md](memory/copilot-data-safety-and-private-ai.md)
  - one platform gateway; Claude on AWS Bedrock, India region only;
  - a credits ledger; workspaces' own AI keys were removed;
  - the Copilot reads data and proposes tasks and notes.
  - **Never run against real Bedrock.**
- **Agentic Deskzo** (MCP, agents, private AI): **plan only**, deliberately not started. — [memory/agentic-deskzo-plan.md](memory/agentic-deskzo-plan.md)
- **Help Center:** 47 module guides at deskzo.com/help, opened from the in-app Help panel. Live publishing needs a manual seed. — [memory/help-center-decisions.md](memory/help-center-decisions.md)
- **Deskzo Docs/PDF:** proposal only; nothing built. — [memory/deskzo-pdf-proposal.md](memory/deskzo-pdf-proposal.md)

**Platform, security, backups**
- **Tenancy and console:** — git log, commits 2026-09-25/26
  - multi-tenant with a database per workspace;
  - a platform console with staff 2FA and support access;
  - provisioning, plans and entitlements, seats;
  - a CMS website with SEO/AEO/GEO tools, and a partner programme.
- **Security and access:** — [memory/dlp-is-deterrent-not-boundary.md](memory/dlp-is-deterrent-not-boundary.md); [memory/workplace-sign-in-and-mail-decisions.md](memory/workplace-sign-in-and-mail-decisions.md); [memory/security-review-2026-10-23.md](memory/security-review-2026-10-23.md)
  - RBAC with record and field access; view-as;
  - sign-in through Microsoft 365, Google Workspace or Zoho using each workspace's own app, with sign-in rules per person or role;
  - device and IP rules;
  - DLP: enforced controls are the export cap, bulk-read limits and crawler blocking; deterrent controls are copy blocking, the watermark and screenshot alerts;
  - a loophole review fixed on 2026-10-23 (1b42f48f).
- **Backups:** encrypted at rest; a safety copy before every restore; workspace reset with a 24 h wait; off-site backups to Azure Blob or S3 with weekly restore drills; CERT-In logs kept 1 year; SNTP clock check (8ea0106d). **Production needs a store configured.** — [memory/workspace-reset-decisions.md](memory/workspace-reset-decisions.md); [memory/offsite-backups-and-cert-in-logs.md](memory/offsite-backups-and-cert-in-logs.md)
- **Custom domains** through Cloudflare for SaaS, with automatic HTTPS (67b778c0). Several web processes (`DESKZO_WEB_PROCESSES`). Load-tested at 3.8M rows; the slow paths were fixed (6d6efb25). — [memory/large-workspace-load-test.md](memory/large-workspace-load-test.md)

### Inferences
- The breadth is close to a whole suite, but maturity is uneven. It is a single-founder codebase about 7 weeks old. There is no evidence in these sources of production customers. Integrations are almost all unverified against live services, so competitor comparisons should treat many items as "built, not field-proven".

### Gaps
- No usage or customer data was found, so I could not tell which modules are live for paying customers.
- Inventory depth was not read in code: manufacturing, BOM and multi-warehouse transfers beyond stock vouchers. No `Bom` model exists, which suggests no manufacturing BOM.
- Helpdesk SLA depth (escalations, business hours) was not examined.

## 3. What India-specific compliance features exist?

### Takeaway
India compliance is the deepest area. It covers:
- GST invoicing with place of supply, HSN/SAC, several GSTINs per workspace;
- GSTR-1 and GSTR-3B summaries;
- e-invoice (IRN) and e-way bills straight to NIC, with the proper encryption;
- live GSTIN checks;
- vendor TDS with challans and the Form 140 file;
- salary TDS under the Income-tax Act 2025;
- PF, ESI and professional tax for about 17 states;
- MSME interest;
- DPDP privacy requests and CERT-In logs.

Most of the government-API paths have **never hit the real portals**, and several statutory outputs are missing: ECR, ESI file, Form 130/138, GSTR-2B reconciliation, GSTR-9, a GSTN JSON file, LWF and TCS returns.

### Cited Findings
- **GST registrations and returns**
  - Branches and several GST registrations in one workspace (b5c740c2).
  - GSTR-1 (B2B, B2C, SEZ and deemed exports, HSN summary by code, unit and rate) and GSTR-3B summaries per registration. — [src/actions/tax-reports.ts](src/actions/tax-reports.ts) (`gstr1`, `gstr3b`); 0290b34a
  - No GSTN JSON export, GSTR-2A/2B reconciliation or GSTR-9 was found in a code search ("GSTR-2B" and "GSTR-9" have 0 hits).
- **E-invoice:** the providers are Mock, NIC sandbox and NIC production. There is no GSP or ASP option. — [src/lib/einvoice/options.ts](src/lib/einvoice/options.ts)
  - The encryption (RSA sign-in, AES-256 session key) was added 2026-10-25. **Before that the NIC path could never have worked, and it is still untried on the real sandbox.**
  - It signs in again for every action, which may hit NIC's limits.
  — [memory/nic-einvoice-encryption.md](memory/nic-einvoice-encryption.md)
- **E-way bills:** generate, update vehicle, cancel, read. Rewritten to NIC's v1.03 scheme; **untried on the real sandbox**. — [memory/nic-einvoice-encryption.md](memory/nic-einvoice-encryption.md); `src/lib/eway/`
- **GSTIN checks** (2133eb79): — [memory/gstin-checks-decisions.md](memory/gstin-checks-decisions.md)
  - offline checks: check character, state code, PAN;
  - a live "Check with GST" through the e-invoice API, which fills in name and address.
  - Not built: a monthly re-check of vendors, and a warning on documents for a cancelled GSTIN.
- **HSN/SAC** from the GST portal's directory, required in India (d5f652f1).
- **Vendor TDS**, under the Income-tax Act 2025 (from 1 Apr 2026) — [memory/tds-decisions.md](memory/tds-decisions.md)
  - Phase 1 (f74f8572): s.393 sections; no-PAN rate of 20% (5% for goods); lower-deduction certificates; rate advice; the year's shortfalls.
  - Phase 2 (f484d84e): challans by section and major head (0020 company / 0021 others), linked to the deductions they paid, posted with interest and fees.
  - Phase 3 (db7c23f0): the quarterly Form 140 file (was 26Q), written to the FVU 1.2 layout. **Never run through the real FVU**, and the layout's deductee numbering is an assumption.
- **Salary TDS (s.392):** — [memory/tds-on-salary-decisions.md](memory/tds-on-salary-decisions.md)
  - new and old regimes, rebate with marginal relief, surcharge, cess;
  - monthly TDS at the year's average rate;
  - previous-employer income.
  - Not modelled: employer NPS 80CCD(2), perquisites, Form 39 arrears relief, non-residents.
- **Professional tax:** dated rules per state; about 17 states checked against their Acts on 2026-10-17. — [memory/professional-tax-rules.md](memory/professional-tax-rules.md)
  - West Bengal's new slabs from 1 Oct 2026; Odisha repealed.
  - Left out on purpose: Meghalaya, Manipur, Puducherry, J&K, DNH&DD.
  - The founder says this is a check, not a CA review.
- **PF and ESI:**
  - PF wage ceiling of ₹25,000 from 17 Sep 2026 (177be0f7);
  - ESI coverage decided on the full month's rate;
  - pro-rating for joiners and leavers.
  — [memory/payroll-exit-and-carry-forward-decisions.md](memory/payroll-exit-and-carry-forward-decisions.md)
- **MSME interest** (MSMED Act s.16) shown on statements and the Samadhaan page; a debit note can charge it. — [memory/payment-recovery-decisions.md](memory/payment-recovery-decisions.md)
- **DPDP and GDPR on deskzo.com** (8f3c4e94): — [memory/dpdp-gdpr-site-decisions.md](memory/dpdp-gdpr-site-decisions.md)
  - a privacy-requests inbox with 30-day due dates;
  - a cookie notice that gates the one non-essential cookie (referral);
  - a grievance officer setting.
  - Legal wording stays with counsel.
- **CERT-In:** 180-day minimum and 1-year log retention, and an NTP clock-drift check against NPL/NIC. — [memory/offsite-backups-and-cert-in-logs.md](memory/offsite-backups-and-cert-in-logs.md)
- **Data residency for AI:** Bedrock India region (ap-south-1 / ap-south-2), with zero data retention. — [memory/ai-gateway-and-credits-decisions.md](memory/ai-gateway-and-credits-decisions.md)
- **Deskzo's own billing:** GST tax invoices with 18% on platform charges; NEFT and distributor (offline) payments. The SAC 9983 code and rate are still for the CA to confirm. — [memory/offline-payments-and-tax-invoices.md](memory/offline-payments-and-tax-invoices.md)

### Inferences
- Against Zoho Books, Tally or ClearTax, the visible statutory gaps are on the filing side: a GSTN JSON upload, 2B matching, GSTR-9, Form 138 for salary TDS, Form 130/131 certificates, ECR and ESI returns, LWF, and TCS returns. The computation side is relatively complete.

### Gaps
- Whether the GSTR-1 screen gives a downloadable file for the GST offline tool was not confirmed; only summary views were seen.
- Whether TCS is collected on invoices was not confirmed. "TCS" appears in `src/lib/gst-engine.ts` and `src/lib/ledger/gst-returns.ts`, but its role was not read.

## 4. What are the pricing and plans?

### Takeaway
India launch prices are per person per month, before 18% GST. A year costs ten months. There is no free plan; a free trial allows 25 people. Deskzo One is ₹1,499. Prices live in the console's plan catalogue and are seeded from the price book.

### Cited Findings
- **Product prices,** per person a month / a year — [src/lib/platform/price-book.ts](src/lib/platform/price-book.ts)

  | Product | Month | Year |
  |---|---|---|
  | One | ₹1,499 | ₹14,990 |
  | CRM | ₹799 | ₹7,990 |
  | Desk | ₹599 | ₹5,990 |
  | Campaigns | ₹499 | ₹4,990 |
  | Books | ₹349 | ₹3,490 |
  | Inventory | ₹349 | ₹3,490 |
  | Subscriptions | ₹349 | ₹3,490 |
  | Pipeline | ₹299 | ₹2,990 |
  | Projects | ₹299 | ₹2,990 |
  | Analytics | ₹249 | ₹2,490 |
  | People | ₹99 | ₹990 |
  | Vault | ₹99 | ₹990 |
  | Cards | ₹99 | ₹990 |
  | Signatures | ₹59 | ₹590 |

- **Add-ons,** per workspace a month — [src/lib/platform/price-book.ts](src/lib/platform/price-book.ts)

  | Add-on | Month | Year |
  |---|---|---|
  | Revenue & Close | ₹2,499 | ₹24,990 |
  | AI Plus (750 credits) | ₹499 | ₹4,990 |
  | Automate Plus | ₹999 | ₹9,990 |
  | Customer inbox | ₹899 | ₹8,990 |

- **Competitor anchors** written in the price book's comments: Zoho One ₹1,250 yearly / ₹2,500 monthly; Zoho CRM Standard ₹800; Bigin Express ₹400; greytHR ₹85 an employee; Zoho Books Standard ₹749 an organisation; Zoho Desk ₹420–800; Blinq US$5; Exclaimer US$0.90–1.75. — [src/lib/platform/price-book.ts](src/lib/platform/price-book.ts)
- **AI credits:** ₹1 a credit. Monthly allowance of 100 a person on One, 50 a person on other products, 200 for a trial. Packs: 500 for ₹499, 2,000 for ₹1,799, 10,000 for ₹7,999. — [memory/ai-gateway-and-credits-decisions.md](memory/ai-gateway-and-credits-decisions.md)
- **Trial and seats:** a 25-person trial; no free plan; "More people" is off sale. Known gap: **users aren't tied to a product.** With People for 100 and CRM for 10, all 110 can use CRM. — [memory/pricing-india-decisions.md](memory/pricing-india-decisions.md)
- **Payment collection:** Stripe and Razorpay checkout, plus offline NEFT and distributor payments. **Stripe and Razorpay have only run against fakes.** — [memory/billing-verified-against-fakes-only.md](memory/billing-verified-against-fakes-only.md)

### Inferences
- Deskzo One at ₹1,499 per *user* sits above Zoho One's all-employee price. The individual apps (People ₹99, Books ₹349 per person) undercut per-organisation competitors only at small team sizes. Books per person can cost more than Zoho Books' per-organisation pricing for teams over about 2–4 users.

### Gaps
- USD and other-country prices were not found in the price book. Packs are sold online in India only, per the AI memory note.

## 5. What notable gaps or limitations are visible?

### Takeaway
The main risks are unproven integrations and missing statutory filings. A few product features are also missing that competitors treat as table stakes: telephony and recordings, Instagram/Facebook messaging, a native iOS app, live push notifications, the Tally export, a GSTN filing file and 2B reconciliation, payroll statutory files and Form 138/130, appraisals, and loans.

### Cited Findings
- **Only met fakes or stand-ins:**
  - Stripe and Razorpay ([memory/billing-verified-against-fakes-only.md](memory/billing-verified-against-fakes-only.md));
  - Razorpay and Cashfree pay links ([memory/payment-recovery-decisions.md](memory/payment-recovery-decisions.md));
  - NIC e-invoice and e-way ([memory/nic-einvoice-encryption.md](memory/nic-einvoice-encryption.md));
  - AWS Bedrock ([memory/ai-gateway-and-credits-decisions.md](memory/ai-gateway-and-credits-decisions.md));
  - Outlook, Google and Zoho calendars ([memory/calendar-integrations-decisions.md](memory/calendar-integrations-decisions.md));
  - signature sync to Google, Zoho and Outlook ([memory/cards-and-signatures-decisions.md](memory/cards-and-signatures-decisions.md));
  - the Form 140 FVU file ([memory/tds-decisions.md](memory/tds-decisions.md));
  - the PWA on a real iPhone ([memory/iphone-pwa-decisions.md](memory/iphone-pwa-decisions.md)).
- **Not built:**
  - Form 138 (24Q) for salary TDS — [src/components/accounting/tds-statement-card.tsx](src/components/accounting/tds-statement-card.tsx);
  - PF ECR, ESI files, LWF, bank salary files, loans, performance reviews, a careers page, multi-level approvals, a compliance calendar — [docs/hrms-roadmap.md](docs/hrms-roadmap.md) §6, plus code searches.
- **Telephony:** calls are logged, not placed; no click-to-call provider; no recordings — [docs/ROADMAP.md](docs/ROADMAP.md).
- **Parked or planned:**
  - Tally export (plan only) — [memory/tally-export-plan.md](memory/tally-export-plan.md);
  - Busy and Tally import — [memory/mid-year-switch-plan.md](memory/mid-year-switch-plan.md);
  - Instagram and Facebook in the inbox — [memory/customer-inbox-decisions.md](memory/customer-inbox-decisions.md);
  - agentic AI and MCP — [memory/agentic-deskzo-plan.md](memory/agentic-deskzo-plan.md);
  - Deskzo Docs/PDF — [memory/deskzo-pdf-proposal.md](memory/deskzo-pdf-proposal.md);
  - personal WhatsApp sync (advised against) — [memory/whatsapp-crm-sync-parked.md](memory/whatsapp-crm-sync-parked.md);
  - MRR/ARR and multi-entity FX revaluation — [memory/revenue-and-close-add-on.md](memory/revenue-and-close-add-on.md);
  - native iOS app, and push notifications (wait on Firebase) — [memory/deskzo-phone-app.md](memory/deskzo-phone-app.md).
- **Security, left on purpose:** attendance location and device kind are reported by the client, not attested; DLP browser controls are deterrents only. — [memory/security-review-2026-10-23.md](memory/security-review-2026-10-23.md); [memory/dlp-is-deterrent-not-boundary.md](memory/dlp-is-deterrent-not-boundary.md)
- **Scale:** a single VM on Coolify. Chat and the inbox run on an in-process SSE bus spread by a cluster hub, not Redis. Slow paths were Node CPU, now fixed. — [memory/large-workspace-load-test.md](memory/large-workspace-load-test.md); [memory/team-chat-proposal-deferred.md](memory/team-chat-proposal-deferred.md)
- **Storage:** files are kept on the VM's disk or as data URLs; there is no object storage. — [memory/deskzo-pdf-proposal.md](memory/deskzo-pdf-proposal.md)
- **Packaging:** proposals and proformas belong to Books, not CRM, so a CRM-only buyer has no quotes. The owner declined to split them out. — [memory/no-external-accounting-sync.md](memory/no-external-accounting-sync.md)
- **Visits and expenses:** no route planning or measured mileage; no per-category expense caps or duplicate-receipt detection. — [docs/ROADMAP.md](docs/ROADMAP.md) "Known gaps"
  - **Caveat:** that list is partly stale. For example, it still says there is no e-way bill and no period close, and both are now built.

### Inferences
- In a competitor comparison, Deskzo's distinctive strengths are its shared-record cross-module features:
  - CRM incentives paid on the payslip;
  - orders to vendor PO to invoice to rebates;
  - the exit handover;
  - TV wins boards;
  - India-hosted AI;
  - biometric push with no connector PC;
  - visitor management in the HRMS.

  Its weaknesses are field-proven integrations and statutory filing outputs.

### Gaps
- No real-customer, uptime or support-SLA information was found.
- Whether the docs/ROADMAP.md "Known gaps" items about expense claims not posting, or credit notes exceeding their invoice, are now fixed was not verified in code. The newer expense-claims commit 83b6a47b suggests claims now reach Accounts.
