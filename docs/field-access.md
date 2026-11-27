# Field access, unmasking and the unmasking log

What a person sees of a lead's, a contact's and a company's sensitive fields, how they reveal one, how many they may reveal a day, and the log a super admin reads.

- **The rules** are in `src/lib/authz/field-policy.ts` (what the answers mean) and `src/lib/authz/fields.ts` (resolving them for one person).
- **The presenters** apply them, one per record type:
  - leads: `src/lib/leads/masking.ts`;
  - contacts: `src/lib/contacts/masking.ts`, and `src/lib/contacts/redaction.ts` for text that quotes a contact;
  - companies: `src/lib/companies/masking.ts`.
- **Revealing** goes through `src/lib/authz/unmask.ts`.

Last brought up to date on 5 Nov 2026, with the Phase 3 masking fixes (waves A and B, `DESKZO_PERMISSION_SYSTEM_AUDIT.md` C.2, C.3, H.4, H.5).

## The fields

Field access covers three record types: **leads**, **contacts** and **companies** (`FIELD_ENTITIES`). Each covers its built-in fields and its own custom fields.

**Leads**

| Field | Key | Masks it offers | Example |
|---|---|---|---|
| Lead name | `title` | first letter, stars | `A********` |
| Company name | `companyName` | first letter, stars | `A********` |
| Contact name | `contactName` | first letter, stars | `R********` |
| Email | `email` | email, first letter, stars | `s*****@g***.com` |
| Phone | `phone` | country code and last four, country code only, stars | `+91 ******4321` |
| Address | `address` | stars, city only, first letter | `********, Pune` |
| Lead source | `source` (and its particulars) | stars, first letter | `********` |
| Enquiry details | `description` | first letter, stars | `W********` |
| Each custom field on leads | `custom:<key>` | as its type: an email, phone, choice or text field's masks | `********` |

**Contacts**

| Field | Key |
|---|---|
| Name | `name` |
| Email | `email` |
| Phone | `phone` |
| Each custom field on contacts | `custom:<key>` |

A masked phone can still be called and messaged on WhatsApp. The server dials the contact by its id; the number never reaches the browser.

**Companies**

