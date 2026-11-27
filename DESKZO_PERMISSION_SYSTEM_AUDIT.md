# Deskzo — Permission System Audit & Architecture Review

| | |
|---|---|
| **Type** | Audit only. No source code, schema, migration or data was changed for this audit |
| **Code audited** | `main` at `4dbf6cd0` (2 Nov 2026) |
| **Method** | Static tracing of the code, with file:line references throughout. Helper classifiers (TypeScript AST) inventoried server actions, routes, pages and permission-key usage. Findings marked *verified* were re-read line by line; nothing was executed against the app or a database for this audit |
| **Scope** | RBAC architecture, permission inventory, masking/unmasking, lead limits, roles, authorization enforcement (actions, APIs, pages, exports, bulk), workspace isolation, audit logging, Developer View evaluation |

## Executive summary

**How it works.** Deskzo has one permission resolver, and every server action and API path goes through it:
1. **Permission keys:** 194 of them, held per role, with per-person exceptions that can expire.
2. **Record reach:** OWN, TEAM, BRANCH, ALL or FOLLOW, for each of 13 record types and 4 actions. These compile into database `where` clauses.
3. **Field masking:** applies to leads only.

On top of that:
- **Super admin:** exactly one per workspace, enforced in the database.
- **Workspace isolation:** each workspace has its own database.
- **Module gating:** the plan, the company's module switch and the section keys decide which modules open.

**What is solid:**
- Workspace isolation; no cross-workspace path was found.
- Server-side page gating on every page sampled.
- Record scope on most id-based actions.
- API key scoping.
- The unmask quota's locking and its log, which never stores values.

**What needs fixing:**

| Severity | Count | Findings |
|---|---|---|
| Critical | 1 | Field masking can be bypassed through the linked contact and company records |
| High | 6 | Role change can confer more than the changer holds; anyone with `users.manage` can create a hidden-role account; the lead page's activity feed leaks masked values; the role editor's advice for closing the leak doesn't work; an export loophole; the leads importer ignores record scope |
| Medium | 17 | Listed in section E |
| Low | 11 | Listed in section E |

**What is missing entirely:**
- lead limits or quotas of any kind;
- field policy for contacts and companies;
- a Developer View.

Key numbers:

| | |
|---|---|
| Modules | 48 (`MODULE_REGISTRY`), each with a `section.*` key |
| Permission keys | 194 (48 section + 146 capability) |
| Built-in roles | 14, plus the hidden `SUPPORT_READONLY` and any custom roles |
| Record-level matrix | 13 record types × 4 actions |
| Masked lead fields | 8 built-in, plus every lead custom field |
| API key scopes | 12 |
| Server actions | 2,058 exported |
| API routes | 160 |
| Dashboard pages | 313 |

---

## A. Existing Architecture

### A.1 Workspace isolation (tenancy)
- **One database per workspace.** `db` (`src/lib/db.ts:83-`) is a proxy that resolves `currentTenant()` on every call (`src/lib/tenancy/resolve.ts:77-99`), in this order:
  1. an explicit `runAsTenant` async context (`resolve.ts:38`);
  2. the request host;
  3. a legacy fallback, used by scripts only.
- **Per-workspace data.** Roles, grants, users and every record live in that workspace's own database. The control plane (`prisma/control/schema.prisma`) holds tenants, plans and platform staff.
- **Hidden accounts.** User and role listings automatically exclude the SUPPORT and AUTOMATION accounts and the `SUPPORT_READONLY` role (`src/lib/db.ts:58-69`).

### A.2 Who is asking
| Channel | How the user is established | Evidence |
|---|---|---|
| Browser session | `auth()` checks that the token's workspace matches the current workspace, then re-reads name, role and kind from the database on every request (the JWT's role is never trusted). `requireUser()` then runs the access gate (device, network and lock rules; verdicts cached 20 s) and substitutes the "view as" target if one is active | `src/lib/auth.ts:321-347`; `src/lib/session.ts:43-54`; `src/lib/access/gate.ts:50, 183-196` |
| Public API v1 | API key plus secret. Then the person's standing, then that they still hold `api.manage` (checked on every call), then the key's scope (12 scopes). The call runs as that person (`runAsApiActor`), so every normal action check applies | `src/lib/api/handler.ts:174-246`; `src/lib/api/scopes.ts:9-22`; `src/lib/api/actor.ts:34-51` |
| Mobile app | Phone token plus an APPROVED device, then `personRefusal`, then `runAsApiActor` with `channel:"app"` | `src/lib/app/handler.ts:174-220` |
| Biometric terminals | Registered, active, non-removed serial; workspace found by host or serial route | `src/app/api/biometric/iclock/[[...path]]/route.ts` |

### A.3 Resolving a permission
`resolveUserPermissions` (`src/lib/authz/resolve.ts:96-194`) is the single resolver. `can(userId, key)` reads it. The first rule that fires wins:

| # | Rule | Evidence |
|---|---|---|
| 0 | Missing user, or the AUTOMATION account → nothing | `resolve.ts:109-112` |
| 1 | `isSuperAdmin` → everything | `:116-119` |
| 2 | Inactive user → nothing | `:123-126` |
| 2b | Role switched off (`Role.active=false`) → nothing | `:129-132` |
| — | `SUPPORT_READONLY` → every key matching `/\.view(?:[A-Z]\w*)?$/`, nothing else | `:84, :139-142` |
| 3 | Unexpired `UserPermission` row → its `allowed` (a personal deny beats the role) | `:146, :157-166` |
| 4 | `RolePermission` row → its `allowed` | `:170-174` |
| 4a | Role `ADMIN` → allow (`adminDefault`) | `:179-182` |
| 4b | Registry default (`everyone` or `defaultRoles`) | `:184-187`; `src/lib/permissions.ts:1534-1536` |
| 5 | Otherwise deny | `:190` |

- **Unknown keys:** an unknown key throws in development and is denied in production (`resolve.ts:203-212`).
- **Caching:** the resolver is cached per request only, with React `cache()`. There is no cross-request permission cache, so a change applies on the next request.
- **Oracle protection:** `hasEffectivePermission` and `navPermissions` refuse to answer about another person unless the caller holds `permissions.view`. `viewerHas` answers only about the session user (`src/actions/permission.ts:36-56`).
- **Manager inheritance:** retired. `delegable` is now display-only (`resolve.ts:29-35`, `permission.ts:91`).

### A.4 Modules, plans and sections
`decideModuleAccess` (`src/lib/navigation.ts:58-71`) checks four conditions, in order:
1. The module is in the plan (`moduleEntitled`, `src/lib/entitlements.ts:105-112`; no entitlements means core only).
2. The company has switched it on.
3. The module's `viewPermission` is held.
4. Its `section.<module>` key is held.

It feeds the sidebar (`buildNavigation`) and pages (`isModuleEnabled`/`moduleAccess`, `src/actions/module.ts:47-55`).

**Server actions mostly use `requireModuleUser`, which checks the plan only** (`src/lib/modules-access.ts:98-117`; 163 action files). The section switch and module switch are therefore enforced on pages and menus, not uniformly in actions (see E).

### A.5 Record-level access (OWN / TEAM / BRANCH / ALL / FOLLOW)
All of this lives in `src/lib/authz/access.ts`. There are 4 actions (view, edit, delete, assign; `:63`) across 13 record types (`:66-80`). Allowed levels and actions per type are defined at `:111-261`.

**Where a level comes from** (`:336-410`), first match wins:
1. Super admin → ALL.
2. Inactive person or role → NONE.
3. `SUPPORT_READONLY` → view only.
4. The person's `UserAccessLevel`.
5. The role's `RoleAccessLevel`.
6. Derived from permissions (e.g. `companies.viewAll` → ALL, otherwise TEAM; `leads.view` → FOLLOW).

**How a level becomes a Prisma `where`:**

| Level | Reaches |
|---|---|
| OWN | `[self]` |
| TEAM | Self plus downline (`getDownlineUserIds` via `User.managerId`) |
| BRANCH | People in the same `User.branchId` |
| ALL | No filter |
| FOLLOW | "If you reach its company" (`throughAccount`) |

- Accounts filter on `ownerUserId` and `sideOwnerUserId` (`:485-512`).
- `under()` nests the actions: edit ⊂ view; delete and assign ⊂ edit and view (`:280-284, :515-534`).
- Older helpers remain: `scope.ts` and `company-scope.ts` still do `viewAll` plus downline.

### A.6 Field-level access
Per-field policies cover **leads only**: `RoleFieldPolicy`, `UserFieldPolicy`, the daily unmask limits, `UnmaskEvent`, and a workspace master switch (see C).

### A.7 Impersonation ("view as")
`startViewingAs` (`src/actions/impersonation.ts:33-108`) requires role ADMIN **and** `impersonation.use`. Rules:
- No chaining.
- Only a super admin may view as a super admin.
- Only targets holding nothing beyond what the admin could grant (`holdsNothingBeyond`, `src/lib/impersonation.ts:94-104`).

The ticket is an encrypted cookie bound to the actor, valid for one hour and re-checked on every request. While viewing:
- every check runs as the target;
- `actingAsSuperAdmin` is false;
- audits record the impersonator;
- password resets, user deletion, bulk user edits and unmasking are refused.

### A.8 Super-admin-only operations (by flag, not by permission key)
These go through `actingAsSuperAdmin`:
- deleting a lead, an attendance day, a ticket, an order, or a non-vendor company;
- "delete all leads";
- the unmasking log;
- the masking switch;
- the permissions Excel export;
- the legacy CRM import.

Evidence: `src/actions/super-admin-delete.ts:31, 57`; `ticket.ts:339`; `company.ts:2013`; `company-delete.ts:37`; `delete-all-leads.ts:16`.

## B. Complete Permission Inventory

### B.1 Roles that exist

**Roles are database rows.** `Role` is a table (`prisma/schema.prisma:28-67`). `User.role` is a single foreign key, so **each person has exactly one role**; there are no multiple role assignments.

**Built-in (system) roles**, 14 in total (`src/lib/roles.ts:44-59`), with the number of permission keys each holds by default (excluding `section.*`):

| Role | Default keys | Notes |
|---|---|---|
| ADMIN | all | Holds every key unless explicitly denied (`adminDefault`, `src/lib/authz/resolve.ts:179-182`) |
| MANAGEMENT | 105 | |
| ACCOUNTS | 44 | |
| SALES | 27 | |
| PURCHASE | 27 | |
| SUPPORT | 25 | |
| CALLING | 16 | |
| PROFILE | 14 | |
| SALES_MANAGER | 6 | |
| RENEWAL_SPECIALIST | 4 | |
| HR | 3 | |
| HR_HEAD | 3 | |
| RECRUITER | 0 | |
| EMPLOYEE | 0 | |

**Other roles and role-like flags:**
- **Hidden role:** `SUPPORT_READONLY` (`roles.ts:67`), for platform support. Its row is inserted by migration `20260926180000_support_users`.
- **Custom roles:** `createRole` (`src/actions/role.ts:68-117`) creates a role holding only the section keys. Duplicating an existing role is supported. System roles can't be deleted or switched off. A role can't be deleted while anyone holds it.
- **Super admin:** a per-user flag (`User.isSuperAdmin`), **exactly one per workspace**, enforced by the database:
  - a partial unique index;
  - triggers that refuse deleting or demoting the last super admin;
  - a CHECK that a super admin is an ADMIN.

  There is no in-app grant. It is transferred only by `scripts/grant-super-admin.ts`, and the first is created at provisioning (`src/lib/platform/bootstrap-owner.ts`).
