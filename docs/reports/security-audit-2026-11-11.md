# Security Assessment Report — Deskzo, 11 Nov 2026

## 1. Executive summary

The core of Deskzo held up. No path was found for a user of one workspace to reach another workspace's data, for an Employee or HR head to raise their own role, or for an outsider to read records without a valid token. Payment-link and billing webhooks, the stock engine, document numbering and the ledger's double-entry checks are sound.

The real problems are at the edges and in newer code:

- **Sign-in:** Microsoft/Google sign-in finds the account by email address alone. Someone with "Security settings" rights, or a stolen admin session, can point the workspace at their own Microsoft directory and sign in as the super admin, skipping the password and two-factor code.
- **Money:**
  - An invoice line accepts a discount over 100%, which produces a negative-tax line. I confirmed this in the browser: an invoice was issued with GST reduced by ₹810, with no credit note and no approval.
  - A cancelled credit note still marks invoices paid. Confirmed in the browser: a ₹82,600 invoice still reads "Paid" with ₹0 received.
  - A credit note can be far larger than its invoice (₹11.7 lakh against ₹6,490 was issued) and spent on any other invoice of the customer.
  - An order punched without a price can be priced after approval, skipping the loss and credit checks. Confirmed: ₹1 a seat on an approved order.
  - A payment can be dated any year (1 January 1900 was accepted and posted) unless the books are locked.
  - A vendor bill can be marked Paid by hand with nothing paid.
  - The same vendor bill can be entered twice by changing the letter case of its number. Confirmed: a duplicate ₹12,192 bill was issued.
  - An HR head with payroll rights can set their own salary. Confirmed while viewing as the HR head: a ₹99 lakh CTC was saved on her own record.
- **Attendance:** the biometric terminal endpoint accepts forged punches from anyone who knows a device's serial number, turning absent days into paid present days.
- **Privacy:** the new quick-message dialog shows every contact's email and phone unmasked to roles that should see them masked.
- **Dependencies:** Next.js 16.3.4 is inside the range of a critical advisory (remote code execution in `next/og` image generation, used by three routes). The fix is 16.4.6.

**Verdict:** remediation is recommended before the next release. Upgrading Next.js and fixing the SSO account match should come first.

## 2. Scope and limitations

| Scope item | Result |
|---|---|
| Repository | `C:\Users\Sachin\Documents\deskzo`, branch `main` at `b657b617`, plus uncommitted work of other sessions |
| Languages and frameworks | TypeScript, Next.js 16 (App Router, server actions), Prisma 6 / PostgreSQL, Auth.js v5 beta, Expo phone app (not reviewed) |
| Components reviewed | All server actions (`src/actions`, 334 files), API routes (`src/app/api`, 167), public pages, auth/tenancy/billing libraries, validation schemas, Dockerfile/next.config |
| Method | Eight parallel read-only code reviews by module, one dependency audit, one secret scan, and hands-on browser testing of the highest-risk forms on the local copy (see section 5b) |
| Environment tested | Local dev server (`deskzo.localhost:3000`) on the local database only; the live site was not touched |
| Authorization basis | The owner asked for this audit of their own application |
| Exclusions | Live infrastructure (Cloudflare, Traefik, Coolify settings), the mobile app's own code, CMS/partner portal internals, load or DoS testing |
| Constraints | Most findings were found by reading code. Only the invoice findings were reproduced in the browser. Browser testing of every form was started, not finished |

## 3. Checks performed

| Area | Status | Tool / method | Result summary | Limitation |
|---|---|---|---|---|
| Source review (SAST) | DONE | 8 module reviewers, findings traced to code | 73 findings, below | Not every one of ~2,100 actions was read line by line |
| Dependencies (SCA) | DONE | `npm audit --omit=dev` | 16 advisories: 1 critical, 11 high, 3 moderate, 1 low | Reachability assessed for Next.js only |
| Secrets | DONE | `git grep` for key/token patterns; tracked-file names | None real; matches were test fixtures and format checks; `mobile/certs/certificate.pem` is public | Git history not scanned |
| Authentication | DONE | Code review of sign-in, SSO, 2FA, reset, sessions | 1 high, 3 medium | Microsoft/Zoho claim behaviour not tested live |
| Authorization / IDOR | DONE | Code review per module; phone and API routes compared with web actions | No cross-workspace path and no broad IDOR; several permission-parity gaps | — |
| Field validation | PARTIAL | Cross-cutting sweep plus browser tests of 17 forms (section 5b) | Missing upper bounds on discounts, dates, text, arrays and page sizes | Not every settings page and module form was tested; most of the ~70 settings pages were not opened |
| DAST | NOT RUN | — | — | No scanner run; manual browser testing only |
| Penetration testing | PARTIAL | Manual exploitation in the browser on the local copy, including View as an HR head and a salesperson | 9 findings reproduced (section 5b) | Findings that need an outside sender, a second real browser session or masking switched on were not exploited |
| Configuration | PARTIAL | `next.config.ts`, proxy, Dockerfile | No CSP or HSTS in the repo; Chromium without sandbox | Edge settings unknown |

## 4. Risk summary

| Severity | Count | Key concern |
|---|---:|---|
| Critical | 1 | Next.js advisory (dependency) |
| High | 7 | SSO account takeover; negative-tax invoices; cancelled credit notes; post-approval pricing; forged biometric punches; spoofed helpdesk email; unmasked contacts |
| Medium | 30 | Approval races, view-as self-approval, unbounded inputs, API key lifetime, backup download, 2FA guessing |
| Low | 35 | Hardening, small permission gaps, rate limits |
| Needs validation | 3 | Edge body-size caps; Cloudflare DMARC enforcement; Zoho email verification |

## 5. Findings

Each finding shows how it was established: **Browser** (reproduced on the local copy), **Code** (I read the code myself), or **Review** (traced by a reviewer, not re-checked by me). File paths are under `src/` unless shown otherwise.

### Critical and High

| ID | Finding | Sev. | Conf. | Evidence / location | Impact | Recommended fix | Status |
|---|---|---|---|---|---|---|---|
| SEC-01 | Next.js 16.3.4 in critical advisory range (RCE in `next/og` ImageResponse) | Critical | High | `package.json`; used in `app/api/marketing/countdown`, `app/api/pwa/icon`, `app/api/signatures/outlook/icon` | Possible server compromise through a public image route | Upgrade to `next@16.4.6` or later; rerun build and suites | Code |
| SEC-02 | SSO matches accounts by unverified email; a `security.manage` holder can set their own Entra tenant and sign in as the super admin past password and 2FA | High | High | `lib/workplace/sign-in.ts:68` (lookup by email only); `lib/workplace/sign-in-rules.ts:56` (super admin gets every provider); `actions/security.ts:90-155`; `lib/validation/security.ts:12` (tenant id not a GUID) | Full takeover of the workspace owner; a fresh SSO sign-in then unlocks password/2FA change, restore, reset and the vault | Bind accounts to the provider's subject (`tid`+`oid`/`sub`); validate the tenant id; require `confirmIdentity` to change SSO apps; don't let SSO skip Deskzo 2FA | Code |
| SEC-03 | Percent discount over 100% makes a negative-tax line on an issued invoice | High | High | `lib/validation/trade-document.ts:27` (no max); `lib/gst-engine.ts:196-198` (percent branch uncapped) | Output GST cut on invoices, e-invoices and returns without credit-note rights or approval. Reproduced: INV/2026-27/0270 issued for ₹6,490 with a −₹810 GST line | `.max(100)` on percent; refuse a negative line value on non-note documents at save and issue | Browser |
| SEC-04 | A cancelled credit note still settles invoices | High | High | `actions/receivable.ts:350` refuses only DRAFT; cancel (`actions/trade-document.ts:968-1009`) leaves applications; readers sum them unfiltered (`lib/collect/balance.ts`, `lib/receivables/sync.ts`) | Invoice reads PAID while the ledger shows it owed; drops out of ageing, reminders and pay links | Refuse CANCELLED in `applyCreditNote`; delete applications and re-sync invoices on cancel (as `cancelVendorCredit` does) | Code |
| SEC-05 | An order punched without a price can be priced after approval | High | High | `lib/validation/order.ts:178`; `actions/order-prices.ts:107-151`; `lib/orders/missing-prices.ts:16` (excludes only CANCELLED) | Below-cost sale without loss approval, over credit limit without override, inflated targets | Refuse fills past PENDING_APPROVAL unless an approver (not the author) does it, or send back to approval | Review |
| SEC-06 | Biometric `/iclock` accepts forged punches with only the device serial | High | High | `app/api/biometric/iclock/[[...path]]/route.ts:74-104, 257-285`; `lib/hr/punch-rollup.ts:104-162` | Anyone can mark any employee present on any date; absent becomes paid; no payroll-lock check; unknown-serial oracle | Per-device secret in the URL or a mandatory IP list; refuse future, old or locked-month punches; rate-limit unknown serials | Review |
| SEC-07 | Inbound helpdesk email trusts the From header (no SPF/DKIM/DMARC) | High | Medium | `lib/support-mail/receive.ts:75, 114-115, 137, 170, 211-217`; `deploy/cloudflare/inbound-email-worker.js` | Spoofed customers open or reply to tickets; acknowledgement relays attacker text; flood limit bypassed | Pass Cloudflare's auth verdict; treat unaligned mail as a stranger's; per-domain caps; drop the display name from acknowledgements | Review (depends on Cloudflare) |
| SEC-08 | Quick messages return every contact's email and phone unmasked | High | High | `lib/quick-messages/server.ts:212-240`; `actions/quick-messages.ts:48`; `lib/app/follow-up.ts:45` | Roles with masked contacts (SALES, CALLING) harvest every number and email they can see | Apply `contactScope` and the contact masker; send by contact id server-side | Review (2 reviewers) |

