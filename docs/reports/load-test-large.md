# Load test — one large workspace

Run 2026-10-30 08:10 UTC by `npm run load:large` (scripts/load-test-large.ts).

## Setup

- The demo workspace (a year of a 50-person company) copied as 10 divisions, its business records 20 times over in each: **1.65 GB, 37,59,419 rows**.
- Largest tables: journal_lines 4,50,008, task_checklist_items 2,23,400, tasks 1,75,800, journal_entries 1,57,403, marketing_consents 1,52,600, activities 1,46,201, task_time_logs 1,35,000, attendance_days 1,22,940, marketing_messages 1,14,600, user_daily_activity 1,13,440, lead_requirements 1,03,600, trade_document_lines 97,002, contacts 88,600, trade_documents 79,402, notifications 75,159, call_logs 69,600, task_comments 65,600, audit_logs 62,676, project_stakeholders 57,400, workbook_records 53,800, leads 53,800, activity_logs 47,060, project_milestones 45,800, company_locations 44,800, companies 43,000.
- Each case is the function the screen or job calls, as the server calls it, signed in as the person named; run once to warm up, then five times (a write once). **Fastest** is the case's own cost — the machine is shared with other work, so the median wanders — and **Node CPU** is how much of that fastest run the app process spent working rather than waiting on the database.
- The workspace role's 30-second statement limit is on, as in production. One process, 20 CPUs, Node v24.16.0; PostgreSQL on the same machine with its stock settings.
- Fast is under 300 ms, fine under a second, slow under five seconds.

## Results