| Field | Key | Covers |
|---|---|---|
| Address | `address` | Every location's street, city, state and PIN code. Its country stays. "City only" leaves the city. |
| GSTIN | `gstin` | Every location's GST number. |
| PAN | `pan` | The company's PAN. Every GSTIN carries it too, so mask GSTIN as well to hide it. |
| Website | `website` | The company's website. |
| Each custom field on companies | `custom:<key>` | The Companies set (not a vendor's own set). |

Two things are never masked:

- **A company's name.** It is the record's identity, the label on every order, ticket, invoice and payment.
- **Trade documents.** An invoice's party address, GSTIN and PAN are printed as issued, because the document is the workspace's own legal record.

**A lead's company and contact.** A lead page shows its company's website and address. They follow the companies policy as well as the lead's own `address` rule, and are masked if either masks them (audit H.4.1). The companies policy here gives its list answers, with today's reveal of the company honoured. The lead's `companyName`, `contactName`, `email` and `phone` keys still follow the lead's own rules.

Every mask is a fixed eight stars, so a mask never gives away how long the value is.

## A policy

Each field has these settings, for a role (`role_field_policies`) or for one person (`user_field_policies`, with a reason and an optional end date):

- **View field.** Off means *restricted*: the value is never sent. The word "Restricted" goes in its place, and the field can't be searched, filtered or edited.
- **Mask in list.** Applies to lists, boards, pickers, search results, dashboards, reports, exports and previews in other modules. A record shown beside another record counts as a preview too, such as a lead's company on the lead's page.
- **Mask in detail.** Applies to the record's own page: the lead's page, a customer's Contacts tab, the company's page.
- **Allow unmask.** Whether the person may reveal a masked value with **Show** (see below). Nothing is revealed just by opening a page.
- **Export** (`none`, `masked` or `clear`; blank means "as the list"). How the field goes out in exports and API lists:
  - `none` leaves the column out;
  - `masked` masks it even where the list shows it in the clear;
  - `clear` sends it in the clear only where the person may see it in the clear somewhere.
- **Mask format.** One of the masks in the tables above.

Masking never grants reading: a field can't be masked or unmasked if it can't be viewed. With nothing set, a field is visible and unmasked, exactly as it was before field access existed.

**The master switch** ("Field masking") is on Settings › Staff › Unmasking logs, and above a role's Field Permissions. Only the super admin can change it. Off, every masked field is shown in the clear and there is nothing to reveal. A restricted field stays restricted. The switch is read on every masked read path (`src/lib/authz/masking-switch.ts`).

**Precedence** (`resolveFieldPolicies`):

1. The super admin sees everything.
2. A deactivated account sees nothing.
3. A person's own unexpired policy applies.
4. Otherwise their role's.
5. Otherwise the field is open.

**Who may change it.** The same rule as permissions: nobody gives anyone more than they see themselves (`withinPolicy`), measured against the stored rules even while masking is switched off.

- A daily limit can't be raised above the giver's own.
- Nobody changes their own.
- Only the super admin changes the super admin's.
- Every change is written to the permission history as `field:<entity>:<field>` or `unmask:dailyLimit`.

## Where it's applied

Everything runs on the server before a value is put in a response. Nothing is masked in the browser.

**Leads**

- The list, the board and the split view.
- The header search.
- The lead's own page (`getLead`). A field masked or restricted there can't be edited until it's revealed: the title, description, contact and custom fields are all locked.
- Lead previews elsewhere: tasks, visits, calls, notes, documents, the calendar, the dashboard, a company's Leads tab, exports and analytics.

**Contacts**

- The Contacts directory, a customer's Contacts tab, search and pickers.
- Calls, the mail log, the inbox, the activity feeds, exports, API v1 and the app.

**Companies**

- The company's page and its forms.
- The Companies, Customers and Vendors lists, the create form's matches and global search.
- API v1, the app, the copilot, reports, the parties export and the account workbook.
- Each lead's page, for the company's website and address.

**Saving a form that showed masked values keeps what is stored.** A masked field is left out of the form, or sent back masked, and the save keeps the real value.

**Free text that quotes a record's fields** is redacted for the person reading it:

- `leadRedactor` covers a lead's description, lost reason, activity notes, tasks, visits, documents and meetings, and won-deal celebrations. On the lead's page it includes the company's address under both policies.
- `contactRedactor` covers text that quotes a contact.
- Each concealed value is replaced wherever it appears. Values under three characters are left alone.

**Search and filters** match only what the person sees in the clear in a list. Matching a masked value would reveal what it holds.

**API v1 and the app.** A single-record read uses the list answers unless the caller revealed that record today. A list uses the list answers plus the field's Export setting (audit M-11).

**Shared screens.** The TV wins screen masks for the workspace's most restrictive policy, not for the person who paired it (audit M-13).

**The guard.** `npm run check:masking-guard` fails on any read of a masked column outside the presenters. A file that does this must either be listed with a reason, or be a known gap that names what it leaks.

## Revealing, and the daily limit

**Show** is always a click; nothing is revealed by opening a page (audit M-10). It sits:

- on a lead's page (`LeadUnmask` → `unmaskLead`);
- on each row of the Leads list;
- beside a masked contact (`ContactReveal` → `unmaskContact`);
- on a company's page, beside its name and links (`CompanyReveal` → `unmaskCompany`).

Show opens a small panel with an optional reason. The reason is tidied to one line, capped at 200 characters, and kept on the log row. Every reveal goes through one function, `revealRecord(userId, entity, recordId, fields, reason?, { family })` (audit H.4.5).

### What one reveal covers

- **The fields it revealed, for the rest of the business day.**
  - These are the fields masked on that record that the person may unmask.
  - A field they're given unmask for later the same day stays masked until they press Show again (audit C.3.6). That second reveal is logged as a new event and uses no extra unit.
- **The record's family** (audit H.5). Revealing a lead also reveals its contact and its company for the day. Each family member:
  - is revealed at no unit of its own, as a usage row with `includedWith` set to the lead;
  - has its own log row with its entity, id and fields;
  - is revealed only where the person reaches it (the record engine's contact and account rules) and may unmask something on it.
- **Where it shows.** A revealed record's fields show in the clear wherever the person meets it and the presenter knows which record it is:
  - a contact: in lists and on a customer's Contacts tab;
  - a company: on its page, in the company lists and on its leads' pages;
  - a lead: on its page and on the Leads list.
- **Where it doesn't.** Exports, the copilot, reports and API lists keep the list answers.
- **Reading only.** A revealed company's fields are still left out of its forms, whose saves keep what is stored.

### The daily limit

- **It counts records, of any kind, per person per business day.** Revealing a lead, contact or company for the first time that day uses one unit. A repeat is free, and so is a family member.
- **The business day is the workspace's.** It runs from midnight to midnight in the workspace's time zone (`workspaceClock().dateKey()`).
- **Where it's set:**
  - on the role, or as the person's own limit, which overrides their role's;
  - from 1 to 10,000 a day, or "no limit".
- **The workspace default.** Someone who may unmask something, with no limit of their own or their role's, gets the workspace's default (`unmask_settings`, 25 a day when nothing is stored) instead of no limit. "No limit" is only ever an explicit choice. The default is set by the super admin beside the master switch.
- **Two tabs can't both take the last unit.** `revealRecord` takes a transaction-scoped advisory lock on (person, day), counts, then writes the usage and the log row in the same transaction. Usage is unique per person, day, entity and record (`unmask_usage`).
- **Possible results:**
  - `ALLOWED`: revealed. A unit is used, unless this is more fields of a record already revealed today.
  - `REPEAT`: already revealed today; nothing is used.
  - `QUOTA_EXHAUSTED`: the limit is reached and the fields stay masked.
  - `DENIED`: the person may not unmask, can't open the record, or is being viewed as by an admin. Under view-as, the request is refused and logged with who was really at the keyboard.

## Where it's set

- **A role:** Settings › Staff › Roles & Permissions › the role › Field Permissions. One card per record type, each with an Export column, plus the role's daily limit. Each change saves as it is made.
- **One person:** Settings › Staff › Users › the person › Field Permissions. This shows the same panels, with where each field's answer comes from. Nothing is saved until **Save changes**, which saves every change on the page with one reason and an optional end date. **Reset to role defaults** removes all of them.
- **The workspace:** the master switch and the default daily limit, drawn together on Settings › Staff › Unmasking logs and above each role's Field Permissions. Both are the super admin's.

## The unmasking log

**Settings › Staff › Unmasking logs.** Every attempt is listed, with filters for when, who, record and result. It is paged and can be exported to CSV.

- **Who can read it:** the workspace's super admin, acting as themselves (`actingAsSuperAdmin`). Nobody else can, not even another admin, and not even the super admin while viewing as somebody.
  - Every action checks this again: `mayReadUnmaskLog` runs on each call.
  - The menu entry is hidden from everybody else.
  - A refused export is itself logged.
- **It holds no values.** A row records:
  - the person and who was viewing as them;
  - the record type (`entity`), its id (`recordId`), how it was named at the time, and the names of the fields concerned;
  - for back-compat, `leadId`, which holds a lead's id, `contact:<id>` or `company:<id>`;
  - the reason the person gave;
  - the result, whether a unit was used, the count and the limit at the time;
  - the request id, the IP address and the browser.
- **It is a hash chain** (audit H.4.8). Each row carries its place (`seq`), the previous row's hash and its own, which is sha256 of that hash and the row's canonical JSON. `verifyUnmaskChain` walks the chain and names the first row that doesn't hold. The log page says "Log intact" or names that row, and the CSV carries every row's place and hashes.
- **Nobody can change or remove a row.** A trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` on `unmask_events`.
  - Deleting a person keeps their events.
  - The workspace data reset archives the log where it is instead of emptying it.
  - The chain can't detect the newest rows being removed, or the whole chain being rewritten by someone who owns the database. That needs the log tables owned by a separate database role, which is operations' part.

## What it doesn't cover

These are known boundaries:

- **Text written about a record somewhere else, and shown there**, is stored as it was written and isn't masked: notifications, the activity log's record labels, meeting titles in the calendar itself, and email subjects in the mail log.
- **A referral's particulars** ("Referred by X at Y") name the referrer's company. They're shown unless Lead source is masked.
- **Reads not yet refitted.** `check:masking-guard` lists each unmasked read that is still open (`KNOWN_GAPS`), with what it leaks.

## Migrations

All are additive.

- `20261110100000_field_access_unmask`: the policy, limit, usage and log tables, the `roles.active` column, and the append-only trigger.
- `20261110110000_role_activation_history`: the role switched off/on history kinds.
- `20261110120000_retire_report_inheritance`: makes inherited permissions explicit. See `docs/permission-redesign.md`, phase 5.
- `20261130080000_field_masking_switch`: the master switch.
- `20261205090000_unmask_entity_chain`, all backfilled in place:
  - the usage and the log gain `entity` and `recordId`, and usage gains `includedWith`;
  - the log gains the stated reason and the hash chain, and refuses `TRUNCATE`;
  - `unmask_settings` holds the default limit.
- `20261205110000_field_policy_export`: the policies' `export` column.

**Switching masking off** for a role means clearing its policies, on screen or by deleting its `role_field_policies` rows. Nothing else depends on them. To switch it off for the whole workspace, use the master switch.