### Medium

| ID | Finding | Conf. | Location | Recommended fix | Status |
|---|---|---|---|---|---|
| SEC-09 | Negative invoice total saved as a draft; issuing it crashes the page (ledger "does not balance") instead of a message | High | `lib/validation/trade-document.ts:143` (adjustment unbounded); `lib/ledger/journal.ts:315` | Bound adjustment; refuse total < 0 at save with a clear message | Browser |
| SEC-10 | Credit note not capped by its invoice; can target a draft or cancelled invoice; credit spends on any invoice | High | `lib/documents/create-draft.ts:380-444` | Cap notes against invoice total; require an issued target | Review |
| SEC-11 | Editing a draft races issuing it: issued document differs from its ledger posting and approval | Medium | `actions/trade-document.ts:243 vs 293-337 vs 498-509` | Claim the row (`updateMany where status DRAFT`) inside the update transaction | Review |
| SEC-12 | Payment settlement read-then-write with no lock; `recordPayment` to an order has no ceiling | High | `actions/receivable.ts:98-127, 261-288`; `actions/payment.ts:150-161, 246-276`; `actions/payable.ts:114-166` | Advisory lock on payment and document; re-read balances in the transaction | Review |
| SEC-13 | Stock-adjustment four-eyes bypassed by editing a colleague's draft | High | `actions/inventory.ts:563-580, 630-636`; `lib/inventory/stock-documents.ts:79` | Refuse approval by creator, submitter or last editor; require PENDING inside the posting transaction | Review |
| SEC-14 | `reverseJournalEntry` reverses system-posted entries (invoices, payments, payroll) | High | `actions/ledger.ts:20-73` | Allow by-hand reversal only for MANUAL/OPENING | Review |
| SEC-15 | `postExpensesToLedger` posts unapproved claims; no posting key | High | `actions/expense.ts:679-742`; `lib/ledger/journal.ts:1044-1111` | Require APPROVED/REIMBURSED; add `postingKey` | Review |
| SEC-16 | Typed document number jumps or overflows the series (Int max) for the whole workspace | High | `lib/trade-number.ts:279-311`; `lib/documents/create-draft.ts:463-494` | Accept typed numbers only in MANUAL mode; cap how far the serial may advance | Review |
| SEC-17 | Commission payee bank details need no finance permission; reps can create a commission party | Med-High | `actions/commission-party.ts:123-200` | Gate on `payments.manage`; notify finance on change | Review |
| SEC-18 | Quick "new account manager" mail sends caller-written text from a colleague's own mailbox | High | `lib/quick-messages/server.ts:199-372` | Template text only when the sender isn't the caller; record the real actor | Review |
| SEC-19 | View-as defeats "never your own" approvals and opens the borrowed person's HR data and bank edit | High | `lib/session.ts:53`; decide* actions in `leave.ts`, `short-leave.ts`, `regularisation.ts`, `expense.ts`, `loan.ts`, `resignation.ts`; `hr.ts:177` | `refuseWhileViewingAs` in each decision and in `saveEmployeeProfile`; compare the real actor | Review |
| SEC-20 | Employees self-edit payroll inputs (state, DOB, gender, PAN, bank) with no approval; partial post nulls fields | Med-High | `actions/hr.ts:185-246` | Limit self-edit to contact details; route the rest through HR approval | Review |
| SEC-21 | Two-factor guessing unlimited: a correct password clears the lockout before the code is checked | High | `actions/auth.ts:105` | Clear failures only after full sign-in; separate code-failure key | Code |
| SEC-22 | Changing own password or 2FA leaves other sessions signed in; 30-day default session | High | `actions/profile.ts:74-101, 288-365`; `lib/auth-session.ts:44-56` | End other sign-ins and devices; shorter `maxAge` | Review |
| SEC-23 | `confirmIdentity` has no attempt limit | High | `lib/security/confirm-identity.ts:44-65` | Lockout per user; end session on lockout | Review |
| SEC-24 | Full backup with workspace keys downloads on a session alone | High | `app/api/backups/[id]/download/route.ts` | Require `confirmIdentity`; notify the super admin | Review |
| SEC-25 | API keys survive password reset and ended sessions; no maximum lifetime | High | `actions/api-keys.ts:103`; `lib/api/handler.ts` | Revoke keys where sign-ins are ended; cap lifetime | Review |
| SEC-26 | Switched-off or signed-out phones keep receiving pushes, now including message previews | High | `lib/app/push.ts:120, 154` | Filter by active user and live sign-in; clear push tokens on sign-out | Review |
| SEC-27 | Request bodies read whole before size or signature checks (chunked bypasses Content-Length) | Medium | `lib/api/handler.ts:135`; `app/api/app-updates/publish`, `app/api/app/pair`, `app/api/inbox/public/*`, `app/api/telephony/callerdesk`, `app/api/collect`, recordings upload | Reuse the streamed `bodyWithin` helper on every POST | Review (needs edge check) |
| SEC-28 | Leave preview materialises any date span (year 1 to 9999) in memory | Med-High | `lib/hr/calendar.ts:34-40`; `actions/leave.ts:107-126` | Cap span to 366 days in `eachDay` | Review |
| SEC-29 | `page`/`pageSize` unclamped in actions: one call returns every lead or company in scope, bypassing export permission | High | `pageSlice` callers in `actions/lead.ts:617`, `company.ts:1281…`, etc.; `listCompanies` unpaged | Clamp inside `pageSlice` | Review |
| SEC-30 | ~345 text fields with no max length; 18 arrays with no max | High | `lib/validation/*` (e.g. company name), bulk-id actions such as `verifyContactEmails` | Shared `shortText`/`longText` helpers; `.max()` on arrays | Review |
| SEC-31 | Double-decision races (leave double-debits balance, loans, expenses) | High | `actions/leave.ts:231-270`; `loan.ts:196-210`; others | Conditional `updateMany` on status inside the transaction | Review |
| SEC-32 | Portal and signup emailed-code attempt limits can be raced | Med-High | `lib/portal/device.ts:102-107`; `actions/platform/signup.ts:341-348` | Atomic attempt claim | Review |
| SEC-33 | `/verify` number search walks every certificate, people's included | High | `lib/verifiable/search.ts:78` | Tight per-address limit on number lookups; hide holder names of people | Review |
| SEC-34 | Public writes with no storage ceiling (chat uploads, helpdesk attachments, visitor rows) | High | `app/api/inbox/public/web/[key]/upload`; `lib/support-mail`; website activity | Per-conversation and per-workspace byte budgets | Review |
| SEC-35 | Public form rate limit keyed on the typed email (23 Oct fix incomplete) | High | `actions/marketing-public.ts:373, 474, 485` | Key on caller address too | Review |
| SEC-36 | Lead-won value editable after win; re-winning moves the won date into this period | High | `actions/lead.ts:789-833`; `lib/leads/stage-move.ts:78-150` | Lock value once WON; reopening needs a permission | Review |
| SEC-37 | `decideEarning` treats an unknown decision as PAID | High | `actions/incentive.ts:567-613` | Validate the decision value | Review |
| SEC-38 | `moveEmployeeRecord` can switch off an Admin's login without `users.manage` | High | `actions/move-employee.ts:22-26` | Require `users.manage` and the target rule | Review |

### Low (summary)