| Area | Case | As | Fastest ms | Median ms | Node CPU ms | Verdict | Returned |
|---|---|---|---|---|---|---|---|
| Leads | board, first pipeline (the default view) | admin (sees everything) | 303 | 316 | 109 | fine | 450 rows of 53,800 |
| Leads | board, as the sales manager | sales manager | 384 | 444 | 95 | fine | 410 rows of 1,140 |
| Leads | board, as the salesperson | salesperson | 380 | 427 | 235 | fine | 450 rows of 53,800 |
| Leads | board, the next 50 of the fullest column | salesperson | 383 | 417 | 140 | fine | 50 rows of 14,600 |
| Leads | list, first page of 50 | admin (sees everything) | 53 | 57 | 46 | fast | 50 rows of 53,800 |
| Leads | list, as the salesperson | salesperson | 65 | 79 | 32 | fast | 50 rows of 53,800 |
| Leads | a lead's page | salesperson | 243 | 244 | 125 | fast | an object |
| Leads | a lead's record (getLead) | salesperson | 51 | 55 | 46 | fast | an object |
| Leads | a lead's score, worked out again (on every view) | salesperson | 14 | 17 | 0 | fast | an object |
| Leads | a lead's activity panel | salesperson | 60 | 68 | 16 | fast | 11 items |
| Customers | customer list, first page | admin (sees everything) | 98 | 103 | 16 | fast | 50 rows of 5,400 |
| Customers | customer list, as the salesperson | salesperson | 119 | 122 | 48 | fast | 50 rows of 5,400 |
| Customers | companies (prospects), first page | admin (sees everything) | 110 | 130 | 0 | fast | 50 rows of 28,800 |
| Customers | the busiest customer's page | admin (sees everything) | 527 | 538 | 390 | fine | an object |
| Customers | the busiest customer's page, part by part | admin (sees everything) | 512 | 534 | 328 | fine | object |
| Customers | the busiest customer's activity panel | admin (sees everything) | 47 | 51 | 47 | fast | 18 items |
| Customers | assignable people (on most forms) | admin (sees everything) | 5 | 6 | 0 | fast | 500 rows |
| Contacts | contact list, first page | admin (sees everything) | 70 | 87 | 47 | fast | 50 rows of 88,600 |
| Tasks | my tasks, list | salesperson | 164 | 177 | 77 | fast | 50 rows of 720 |
| Tasks | my tasks, board | salesperson | 405 | 411 | 110 | fine | 720 rows |
| Tasks | task counts | salesperson | 30 | 33 | 31 | fast | an object |
| Home | dashboard, overview | admin (sees everything) | 1,824 | 1,974 | 1,374 | slow | 4 rows |
| Home | dashboard, as the salesperson | salesperson | 622 | 638 | 687 | fine | 4 rows |
| Search | the header box, everything | admin (sees everything) | 689 | 726 | 187 | fine | an object |
| Search | the header box, as the salesperson | salesperson | 639 | 667 | 141 | fine | an object |
| Notifications | the bell's poll | salesperson | 120 | 131 | 78 | fast | an object |
| Notifications | the bell, opened | salesperson | 112 | 118 | 32 | fast | 20 rows |
| Calls | call log, first page | admin (sees everything) | 49 | 55 | 16 | fast | 50 rows of 69,600 |
| Calls | today's call summary | admin (sees everything) | 16 | 19 | 15 | fast | an object |
| Activity | the activity log, everyone | admin (sees everything) | 11 | 12 | 0 | fast | 50 rows of 47,061 |
| Activity | the activity log's summary | admin (sees everything) | 11 | 12 | 16 | fast | an object |
| Documents | invoices, first page | accounts | 30 | 33 | 31 | fast | 50 rows of 22,402 |
| Documents | invoices, the summary strip | accounts | 97 | 100 | 140 | fast | 5 rows |
| Documents | invoices, as the salesperson | salesperson | 30 | 33 | 16 | fast | 50 rows of 22,402 |
| Documents | an invoice's page | accounts | 123 | 128 | 63 | fast | an object |
| Receivables | open invoices (the default view) | accounts | 657 | 675 | 499 | fine | 5200 rows |
| Receivables | aging, by customer | accounts | 614 | 657 | 719 | fine | 5800 rows |
| Receivables | aging, as the salesperson | salesperson | 616 | 682 | 797 | fine | 5800 rows |
| Receivables | customer balance summary | accounts | 932 | 1,009 | 1,016 | fine | 7200 rows |
| Receivables | insights: DSO and the next eight weeks | accounts | 562 | 608 | 501 | fine | an object |
| Receivables | the busiest customer's statement | accounts | 38 | 43 | 16 | fast | an object |
| Receivables | an invoice's settlement panel | accounts | 25 | 29 | 16 | fast | an object |
| Collections | the follow-up list | accounts | 1,034 | 1,130 | 985 | slow | an object |
| Payments | orders with payments, first page | accounts | 325 | 369 | 296 | fine | 50 rows of 33,800 |
| Payments | payments, first page | accounts | 152 | 175 | 250 | fast | 50 rows of 25,401 |
| Accounting | journal, first page | accounts | 25 | 29 | 16 | fast | 50 rows of 1,57,403 |
| Accounting | trial balance | accounts | 95 | 104 | 31 | fast | 58 rows |
| Accounting | profit and loss, this financial year | accounts | 82 | 90 | 0 | fast | an object |
| Accounting | balance sheet | accounts | 94 | 103 | 15 | fast | an object |
| Accounting | the busiest account's ledger | accounts | 154 | 162 | 15 | fast | 200 rows of 51,603 |
| Accounting | GSTR-1, last month | admin (sees everything) | 149 | 162 | 187 | fast | an object |
| Accounting | GSTR-3B, last month | admin (sees everything) | 269 | 277 | 266 | fast | an object |
| Accounting | GSTR-1 as the portal's JSON | admin (sees everything) | 155 | 177 | 203 | fast | an object |
| Accounting | GSTR-3B as the portal's JSON | admin (sees everything) | 286 | 305 | 219 | fast | an object |
| Accounting | the filing calendar | admin (sees everything) | 31 | 35 | 16 | fast | 14 rows |
| Items | items list, first page, every HSN checked | admin (sees everything) | 12 | 12 | 15 | fast | 50 items of 54 |
| Vendors | vendor list, first page | admin (sees everything) | 76 | 77 | 15 | fast | 50 rows of 3,400 |
| Finance | income and expense, this year | admin (sees everything) | 154 | 156 | 0 | fast | an object |
| Finance | cash flow | admin (sees everything) | 50 | 53 | 0 | fast | an object |
| Finance | top expenses, this year | admin (sees everything) | 148 | 151 | 15 | fast | 6 rows |
| Finance | receivables outstanding | admin (sees everything) | 176 | 203 | 110 | fast | an object |
| HR | attendance, the month for everyone | admin (sees everything) | 186 | 188 | 62 | fast | 500 rows |
| HR | payroll runs | admin (sees everything) | 10 | 11 | 0 | fast | 13 rows |
| HR | leave, my balances | salesperson | 88 | 93 | 47 | fast | 5 rows |
| HR | leave, everyone's requests | admin (sees everything) | 14 | 16 | 16 | fast | 50 rows of 5,220 |
| Jobs | lead scores gone stale (500) | admin (sees everything) | 2,182 | 2,222 | 1,204 | slow | number |
| Jobs | credit ratings gone stale (500) | admin (sees everything) | 307 | 318 | 46 | fine | number |
| Writes | an invoice made and issued | admin (sees everything) | 431 | 431 | 157 | fine | an object |
| Writes | a payment recorded against an invoice | admin (sees everything) | 113 | 113 | 31 | fast | an object |
| Writes | a lead moved to another stage | salesperson | 62 | 62 | 47 | fast | an object |