- **"Workspace owner"** means the super admin. The control plane's `Tenant.ownerEmail` is used for mail only.
- **Manager, Team Leader, Staff:** these exist only as the reporting line (`User.managerId`, which defines TEAM reach) and as the built-in roles above. There is **no role hierarchy** apart from ADMIN's default-allow.
- **Presets:** 22 permission bundles defined in code (`src/lib/authz/presets.ts`).

### B.2 Permission keys: 194 in total (`src/lib/permissions.ts`)

| Group | Keys | Notes |
|---|---|---|
| Sections (`section.<module>`) | 48 | One per module in `MODULE_REGISTRY` (1:1, verified by script). `everyone:true`, non-delegable. Gate the menu and pages |
| Sales & customers | 32 | |
| Finance | 31 | |
| Administration | 26 | |
| Orders & fulfilment | 12 | |
| People & HR | 12 | |
| Data import & export | 10 | No default roles; all non-delegable |
| Support | 9 | |
| Marketing | 7 | |
| Performance | 5 | |
| IT assets | 2 | |

**Flags:**
- `delegable:false`: 88 keys.
- `superAdminOnly`: 8 keys (`backups.download`, `backups.restore`, `users.assignRole`, `billing.manage`, `security.manage`, `impersonation.use`, `data.exportUsers`, `data.importUsers`).
- `adminOnly`: 1 key (`files.view`).
- `selfExcluded`: 10 keys (you can't approve your own).
- Risk tiers: 34 keys are sensitive and 17 critical.

**Every key by group:**
- **Sales & customers.**
  - Leads: `leads.view`, `leads.create`, `leads.assign`.
  - Accounts: `accounts.reassign`, `accounts.handOffOwn`, `companies.viewAll`, `companies.merge`, `companies.changeRole`, `companies.manageCategories`.
  - Contacts: `contacts.view`, `contacts.directory`, `contacts.viewRestricted`.
  - Activity: `activities.viewAll`, `calls.view`, `emails.view`, `meetings.schedule`, `visits.view`, `visits.viewAll`, `notes.broadcast`.
  - Documents: `documents.issue`, `documents.send`, `documents.void`, `documents.notes`.
  - Feedback and wins: `feedback.request`, `feedback.viewAll`, `forecast.manage`, `wins.manage`, `wins.tv`.
  - Other: `commissions.view`, `workspace.manageAny`, `pipeline.manage`, `booking.manage`.
- **Orders & fulfilment:**
  - Orders and products: `orders.view`, `orders.approve`, `orders.approveLoss`, `orders.process`, `purchase.raiseOrders`, `products.edit`, `products.delete`, `catalog.manage`, `vendors.delete`.
  - Projects: `projects.manage`, `projects.viewAll`, `projects.credentials`.
- **Finance:**
  - Payments: `payments.view`, `payments.record`, `payments.delete`, `payments.manage`.
  - Expenses and rebates: `expenses.approve`, `expenses.reimburse`, `expenses.viewAll`, `rebates.view`, `rebates.manage`.
  - Books and close: `purchase.reconcile`, `ledger.post`, `ledger.viewReports`, `ledger.manageAccounts`, `books.close`, `revenue.viewReports`, `revenue.manage`, `close.work`, `close.manage`.
  - Inventory: `inventory.view`, `inventory.receive`, `inventory.transfer`, `inventory.adjust`, `inventory.approveAdjustments`, `inventory.manage`.
  - Other: `vouchers.create`, `vouchers.approve`, `accounts.configure`, `statements.view`, `collections.followUp`, `credit.override`, `documents.view`.
- **Support:** `tickets.view`, `tickets.create`, `tickets.delete`, `tasks.delete`, `visitors.view`, `visitors.manage`, `projects.view`, `inbox.view`, `inbox.viewAll`.
- **Marketing:** `marketing.manage`, `marketing.send`, `marketing.approve`, `marketing.viewAll`, `forms.create`, `forms.manageAll`, `signatures.manage`.
- **People & HR:**
  - HR: `hr.manage`, `hr.viewAll`, `hr.approveLeave`, `hr.approveExpenses`, `hr.approveAttendanceExceptions`, `hiring.manage`, `payroll.manage`, `files.view`, `people.handover`.
  - Engagement and cards: `engagement.readFeedback`, `engagement.manage`, `cards.manage`.
- **Performance:** `performance.view`, `targets.manage`, `targets.viewAll`, `incentives.manage`, `incentives.approve`.
- **IT assets:** `assets.manage`, `assets.viewAll`.
- **Data import & export:** `data.exportCrm`, `data.importCrm`, `data.exportFinance`, `data.importFinance`, `data.exportCatalog`, `data.importCatalog`, `data.exportPeople`, `data.importPeople`, `data.exportUsers`, `data.importUsers`.
- **Administration:**
  - Access and users: `permissions.view`, `permissions.manage`, `users.manage`, `users.lock`, `users.assignRole`, `impersonation.use`, `access.approveDevices`, `access.viewSignIns`.
  - Settings and security: `settings.manage`, `billing.manage`, `security.manage`, `api.manage`, `portal.manage`, `fields.manage`, `fields.seeRestricted`, `fields.revealSecrets`.
  - Backups: `backups.manage`, `backups.download`, `backups.restore`.
  - Vault: `vault.use`, `vault.viewAll`, `vault.manageTags`.
  - Other: `activity.viewAll`, `activity.export`, `copilot.use`, `help.manage`.

### B.3 Actions per module (only what exists)

| Module | Permission keys | Record-level actions (`access.ts`) | Absent / notes |
|---|---|---|---|
| Dashboard | None of its own; widgets are gated by module access plus a per-widget permission (`src/lib/dashboard-widgets.ts:38-44`) | — | No dashboard key |
| Leads | `leads.view`, `leads.create`, `leads.assign`, `accounts.reassign`, `accounts.handOffOwn`, `pipeline.manage` | view / edit / delete / assign | **Delete** is super-admin-only, with no key. Import and export only through `data.importCrm` / `data.exportCrm` (plus the leads screen's export with the row cap). No edit key: edit = record level |
| Contacts | `contacts.view` (also needed to add one), `contacts.directory`, `contacts.viewRestricted` | view / edit / delete / assign (NONE / FOLLOW / ALL) | No create key |
| Companies / Customers / Vendors | `companies.viewAll`, `companies.merge`, `companies.changeRole`, `companies.manageCategories`, `vendors.delete`, `accounts.reassign` / `handOffOwn` | companies: view / edit / delete / assign; vendors: view / edit / assign | Non-vendor delete is super admin only; create needs module access only |
| Deals / Orders / Pipelines | `orders.view`, `orders.approve`, `orders.approveLoss`, `orders.process`, `purchase.raiseOrders`, `products.edit` / `delete`, `rebates.*`, `credit.override`, `documents.*`, `pipeline.manage`, `forecast.manage` | orders and documents: view / edit / delete / assign | No Deal model (the pipeline is leads). Order delete is super admin only |
| Tasks | `tasks.delete` (+ `section.tasks`) | view / edit / delete / assign | No create key; view, edit and assign default to ALL |
| Activities | `activities.viewAll`, `calls.view`, `emails.view`, `meetings.schedule`, `notes.broadcast` | view / edit | `activity.viewAll` / `activity.export` are the security log |
| Campaigns / Marketing | `marketing.manage` / `send` / `approve` / `viewAll`, `forms.create` / `manageAll`, `signatures.manage` | — | — |
| Reports / Analytics | `section.reports` only for the report builder; `performance.view`, `targets.*`, `incentives.*`, `ledger.viewReports`, `revenue.viewReports` | — | No report-builder key: rows are scoped by each source's record access |
| Team / User management | `users.manage`, `users.assignRole`, `users.lock`, `permissions.view` / `manage`, `people.handover`, `impersonation.use` | — | User delete is super admin only |
| Settings | `settings.manage` (39 catalogue entries), `security.manage`, `fields.*`, `help.manage`, `accounts.configure`, `portal.manage`, `backups.*`, `catalog.manage` | — | — |
| Integrations / Automate / API | `api.manage` + 12 API key scopes; Automate requires `settings.manage` | — | — |
| Notifications | `section.notifications` only | — | — |
| Import / Export | 10 `data.*` keys | — | — |
| Billing | `billing.manage` | — | — |
| Custom modules | **No custom modules exist**. There are custom *fields* per record type (`fields.manage`, `fields.seeRestricted`, `fields.revealSecrets`) | — | — |

### B.4 Inconsistencies (proven from code)
1. **Declared but never enforced: `tickets.delete`.**
   - It has a MANAGEMENT default and appears in presets, but nothing checks it.
   - `deleteTicket` is super admin only (`src/actions/ticket.ts:337-341`).
   - Every other key has at least one enforcement site. `section.inbox` and `section.automate` are enforced dynamically (`navigation.ts:68-69`).
2. **Keys the module-based role and person editors never show.** These are hidden by `REACH_KEYS`, `FOLDED_KEYS` and missing `sections` (`src/lib/staff/access-modules.ts:284, 295, 350`):
   - `payments.delete`, `tickets.delete`, `tasks.delete`;
   - `companies.viewAll`, `visits.viewAll`, `projects.viewAll`, `activities.viewAll`, `expenses.viewAll`;
   - `section.inbox`, `section.automate`.

   All 194 keys do appear on Roles › Permission matrix.
3. **Section keys hide pages, not actions.** Actions guarded only by `requireModuleUser` (plan only) still run when a section is unticked, for example every task action and every vault action (`src/actions/task.ts`, `src/actions/vault.ts:180`).
4. **`superAdminOnly` limits who may *grant* a key, not who *holds* it.** ADMIN holds all 8 superAdminOnly keys through `adminDefault`. So any non-super ADMIN passes the role-change check, even though its message says "Only a super admin can change somebody's role" (`src/actions/user.ts:128-130`, verified).
5. **Presets do less than their preview says.**
   - `applyPreset` deletes the rows for keys the preset leaves out, which returns them to registry defaults (`src/actions/access.ts:319-320`).
   - The preview counts those keys as "revoked" (`presets.ts:571-588`).
   - Example: "Auditor (read-only)" applied to MANAGEMENT leaves about 80 MANAGEMENT defaults in force, including `payments.delete`, `documents.void` and `orders.approve`.
6. **Role names checked directly instead of permissions.** 15 sites, including:
   - `startViewingAs` (ADMIN plus the key);
   - bulk user edits (`user.ts:501`);
   - `adminOnly` (`guards.ts:96`);
   - the file manager (`file-manager.ts:77, 260`);
   - SALES self-assign (`lead.ts:121, 140`);
   - the DLP exemption (`security/policy.ts:83`);
   - the SSO fallback (`workplace/sign-in-rules.ts:62`).
7. **`SUPPORT_READONLY` can't open any module.** Its view-only keys don't include `section.*`, and nothing special-cases it.
8. **A single role change writes no audit entry** (`assignUser`, `user.ts:82-171`), although `ROLE_ASSIGNED` exists in the enum. Bulk edits are audited.
9. **`listUsers` is open to any signed-in user.** It returns every user's role, manager and 2FA status (`user.ts:40-63`).

## C. Masking & Unmasking Report

### C.1 What exists

**Masking covers the Lead record only.** `FIELD_ENTITIES = ["leads"]` (`src/lib/authz/field-policy.ts:35`, verified). The sensitive fields are listed in `SENSITIVE_FIELDS` (`field-policy.ts:63-74`):

| Key | Kind | Where the value is actually stored |
|---|---|---|
| `title` | text | `Lead.title` |
| `companyName` | text | `Company.name` |
| `contactName` | text | `Contact.name` |
| `email` | email | `Contact.email` |
| `phone` | phone | `Contact.phone` |
| `address` | address | `CompanyLocation` (the primary location) |
| `source` (+ `sourceDetail`) | choice | `Lead.source`, `Lead.sourceDetail` |
| `description` | text | `Lead.description` |
| `custom:<key>` | each non-archived LEAD custom field | `Lead.customFields` (`src/lib/authz/fields.ts:53-67`) |

Five of these eight built-in fields live on **other** records (Contact, Company, CompanyLocation). They are masked only when they are reached *through a lead*.

**How a value is shown, per person and per field** (`RoleFieldPolicy` / `UserFieldPolicy`; personal rules can expire):

| Policy | What it does |
|---|---|
| `view` | `false` hides the value completely (the word "Restricted") |
| `maskInList` / `maskInDetail` | Show the value masked in lists, on the record page, or both |
| `unmask` | The person may reveal a masked value |
| `format` | `first`, `stars`, `email`, `phone_last4`, `phone_code` or `partial_address` (`field-policy.ts:38-48, 169-209`). Masks are a fixed 8 stars, so the length doesn't leak. Whether a field is empty does leak, because an empty field returns null |

**Workspace master switch:**
- `FieldMaskingSettings`, super admin only, audited (`src/lib/authz/masking-switch.ts`, `src/actions/field-access.ts`).
- Off: masked fields show in the clear, and restricted fields stay restricted.
- A grant is still measured against the granter's *stored* rules (`resolveStoredFieldPolicies`).

**Where masking happens: always on the server.**
- `leadMasker` and `maskCustomValues` (`fields.ts:168-209`).
- `maskLead`, `maskLeads`, `maskContact` and `leadRedactor` (`src/lib/leads/masking.ts:90-217`).

Lead read paths:
- Lists, board, search, exports and the API list use the "list" answers. `getLead` uses the "detail" answers (`src/actions/lead.ts:689-704`).
- Search and filters skip any field that isn't shown in the clear (`lead.ts:465-500`).
- Masked fields can't be edited (`detailLeadMasker.locked`).
- The Call button gets `phone: null` when the phone is concealed.

**On lead paths the browser never receives raw values**, with one exception, finding C-H1 below.

**Unmasking:**

| Aspect | Status | Evidence |
|---|---|---|
| Permission-controlled | **Yes.** `policy.unmask`, only with `view` on and some mask applied, also enforced by a DB CHECK. `unmaskLead` also requires the leads module, `leads.view` and `leadAccess(view)`. Refused while viewing as someone, and the refusal is logged | `field-policy.ts:141-145`; `src/actions/lead-unmask.ts:296-345` |
| Quota | **Yes.** Distinct leads per person per business day. The person's limit beats the role's; super admin has none. **No limit row means unlimited** | `src/lib/authz/unmask.ts:51-70` |
| Race-safe | **Yes.** Advisory xact lock, then count, then insert usage and event, in one transaction. A unique index backs it up. The check script covers 6-way bursts | `unmask.ts:166-202`; `scripts/check-field-access.ts:251-256` |
| Logged | **Yes.** `UnmaskEvent` records the user, the impersonator, the lead and lead ref, **field keys only (never values)**, the result (ALLOWED / REPEAT / QUOTA_EXHAUSTED / DENIED), the count used, the limit, the request id, IP and UA. DENIED logging is best-effort | `unmask.ts:220-253` |
| Who reads the log | The super admin, acting as themselves only. The CSV is capped at 10k rows and its export is itself logged | `src/actions/unmask-log.ts:44-47, 146-183` |
| Tamper-proofing | An `unmask_events_append_only` trigger blocks UPDATE and DELETE. **Not** TRUNCATE (the data reset uses it), not a DB owner dropping the trigger, no hash chain, and `unmask_usage` has no trigger | migration `20261110100000` |
| Trigger | Unmask runs **automatically** when the lead page opens: no click and no reason | `src/components/leads/lead-unmask.tsx:47-67` |

**Defaults: who sees what.**

| Who | What they see |
|---|---|
| No policy rows (a fresh workspace) | **Everybody sees everything in the clear, with no unmask limit** (`openPolicy`, `field-policy.ts:127-129`) |
| Super admin | Everything in the clear and unlimited; this can't be changed |
| Inactive person, switched-off role, no role, the Automation account | Every field "Restricted" (`closedPolicy`) |
| ADMIN | In the clear, unless a super admin sets ADMIN rules |
| Platform support read-only | In the clear, and it can't be masked |
| Admin viewing as someone | That person's masks, and unmasking is refused |

### C.2 Where the same data leaks (bypass paths)

The rows below assume a role whose lead email, phone, company and address are masked. With default record access, anybody who can see a lead can also open its company. Every lead row hands out `company.id` and `contact.id`/`ref`, which lead to these paths.

| Path | Function (file:line) | What it returns | Bypass? |
|---|---|---|---|
| Company page | `getCompany` (`src/actions/company.ts:1756-1903`; `contacts:` included in full, verified) | All contacts with **raw email/phone**, all locations | **Yes.** Gated by the `contacts.view` *permission* (`src/lib/authz/contact-access.ts:28-30`), not the Contacts record level |
| Contacts directory | `listAllContactsPaged` (`src/actions/contact.ts:137-167`) | Raw name, email, phone, company; search matches email and phone | **Yes** (`contacts.directory` + contacts level) |
| Global search | `src/actions/search.ts:121-210` | Contacts: raw name and company. Companies: raw name. Leads: masked | Yes, for contact name and company name |
| Data export: contacts and companies | `contactsExporter`, `partyExporter` (`src/lib/portability/exporters/crm.ts:28-130`) | Raw email/phone, name, address, GSTIN, PAN. **Same `data.exportCrm` permission as the masked leads export** | **Yes, in bulk** |
| Per-company workbook | `src/lib/portability/export.ts:157-275` | Leads sheet masked; Account, Locations and Contacts sheets raw in the same file | **Yes** |
| API v1 | `readCompany`, `readContact`, `listContactsApi` (`src/lib/api/v1/companies.ts:28-99, 183-201`) | Raw company name, address, contact email/phone | **Yes** |
| Mobile app | `appCompany`, `appContacts` (`src/lib/app/sales.ts:136-173`) | Raw contacts and company | **Yes** |
| **Lead page Activity feed** | `recordActivity` → `callRows`/`loggedRows` (`src/lib/activity/timeline.ts:192, 232`, verified), rendered by `lead-detail.tsx:163, 320` | Raw contact name, phone number, company name and call notes | **Yes, on the lead's own page** |
| Calls | `listCompanyNumbers` (`src/actions/call.ts:268-302`), `listCalls` (`call.ts:304-365`) | Every contact's phone **and email** with `calls.view` alone; raw numbers and names in the call list | Yes |
| Documents | `findTradeDocumentFor` (`src/lib/documents/load.ts:14-54`); `recipientsFor` (`src/lib/documents/send-email.ts:83-91`) | Company name, address, billing/shipping phones; every contact's email (needs `documents.send` only) | Yes |
| Mail log | `listMailLog` (`src/actions/mail-log.ts`) | Raw recipient email (searchable), company, contact | Yes (`emails.view`) |
| Copilot | `get_company` (`src/lib/copilot/tools.ts:108-131`) | Raw contact email/phone, sent to the LLM | Yes |
| Reports engine | `src/lib/analytics/sources.ts` | Leads masked except the `lostReason` dimension. Orders, tickets, invoices, payments and visits show `company.name` raw | Partial |
| Leads data export | `src/lib/portability/exporters/leads.ts:40, 62-74` | Masked, but includes contact email/phone **without a `contacts.view` check**; `Lost reason` raw | Partial |
| API v1 / app single-lead read | `readLead` → `getLead` (`src/lib/api/v1/leads.ts:68-72`, `src/lib/app/sales.ts:86-96`) | **Detail** answers. With "mask in list" on and "mask in detail" off, a script reads every lead in the clear with no unmask and no log | Yes (in that configuration) |
| TV wins screen | `src/app/(tv)/tv/wins/page.tsx:39` | Masked as the person who **paired** the screen. Paired by an admin, deal titles show in the clear on a shared screen | Yes (in that configuration) |
| Inbox / WhatsApp | `src/actions/inbox.ts`, `src/lib/inbox/*` | No masking calls found (grep) | Unverified in depth |

The team knew about part of this: `docs/field-access.md:95-106` calls it a "known, deliberate boundary", and the role editor shows a warning (`roleWarnings`, `field-access.ts:194-224`). That warning's advice ("Set Contacts to None") does not close the company page, the API or the app, because those gate on the `contacts.view` *permission* and not on the record level.

### C.3 Masking gaps (missing functionality)
1. No field policy for Contacts or Companies, or for their custom fields: `restrictedByPolicy`, `unsearchableByPolicy` and `customTextMasker` return nothing for any entity except LEAD (`src/lib/custom-fields/server.ts:107-141`).
2. No `export` dimension in the policy: exports and API lists can't be told "masked even if the screen is clear".
3. Unmasking is lead-only, automatic, with no reason asked, and unlimited when no limit is set.
4. Free-text redaction is a best-effort exact-substring match (`masking.ts:195-207`). Raw free text appears in `lostReason`, task titles, mail subjects, form answers and notes.
5. The log isn't protected against TRUNCATE or an owner disabling the trigger, and has no hash chain.
6. A same-day reveal covers fields granted later that day, with no new event (`masking.ts:48-49`).

## D. Lead Limits Report

### D.1 What exists today

**No lead limits of any kind exist.** There is no cap on leads per user, team or workspace, no daily/monthly assignment cap, and no plan-based lead cap. What *does* exist is a set of adjacent quotas and rate limits:

| Limit | Status | Evidence |
|---|---|---|
| Max open/total leads per user | **Missing** | No such field on `LeadAssignmentRule`, `User` or `Lead` (`prisma/schema.prisma`); no `maxLeads`/`leadLimit`/`capacity` anywhere |
| Daily / monthly assignment cap per user | **Missing** | `chooseOwner` (`src/lib/leads/assign.ts:218-244`) filters only inactive users and people on leave (`assign.ts:116-131`) |
| Team-level / workspace-level lead cap | **Missing** | — |
| Plan / subscription lead cap | **Missing** | `Entitlements` holds only `seats`, `copilotTokens`, `customDomains`, `automation` (`src/lib/entitlements.ts:10-42`); Leads is an on/off module (`src/lib/modules-access.ts:106-117`, `src/lib/products.ts`) |
| Daily **unmask** quota (distinct leads/day/person) | Exists, server-enforced | `src/lib/authz/unmask.ts:51-70` (person limit over role limit; super admin unlimited; none configured = unlimited), `162-214` |
| Lead capture API | 60 leads/min/key, 64 KB body | `src/lib/lead-capture/spec.ts:15-16`, `src/lib/lead-capture/receive.ts:41-55` |
| Public form | 5/hour per email+form, 300/hour per form | `src/actions/marketing-public.ts:373, 478-485` |
| Booking page | 5/hour per source, 30/hour per page | `src/lib/booking/server.ts:143, 173-178` |
| Digital card share-back | 10 per 10 min per card (60 in booth mode), 60/min workspace-wide | `src/actions/card-public.ts` |
| Public API v1 | 120 calls/min per key; max 20 keys per person | `src/lib/api/scopes.ts:31`, `src/lib/api/handler.ts:120-131, 217-219`, `src/lib/api/keys.ts:18, 57-58` |
| Lead export row cap | Per file, from the security policy | `src/actions/lead.ts:956`, `src/lib/security/policy.ts:161-173` |
| Import size | 25 MB, `.csv`/`.xlsx`; a row window ≤ 2000 *if the caller sends one* | `src/actions/data-import.ts:29, 51-55, 71-74` |
| Import row count / rate / per-day cap | **Missing** | — |

**When an existing limit is hit:**
- **Unmask:** `QUOTA_EXHAUSTED`; the fields stay masked and the attempt is logged (`unmask.ts:182-200`, `src/actions/lead-unmask.ts:133-138`).
- **Capture API and public API:** HTTP 429. The capture API also sends `Retry-After`.
- **Form and booking:** an `ok:false` message.
- **Bot traps:** a fake success, and the submission is dropped.
- **Export:** refused with the reason.

### D.2 Assigned vs accessible

`leadAccess(userId, action)` (`src/lib/authz/access.ts:673`) resolves a level in this order (`access.ts:338-411`):
1. Super admin → ALL.
2. Inactive person or switched-off role → NONE.
3. The person's own `UserAccessLevel`.
4. The role's `RoleAccessLevel`.
5. Otherwise derived: `leads.view` → **FOLLOW**, else NONE (`access.ts:148-155`).

What each level keys off:
- **FOLLOW** is "as far as the account": `Company.ownerUserId` must be in the person's downline, or the person holds `companies.viewAll` (`access.ts:124, 454-462, 628-630`).
- **OWN / TEAM / BRANCH** key off `Lead.ownerUserId` (`access.ts:619`).

So by default a lead's visibility follows the **account manager**, not the lead owner (stated in `src/actions/lead.ts:425-445`). An owner can therefore be assigned a lead they cannot open:
- The list, the board and the app's "mine" view AND `ownerUserId` with `leadAccess` (`lead.ts:497-504`, `src/lib/app/sales.ts:80`).
- `getLead` returns null for them (`lead.ts:675`).

Nothing checks the assignee's reach:
- Create-time owner: checked only for being active (`lead.ts:116-117`).
- Assignment rules: `chooseOwner` checks only active and on-leave.
- Bulk assign: checked only for being active (`lead.ts:1059-1063`).
- Capture onto an existing company (`src/lib/lead-capture/intake.ts:296-308`).

Pipelines are filters, not boundaries: `LeadPipeline` has no members (`prisma/schema.prisma`, `inPipelineWhere` in `lead.ts:470-482`).

### D.3 Ownership and reassignment

| Path | Who may set the owner | Evidence |
|---|---|---|
| New lead naming an owner | Self freely. Anyone else needs `leads.assign` **or** `accounts.reassign`. Target must be active | `src/actions/lead.ts:109-118` |
| New lead naming no owner | A SALES user without assign rights → self. Otherwise the assignment rules. No rule matches → SALES self, else unassigned | `lead.ts:121-141` |
| Reassign after creation (lead page, bulk bar) | Only through `bulkUpdateLeads`. `accounts.reassign`: any lead at `leads:assign` level, may unassign. `accounts.handOffOwn`: own leads only, never to nobody. `leads.assign` alone does **not** reassign | `lead.ts:1055-1091`; `src/lib/authz/reassign-rules.ts:63-70`; `src/actions/lead-owner.ts:25-51` |
| Automate "Assign a lead" | Bulk rules plus reach at `assign` level | `src/lib/automate/actions/lead-assign.ts:46-50` |
| Automate "Create a lead" | **Any active person; no `leads.assign` check** | `src/lib/automate/actions/lead-create.ts:56, 77`; `src/lib/automate/actions/shared.ts:31-36` |
| Import (portability) | Anyone with `data.importCrm`; **no reassign check** | `src/lib/portability/importers/leads.ts:428-440, 611, 636` |
| Legacy CRM import | Super admin only | `src/actions/legacy-import.ts:22-25` |

Defaults:
- `leads.assign`: MANAGEMENT, CALLING.
- `accounts.reassign`: MANAGEMENT.
- `accounts.handOffOwn`: SALES, MANAGEMENT.
- `data.importCrm`: no default role (`src/lib/permissions.ts`, `src/lib/authz/presets.ts`).

Every owner change is recorded by a DB trigger, whatever the path (`record_lead_assignment`, migration `20261127120000_lead_assignment_performance`).

### D.4 Creation and import restrictions

**`createLead` is the shared path** for the UI, Quick lead, API v1 and the mobile app (`src/lib/api/v1/leads.ts:117`, `src/app/api/app/leads/route.ts:13`, `src/actions/quick-lead.ts`). It checks, in order:
1. Module entitled and on.
2. `leads.view` + `leads.create`.
3. The company is visible and customer-side.
4. The contact belongs to that company.
5. Required custom fields are filled.
6. The pipeline is not archived.
7. Title is at least 2 characters.

These paths do not go through it:
- The server-action schema puts **no max length** on title, description or requirements (`src/lib/validation/lead.ts:54-65`). The API schema caps them at 200 and 5000 (`src/lib/api/v1/schemas.ts:23-24`).
- Import, Automate "Create a lead", public forms, capture, booking, cards, the inbox and pipeline carry-on write leads **themselves** (`importers/leads.ts:600`, `legacy-import/apply.ts:710`, `marketing-public.ts:570, 783`, `intake.ts:395`, `pipeline/carry-on.ts:64`).

**Duplicates:**
- None are detected for manual, API or form leads; only request idempotency applies.
- Capture is unique on `(captureKeyId, externalId)`.
- Import matches on Key, Old system ID, or title + company (+ email).

**Import restrictions:**
- Requires `data.importCrm` and the leads module, with a 25 MB cap.
- The 200-row windowing is **UI-only** (`src/components/settings/import-dialog.tsx:60-61`). The server takes the whole file when no window is sent (`data-import.ts:51-55, 126`).
- There is no row cap and no rate limit.

### D.5 Race conditions

| Mechanism | Verdict | Evidence |
|---|---|---|
| Unmask quota | **Correct.** Advisory lock per person/day, then count, then insert, then event, in one transaction; plus a unique `(userId, businessDate, leadId)` index | `unmask.ts:166-201` |
| Round-robin cursor | Atomic (`UPDATE … rrCursor = rrCursor + 1 … RETURNING`). But `chooseOwner` runs outside the create transaction, so a failed or duplicate create still burns a turn. The public form picks an owner *before* its rate-limit check | `assign.ts:163-166`; `lead.ts:128, 189` vs `205`; `marketing-public.ts:458` vs `485` |
| LEAST_LOADED / PERFORMANCE strategies | **Not race-safe.** Read counts, then pick, with no lock; concurrent leads pile onto one person | `assign.ts:137-156`, `src/lib/leads/performance.ts:98-101` |
| Lead idempotency key | Race-safe (pre-check, plus P2002 caught after insert). The key never expires, and the body isn't compared, so a reused key returns the old lead | `lead.ts:161-163, 246-254` |
| Capture / form / booking / card rate limits | **Check-then-act** (`count()` then write); bursts pass together. By contrast the API key counter is atomic | `receive.ts:47-55`; `marketing-public.ts:481-485`; `handler.ts:120-131` |
| Bulk reassign | Scope check, then a separate `updateMany` with no transaction or `ownerUserId` guard (a TOCTOU window). `leadIds` is unbounded. Audit rows are written after the update, one at a time | `lead.ts:1073-1101`; `validation/lead.ts:151` |
| Response-hours sweep | Read owner, then unconditional update; can overwrite a reassignment made in between. Double runs are prevented by the tenant job lease | `src/lib/leads/response.ts:110-121` |

### D.6 Missing lead-limit functionality
1. A per-person cap on open leads (capacity), and per-person daily/monthly assignment caps.
2. Team (downline or branch) and workspace caps, and a plan-level lead cap in `Entitlements`.
3. Assignment that skips people who are at capacity or can't see the lead, with an overflow policy (refuse, next person, or unassigned + notify).
4. Duplicate detection when creating manual, API and form leads.
5. Atomic intake counters, server-side import row caps, and per-day import caps.
6. Idempotency keys that expire and check that the request body matches.

## E. Security Findings

Each finding below is backed by the code reference given. "Verified" means I re-read the cited lines myself. The others come from tracing the code; nothing was run against the app, so their runtime behaviour is unverified. A finding is listed once, even when it surfaced in more than one part of the audit.

### Critical

**C-1. Field masking stops at the Lead record; the same phone, email, company and address are served raw on other paths.**
- `FIELD_ENTITIES = ["leads"]` (`src/lib/authz/field-policy.ts:35`, verified).
- `getCompany` includes every contact in full (`src/actions/company.ts:1770-1776`, verified).
- The other raw paths are listed in C.2: the contacts directory, API v1 companies and contacts, the mobile app, the contacts and companies exports, the per-company workbook, calls, document recipients and copilot.
- Every lead row carries the `company.id` and `contact.ref` that lead to those paths.
- None of these paths unmasks, counts against the daily limit, or writes an `UnmaskEvent`.
- The boundary is partly documented (`docs/field-access.md:95-106`). It is rated Critical because it defeats the stated purpose of the unmask limit, which is to stop contact-data harvesting, in one click or in bulk.

### High

**H-1. Changing an existing user's role skips the "can't confer more than you hold" rule.**
- `assignUser` checks only:
  - `users.assignRole`;
  - that the target isn't the caller;
  - that the role is active;
  - that the target isn't the super admin.

  It never calls `assertMayStartInRole` (`src/actions/user.ts:127-143`, verified). Creating a user does call it (`user.ts:270`).
- The users importer has the same gap for existing accounts (`src/lib/portability/importers/users.ts:333`).
- `users.assignRole` is held by **every ADMIN** through `adminDefault` (see M-1), and by anyone a super admin grants it to. Such a person can:
  1. create, or reset to a temporary password, a low-privilege account they control;
  2. move that account into ADMIN, or into any role holding keys they were denied.
- The role change itself is not audited (M-9).
- **Fix:** call `assertMayStartInRole(actor, role)` on every role change.

**H-2. Anyone with `users.manage` can create an account in the hidden `SUPPORT_READONLY` role.**
- `assertRoleAssignable` only checks that the role is active (`src/lib/authz/guards.ts:189-192`, verified).
- `assertMayStartInRole` compares stored role grants, which for this role are sections only.
- The resolver then gives that role **every `*.view*` key**, including `vault.viewAll`, `permissions.view` and `hr.viewAll` (`src/lib/authz/resolve.ts:139-142`, verified).
- The set-up link goes to the email the creator typed.
- Pages gated by section stay closed. Actions and pages that check only the key, or only the plan, are reachable (runtime unverified).

**H-3. The lead's own page leaks masked values through its Activity feed.**
- `lead-detail.tsx:163, 320` renders `recordActivity`. Its call rows put the raw contact name, phone number, company name and notes in the clear (`src/lib/activity/timeline.ts:192, 232`, verified).
- This happens even when the lead is masked and the person's daily limit is used up.
- The test (`scripts/check-field-access.ts:196`) asserts on a field the page never renders.

**H-4. The role editor's advice for closing the masking leak doesn't work.**
- `roleWarnings` says "Set Contacts to None" (`src/actions/field-access.ts:194-224`).
- But the company Contacts tab, `getCompany`, API v1 `readCompany`/`readContact` and the app's `appCompany` are gated by the `contacts.view` **permission** (`src/lib/authz/contact-access.ts:28-30`), not by the Contacts record level.
- `listCompanyNumbers` returns contacts' phone and email with `calls.view` alone (`src/actions/call.ts:268-302`).

**H-5. One export permission masks leads but ships contacts and companies raw.**
- `data.exportCrm` covers the masked leads export and also the raw contacts and companies exports (`src/lib/portability/areas.ts:45-70`; `exporters/crm.ts:28-130`).
- The per-company workbook masks its leads sheet but includes raw contacts and locations in the same file (`src/lib/portability/export.ts:157-275`).

**H-6. The leads importer bypasses record scope and reassign rights, and its preview reads leads outside scope.**
- `gate()` checks only `data.importCrm` (`src/actions/data-import.ts:31-45`, verified).
- Leads are matched by Key with an unscoped `findUnique` (`importers/leads.ts:288-290`, verified).
- `apply` overwrites the owner and other fields without `mayChangeLeadOwner` (`:626-643`).
- The preview returns each matched lead's current values (`:516-530`, verified). So a file listing `LEAD-000001…N` reveals every lead's title, owner, value and stage.
- Mitigation today: `data.importCrm` has no default role.

### Medium

| ID | Finding | Evidence |
|---|---|---|
| M-1 | `superAdminOnly` limits *granting*, not *holding*. ADMIN holds all 8 such keys by default (`users.assignRole`, `security.manage`, `billing.manage`, `impersonation.use`, `backups.download`/`restore`, `data.exportUsers`/`importUsers`). The role-change error message claims super admin only | `resolve.ts:179-182` (verified); `user.ts:128-130` (verified) |
| M-2 | A temporary grant can be made permanent by its holder: `extendUserPermission` refuses self only for *deny* rows. `setUserPermission` has no self check | `src/actions/access.ts:497-530` (verified) |
| M-3 | `applyPreset` deletes unlisted rows, so the role's defaults come back. A denied key can return without the caller holding it, including on their own role. The preview calls those keys "revoked" | `access.ts:265-273, 319-320`; `presets.ts:571-588` |
| M-4 | Resetting a role's access level (null) skips the reach check, and the derived level can be wider | `src/actions/access-levels.ts:165` |
| M-5 | Changing someone's manager widens TEAM reach with no reach check (needs `permissions.manage`) | `user.ts:117-125` |
| M-6 | Order actions check only company visibility (`visibleOrder` → `canSeeCompany`), not the Orders record level. Affected: `cancelOrder`, `processOrder`, `setOrderQuote`, price-increase, release/schedule/hold, `approveOrderLoss`, `setOrderDeal`, `revealOrderSecret`, `updateOrderCustomFields`, `settleVendorPo`, the order-files route, `listCompanyOrdersForPayment` (which returns purchase and deal prices). Exploitable when a role's Orders level is set narrower than Companies | `src/actions/order.ts:100-107` (verified); `src/actions/payment.ts:488` |
| M-7 | Resetting a role's field policy (null) skips `withinPolicy`. An admin whose own email is masked can open email for any non-ADMIN role | `field-access.ts:243-253` (verified) |
| M-8 | The biometric endpoint authenticates a terminal by serial number alone. Anyone who knows the serial can post attendance, which feeds payroll. The risk is documented in the file header | `src/app/api/biometric/iclock/[[...path]]/route.ts:12-40` |
| M-9 | Audit gaps: single role/department/manager change, single activate/deactivate, admin 2FA reset, own password change and 2FA disable, module switch, branding, departments, payroll statutory and bank-file downloads | `user.ts:82-171, 375, 435-463, 589-605`; `profile.ts:66, 188`; `module.ts:57`; `statutory-files.ts:12` |
| M-10 | Unmasking is unlimited by default when no limit row exists, and it fires automatically on page open | `unmask.ts:69`; `lead-unmask.tsx:47-67` |
| M-11 | API v1 and app single-lead reads use the "detail" answers. With mask-in-list on and mask-in-detail off, a script reads leads in the clear with no unmask and no log | `src/lib/api/v1/leads.ts:68-72`; `src/lib/app/sales.ts:86-96` |
| M-12 | Documents return the company's address and phones, and recipients' emails, with no contacts check or masking. The leads data export includes contact email and phone without `contacts.view` | `src/lib/documents/load.ts:14-54`; `send-email.ts:83-91`; `exporters/leads.ts:40, 62-63` |
| M-13 | The TV wins screen masks as whoever paired it; paired by an admin, deal titles show in the clear | `src/app/(tv)/tv/wins/page.tsx:39` |
| M-14 | Automate "Create a lead" bypasses `leads.assign` and the company reach check that `createLead` applies | `src/lib/automate/actions/lead-create.ts:56, 77`; `intake.ts:262-266, 353` |
| M-15 | Assigned ≠ accessible: a lead can be given to someone who can't open it | `lead.ts:116-117, 1059-1063`; `assign.ts:116-131` |
| M-16 | Bulk reassign has no maximum, isn't one transaction, and has a check-then-act gap | `validation/lead.ts:151`; `lead.ts:1073-1101` |
| M-17 | Intake rate limits (capture, form, booking, card) count first and write after, so a burst passes the limit. The capture limit counts only *created* leads | `receive.ts:47-55`; `marketing-public.ts:481-485` |

### Low
- **L-1** `listUsers` is open to any signed-in user. It returns every account's role, manager, 2FA and setup state (`user.ts:40-63`). It isn't client-exposed today; its page requires `permissions.view`.
- **L-2** Other server-only actions have no checks of their own (`handoverHistory`, `activityReport`, `getResellerPriceForItem`). They would become exposed if a client component imported them.
- **L-3** `tickets.delete` is declared and granted by default but never enforced; ticket delete is super admin only.
- **L-4** View-as and the set-up-link hand-off compare permission keys only, ignoring record levels and field policies (`src/lib/impersonation.ts:94-104`; `account-setup.ts:79-89`).
- **L-5** `resetUserTwoFactor` has no self or view-as refusal.
- **L-6** Section keys hide pages but don't stop actions gated by plan only (`requireModuleUser`).
- **L-7** 15 role-name checks stand in for permission checks.
- **L-8** Masking leaks and gaps:
  - Free-text redaction is best-effort.
  - `lostReason` is raw in reports and exports.
  - The unmask log isn't protected against TRUNCATE or a disabled trigger.
  - A reveal covers fields granted later the same day.
- **L-9** Lead pipeline and limit gaps:
  - Round-robin turns are used up by failed creates.
  - The LEAST_LOADED and PERFORMANCE assignment strategies skew under concurrency.
  - Idempotency keys never expire.
  - Import windowing is UI-only.
  - API lead listing has no export cap.
  - The server-action lead schema is unbounded.
- **L-10** Biometric serial squatting across workspaces is first-come (`claimDeviceSerial`).
- **L-11** The unauthenticated Outlook signature endpoint confirms whether an email belongs to an employee (`src/lib/signatures/outlook.ts:428-466`).

### Observations (no exploit shown, or by design)
- **Line managers see subordinates' full bank and ID details.** `getPerson` serves the whole employee profile, including PAN, UAN, ESIC, bank account and IFSC, to anyone up the reporting line (`src/actions/hr.ts:158`; `employee-record.tsx:166-176`).
- **Item cost price** (`Item.costPrice`) is visible to everyone whose plan includes Items, since `items` has no view permission.
- **Platform support read-only** sees all lead fields in the clear and can't open any module (no `section.*`).
- **What is solid:**
  - Workspace isolation: one database per workspace, the host bound in the session, tenant-keyed caches, fail-closed resolution.
  - The unmask quota's locking and value-free log.
  - Super admin uniqueness enforced in the database.
  - API key scoping.
  - Server-side page gating on all 25 sampled pages.
  - Record scope on 188 of 216 sampled id-taking actions.

## F. Database Architecture

All of these models live in each workspace's own database (`prisma/schema.prisma`). The control plane (`prisma/control/schema.prisma`) holds tenants, plans, entitlements and platform staff (console roles OWNER, MANAGERS and others, which are unrelated to workspace roles).

### F.1 Identity and roles
| Model | Key fields | Purpose |
|---|---|---|
| `User` | `role` (FK → Role.key, **one per user**), `isSuperAdmin`, `active`, `kind` (MEMBER / SUPPORT / AUTOMATION), `managerId` (TEAM), `branchId` (BRANCH), `departmentId` (no authz effect) | The person |
| `Role` | `key` PK, `name`, `active`, system flag | Roles as data; 14 system rows plus custom roles plus hidden `SUPPORT_READONLY` |
| `Branch`, `Department` | — | BRANCH reach and the org chart |

Database-level guarantees for super admin:
- a partial unique index `users_one_super_admin`;
- triggers that refuse deleting or demoting the last super admin;
- a CHECK that a super admin is an ADMIN.

### F.2 Permissions (what you may do)
| Model | Key fields | Notes |
|---|---|---|
| `RolePermission` (L3538) | `role`, `permission`, `allowed` | Overrides the registry default for one role. No row means the default |
| `UserPermission` (L11791) | `userId`, `permission`, `allowed`, `reason`, `grantedById`, **`expiresAt`** | A personal exception; a personal deny beats the role |
| `PermissionChange` (L12048) | `actorUserId`, `impersonatedByUserId`, `subjectType` (ROLE / USER), `subjectRole`, `subjectUserId`, `permission`, `fromAllowed`, `toAllowed`, `changeKind`, `detail` | History of authorization changes, written by `src/lib/authz/audit.ts` |

The **registry** (`src/lib/permissions.ts`) is code, not data: 194 keys with group, defaults and flags. The 22 **presets** are also code (`src/lib/authz/presets.ts`).

### F.3 Record reach (which rows)
| Model | Key fields | Notes |
|---|---|---|
| `RoleAccessLevel` (L3558) | `role`, `record`, `action`, `level` | NONE / OWN / TEAM / BRANCH / ALL / FOLLOW, per record type (13) and action (4). No row means derived from permissions |
| `UserAccessLevel` (L11824) | `userId`, `record`, `action`, `level`, `reason`, `grantedById`, `expiresAt` | A personal exception |

### F.4 Fields (what you see of a row)
| Model | Notes |
|---|---|
| `RoleFieldPolicy`, `UserFieldPolicy` | `entity` (only `leads` today), `field`, `view`, `maskInList`, `maskInDetail`, `unmask`, `format`; the personal row has reason and expiry |
| `RoleUnmaskLimit`, `UserUnmaskLimit` | Distinct leads per day; the personal limit wins; no row means unlimited |
| `UnmaskUsage` | Daily counter, unique `(userId, businessDate, leadId)` |
| `UnmaskEvent` | Append-only log (trigger blocks UPDATE and DELETE); field keys, never values |
| `FieldMaskingSettings` | Workspace master switch; no row means on |
| Custom fields | `CustomFieldDefinition.restricted` (needs `fields.seeRestricted`); SECRET fields with `CustomFieldReveal` log (`fields.revealSecrets`) |

### F.5 Sign-in and access gate
| Model | Purpose |
|---|---|
| `RoleAccessPolicy` (L11682), `UserAccessPolicy` (L11707) | Device kinds allowed (mobile / tablet / computer), device approval, unknown-network behaviour, location requirement |
| `IpRule` | Allowed or blocked CIDRs, optionally per role, with expiry |
| `SignInRule` | Sign-in method per user or role (Microsoft only, SSO, password) |
| `UserDevice` | Known browsers and devices with approval status |
| `SecuritySettings`, `SecurityPolicy` | 2FA and SSO enforcement; DLP (copy/print blocking, watermark, export row cap) |
| `ApiKey` | Public API key: scopes, expiry, revocation; acts as its creator |

### F.6 Leads and quotas
| Model | Purpose |
|---|---|
| `Lead` | `ownerUserId`, `sourcedByUserId`, `idempotencyKey` (unique), `captureKeyId` + `externalId` (unique) |
| `LeadAssignmentRule` (L14726) | Priority-ordered conditions plus strategy (round robin with `rrCursor`, least loaded, performance); no caps |
| `LeadAssignment` (L1790) | One row per owner change, written by a DB trigger, whatever path changed the owner |
| `AuditLog` (L5875) | Record-level audit (user, impersonator, action, entity, changes); not every mutation writes one |

### F.7 How these fit together
```
User ──role──▶ Role ──▶ RolePermission (key→allowed)      ┐
  │                 └──▶ RoleAccessLevel (record×action→level) ├─▶ resolveUserPermissions / resolveAccess
  │                 └──▶ RoleFieldPolicy (entity×field)     ┘     (per request, React cache)
  ├──▶ UserPermission / UserAccessLevel / UserFieldPolicy  (personal exceptions, expiring)
  ├──managerId──▶ User (TEAM)      └──branchId──▶ Branch (BRANCH)
  └──isSuperAdmin (DB-enforced singleton) → bypasses all of the above
Registry (code): PERMISSIONS[194] with defaults; MODULE_REGISTRY[48] with section keys; presets[22]
```

## G. API & Backend Audit

### G.1 Server actions
- **Size:** 2,058 exported functions in 312 `"use server"` files. 1,750 of them are in `src/actions/*.ts`.
- **What guards them** (static AST classification that follows calls through helpers):

| Guard | Count | Notes |
|---|---|---|
| A permission or scope check | 1,521 | Reachable from the action |
| Authentication only (`requireUser` / `requireModuleUser`) | 185 | Reviewed by hand. Almost all are own-data actions or intentionally open name lists. The exceptions are L-1/L-2 |
| No auth call | 44 | All intentional token or public flows: portal, kiosk, TV pairing, forms, booking, card, unsubscribe, sign-in, password reset. They match `PUBLIC_ACTIONS` in `scripts/check-rbac.ts:335-440` |

- **`requireModuleUser`** checks sign-in plus the plan only, **not** a permission, the company module switch or the section key (`src/lib/modules-access.ts:106-117`).
- **`isModuleEnabled`** checks plan, switch and view permission.
- **Platform console, CMS and partner actions** (308 exports) are role-gated via `requireStaff`, `cmsAction` and `requirePartner`.

### G.2 API routes (160 `route.ts`)
| Authentication | Count / examples |
|---|---|
| Public API v1 key (`apiRoute`) | 18: key digest, lockout, person policy, `can("api.manage")` per call, per-key scope, 120/min rate limit; handlers reuse the scoped actions |
| Mobile app device token (`appRoute`) | 62 (+2 pairing); runs as the device's user |
| Session (`auth()`/`requireUser`) | 29 (+9 via delegated helpers), e.g. `data-import`, HR documents, payroll files, support attachments, marketing uploads |
| Cron | 3, Bearer secret compared in constant time, fanned out per workspace |
| Signed webhooks | Stripe, Razorpay, inbound email (HMAC), WhatsApp, marketing, app-update publish (RSA) |
| Token in URL | Calendar feed, automate hooks, CallerDesk, Elementor, web widget, signature links, unsubscribe |
| Public by design | Brand mark, PWA manifest, widget.js, health, TLS ask, maintenance status, OpenAPI docs, marketing assets |
| Serial number only | Biometric iClock (M-8) |

### G.3 IDOR and record scope
188 of the 216 sampled id-taking actions reach a record-scope helper:

| Area | Helpers |
|---|---|
| Leads | `getLead` → `mayAccess`; `leadInScope` |
| Companies | `canSeeCompany` |
| Contacts | `mayWorkWithContactsOf` |
| Tickets | `reachableTicket` |
| Tasks | `reachableTask` / `workableTask` |
| Payments | `accessLevel` |
| Documents | `reachesDocument` |
| Projects, visits, expenses | `projectAccess`, `canActFor`, `expenseAccess` |
| HR | `visibleUserIds` |
| Files | Per-owner checks; vault requires password re-entry |

**The incorrect pattern is orders (M-6).**

### G.4 Exports and bulk operations
- **Exports.** Every one checks a dedicated permission (`data.export*`, or the leads screen's `data.exportCrm` with row cap and security log). Exporters apply the per-record `*Access` fragments.
  - Gaps: field masking (H-5, M-12); payroll statutory and bank files are not logged (M-9).
- **Bulk operations.** They delegate per item to the single-record actions or apply the assign-level fragment: leads, tickets, documents, companies, contacts.
  - `bulkUpdateUsers` is ADMIN-only and calls `assignUser`, so it inherits H-1.
  - Bulk lead reassign: M-16.

### G.5 Direct URL access
All 313 dashboard pages were classified, and 25 across modules were read in full.
- The server-side pattern is:
  1. `isModuleEnabled`, which renders `ModuleDisabledNotice` otherwise;
  2. a record-scoped load, which calls `notFound()` otherwise.
- Settings pages are gated by `SettingsPage` (`mayOpen` → `notFound()`) or an explicit `can()`.
- **No page relies on hiding its menu link alone.**

### G.6 Workspace isolation
- **Binding:** `db` resolves the workspace on every call, from `runAsTenant` or the request host. Mismatched hosts are refused, and resolution outside a request fails closed.
- **Sessions:** each session is bound to one workspace by a per-workspace secret, a `tid` check, and a re-read of the user from that workspace's database (`src/lib/auth.ts:325-345`).
- **Process-wide caches** are keyed by workspace:
  - access gate;
  - masking switch;
  - security settings;
  - chat bus `${tenantId}|${userId}`;
  - API lockouts.
- **Intentional cross-workspace paths:** linked sign-in and hand-off (proof checked against the workspace id), the platform console (separate staff auth), and biometric serial routing (L-10).
- `check:tenancy-isolation` asserts these invariants.
- **No cross-workspace data path was found.**

### G.7 Audit logging
- **Two channels:**
  - `recordAudit` (`src/lib/audit.ts`) records the impersonator and the API or app channel automatically.
  - `recordPermissionChange` (`src/lib/authz/audit.ts`) records role, person, field and file-manager grants.
- **Logged:**
  - view-as start/stop;
  - user delete;
  - temporary password reset;
  - set-up and reset emails;
  - bulk user edits;
  - permission and level changes;
  - exports and their refusals;
  - unmask attempts;
  - vault reveals;
  - chat export;
  - masking switch;
  - document templates;
  - biometric terminal removal.
- **Not logged:** see M-9.

## H. Recommended Permission Architecture

The engine Deskzo already has is sound. Its pieces are:
- one resolver;
- personal exceptions with expiry;
- record levels compiled to Prisma `where` clauses;
- server-side masking;
- a database per workspace;
- DB-enforced super admin.

**The recommendation is to close its gaps and unify its edges, not to replace it.** Every item below builds on existing models.

### H.1 RBAC: one rule for conferring access
1. **One function** decides whether an actor may confer something on a target:
   - `assertMayConfer(actor, { role? | permission? | level? | fieldPolicy? | preset? }, target)`.
   - Every path calls it: create user, change role, import users, grant, extend, reset, apply preset, set level, set field policy, change manager.
   - Today the rule is re-implemented in 7 places and missing in 5 (H-1, M-2, M-3, M-4, M-5, M-7).
   - **Resets are checked too:** a reset is checked by its *effective* result, not skipped.
2. **`superAdminOnly` means "held only by the super admin".**
   - Today it only restricts granting. ADMIN holds those 8 keys through `adminDefault` (M-1).
   - Fix: in the resolver, `adminDefault` skips `superAdminOnly` keys.
3. **No self-service on your own access:**
   - refuse acting on yourself in `extendUserPermission` and `setUserPermission`;
   - refuse changing your own manager or your own role's levels and presets.
4. **Hidden roles can't be assigned:** `assertRoleAssignable` refuses `SUPPORT_READONLY` (and any `system-hidden` role) outside the platform's own provisioning (H-2).
5. **Keep one role per person.** It's simple and the whole codebase assumes it. Personal exceptions already cover "an accountant who also sells".

### H.2 Resource- and action-level permissions
1. **Module, section and permission enforced in actions, not just pages.**
   - Give `requireModuleUser(module)` an option, or add `requireModuleAccess(module)`, that applies `decideModuleAccess`: plan, switch, view permission and section.
   - Use it in actions, so unticking a section or switching a module off stops its actions too (L-6).
2. **Fix the registry's loose ends:**
   - enforce or remove `tickets.delete` (L-3);
   - show the 10 hidden keys in the module editor, or document why they're folded (B.4-2);
   - replace the 15 role-name checks with permission keys where they gate capability (L-7).
3. **Preset semantics:** applying a preset either writes explicit deny rows for unlisted keys (matching its preview), or its preview says "back to default" (M-3).

### H.3 Record-level access
1. **Every id-taking action checks the record type it acts on**, through the existing `mayAccess(record, action)`. Orders is the known gap (M-6): `visibleOrder` adds `mayAccess("orders", action)`.
2. **Contacts gated by level, not just permission.**
   - Gate contact reads (the company Contacts tab, API, app, calls, documents) on the Contacts **record level** as well as on `contacts.view`, so "Contacts = None" means what the editor says (H-4).
3. **Assignment respects visibility.** An owner must be able to reach the lead at `view` (M-15).
4. **A `check:` that inventories id-taking actions.** It fails when a new one doesn't reach a scope helper, generalising the agent's classifier (`scratchpad/audit/scope.js`) into `scripts/`.

### H.4 Field-level permissions, masking and unmasking

Keep `RoleFieldPolicy` and `UserFieldPolicy`; their `entity` column is already a string. Widen what they cover. Don't replace them.

```json
{
  "leads":     { "title": { "view": true, "mask": "none", "unmask": false, "export": "clear" } },
  "contacts":  { "email": { "view": true, "mask": "list+detail", "unmask": true,  "export": "masked", "format": "email" },
                 "phone": { "view": true, "mask": "list+detail", "unmask": true,  "export": "masked", "format": "phone_last4" } },
  "companies": { "name":  { "view": true, "mask": "none", "unmask": false, "export": "clear" },
                 "address": { "view": true, "mask": "list", "unmask": true, "export": "masked", "format": "partial_address" } }
}
```

*(The format is illustrative. `mask` is a shorthand for the existing `maskInList` and `maskInDetail` flags, and `export` would be a new column.)*

1. **Set policy on the record that owns the value.**
   - Widen `FIELD_ENTITIES` to `["leads", "contacts", "companies"]`.
   - Contact fields: name, email, phone, linkedinUrl, `custom:*`.
   - Company fields: name, address (all locations), gstin, pan, website, `custom:*`.
   - A lead's email, phone and contact name come from the contacts policy, and its company name and address from the companies policy. Keep the lead keys as aliases, so existing rows still apply.
2. **One presenter per entity.**
   - Add `contactMasker(userId, ctx)` and `companyMasker(userId, ctx)` next to `leadMasker`.
   - Every Contact and Company read goes through them: the company page, the directory, search, API v1, the app, calls, documents, copilot and exporters.
   - Generalise the custom-field `*ByPolicy` helpers to CONTACT and COMPANY.
3. **A guard against the next bypass.** Add a `check:` script that fails on any `select`/`include` of `Contact.email`/`phone` or `Company.name`/`locations` outside the presenter modules.
4. **An `export` dimension.**
   - Add one column: `export: "none" | "masked" | "clear"`.
   - Exports, API lists and copilot always use the "list" answers plus `export`.
   - An API single-record read uses the list answers unless a counted unmask exists.
5. **General unmasking.**
   - Add `entity` and `recordId` to `UnmaskUsage` and `UnmaskEvent`, keeping `leadId` for back-compat.
   - Unmasking a lead also reveals its contact and company for that day.
   - Require a daily limit whenever `unmask` is granted, or add a workspace default limit.
   - Make revealing an explicit click, optionally with a reason.
6. **Gates aligned with record levels.** Gate the company Contacts tab, `listCompanyNumbers` and `recipientsFor` on the contacts level and the contacts policy, not just on the `contacts.view` permission. Rewrite `roleWarnings` so its advice is true.
7. **Central redaction.** Apply the redactor in the timeline builders (`callRows`, `loggedRows`), in report dimensions and in exporters, rather than page by page.
8. **A tamper-evident log.**
   - Make a separate DB role own the log tables, and revoke UPDATE, DELETE and TRUNCATE from the app role.
   - Hash-chain the rows.
   - Archive the log rather than truncating it on a data reset.

### H.5 Masking and unmasking (process)
- **Explicit reveal.** Revealing becomes a click, optionally with a reason. A default daily limit applies whenever `unmask` is granted, so there is no unlimited-by-default (M-10).
- **Unmask scope.** One unmask covers the lead and its contact and company for the day, and is logged with entity and record id.
- **API and app.** API and app single reads use the "list" answers unless a counted unmask exists (M-11).
- **Shared screens.** Use the most restrictive policy, not the pairer's (M-13).

### H.6 Lead quotas and limits (a minimal engine)

Build it the way the daily unmask limit is already built, because that design works (`src/lib/authz/unmask.ts`).

1. **Configuration.**
   - `RoleLeadLimit(role PK, maxOpen Int?, maxPerDay Int?, maxPerMonth Int?)`.
   - `UserLeadLimit(userId PK, limited, maxOpen?, maxPerDay?, maxPerMonth?, reason, expiresAt)`. The person's limit overrides the role's, as `UserUnmaskLimit` overrides `RoleUnmaskLimit`.
   - A plan cap `leads?: { monthly, open }` in `Entitlements` (`src/lib/entitlements.ts`), parsed like `automation`.
   - An overflow mode per assignment rule: `SKIP`, which tries the next person, then the next rule, then leaves the lead unassigned and notifies managers; or `REFUSE`.
2. **Counters.** No new counter table is needed for per-person limits.
   - **Open leads:** `count(leads where ownerUserId = p and status not in (WON, LOST, DISQUALIFIED))`. `ownerUserId` is already indexed.
   - **Daily and monthly assignments:** `count(lead_assignments where userId = p and assignedAt in the business day or month)`. The `[userId, assignedAt]` index already exists, and the DB trigger writes this table on every path.
   - **Workspace monthly creations:** one `lead_usage(month PK, created)` row, incremented with `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the create transaction. This copies the `automation_usage` pattern (`src/lib/automate/usage.ts:44-52`).
3. **Race safety.** One helper, `claimLeadCapacity(tx, ownerIds[], creating)`, called inside the transaction that writes `ownerUserId`:
   - It takes `pg_advisory_xact_lock(hashtext('leads:workspace'))` when creating, which is the seats pattern (`src/lib/seats.ts:31-35`).
   - It then takes one lock per owner, sorted by id to avoid deadlocks.
   - It counts, compares, and throws `LeadCapacityFull` the way `SeatsFull` is thrown.
   - `chooseOwner` moves inside the same transaction (its `db` option already exists, `src/lib/leads/assign.ts:221`). It drops people who are full and locks the rule before `pick`. That makes LEAST_LOADED and PERFORMANCE serial, and a failed create rolls the round-robin cursor back.
4. **A backstop on every write path.** A `BEFORE INSERT OR UPDATE OF "ownerUserId"` trigger on `leads` runs the same check and raises a custom SQLSTATE. This covers the importer, the legacy importer, Automate, carry-on, the sweep and scripts. It follows the precedent of `record_lead_assignment`. The app-level check stays, for readable messages.
5. **What each path does on overflow.**
   - `createLead`: refuses, which API v1 and the app return as 422.
   - Intake (capture, Elementor, cards, booking, inbox, Automate) and public forms: create the lead **unassigned** and notify managers, so no enquiry is lost. Hitting the workspace cap returns 429.
   - Import: the row goes to `failed`.
   - `bulkUpdateLeads`: all-or-nothing in one transaction, with `updateMany where { id in, ownerUserId: oldOwner }`.
6. **Quick fixes alongside.**
   - Make the capture counter atomic: a per-key `windowStart`/`windowCount` updated with `UPDATE … RETURNING`, as `countCall` does.
   - Add scope and reassign checks to the importer.
   - Require `leads.assign` in Automate "Create a lead" when it names an owner.
   - Cap `leadIds` (for example at 500) and the import window on the server.

### H.7 Workspace isolation
**Keep the database-per-workspace model.** It is the strongest guarantee available, and no cross-workspace path was found.

Add:
1. a per-terminal source-IP allowlist (or a shared secret where the firmware allows) for the biometric endpoint (M-8);
2. a "claimed by another workspace" support flow for serial squatting (L-10).

### H.8 Audit logging
1. Close the gaps in M-9:
   - role, manager and department changes;
   - activate and deactivate;
   - 2FA reset and disable;
   - own password change;
   - module switch, branding and departments;
   - payroll file downloads.
2. **One rule:** every action that changes access, identity or a security setting writes `recordAudit` or `recordPermissionChange`. Enforce it with a `check:` that lists the exported actions touching `user`, `role*`, `*Permission`, `*AccessLevel`, `*FieldPolicy`, `securitySettings`, `systemModule` and `ipRule`, and asserts that each writes an audit row.
3. **Tamper evidence** for `UnmaskEvent`, `PermissionChange` and `AuditLog`:
   - a separate DB owner role;
   - REVOKE UPDATE, DELETE and TRUNCATE for the app role;
   - an optional hash chain;
   - archiving instead of TRUNCATE on a data reset.

## I. Recommended Developer View

### I.1 Format: JSON, validated with zod

| Option | Fit with Deskzo | Verdict |
|---|---|---|
| **JSON** | Native to the stack: the TypeScript registry, Prisma `Json` columns, `zod` already a dependency (`package.json`), the API's JSON, the existing Excel export. No new parser. Exact error positions are available from `JSON.parse` plus a light location map. Diffable and pasteable | **Recommended** |
| YAML | Friendlier to hand-write, but needs a new dependency. Implicit typing (`no`/`off` → false, `0123`) is a known source of wrong permissions. Comments are lost on round-trip because the source of truth is DB rows | Not recommended |
| TOML / HCL | Poor fit for deep maps (role → record → action) and no existing tooling here | No |
| A DSL (`grant leads.view to SALES`) | Most readable, but a parser and grammar to maintain, plus a second mental model | No |

### I.2 One engine, two views

The Developer View is a **serialisation** of the same database rows the Normal View edits. It is not a second engine:

```
Normal View (switches) ─┐                         ┌─▶ RolePermission / RoleAccessLevel / RoleFieldPolicy
                         ├─▶ applyAccessChanges() ─┤     RoleUnmaskLimit / (UserPermission … for people)
Developer View (JSON)  ──┘   one guarded path      └─▶ PermissionChange history (one row per change)
```

- **Read.** `exportAccessDocument(scope)` builds the document from the resolver and the stored rows, the same data as today's Permission matrix and its Excel export.
- **Validate.** `accessDocumentSchema` is a zod schema *generated from the registries*:
  - permission keys from `PERMISSION_KEYS`;
  - record types, actions and levels from `src/lib/authz/access.ts`;
  - field entities, fields and formats from `field-policy.ts`.

  Unknown keys, impossible levels and wrong types each produce an error with its JSON path, mapped to a line and column.
- **Diff, preview and save.** `applyAccessChanges(doc, { dryRun })` diffs the document against the current rows.
  - It returns the change list for preview: added, removed, changed, and "back to default".
  - On save it applies every change in one transaction, through the **same guarded functions** the Normal View uses. Those are the `assertMayConfer` rules from H.1: ADMIN only by the super admin, nothing beyond your own authority, no self-edits. **No separate authorization code.**
  - The Normal View's per-switch actions become thin callers of the same function, so both views share validation, guards and history.
- **History.** `PermissionChange` already records each change. Add a `batchId` so one Developer View save shows as one entry with its diff. An optional `AccessDocumentVersion` snapshot (JSON, author, time) allows "restore this version", which is itself applied through the same path.

### I.3 Document shape (illustrative)
```json
{
  "version": 1,
  "roles": {
    "SALES": {
      "permissions": { "leads.view": true, "leads.create": true, "leads.assign": false },
      "levels":      { "leads": { "view": "TEAM", "edit": "OWN" }, "companies": { "view": "FOLLOW" } },
      "fields":      { "leads": { "phone": { "view": true, "mask": "list+detail", "unmask": true, "format": "phone_last4" } } },
      "unmaskLimit": 25
    }
  },
  "people": {
    "user@acme.in": { "permissions": { "payroll.manage": { "allowed": false, "reason": "Probation", "until": "2026-12-31" } } }
  }
}
```
- **Omissions mean "registry default".** A key that is left out falls back to its default. Explicit `false` or `true` writes a row. This is exactly how the rows already behave, so the document never invents state.
- **Never in the document:** `isSuperAdmin`, users' roles, and the hidden `SUPPORT_READONLY` role.
- **Read-only unless super admin:** the ADMIN role.

### I.4 The editor
| Requirement | Approach |
|---|---|
| Syntax highlighting | CodeMirror 6 (`@codemirror/lang-json`, about 150 KB, lazy-loaded on the Developer tab only). There is no editor dependency today (verified). A plain `<textarea>` plus server validation is the fallback with zero new dependencies |
| Validation and errors | zod on the client for instant feedback and again on the server as the authority. Errors become CodeMirror diagnostics at line and column |
| Permission search | Search box filters by key, label or group. "Jump to" reveals the matching line. The registry provides labels for hover tooltips |
| Import / Export | Download the current document as `.json`; upload a file, which loads into the editor as unsaved changes and goes through the same dry-run preview |
| Bulk updates | Edit many keys at once; the dry-run diff lists every change before Save |
| Unsaved changes | Compare against the loaded document's hash; show a "Unsaved changes" badge and guard navigation with the app's existing `useUnsavedGuard` (`src/components/cms/common`) |
| Save / Discard | Save runs the dry-run, opens a confirm dialog listing the diff, then applies. Discard reloads from the server |
| Change history | The `PermissionChange` list filtered by `batchId`, with the actor and impersonator; restoring a version applies it through the same path |
| Access | Tab visible with `permissions.view` (read-only) or `permissions.manage` (edit). Every save is re-checked on the server |

### I.5 Why it won't break anything
- No new storage engine; the same tables, resolver and caches.
- The Normal View keeps working throughout. Its actions move onto the shared `applyAccessChanges` as a pure refactor, covered by the existing checks (`check:rbac`, `check:roles`, `check:access-editor`, `check:field-access`, `check:permission-gates`).
- The Developer View ships behind its own tab, and can be limited to the super admin at first.

## J. Migration & Implementation Roadmap

Each phase ships on its own, behind the existing checks, with a new `check:` script for what it adds.

### Phase 1: Security fixes (do first)
| Item | Fix | Files | DB | Risk |
|---|---|---|---|---|
| H-1 | `assertMayStartInRole` on every role change, single and import | `src/actions/user.ts`, `src/lib/portability/importers/users.ts`, `src/lib/authz/guards.ts` | — | Low |
| H-2 | Hidden roles not assignable | `guards.ts` (`assertRoleAssignable`), `role-registry.ts` | — | Low |
| H-3 | Redact the timeline (`callRows`, `loggedRows`) with the lead redactor; test what the page renders | `src/lib/activity/timeline.ts`, `src/lib/leads/masking.ts`, `scripts/check-field-access.ts` | — | Low |
| H-6 | Importer: `leads.create`, `leadAccess("edit")` on matches, `mayChangeLeadOwner`; preview shows only reachable leads | `src/actions/data-import.ts`, `src/lib/portability/importers/leads.ts` | — | Medium (import behaviour changes) |
| M-1 | `adminDefault` skips `superAdminOnly` keys; audit each call site | `src/lib/authz/resolve.ts`, `permissions.ts` | — | Medium: admins lose 8 keys. Announce it |
| M-2, M-4, M-5, M-7, M-3 | Self and reset checks via one `assertMayConfer` | `src/actions/access.ts`, `access-levels.ts`, `field-access.ts`, `person-access.ts`, `user.ts` | — | Low |
| M-6 | `mayAccess("orders", …)` in `visibleOrder` and its callers, plus `listCompanyOrdersForPayment` | `src/actions/order.ts`, `payment.ts`, `src/app/api/custom-fields/files/[id]/route.ts` | — | Low |
| M-9 | Audit the missing admin and security actions | `user.ts`, `profile.ts`, `module.ts`, `branding`, `department.ts`, payroll files | — | Low |
| M-8 | Per-terminal IP allowlist | `iclock` route, BiometricDevice settings UI | Add `allowedIps String[]` | Medium (on-prem terminals behind NAT) |

**Dependencies:** none. **Tests:** extend `check:rbac`, `check:roles`, `check:field-access`; add `check:confer`.

### Phase 2: Permission architecture improvements
- **Section and switch enforcement in actions:** `requireModuleAccess` replaces `requireModuleUser` in action files, one module at a time (L-6).
  - Files: `src/lib/modules-access.ts`, 163 action files.
  - Risk: medium. People with a section unticked lose actions they could still call; this is intended, but announce it.
- **Registry clean-up:** `tickets.delete`, the hidden editor keys, role-name checks, preset semantics.
  - Files: `src/lib/permissions.ts`, `src/lib/staff/access-modules.ts`, `src/lib/authz/presets.ts`, `src/actions/access.ts`.
- **Contacts gated by level as well as permission** (H-4).
  - Files: `src/lib/authz/contact-access.ts`, `company.ts`, `api/v1/companies.ts`, `app/sales.ts`, `call.ts`, `documents/send-email.ts`.
- **Scope-coverage check script** (`scripts/check-record-scope.ts`).
- **Dependencies:** Phase 1 (`assertMayConfer`). **DB:** none.

### Phase 3: Masking and unmasking improvements
- **Field policy for contacts and companies:**
  - `FIELD_ENTITIES` widened;
  - `contactMasker` / `companyMasker`;
  - custom-field `*ByPolicy` helpers generalised;
  - about 20 read paths refitted (C.2);
  - `export` column;
  - explicit reveal with an optional reason;
  - default limit when `unmask` is granted;
  - API and app reads on list answers;
  - shared screens on the most restrictive policy.
- **Files:** `src/lib/authz/field-policy.ts`, `fields.ts`, `unmask.ts`, `src/lib/leads/masking.ts`, new `src/lib/contacts/masking.ts`, `src/lib/companies/masking.ts`, `src/lib/custom-fields/server.ts`, the read paths in C.2, `src/components/settings/access/field-policy-editor.tsx`, `person-permissions-panel.tsx`.
- **DB (additive):**
  - `RoleFieldPolicy.export` and `UserFieldPolicy.export`;
  - `UnmaskUsage` / `UnmaskEvent` gain `entity` and `recordId`;
  - tamper-evidence grants (a migration that revokes TRUNCATE etc. from the app role).
- **Risk:** medium-high. Many read paths change, so each needs a "no raw value leaks" assertion (`check:field-access`'s `leaks()` helper). Roll out entity by entity.
- **Dependency:** Phase 2's contacts gating.

### Phase 4: Lead limits engine (H.6)
- **Files:**
  - `src/lib/leads/assign.ts`, `src/lib/leads/performance.ts`;
  - `src/actions/lead.ts`, `src/lib/lead-capture/intake.ts`, `receive.ts`, `src/actions/marketing-public.ts`;
  - `src/lib/portability/importers/leads.ts`;
  - `src/lib/entitlements.ts`;
  - settings UI for limits, next to the unmask limits.
- **DB:**
  - new `RoleLeadLimit`, `UserLeadLimit`, `lead_usage`;
  - overflow mode on `LeadAssignmentRule`;
  - capture key window counters;
  - a `leads` owner trigger (backstop).
- **Risk:** medium. Behaviour change on overflow, and a trigger on a hot table. Ship the trigger in warn-only mode first.
- **Dependencies:** Phase 1 (importer fix) and M-15 (assignment visibility).

### Phase 5: Normal View improvements
- Show the hidden keys; correct the warnings (`roleWarnings`); a preset preview that matches its effect.
- A per-entity field policy editor (after Phase 3); lead limits in the role and person editors (after Phase 4).
- Batch history view.
- **Files:** `src/app/(dashboard)/settings/roles/*`, `src/components/settings/roles/*`, `src/components/settings/access/*`, `src/components/settings/people/*`.
- **Risk:** low.

### Phase 6: Developer View (section I)
- **Build steps:**
  1. `accessDocumentSchema` generated from the registries;
  2. `exportAccessDocument`;
  3. `applyAccessChanges` (dry run plus apply), with the Normal View's actions refactored onto it;
  4. the Developer tab (CodeMirror 6, lazy-loaded);
  5. Import / Export;
  6. batch history.
- **DB:** `PermissionChange.batchId`; optional `AccessDocumentVersion`.
- **Risk:** low to medium. The refactor of the Normal View's write path is the risky part; keep it a pure refactor with the existing checks green before adding the editor.
- **Dependencies:** Phases 1 and 2 (`assertMayConfer`, clean registry). Ideally also Phases 3 and 4, so the document covers fields and limits from day one.

### Phase 7: Testing and validation
- **New checks:**
  - `check:confer` (every way of conferring access);
  - `check:record-scope` (id-taking actions reach a scope helper);
  - `check:field-access` extended to every bypass path in C.2 plus `recordActivity`;
  - `check:lead-limits` (concurrent bursts, overflow, imports, API);
  - `check:access-document` (round-trip export → apply = no change; guards refuse the same things as the Normal View);
  - `check:audit-coverage`.
- **Manual review:**
  - a browser pass as each built-in role on the copy database;
  - a final read-only re-audit of this document's findings.

---

## Appendix: Files that will need modification (future work, by phase)

| Phase | Files |
|---|---|
| 1 Security | `src/actions/user.ts`, `src/lib/portability/importers/users.ts`, `src/lib/authz/guards.ts`, `src/lib/authz/role-registry.ts`, `src/lib/authz/resolve.ts`, `src/lib/permissions.ts`, `src/actions/access.ts`, `src/actions/access-levels.ts`, `src/actions/field-access.ts`, `src/actions/person-access.ts`, `src/actions/order.ts`, `src/actions/payment.ts`, `src/app/api/custom-fields/files/[id]/route.ts`, `src/lib/activity/timeline.ts`, `src/lib/leads/masking.ts`, `src/actions/data-import.ts`, `src/lib/portability/importers/leads.ts`, `src/actions/profile.ts`, `src/actions/module.ts`, `src/actions/department.ts`, `src/lib/payroll/statutory-files.ts`, `src/app/api/biometric/iclock/[[...path]]/route.ts` |
| 2 Architecture | `src/lib/modules-access.ts` + action files using `requireModuleUser`, `src/lib/staff/access-modules.ts`, `src/lib/authz/presets.ts`, `src/lib/authz/contact-access.ts`, `src/actions/company.ts`, `src/lib/api/v1/companies.ts`, `src/lib/app/sales.ts`, `src/actions/call.ts`, `src/lib/documents/send-email.ts`, `src/lib/documents/load.ts` |
| 3 Masking | `src/lib/authz/field-policy.ts`, `src/lib/authz/fields.ts`, `src/lib/authz/unmask.ts`, `src/actions/lead-unmask.ts`, `src/components/leads/lead-unmask.tsx`, `src/lib/custom-fields/server.ts`, new `src/lib/contacts/masking.ts` and `src/lib/companies/masking.ts`, `src/actions/contact.ts`, `src/actions/search.ts`, `src/lib/portability/exporters/*`, `src/lib/portability/export.ts`, `src/lib/analytics/sources.ts`, `src/lib/copilot/tools.ts`, `src/actions/mail-log.ts`, `src/app/(tv)/tv/wins/page.tsx`, `src/lib/api/v1/leads.ts`, `src/components/settings/access/field-policy-editor.tsx`, `src/components/settings/people/person-permissions-panel.tsx`, `prisma/schema.prisma` (additive) |
| 4 Lead limits | `src/lib/leads/assign.ts`, `src/lib/leads/performance.ts`, `src/actions/lead.ts`, `src/lib/lead-capture/intake.ts`, `src/lib/lead-capture/receive.ts`, `src/actions/marketing-public.ts`, `src/lib/booking/server.ts`, `src/actions/card-public.ts`, `src/lib/automate/actions/lead-create.ts`, `src/lib/entitlements.ts`, `src/lib/validation/lead.ts`, settings UI for limits, `prisma/schema.prisma` (new models + trigger migration) |
| 5 Normal View | `src/app/(dashboard)/settings/roles/*`, `src/components/settings/roles/*`, `src/components/settings/access/*`, `src/components/settings/people/*` |
| 6 Developer View | new `src/lib/authz/access-document.ts` (schema, export, diff), new `src/actions/access-document.ts` (`applyAccessChanges`), the Normal View's write actions refactored onto it, new Developer tab under `src/app/(dashboard)/settings/roles/`, `prisma/schema.prisma` (`PermissionChange.batchId`, optional `AccessDocumentVersion`), `package.json` (CodeMirror 6, optional) |
| 7 Tests | new `scripts/check-confer.ts`, `check-record-scope.ts`, `check-lead-limits.ts`, `check-access-document.ts`, `check-audit-coverage.ts`; extended `scripts/check-field-access.ts`, `check-rbac.ts`, `check-roles.ts` |

## What was not verified
- Nothing was run against the app or a database for this audit. Runtime behaviour of every finding is inferred from code.
- These areas were traced only lightly:
  - the inbox and WhatsApp rendering of contact data;
  - telephony screen-pop;
  - the copilot tool surface beyond `get_company`;
  - linked sign-in cryptography;
  - report-engine scoping internals;
  - the platform console's per-action role choices.
- Of the 1,521 actions that reach a permission or scope check, a sample was read in full; the rest were classified automatically.

*End of audit. No code changes have been made; implementation waits for approval.*