| ID | Finding | Location |
|---|---|---|
| SEC-39 | Vendor bill can be set PAID by hand with no payment | `lib/trade-documents.ts:195` |
| SEC-40 | Manual journals accept negative sides and any `source`; chart allows parent cycles | `actions/ledger.ts:92-176, 237-264` |
| SEC-41 | `unlinkInvoiceLine` needs only view; statement PDF filename unvalidated, one Chromium per call | `actions/order-billing.ts:243-252`; `app/api/statements/.../pdf/route.ts` |
| SEC-42 | `users.manage` can deactivate or reset 2FA of accounts holding more rights | `actions/user.ts:486-530, 660-691` |
| SEC-43 | Payroll managers can act on their own loan repayment, salary and settlement | `actions/loan.ts:259-293`; `payroll.ts`; `settlement.ts` |
| SEC-44 | Attendance changes ignore the payroll lock; regularisation to ON_LEAVE is a paid day | `actions/attendance.ts:117`; `regularisation.ts:70, 144` |
| SEC-45 | Line managers read reports' bank, PAN and ID documents | `actions/hr.ts:158-175`; `employee-docs.ts` |
| SEC-46 | Website visitors can spend the AI credits and read AI Knowledge files through the bot | `lib/inbox/server.ts:556-570` |
| SEC-47 | Chat visitor linked to a customer on an unverified typed email | `lib/inbox/server.ts:258-263` |
| SEC-48 | Shared caps let one outsider switch off TV pairing, chat, booking or `/verify` | `lib/tv/screens.ts`; inbox and booking limits |
| SEC-49 | Quick WhatsApp to any number; no daily limit on quick messages; any template's PDF attachable | `actions/quick-messages.ts:84-103`; `lib/quick-messages/server.ts:331` |
| SEC-50 | API lockout checked before the key (shared address blocks good keys) | `lib/api/handler.ts:179-203` |
| SEC-51 | API key scopes leak contacts through `companies:read` and `leads:read` | `lib/api/v1/companies.ts:200`; `lib/api/v1/leads.ts` |
| SEC-52 | Recording downloaded whole without a play logged (Range suffix) | `app/api/calls/[id]/recording/route.ts:34` |
| SEC-53 | Visits completed or cancelled from any state | `actions/visit.ts` (`completeVisit`, `setVisitStatus`) |
| SEC-54 | Call sync and recordings are self-reported; 40 MB by extension only | `lib/app/calls.ts`; `lib/calls/recordings.ts` |
| SEC-55 | Writes checked at view level; pickers open to every signed-in person | `actions/company.ts` (several); `document-approval.ts:206-219` |
| SEC-56 | 25 actions return raw error text (Prisma internals) | e.g. `actions/ledger.ts:71, 195` |
| SEC-57 | CSV exports that bypass the formula guard | `components/performance/new-customers-download.tsx`; `components/settings/migration/receipts-check.tsx`; `lib/hr/statutory-files.ts:137-139` |
| SEC-58 | No CSP or HSTS in the repo; `/api` responses skip hardening headers | `next.config.ts`; `proxy.ts:157-168, 346` |
| SEC-59 | Default workspace restores unsigned archives; backup directory not confined | `app/api/backups/*` |
| SEC-60 | Backup routes have no Origin check | `app/api/backups/*` |
| SEC-61 | Headless Chromium runs without its sandbox beside the platform key | `Dockerfile:69` |
| SEC-62 | Custom-field file uploads never cleaned up | `app/api/custom-fields/files` |
| SEC-63 | Unsubscribe answer reveals whether a token is real | `app/api/marketing/unsubscribe/[token]/route.ts:26` |
| SEC-64 | Razorpay event id taken from an unsigned header | `lib/billing/webhooks.ts:178` |
| SEC-65 | Inbox knowledge cache not keyed by workspace | `lib/inbox/knowledge.ts:242-256` |
| SEC-66 | ID card QR fixed for life; small existence oracles (referrals, company names) | `lib/id-cards/cards.ts`; `actions/referrals.ts`; `quick-lead.ts` |

## 5b. Browser testing results (local copy, signed in as the owner)

Every test was typed into the real forms on `deskzo.localhost:3000` against the local database, after a backup. Status "Broken" means the system accepted something it should refuse; "OK" means it refused with a clear message.

| Form | Input tried | Result | Finding |
|---|---|---|---|
| New tax invoice | One line at a 250% discount | **Broken.** INV/2026-27/0270 issued for ₹6,490 with a line of taxable −₹4,500 and GST −₹810 | SEC-03 |
| New tax invoice | Adjustment −₹50,000 (total −₹51,770) | Draft saved. Issuing crashed the page ("Entry does not balance") instead of refusing with a message | SEC-09 |
| Record payment | ₹9,99,99,999 against ₹6,490 due | OK: "Only ₹6,490.00 is outstanding…" | — |
| Record payment | −₹500 | OK: "Enter an amount greater than 0" | — |
| Record payment | Dated 1 January 1900 | **Broken.** Saved and posted as journal JV/1899-00/0001, before the invoice existed. A books lock date would refuse it; none was set | New: SEC-67 |
| Credit note from an invoice | Line raised to ₹10,00,000 (note ₹11,74,690 against a ₹6,490 invoice) | **Broken.** CN/2026-27/0053 issued | SEC-10 |
| Apply credit note | ₹82,600 to an unrelated invoice of the same customer | Accepted | SEC-10 |
| Cancel that credit note | — | **Broken.** INV/2026-27/0246 still reads "Paid — Settled in full", ₹0 received, ₹82,600 credited by the cancelled note | SEC-04 |
| Punch order | Sales price −₹1,00,000 | OK: "Enter a price above zero, or leave it blank for the list price." | — |
| Fill missing prices | ₹1 a seat on an APPROVED order (list ₹9,500; state set up by clearing its price) | **Broken.** "1 order priced." No return to approval. Price restored after | SEC-05 |
| Apply for leave | Loss of pay, 1 Jan 2026 to 31 Dec 2035 | Preview said "2603 day(s) will come off your balance". Submit crashed the page on a database overflow (not saved by accident). Spans under ~999 working days would save | SEC-28 |
| New expense | Amount ₹100, tax ₹5,000, 20,007-character description | **Broken.** EXP-000013 submitted for approval | New: SEC-68 |
| New company | Website and LinkedIn `javascript:alert(…)` | OK: refused. But no message says why; the form just does nothing | New: SEC-69 (UX) |
| New company | Name with `<img onerror>` / `<script>` | OK: shown as plain text; nothing ran (COM-000151) | — |
| New company | 50,017-character name | **Broken.** Saved as COM-000152; the companies page HTML grew to 536 KB | SEC-30 |
| New lead | Estimated value −₹50,00,000, seats −10 | Refused, but with no visible message | SEC-69 (UX) |
| Vendor bill | More → Paid with nothing paid | **Broken.** BILL/2026-27/0095 reads "Paid. Settled with the vendor." while showing ₹12,192 outstanding | SEC-39 |
| New vendor bill | Same vendor, same number BILL/2026-27/0095 | OK: "BILL/2026-27/0095 is already used by another document." | — |
| New vendor bill | Same vendor, same ₹12,192, number in lower case `bill/2026-27/0095` | **Broken.** Saved and issued: the bill is now in the books twice | New: SEC-70 |
| Stock adjustment | Write off 9,99,999 units (about ₹791 crore at cost) | Saved and submitted with no check. Self-approval correctly refused ("You wrote it, so it isn't yours to approve"). Cancelled after | — |
| Add staff (viewing as the HR head) | Role dropdown shows only Employee; Admin added to the dropdown by script | OK: "Only a super admin can create an admin account." | — |
| Add staff (viewing as the HR head) | Sales manager added to the dropdown by script | OK: "You can only start people as an Employee." | — |
| Set salary (viewing as the HR head, on her own record) | Annual CTC ₹99,00,000 | **Broken.** Saved with no second person. Test structure deleted after | SEC-43 |
| Company contacts (viewing as a salesperson) | Her own customer's contact | Email and phone shown unmasked, so masking is off for her locally; the quick-message leak (SEC-08) could not be shown in the browser | — |
| Branding | Colour `red;}…</style><script>…` | OK: "Use a 6-digit hex colour" | — |
| Branding | App name with `<script>` plus 5,000 characters | Saved; becomes every user's browser tab title. Shown as text, nothing ran. Admin-only. Restored | Low |
| Numbering | Proposal series moved back from 1019 to 1 | Saved with no warning; the next proposal was pre-filled QT/2026-27/0001. Exact duplicates are still blocked, but a series can go backwards (for tax invoices this breaks continuous GST numbering). Restored | New: SEC-71 |

New findings from the browser:

| ID | Finding | Sev. | Location | Fix |
|---|---|---|---|---|
| SEC-67 | Payments accept any date: years before the invoice, 1900, far future. They post to the ledger in that year unless a books lock is set | Medium | `lib/validation/payment.ts`, `lib/validation/receivable.ts` (`paidOn` any string) | Refuse a date before the document's issue date or after today; sane minimum year |
| SEC-68 | Expense tax amount may exceed the expense amount; description unbounded | Medium | `lib/validation/expense.ts` | Refuse tax > amount; cap description |
| SEC-70 | Vendor bill number uniqueness is case-sensitive: the same vendor bill can be booked twice | High | `docNumber @unique` (`prisma/schema.prisma:3086`); bill create in `lib/documents/create-draft.ts` | Compare vendor bill numbers case- and space-insensitively per vendor; warn on same vendor + amount + date |
| SEC-71 | A document series can be moved backwards | Low | `settings/numbering` save | Refuse a next number below the highest already issued in that series and year |
| SEC-69 | Refused inputs show no message (company `javascript:` links, negative lead value); invoice issue and leave submit crash the page instead of refusing | Low | company and lead forms; `issueTradeDocument`, `applyForLeave` | Show the server's refusal next to the field; validate before the database does |

## 5c. Fix status, 12 Nov 2026

The first batch (commit 9457a7b0) fixed SEC-01 to SEC-05, SEC-08 to SEC-10, SEC-18, SEC-39, SEC-67, SEC-68, SEC-70 and the date, lockout and logging parts of SEC-06. The second batch, the same day, is below. Each fix has a check in `npm run check:audit-fixes` (seven files: the first batch, then A1, A2, B, C, D, E), which calls the server's own code the way the finding broke it.