## What needs work

- **Jobs › lead scores gone stale (500)** (admin (sees everything)): 2,182 ms.
- **Home › dashboard, overview** (admin (sees everything)): 1,824 ms — chart: payments outstanding 273 ms, chart: finance receivables 245 ms, chart: finance topExpenses 173 ms, KPI cards 168 ms, chart: finance incomeExpense 165 ms, chart: tasks completion 150 ms.
- **Collections › the follow-up list** (accounts): 1,034 ms.

## Found by this test (23 Oct 2026)

- **The leads board fails** once a pipeline holds more leads than one query can name (about 32,000): `leadBoardExtras` and `leadQuotes` put every lead's id in one `IN (…)`, and the board itself loads every lead unpaged. Hit by the admin and by the salesperson, whose role sees every lead in this workspace.
- **The slow cases are the app's own work, not the database's.** Node CPU is about the whole time for every one of them; the database logged only 23 statements over 200 ms in a full run. And the server runs one Node process: while one person's dashboard computes for six seconds, every other request — in every workspace — waits.
- Four habits make that work:
  1. **Everything loaded, one page shown** — payments' order and payment lists read every row to show 50.
  2. **No page at all** — the leads board, an account's ledger (51,604 lines), the receivables views (thousands of customers or invoices) — and the browser then draws them all.
  3. **Adding up in JavaScript** — income and expense, top expenses and the dashboard's finance cards read every income and expense line of the year to total them.
  4. **The dashboard's summary** (`getDashboardSummary`) works out every older card at once, whichever chart asks first.
- Paged lists, the accounting reports (trial balance, P&L, balance sheet, GST returns), attendance, payroll, leave and the writes are all well under half a second.

## Fixed the same day

Each rewrite was compared with the code it replaced on this workspace and gives the same answers.

- **Leads board** — each column's first 50 cards with its whole count, and "Show more" (`listLeadBoard`, `listLeadBoardColumn`): from failing to under 0.6 s.
- **Dashboard** — the summary works out only the parts a chart asks for, once a page; the finance figures are added up by the database.
- **Adding up** — income and expense, top expenses and cash flow by the database, a month at a time; the receivables subledger (aging, balance summary, the close's tie-out) by grouped queries; support load's peers by one query, not every customer's credit history. The aging summary no longer sends every open invoice behind it.
- **Paging** — the payments lists page in the database (with a tie-breaker, so a page always holds the same rows); an account's ledger is 200 lines a page with the balance brought forward.
- **A customer's page** — the statement, the payments list and the visits are read when their tab is opened.
- **Lists of ids that grow with the workspace** go in batches (src/lib/batches.ts) — the collections follow-ups, an account's parties.
- **One process** — `DESKZO_WEB_PROCESSES` runs several copies of the app in the container, keeping what they hold in memory in step (docs/runbook.md §7.1, `npm run check:cluster`).

## Not covered

- Page rendering and the browser: these are the server's data calls only.
- Many people at once: each case runs alone (scripts/load-test.ts measures throughput).
- React's request cache is stood in for, one per run of a case, as a page has one.

## Run again, 30 Oct 2026

The same test a week on, with the screens built since (the GST portal files, the filing calendar, the items list's HSN
check, the vendor list) added. Nothing fails. Three things had grown slow, and were fixed the same day:

- **Turning moments into days** (`src/lib/time/zone.ts`): every date bucketed on a workspace's clock went through
  `Intl.DateTimeFormat.formatToParts`, and the dashboard's sparklines did it once per task and lead in the period.
  The zone's offset is now asked once per UTC day (a quarter-hour at a time only on a day the zone changes its
  clocks): about 25 times faster, the answers identical (`npm run check:zone-fast` — every minute around the clock
  changes of eleven zones, and 220,000 moments from 1970 to 2040). The salesperson's dashboard went from 1.9 s to 0.6 s.
- **The dashboard's finance figures**: each finance chart asks for its own figure (`finance.incomeExpense`…) instead
  of all five being worked out for any one of them; outstanding payments sum each order's allocations in the
  database. The admin's dashboard, about fifteen charts timed one after another, from 3.3 s of CPU to 1.4 s.
- **Sorting by name** (`src/lib/receivables/aging.ts`, `balance-summary.ts`, `src/lib/platform/linked/groups.ts`):
  `localeCompare(…, "en", { sensitivity: "base" })` builds a collator on every call; one `Intl.Collator` per file, the
  same order. Aging by customer from 1.5 s to 0.6 s, the balance summary from 1.1 s to 0.9 s.

The payments snapshot rewrite was compared with the old code on this workspace as the admin, the sales manager and the
salesperson: the same answers.