| ID | Status | What changed |
|---|---|---|
| SEC-06 | Fixed (opt-in per terminal) | A terminal can have its own secret address, `/iclock-k/<key>`; with one, its serial alone is refused as an unknown serial is. Needs a terminal whose server address takes a web address with a slash. Not tried on a real terminal |
| SEC-07 | Fixed in code; worker must be redeployed | The Cloudflare worker passes its own SPF/DKIM/DMARC verdict; mail that isn't proved waits in the Support inbox as a stranger's and never replies into a ticket. Until the worker is redeployed the old behaviour stands |
| SEC-11 | Fixed | Save and issue each claim the draft inside their transaction |
| SEC-12 | Fixed | Settlements take an advisory lock and re-read balances (`src/lib/finance/settlement-lock.ts`), vendor credits included; a payment to an order is capped at what it owes |
| SEC-13 | Fixed | Approval refuses the creator, the sender and anyone who edited; the edit's record is written in the edit's own transaction |
| SEC-14, SEC-40 | Fixed | Only MANUAL and OPENING entries reverse by hand; no negative sides; no parent cycles |
| SEC-15 | Fixed | Only approved or reimbursed claims post, once, under a posting key |
| SEC-16, SEC-71 | Fixed | A typed number moves a series at most 1,000 ahead; a series can't be set below a number already used |
| SEC-17 | Fixed | Payee bank details need `payments.manage`. Finance isn't yet told of a change |
| SEC-19 | Fixed | Every decision, and the HR profile save, refuses while viewing as somebody |
| SEC-20 | Fixed | People edit their own contact details only; pay inputs are HR's. A partial save keeps what it didn't send |
| SEC-21 to SEC-25 | Fixed | 2FA tries counted on their own key; other sign-ins and API keys ended on a password change; `confirmIdentity` locks out; a backup download asks for identity and tells the other super admins; API keys last a year at most |
| SEC-26 | Fixed | Pushes go only to an active person's approved phone with a live sign-in |
| SEC-27 | Fixed | Every public POST reads its body under a ceiling (`src/lib/http/body.ts`) |
| SEC-28, SEC-31, SEC-32 | Fixed | Leave spans capped at 366 days; decisions and emailed-code tries claim their row atomically |
| SEC-29 | Partly | `pageSlice` clamps to 500. Still unpaged: `listCompanies` and its siblings, `listTradeDocuments`, about ten hand-rolled pagers |
| SEC-30 | Fixed | 464 text fields and 37 lists given maxima (`src/lib/validation/text.ts`). Ten raw-array actions noted in the appendix remain |
| SEC-33 to SEC-35 | Fixed | `/verify` lookups limited per address and people's names hidden; byte budgets on public uploads; form limits by caller address |
| SEC-36 | Partly | A won lead's value is locked; moving between won stages keeps the date. A lead reopened and won again still takes today's date — needs an owner decision on who may reopen |
| SEC-37, SEC-38 | Fixed | Unknown decisions refused; switching off a login while moving a record needs `users.manage` |
| SEC-41 | Fixed | Unlink needs issue rights; statement PDF inputs validated; at most three PDF browsers at once |
| SEC-43, SEC-44 | Fixed | Nobody acts on their own pay; attendance changes respect the payroll lock; no regularising to On leave |
| SEC-46 | Fixed | The bot answers visitors only from AI Knowledge files marked "Website chat may use this" (none are marked after the update), within per-conversation and per-day caps |
| SEC-47 to SEC-54 | Fixed | Typed emails only suggest a customer; limits are per caller; 200 quick messages a day; API contacts need `contacts:read`; every play logged; recordings checked by their bytes |
| SEC-56, SEC-57 | Fixed | Plain error text (`src/lib/plain-error.ts`); CSV guard on the three exports |
| SEC-58 | Fixed | HSTS, a conservative CSP (`base-uri`, `object-src`, `frame-ancestors`), nosniff on `/api`. No script or style rules yet |
| SEC-59, SEC-60 | Fixed | Unsigned archives refused unless `BACKUP_ALLOW_UNSIGNED_RESTORE=1`; backup routes check the request's origin |
| SEC-62 to SEC-66 | Fixed | Unclaimed uploads swept daily; unsubscribe answers alike; Razorpay event id from the signed body; cache keyed by workspace; a lost ID card can be replaced |
| SEC-69 | Fixed | Refusals shown on the company and lead forms; issue and leave refuse in words |
| — | Fixed (found by `check:record-scope`) | Service cycle actions ask for the customer's record, not just `cycles.manage` |

**Still open**

| ID | Why |
|---|---|
| SEC-42, SEC-45, SEC-55 | Permission-model changes; with the person working on permissions |
| SEC-61 | Chromium sandbox in the Dockerfile — changes the deploy image; to be planned with the owner first |
| SEC-22 (part) | The 30-day session length is unchanged; an owner decision |
| SEC-29 (part), SEC-36 (part) | As above |
| SEC-07 follow-up | Forwarders whose mail passes only ARC wait in the inbox; confirm on real mail after the worker is redeployed |

**Deploy notes:** `npm run tenants:migrate` (two migrations: `20261212120000_id_card_version`, `20261212130000_device_key_and_customer_knowledge`); redeploy `deploy/cloudflare/inbound-email-worker.js`; mark the AI Knowledge files the website bot may use; API keys older than a year stop working.

## 6. Security properties

| Property / control | Status | Evidence | Required action |
|---|---|---|---|
| Confidentiality | PARTIAL | Workspaces isolated; masking bypassed in quick messages (SEC-08) and API scopes (SEC-51) | Fix SEC-08, SEC-29, SEC-51 |
| Integrity | FAIL | Negative-tax invoices issued (SEC-03); credit notes, post-approval pricing, forged punches | Fix SEC-03 to SEC-06, SEC-10 to SEC-15 |
| Availability | PARTIAL | Unbounded spans, bodies and page sizes; shared caps | Fix SEC-27 to SEC-30, SEC-34 |
| Authentication | FAIL | SSO email match (SEC-02); 2FA guessing (SEC-21) | Fix SEC-02, SEC-21 to SEC-23 |
| Authorization | PARTIAL | Core roles sound; view-as and parity gaps | Fix SEC-19, SEC-38, SEC-55 |
| Accountability | PARTIAL | Audit trail broad; mail log names the wrong sender (SEC-18); recording plays can go unlogged (SEC-52) | Fix SEC-18, SEC-52 |
| Security posture | PARTIAL | Critical dependency; no CSP or HSTS in the repo | Upgrade dependencies; add headers |

## 7. Remediation plan

| Priority | Action | Finding IDs | Target timeframe |
|---|---|---|---|
| P0 | Upgrade Next.js to 16.4.6 or later; review the other high advisories | SEC-01 | This week |
| P0 | Bind SSO to provider subject; require identity confirmation to change SSO | SEC-02 | This week |
| P1 | Invoice maths: cap discount at 100%, no negative lines or totals on invoices, bound adjustment | SEC-03, SEC-09 | This week |
| P1 | Credit notes: refuse cancelled, undo applications on cancel, cap per invoice | SEC-04, SEC-10 | This week |
| P1 | Biometric device secret and date rules | SEC-06 | This week |
| P1 | Mask quick-message contacts; template-only manager notice | SEC-08, SEC-18, SEC-49 | This week |
| P1 | Lock post-approval price fills | SEC-05 | This week |
| P2 | 2FA lockout, sessions ended on password change, `confirmIdentity` limit, backup download confirmation, API key revocation | SEC-21 to SEC-25 | 2 weeks |
| P2 | Races: conditional status updates and posting locks | SEC-11 to SEC-15, SEC-31, SEC-32 | 2 weeks |
| P2 | View-as refusals; HR self-edit limits | SEC-19, SEC-20, SEC-38 | 2 weeks |
| P2 | Input bounds: `pageSlice` clamp, date spans, text and array maxima, streamed body caps | SEC-27 to SEC-30 | 2 to 4 weeks |
| P3 | Helpdesk sender authentication (needs a Cloudflare check) | SEC-07 | 2 to 4 weeks |
| P3 | Remaining medium and low items | rest | Backlog |

## 8. Validation and retest plan

- **SEC-01:** `npm audit --omit=dev` shows no critical; `npm run build` passes; the three `next/og` routes still render.
- **SEC-03, SEC-09:** in the browser, an invoice line with a 250% discount and an adjustment of −50,000 is refused at save with a message. The test invoices below are cancelled or restored away.
- **SEC-02:** a scripted check where an SSO profile with a matching email but a different subject is refused.
- **SEC-04:** apply, then cancel a credit note; the invoice returns to open and the ageing report includes it.
- **SEC-06:** a punch without the device secret is refused; a future-dated punch is refused.
- **SEC-21:** after eight wrong codes, a correct password plus a correct code is still locked out.
- Run the existing suites touched by each fix (`check:loopholes`, `check:collect`, `check:debit-notes`, `check:app-chat`, `check:lead-capture`, `check:renewal-watch`), plus `tsc` and lint.

## 9. Overall assessment

**Remediation recommended before release.** Live use is already exposed to SEC-01 (dependency), SEC-02 (owner takeover by an insider with security rights), SEC-03 (GST under-reporting by any invoice issuer) and SEC-06 (attendance fraud), so these four warrant fixing now rather than waiting for a release. Residual risk: most findings come from code reading, not live exploitation, and the edge configuration was not reviewed.

## 10. Appendix

- **Commands:** `npm audit --omit=dev --json`; `git grep` secret patterns; `pg_dump` local backup.
- **Browser:** local dev server; signed in by the owner; invoice form tested.
- **Backup before testing:** `backups/manual/deskzo-before-form-tests-2026-11-11.dump` (git-ignored). To undo the test records, restore it into the `deskzo-postgres` container.
- **Test records created or changed on the local copy:**
  - INV/2026-27/0269, draft, total −₹51,770 (Apex Agro)
  - INV/2026-27/0270, issued, ₹6,490 with a −₹810 GST line, plus a ₹1 payment dated 1 Jan 1900 (journal JV/1899-00/0001)
  - CN/2026-27/0053, ₹11,74,690, cancelled; INV/2026-27/0246 (seeded) left wrongly "Paid"
  - ORD-000025 priced at ₹1 then restored to ₹9,500
  - EXP-000013, submitted, tax larger than amount
  - COM-000151 and COM-000152 (test companies)
  - BILL/2026-27/0095 (seeded) marked Paid by hand; duplicate bill `bill/2026-27/0095` issued
  - ADJ/2026-27/0001 stock adjustment, cancelled
  - Divya Malhotra's test salary structure (deleted); branding and proposal numbering restored
- **Not run:** DAST scanner; most settings pages; customer portal and public forms in the browser; live-site checks; git-history secret scan; mobile app review.
- **Earlier report:** `docs/reports/loopholes-2026-10-23.md`. Nothing above repeats its fixed items, except SEC-35, which completes its finding 19.

## 11. Round two, 13 Nov 2026: the areas the first round left out

Eight read-only reviewers, one per area, read the code as it stood on 13 Nov (main at efd5d4e0 plus the batch-2 fixes). Nothing was run against the live site. Each Medium-or-worse finding below was re-read against the code before it went in; "Needs validation" means the code path is real but its effect wasn't tried.

**Headline:** no Critical finding and one High (the payroll import). No path was found across workspaces, into the internal network, or into the console from outside. The worst issues are bulk imports that skip rules the forms enforce, and a handful of places where a stolen session or an insider gets further than it should.

### Areas and verdicts

| Area | Worst | Verdict |
|---|---|---|
| Imports, exports, backups, restore, reset | High (R2-01) | Imports bypass rules fixed on the forms; exports, restore and reset sound |
| Chat, mail, calendar, vault, cards, git history | Medium-High (R2-02) | Vault reveal skips the identity check others use; chat and mail OAuth sound; no real secret ever committed |
| Deskzo billing, signup, entitlements, domains | Medium (R2-05, R2-06) | Billing hold leaks through the billing page; webhooks and checkout sound |
| Platform console and staff sign-in, tenancy | Medium (R2-07, R2-08) | Every console action and page guarded; availability and step-up gaps |
| Automate and AI | Medium (R2-09, R2-10) | No SSRF, no expression injection; workflow ownership gaps |
| Phone app and its endpoints | Medium (R2-11 to R2-13) | Token, PKCE, WebView and OTA integrity sound; parity and sign-in gaps |
| Customer portal and public pages | Medium (R2-14, R2-15) | No portal IDOR; print pages, pay links and tokens sound |
| Public website CMS and partner portal | Medium (R2-16) | No stored XSS; partner data scoped; lockout and form-cap gaps |

### Findings, worst first

| ID | Finding | Severity | Where | Fix |
|---|---|---|---|---|
| R2-01 | The payroll import (and Kredily, through it) lets a payroll manager set their own salary, salary bank account or TDS. It also runs while viewing as somebody, reopening SEC-43 and SEC-19 through the bulk door. Confirmed | High | `lib/portability/importers/payroll.ts:353-395`; `actions/payroll-import.ts:28-32` | Refuse the actor's own row; `refuseWhileViewingAs` in the gate |
| R2-02 | Opening a vault secret checks the password itself, with no lockout, no session end and no 2FA code, so the SEC-23 fix doesn't reach it. Confirmed | Medium-High | `actions/vault.ts:570-608` | Confirm through `confirmIdentity` |
| R2-03 | The chart-of-accounts import changes the type of accounts with entries, or makes them groups, without `ledger.manageAccounts`. Confirmed | Medium-High | `lib/portability/importers/ledger.ts:106-176` | The form's guards, and its permission |
| R2-04 | The expenses import has no record scope. It rewrites others' draft or submitted claims, files claims in anyone's name, and skips the amount and tax rules | Medium | `lib/portability/importers/expenses.ts` | `expenseAccess` per row; the form's schema |
| R2-05 | A workspace held for non-payment still runs the actions the billing page's shell loads (global search, onboarding writes). Confirmed | Medium | `lib/tenancy/hold.ts:4`; `app/(dashboard)/layout.tsx` | Refuse server actions for held workspaces except billing's |
| R2-06 | Razorpay "authenticated" counts as paid before any money arrives, so a mandate can lift a hold or end a trial. Needs validation against Razorpay | Medium | `lib/billing/razorpay.ts:103-111` | INCOMPLETE until the first charge |
| R2-07 | The host-to-workspace cache keeps every lookup, misses included, and never shrinks, so random host names grow it without limit. Confirmed | Medium | `lib/tenancy/registry.ts:137-146` | Bound it; sweep misses |
| R2-08 | Console owners turn off staff 2FA, reset another owner's 2FA, change gateway keys or close a workspace with no fresh code | Medium | `actions/platform/console.ts`; `lib/platform/staff.ts` | Fresh TOTP on these; tell every owner |
| R2-09 | Taking over a workflow lets its waiting runs carry on as the new owner, with that person's access and mailbox. Confirmed | Medium | `lib/automate/store.ts:195-211` | Cancel open runs on takeover |
| R2-10 | A workflow can send admin-written text from the lead owner's own mailbox to any address (the same class as SEC-18). Confirmed | Medium | `lib/automate/actions/email-send.ts:284-299` | Lead owner only to the lead's contact, template only |
| R2-11 | Phone call sync and lookup match numbers to names regardless of contact masking, so a masked phone can be recovered. Confirmed | Medium | `lib/app/match.ts:41-71`; `lib/app/calls.ts` | Cap unmatched lookups; mask names |
| R2-12 | Another app on the phone can start the app's browser sign-in, and the code returns over `deskzo://`. Needs a malicious app and a tap | Medium | `app/(auth)/app-sign-in/…`; Android manifest | Verified App Link on deskzo.com |
| R2-13 | Over-the-air updates rest on one unencrypted key file. Publishing needs nothing else and tells nobody | Medium | `app/api/app-updates/publish/route.ts` | Passphrase or hardware key; second factor; alert on publish |
| R2-14 | A public form, booking or card naming an existing customer adds the visitor as that customer's contact, and automatic reminders can pick it. Confirmed | Medium | `actions/marketing-public.ts:536-592`; `lib/lead-capture/intake.ts` | Mark public-made contacts unconfirmed; leave them out of automatic recipients |
| R2-15 | The booking page sends an invitation carrying visitor text to any address from the host's calendar | Medium-Low | `lib/booking/server.ts` | Confirm by email before the meeting exists |
| R2-16 | The shared lockout drops entries once it holds 20,000, even live locks, so a flood of made-up tries erases a victim's lock. IPv6 callers are keyed per address. Affects workspace, console, CMS and partner sign-in. Confirmed | Medium | `lib/security/lockout.ts:39-52` | Never evict a live lock; key IPv6 by /64; account locks in Postgres |
| R2-17 | Settings › Blocked addresses isn't checked when mail goes from a person's own mailbox (documents, invitations). Confirmed | Medium | `lib/mail/mailbox.ts:140-171` | Check `allMailBlockFor` in `sendAsUser` |
| R2-18 | Vault share, change, delete and list run while viewing as somebody, so an admin can share a colleague's secrets to themselves. Confirmed | Medium | `actions/vault.ts` (no `refuseWhileViewingAs`) | Refuse every vault action while viewing as |
| R2-19 | A crafted .xlsx or zip can exhaust memory in the one process serving every workspace, because the inflated size is unchecked | Medium | `lib/portability/import.ts:115`; `lib/kredily/read.ts`; `lib/migration/upload.ts` | `readCapped` and per-entry caps before parsing |
| R2-20 | The portal's emailed code has no lockout across codes: 25 guesses an hour, for ever, on a link that never expires | Low-Medium | `lib/portal/device.ts` | Revoke after about 20 failures; default link expiry |

**Low** (each confirmed in code unless marked):

- **Imports:**
  - The people import edits anyone's pay inputs (SEC-20 through import).
  - The earlier-years archive export skips `data.exportFinance`, its row cap and logging.
  - The items import accepts negative prices and tax over 100%.
  - Kredily attendance writes into locked payroll months (needs validation).
  - No plan check per import area.
  - The archive PDF needs only company visibility.
- **Billing and signup:**
  - Partner invitation codes skip one-trial-per-mailbox and can start on add-on plans.
  - The signup country is never checked.
  - The buyer GSTIN on Deskzo's own tax invoices is unverified.
  - `tickets` isn't a locked platform host.
  - A broken custom domain stays reserved.
  - The workspace-name check has no rate limit.
- **Console:**
  - `/api/platform/tls-ask` answers on every host under Traefik and lists which workspaces exist.
  - Staff TOTP codes can be replayed for 90 s.
  - Sign-in confirms a right password before asking for the code.
  - Anyone can lock a known staff email out.
  - Billing webhooks read the whole body first.
  - Tokens in `/v/` and `/id/` paths land in the year-long access log.
- **Automate and AI:**
  - HTTP-step secrets are visible to other Automate admins.
  - The copilot confirm card hides the task description.
  - No default per-person credit cap.
  - The copilot chat body is read uncapped.
  - Copilot chats are kept for ever.
  - Copilot settings skip the view-as refusal.
- **Phone:**
  - The recorder matcher can upload a personal call's audio.
  - `deskzo://web?path=` opens any path.
  - A pairing QR pairs with any host without asking.
  - Every call's number leaves the phone, and the lookup puts it in a URL.
  - The token and offline data sit in plain files.
  - Two app routes read multipart bodies uncapped.
  - Phone tokens never expire while in use.
- **Portal and public pages:**
  - Kiosk text is uncapped and its company search unthrottled.
  - Portal requests and invoice PDFs are unthrottled per link.
  - Several bearer tokens are stored in clear.
  - The Outlook signature endpoint confirms staff emails.
- **CMS and partners:**
  - Removing your own authenticator has no attempt limit.
  - Payout bank changes need no step-up, and admins are told only after approval.
  - The self-referral check is easily bypassed.
  - One outsider can close a public form for an hour.
  - The privacy form mails attacker text from Deskzo.
  - An editor can point deskzo.com's chat at any workspace.
  - Authors can change built-in pages' drafts.
  - Partner directory entries go live unreviewed.
  - Deal registration reveals who is a customer.
  - `/track` writes a row per hit.
- **Chat:**
  - Reply quotes show up to 200 characters from before a member joined.
  - Exporting a chat needs no fresh identity check.
  - The group-picture route skips the access gate.
  - The vCard doesn't escape a bare carriage return (needs validation).

### Checked and found sound

- **Console and tenancy:** every console action and all 44 pages check staff and role on the server. No request input selects another workspace's database. Forwarded-host tricks get a 421.
- **Automate:** HTTP steps go through a pinned fetch that refuses private ranges, so no SSRF. The expression engine has no `eval`. Hooks are HMAC'd with replay refusal.
- **Copilot:** tools run as the asking person, with their scope and masking. Write tools need a confirm. Output can't carry links or images.
- **Portal and public tokens:** every token is CSPRNG and scoped to one record and workspace. No portal IDOR. Print pages need a single-use HMAC pass. Pay-link and gateway notices are re-read from the gateway, never believed.
- **CMS and partners:** the CMS is a block model with no HTML. Media is told apart by its bytes and sandboxed. Previews are HMAC'd. Every partner query is scoped to the partner.
- **Phone:** tokens are hashed, compared in constant time and revoked on every call. PKCE is correct. The WebView has no bridge. OTA manifests are verified against a pinned certificate, so the server can't push code.
- **Signup and billing:** prices and currency come from the server. Webhooks are HMAC'd, processed once, and tied to our own records. Seats are claimed under a lock. Session cookies are `__Host-` and per workspace.
- **Exports, restore and reset:** exports are permissioned, scoped, masked, capped and logged. Restore and reset enforce their typed phrase, identity check, wait, signature and safety copy on the server.
- **Chat:** membership and the joined–left window are checked on every action, file and stream event.
- **Mail and calendar:** mail OAuth is sealed, uses PKCE and is bound to the person. Tokens are encrypted. Headers are built by libraries, not by hand. The calendar's busy view stays busy-only.
- **Git history:** all 809 commits scanned. No real key, token, password or keystore was ever committed; the matches are fixtures and placeholders. `mobile/store/review-access.md` holds only a placeholder.

### Not reviewed in round two

- The real Cloudflare, Traefik and Coolify settings, including whether `TRUST_PROXY` is set in production. Every per-address limit depends on it.
- Real Stripe and Razorpay accounts (R2-06), and a real phone (R2-12).
- The Automate worker internals, the commission engine's arithmetic, the calendar providers' sync parsers, and the off-site recovery drill.

### Round two fix status, 13 Nov 2026

Every High and Medium above is fixed except where marked. `npm run check:audit-round2` (five files, 216 checks) proves each fix the way it was broken; the round-one checks still pass; tsc and lint are clean.

| ID | Status | What changed |
|---|---|---|
| R2-01 | Fixed | Payroll and Kredily imports refuse the actor's own pay row; payroll, Kredily and data imports refuse while viewing as |
| R2-02 | Fixed | Vault reveal goes through `confirmIdentity`: lockout, session ended on lockout, two-factor code; the vault's 2-minute SSO window kept |
| R2-03 | Fixed | Chart-of-accounts import needs `ledger.manageAccounts`; no retype or group change on an account with entries or a system key |
| R2-04 | Fixed | Expenses import scoped by `expenseAccess`, validated by the form's schema; filing for others needs `expenses.approve` |
| R2-05 | Fixed | A held workspace runs only billing's actions (`requireUser`/`currentUser`), in a bare shell |
| R2-06 | Fixed, against fakes only | Razorpay "authenticated" stays INCOMPLETE until the first charge |
| R2-07 | Fixed | Host cache capped at 5,000; `/api/platform/tls-ask` answers only internal callers or `TLS_ASK_SECRET` |
| R2-08 | Fixed | Dangerous console owner actions need a fresh single-use authenticator code; other owners are emailed |
| R2-09 | Fixed | Taking over a workflow cancels its open runs, waits and approvals |
| R2-10 | Fixed | "From the lead owner" only to the lead's contact, with a saved template, no CC |
| R2-11 | Fixed | Caller names masked as on the web; 300 unmatched numbers a day for masked-phone roles |
| R2-12 | Partly | A new phone sign-in emails its person; the consent page names the phone. The verified Android App Link is built but off until fingerprints, `DESKZO_APP_LINKS=1` and a store build |
| R2-13 | Fixed | Publishing an update needs `APP_UPDATES_PUBLISH_SECRET`, is rate-limited and emailed; passphrase keys supported |
| R2-14 | Fixed | Contacts made from public input on an existing customer are marked unconfirmed and kept out of every automatic recipient until confirmed |
| R2-15 | Partly | Invitations carry only the page title and a cleaned name; two bookings a day per guest email. Confirm-by-email not built |
| R2-16 | Fixed | A live lock is never dropped; IPv6 callers keyed by /64; staff TOTP codes single-use; staff sign-in gives one answer |
| R2-17 | Fixed | `sendAsUser` refuses blocked addresses; document and invite screens say which was left out |
| R2-18 | Fixed | Every vault action refused while viewing as |
| R2-19 | Fixed | Spreadsheets and zips measured while streaming (50 MB a part, 200 MB total, 100,000 rows, 500 columns) before parsing |
| R2-20 | Fixed | 8-digit portal codes; a link pauses after 20 wrong codes a day and alerts its owner; new links last 180 days |

Most of the lows were fixed too, including the people and items imports, the archive export and PDF, Kredily attendance in locked months, chat reply quotes, chat export, the group-picture route, the vCard, copilot view-as, billing webhook bodies, platform host names, the workspace-name rate limit, tokens in the access log, phone token lifetime, the lookup by POST, the app's link and pairing prompts, the recording matcher, portal request and PDF caps, the kiosk, and Automate secrets hidden from other admins.

**Still open:** confirm-by-email booking (R2-15); the full App Link (R2-12, owner steps); account locks, the phone lookup cap and staff TOTP memory are per process, not in Postgres; no plan check per import area; the remaining lows (Automate copilot card, credit cap, chat retention, kiosk-free items, partner and CMS lows).

**Deploy:** `npm run tenants:migrate` (`20261213200000_unconfirmed_contacts`); set `APP_UPDATES_PUBLISH_SECRET` on the server and the publishing computer before the next over-the-air update; set `TLS_ASK_SECRET` only if something other than Caddy calls tls-ask. Behaviour people will notice: held workspaces see only billing; console owners enter a code for dangerous actions; portal codes are 8 digits; typed text can't go from a lead owner's mailbox; website-made contacts need a Confirm before automatic mail.

### The lows, 13 Nov 2026

The remaining lows of both rounds were fixed in one pass. `npm run check:audit-lows` (four files, 213 checks) proves each the way it was broken; every earlier audit check still passes; tsc and lint are clean.

| Area | Fixed |
|---|---|
| CMS and partner portal | Removing your own authenticator: a code works once, five wrong ones end the session. A payout bank change needs a fresh code and emails every partner admin when asked. A signup matching the partner's own name, GSTIN or PAN, and a partner's first three signups, are flagged for staff (console pills). Public site forms: callers keyed by IPv6 /64; past the site-wide cap a known caller's request is kept and held, no mail; the privacy form is never closed. The privacy acknowledgement echoes nothing typed. Only a CMS admin changes deskzo.com's chat. Authors edit only their own, non-built-in pages. Partner directory name, website and listing go through staff approval. Deal registration answers alike for a customer's domain (staff decline it). `/track` writes one open and one click per message per 10 minutes |
| AI and copilot | The confirm card shows the whole task and who it's for. A default cap of 200 credits per person a day ("No cap" is a choice). The chat body is read under 16 KB after `copilot.use` is checked; the AI Knowledge upload is capped. Conversations untouched for 90 days are deleted; lookups older than a week aren't replayed to the model |
| Imports, lists, chat, finance | Imports are refused for modules outside the plan. The ten uncapped list actions have limits. A removed chat member can't delete messages. Finance gets a bell alert when a payee's bank details change |
| Billing, signup, domains, console | A partner's code no longer gives a repeat trial or an add-on plan. The billing GSTIN is checksum- and state-checked, verified with GST where an e-invoice login exists, and locked after the first tax invoice. A domain broken for 14 days can be taken over by a fresh proof, with the old owner told. A locked staff account still lets in the right password plus the right code. `PLATFORM_CONSOLE_IP_ALLOWLIST` and `TLS_ASK_SECRET` are in `deploy/azure/env.example` |
| Portal and public tokens | New portal and kiosk links are stored as a hash plus a sealed copy (migration `20261213210000_token_hashes` backfills hashes, so old links keep working); TV pairing secrets are sealed. The Outlook signature endpoint answers alike for unknown addresses. Poll answers count only against the poll as sent |
| Phone and lists | The phone token is sealed under an Android Keystore key, and the app wipes its offline copies at start-up after a sign-out. Calls already answered aren't sent again. The unpaged list readers stop at 5,000 rows, `listTradeDocuments` and five hand-rolled pagers at 500 a page |

**Still open:**
- Tokens: feedback, form-invite, candidate-intake and marketing-message tokens are still stored in clear. The plain token columns on old portal and kiosk rows wait for a contract release.
- Phone: offline copies and the outbox are not encrypted. The Keystore and call-sync changes need a store build.
- AI: the credit overdraft guard is still in memory.
- Partners: the payout-request email has fixed wording (no editable template key yet).
- Forms: "Find my workspaces" still refuses everyone past its site-wide cap.
- Owner decisions and other owners: who may reopen a won lead, and the permission-model items SEC-42/45/55 (Access Control); the Chromium sandbox (SEC-61, needs a deploy plan); the 30-day session length; checking the signup country.

**Deploy:** `npm run tenants:migrate` (`20261213210000_token_hashes`). Behaviour people will notice: a default AI cap of 200 credits a day; old copilot chats deleted after 90 days; partner payout changes need an authenticator; partner directory changes wait for staff; billing GSTINs are validated and locked after the first tax invoice; signing up again through a partner's code is refused.

## 12. Round three, 13 Nov 2026: depth, and what was added since

Six read-only reviewers read main at 50921f85: the features added since 11 Nov (the storage box, Access Control, lead limits, field rules, bulk merge and the rest), GST and tax integrations, payroll and HR in depth, stock, purchase, orders and projects, marketing, helpdesk and calling, and reports, search and masking. Nothing was run. The worst finding in each area was re-read against the code before it went in; "needs validation" means the path is real but its effect wasn't tried, and law-dependent tax points need a CA's view.

**Headline:** four Highs, and none crosses workspaces except R3-01, which takes every workspace down rather than reading one. The pattern this round: **money and tax arithmetic** (foreign currency in GST, payroll reruns, rejected orders in targets) and **side doors around rules the main screens keep** (forecast, "New customers", pickers, the activity feed, view-as in operations approvals).

### Highs

| ID | Finding | Where | Fix |
|---|---|---|---|
| R3-01 | A workspace admin can save a custom field-rule pattern such as `(a+)+b`; a lead titled with about 40 "a"s then backtracks the regex with no time limit and freezes the one Node process every workspace shares. Any trial owner is an admin. Confirmed | `lib/field-rules/check.ts:64-91` | Run patterns through RE2 (linear time) or drop custom patterns; cap the input tested |
| R3-02 | Foreign-currency documents go to GST at face value: GSTR-1, GSTR-3B and the e-invoice payload never apply the exchange rate, so a USD 10,000 invoice is reported as ₹10,000. The ledger and UAE VAT do convert. Confirmed | `actions/tax-reports.ts:78-178`; `actions/trade-document.ts:685-709` (e-invoice) | Convert to rupees in the return builder and the IRN payload; export details for exports |
| R3-03 | Recalculating a draft payroll run drops approved incentives: the rerun deletes the payslips, the earnings stay "Paid" with no payslip, and the next run takes only unpaid ones — gone from pay, bank file, books and TDS. The normal "fix attendance, run again" path does it. Confirmed | `actions/payroll.ts:465, 630-646`; `actions/incentive.ts:720` | Put this run's earnings back to approved before deleting its payslips, or mark them paid only at lock |
| R3-04 | A paid payroll run can be taken back to locked, then draft, and recalculated (only paid→draft is refused), rewriting paid payslips and dropping their TDS challan links; unlock never reverses the ledger posting either. Confirmed | `actions/payroll.ts:845-891`; `lib/ledger/journal.ts:1201` | Never leave PAID; claim each transition with `updateMany where status = from`; reverse the payroll entry on unlock |

### Mediums

| ID | Finding | Where |
|---|---|---|
| R3-05 | Freight and its GST are missing from the GST return files and the e-invoice item list | `lib/ledger/gstn-json.ts`; `lib/einvoice/payload.ts:142-167` |
| R3-06 | Cancelling through the IRN path skips the normal cancel: credit-note applications stay (SEC-04 again), stock isn't reversed | `actions/trade-document.ts:831-847` |
| R3-07 | An IRN can be generated on a cancelled or rejected document; e-way bills on drafts, cancelled invoices and vendor bills; cancelling an invoice ignores a live e-way bill | `actions/trade-document.ts:769`; `actions/eway.ts:540-547` |
| R3-08 | A real workspace can pick the mock e-invoice/e-way provider and print IRNs and e-way numbers the government never issued | `actions/branch.ts:526-539`; `einvoice/provider.ts` |
| R3-09 | Each line's GST rate (0–100) and UAE VAT category are free, with no check against the item or the slabs; credit notes aren't capped per rate or place of supply | `validation/trade-document.ts:29-31`; `documents/create-draft.ts:428-438` |
| R3-10 | Reverse charge changes no arithmetic in India (3B under-states what's payable) and SEZ/export isn't treated as zero-rated in the engine or the IRN. Law: needs validation | `gst-engine.ts`; `ledger/gst-returns.ts`; `einvoice/payload.ts:89-91` |
| R3-11 | The salary bank file uses the account on the profile at download time; HR can change it between lock and transfer unnoticed | `lib/hr/statutory-data.ts:33-63`; `actions/hr.ts` |
| R3-12 | Payroll managers can set their own income-tax declaration (previous TDS, deductions) — SEC-43 through the declaration form | `actions/payroll.ts:1009-1030` |
| R3-13 | Issued letters carry CTC, gross and net pay, readable by line managers and HR without payroll rights | `actions/employee-docs.ts:350-549` |
| R3-14 | Settlement overrides take any value (negative tax), and the preparer can approve; typed PF/ESI/TDS have no floor or second approver | `actions/settlement.ts`; `actions/payroll.ts:193-208` |
| R3-15 | Rejected orders count toward targets, incentives, scorecard, wins and forecast (the filter excludes only pending and cancelled) | `lib/targets/measure.ts:117-246`; `lib/wins/detect.ts`; `actions/forecast.ts:414` |
| R3-16 | Stock leaves without four-eyes approval through the item page, purchase returns and cancelling a posted receipt; goods receipts aren't checked against their PO's lines, quantities or prices | `actions/item.ts:288-359`; `actions/inventory.ts:474-540` |
| R3-17 | Cancelling an order leaves its invoices live and frees the subscription to renew again (a double renewal invoice); progress billing can pass 100% by a double click or through a proforma | `actions/order.ts:1237-1309`; `actions/progress-billing.ts:94-131` |
| R3-18 | View-as still gets round "never your own" on order approval, loss approval, stock approval and incentive decisions | `actions/order.ts:504-894`; `actions/inventory.ts:644`; `actions/incentive.ts:574` |
| R3-19 | Forecast ignores the lead and order rules; "New customers" lists every customer's first invoice to anyone with `performance.view` (HR roles included) | `actions/forecast.ts:60-203`; `actions/new-customers.ts:46-58` |
| R3-20 | A hidden filter flag lets a workbook or marketing audience reach a reseller's end customers | `lib/workspace/filters.ts:132`; `actions/workspace.ts:108`; `lib/marketing/audience.ts` |
| R3-21 | Masked contact names still match search (a letter-by-letter oracle, API included); the company/contact pickers send names unmasked; a person's Activity feed isn't limited to records the viewer may open, and company website changes show in full | `actions/contact.ts:47`; `actions/company.ts:1626`; `lib/activity/timeline.ts:521-559` |
| R3-22 | Marketing staff receive customers' live preference tokens and can re-subscribe someone who unsubscribed from everything, recorded as the contact's own choice. Confirmed | `actions/marketing.ts:1165-1195`; `actions/marketing-public.ts:140-155` |
| R3-23 | Marketing previews, recipient lists and company marketing show contacts' emails and phones unmasked; a builder can retarget an active journey, and journeys skip the approval threshold; campaign approval can be self-approved by taking over a draft | `actions/marketing.ts:166-1000` |
| R3-24 | Closing a workspace leaves its call recordings, unencrypted, in the storage box; bulk duplicate merge is one irreversible click, workspace-wide, including name-only matches | `lib/platform/lifecycle.ts:105-118`; `actions/company-merge.ts` |

**Low:**
- **Payroll and leave:**
  - net pay can go negative and drop out of the bank file;
  - approving leave ignores the payroll lock;
  - HR can type their own opening leave balance;
  - payroll status races;
  - ESI coverage is decided monthly (law).
- **Tax:**
  - place of supply isn't compared with the buyer's GSTIN;
  - the e-way declared value is typed by hand;
  - associating an e-way bill can overwrite a live one;
  - NIC calls have no timeout;
  - the GSTR-2B CSV has no formula guard.
- **Operations:**
  - repeating tasks can farm XP;
  - back-dated stock is allowed in closed periods under periodic inventory;
  - project billing stages have no cap;
  - a recurring-billing cycle change can raise overlapping periods;
  - reseller self-activation;
  - a vendor credit can settle another payer's rebate;
  - incentive awards and targets lack separation of duties.
- **Since 11 Nov:**
  - an uploaded file can pose as a storage-box reference (needs a key leak);
  - a unique field rule reveals values outside scope;
  - renewal reminders can be CC'd to any outside address;
  - someone with `permissions.manage` can lift their own role's lead limit;
  - reopening a closed lead skips the open-leads limit;
  - saving roles isn't refused while viewing as;
  - the staging prefix doesn't isolate environments.
- **Reports and marketing:**
  - account filters reveal masked city or state;
  - a report request returns every row without export rights;
  - the activity export ignores `activity.viewAll`;
  - new tickets by email skip the attachment budget;
  - the lead-capture API ties a visitor to an existing contact by typed email;
  - journey steps load 5,000 contacts each;
  - the Support inbox ignores company scope;
  - marketing uploads read bodies whole;
  - the recording proxy follows redirects;
  - helpdesk mail carries a free-text brand name.

### Checked and found sound

- **Tax credentials:** the government-portal logins are encrypted per GST registration, never returned to the browser and never logged, and no workspace can use another's login. NIC hosts are hard-coded. Issued documents are locked, and the 24-hour IRN cancel window is enforced.
- **TDS:** the sections, the no-PAN rate, aggregate limits and 194Q look right. Law: needs validation.
- **Payroll:** payslip and HR document access are correct. Letters render as text, never through the PDF browser. Bank, ECR and ESI files are quoted and formula-guarded. Salary structures and loans refuse your own. The income-tax maths is sound (slabs, rebate, marginal relief, regime switch).
- **Stock and orders:**
  - the stock engine locks per item and warehouse, refuses negative stock and is idempotent;
  - recurring billing and auto-renewal are idempotent;
  - licence keys need the reveal right and are logged;
  - order approval refuses the author;
  - the reseller contact rule holds on every send path.
- **Reporting:** every source applies its record rule and masks before grouping. Restricted fields never become dimensions. No user input reaches raw SQL. The calculated-field parser has no `eval`. Shared reports run as the viewer, and "Email a report" runs as each recipient. Unmask limits are locked.
- **Storage box:** the account key never leaves the server, blob names never come from users, and workspaces are isolated by folder and by seal.
- **Since 11 Nov:** Access Control writes check authority and keep the super admin's rules. Every lead-creating path respects lead limits.
- **Marketing and calling:** merge tags are escaped, previews are sandboxed, and suppression is checked on every send. Webhooks (WhatsApp, CallerDesk, marketing) are verified. Ticket comments never reach the portal.

### Not reviewed in round three

Tally export (not built); real NIC/IRP behaviour (never called); Form 140/24Q field by field; each state's PT table against its Act; costing arithmetic and stock reports; vendor PO raising; commission payouts; the inbox visitor views; notification digests to people who lost access; the GSTR-2B matcher.

### Round three fix status, 14 Nov 2026

Every High and Medium of round three is fixed except where marked. `npm run check:audit-round3` (five files, 277 checks) proves each fix the way it was broken; every earlier audit check still passes; tsc and lint are clean.

| ID | Status | What changed |
|---|---|---|
| R3-01 | Fixed | Custom patterns with nested repeats, overlapping choices under a repeat, backreferences or lookarounds are refused at save; a value over 200 characters fails a custom rule; every match runs under a 50 ms `node:vm` time limit (proved: `(a+)+b` on 40 "a"s stops in ~55 ms instead of hanging). The word filter runs under the same guard and lets text through on a timeout (fail-open, logged) |
| R3-02 | Fixed | GSTR-1, GSTR-3B, their portal JSON, the B2CL test, the e-invoice minimum and the IRN payload are in rupees at the document's own rate; exports carry `ExpDtls` |
| R3-03 | Fixed; old data needs a reviewed repair | A rerun puts its earnings back to approved, rewrites the payslips and re-attaches them. `scripts/repair-incentives-dropped-by-rerun.ts` lists earnings an earlier rerun dropped; review it with payroll before `--apply` |
| R3-04 | Fixed | Run status moves by a fixed table and never leaves PAID; reopening reverses the wage entry and is refused while TDS challans link to the run; postings are keyed so a run posts once |
| R3-05 | Fixed | Freight is its own line (SAC 996511) in the returns and the IRN; TCS and adjustment go as other charges |
| R3-06 | Fixed | One cancel path (`applyDocumentStatus`) for a status cancel and an IRN cancel |
| R3-07 | Fixed | IRNs only on live issued documents; e-way bills only on goods documents that aren't drafts, cancelled or vendor bills; no cancel while an e-way bill is live; the declared value comes from the document |
| R3-08 | Fixed | Mock and sandbox portals refused in production unless `EINVOICE_ALLOW_TEST_PROVIDERS=1`; the print marks a test IRN |
| R3-09 | Fixed | Indian sales rates limited to the GST slabs; a rate other than the item's needs a "Rate: …" reason line; credit notes capped per rate and tax head at save and at issue, on the invoice's place of supply |
| R3-10 | Fixed, confirm with a CA | SEZ and exports are inter-state with SEZWP/SEZWOP/EXPWP/EXPWOP/DEXP; reverse charge is a 3.1(d) liability with credit under ISRC |
| R3-11 | Fixed | Bank details copied onto the payslip at lock and the bank file built from the copy; bank changes named in the audit, notified, and refused while the person's run is locked |
| R3-12 | Fixed | Own tax declaration refused, also while viewing as; previous or other TDS needs a note |
| R3-13 | Fixed | Letters freeze pay only for pay letters drafted by payroll; managers get no pay figures |
| R3-14 | Fixed | Settlement overrides validated with reasons, approver ≠ preparer; fixed PF, ESI or TDS below the statutory figure needs a reason; PF on at ₹0 is an ECR problem |
| R3-15 | Fixed | Targets, scorecard, wins and forecast count only approved, processing and fulfilled orders; cancelling an order or issuing a credit note holds the open incentive earnings it fed into for review |
| R3-16 | Fixed | With approval on, the item page can't take stock out; purchase returns and cancelling a posted receipt go through approval; RETURNED needs `inventory.adjust`; receipts are checked line by line against their PO (item, quantity, price) |
| R3-17 | Fixed | An order with a live invoice can't be cancelled (its drafts are cancelled with it); progress billing is locked per quote and counts invoices reached through a proforma; a staged quote can't be converted to a proforma |
| R3-18 | Fixed | View-as refused on order, loss, price-increase, stock, incentive, award and target decisions |
| R3-19 | Fixed | Forecast goes through the lead, order and asset rules; "New customers" through the company and document rules, its download needs `data.exportFinance` |
| R3-20 | Fixed | The reseller flag is honoured only by report sources and stripped everywhere else |
| R3-21 | Fixed | Masked names aren't searched or sorted on; pickers scoped and masked; the Activity feed checks each record and masks company changes; filters on masked city, state or website dropped; reports capped at 200 rows without export rights; the activity export follows `activity.viewAll` |
| R3-22 | Fixed | Message rows reach staff without token or body; samples use a dummy token; re-subscribing after a blanket unsubscribe needs the double opt-in email; IP and browser recorded as evidence |
| R3-23 | Fixed | Marketing previews masked; editing a running journey without `marketing.send` pauses it; a large journey needs approval by someone else; a campaign's editor or requester can't approve it |
| R3-24 | Fixed | Closing a workspace deletes its storage-box folders and recordings; new recordings are sealed; bulk merge leaves out name-only pairs, needs the workspace name typed, is capped at 25 a call and 200 a day, and tells account managers |

Lows fixed with them:
- **Payroll and leave:**
  - net pay can't go negative;
  - leave in a locked month is refused;
  - HR can't type their own opening leave balance;
  - payroll status is claimed atomically;
  - ESI coverage is held per contribution period (confirm with a CA).
- **Tax:**
  - a place-of-supply warning against the buyer's GSTIN;
  - NIC timeouts;
  - a duplicate IRN is matched before being adopted;
  - the GSTR-2B CSV is formula-guarded.
- **Operations:**
  - XP from repeating tasks is limited;
  - stock movements are refused in closed periods;
  - project stages are capped and linked one-to-one;
  - recurring-billing cycle changes are guarded;
  - reseller activation needs a second person;
  - rebates are paid only by their own vendor;
  - no awarding or approving your own incentive or target.
- **Since 11 Nov:**
  - storage-reference lookalikes are refused;
  - unique-rule answers are generic and rate-limited;
  - renewal CC goes only to your own people's domains;
  - you can't lift your own role's lead limit;
  - reopening a lead counts against the open-leads limit (migration `20261214300000_lead_limit_reopen`);
  - role saves are refused while viewing as;
  - the storage prefix is documented as not isolating environments.
- **Reports and marketing:**
  - ticket attachments stay within budget;
  - the visitor link only goes to a contact the submission created;
  - journey steps read only their own recipients;
  - the Support inbox is scoped;
  - marketing uploads are capped;
  - the recording proxy re-checks each redirect;
  - helpdesk mail says "via Deskzo".

**Still open:**
- **Payroll:** limiting non-pay letter fields per type; the repair of earnings dropped by earlier reruns needs a person to review it.
- **Tax:**
  - a provider column for an exact test-IRN mark, and LUT, shipping-bill and port fields for full export details;
  - the rate-override reason is audit-logged on create only;
  - the slab rule also refuses old off-slab rates on import.
- **Reseller:** pricing has no approver (needs columns).
- **Word filter:** a timeout lets text through unfiltered (fail-open); decide whether it should hold the message instead.
- **Contact masking:** `check:contact-masking` section 7 (leads export, Activity, mail log, inbox showing raw email and phone) fails the same way on the committed code. It's an older gap, not from this round, still to trace.

**Deploy:**
- Run `npm run tenants:migrate` for `20261214100000_payslip_bank_copy` and `20261214300000_lead_limit_reopen`.
- Set `EINVOICE_ALLOW_TEST_PROVIDERS=1` only on a staging server that runs in production mode.
- Before relying on the round-three GST treatment, confirm with your CA: SEZ/export, reverse charge in 3B, freight at SAC 996511, the slab list, ESI periods and the PF floor.
