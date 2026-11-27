-- A built-in Employee role (owner, 1 Nov 2026: "a role for a fresh onboarding user with basic permissions — his
-- attendance, his leave"). A new joiner's starting point: their own HR page, attendance, leave and payslips, their
-- expense claims, tasks, calendar, notes, chat, Speak Up — and no permission over the business's records.
--
-- As with the other built-in roles (20261030110000), it is inserted only where no role has its key yet, and its
-- starting menu is written as role rows: every section about the business unticked, the way unticking them on
-- Staff & roles does. It grants nothing of the business's — only the copilot, which every built-in profile carries and
-- which sees and does only what its user already can. An admin adds what the job needs, or applies a preset.

WITH new_roles AS (
  INSERT INTO "roles" ("key", "name", "description", "isSystem", "sortOrder", "updatedAt") VALUES
    ('EMPLOYEE', 'Employee', 'A new joiner''s starting point: their own attendance, leave, payslips, claims, tasks and chat — nothing of the business''s records.', true, 5, now())
  ON CONFLICT ("key") DO NOTHING
  RETURNING "key"
),
starting ("role", "permission", "allowed") AS (
  VALUES
    ('EMPLOYEE', 'copilot.use', true),
    ('EMPLOYEE', 'section.leads', false),
    ('EMPLOYEE', 'section.companies', false),
    ('EMPLOYEE', 'section.wins', false),
    ('EMPLOYEE', 'section.forecast', false),
    ('EMPLOYEE', 'section.workspace', false),
    ('EMPLOYEE', 'section.domains', false),
    ('EMPLOYEE', 'section.calls', false),
    ('EMPLOYEE', 'section.salesDocuments', false),
    ('EMPLOYEE', 'section.items', false),
    ('EMPLOYEE', 'section.orders', false),
    ('EMPLOYEE', 'section.renewals', false),
    ('EMPLOYEE', 'section.purchaseDocuments', false),
    ('EMPLOYEE', 'section.payments', false),
    ('EMPLOYEE', 'section.receivables', false),
    ('EMPLOYEE', 'section.payables', false),
    ('EMPLOYEE', 'section.accounting', false),
    ('EMPLOYEE', 'section.revenueClose', false),
    ('EMPLOYEE', 'section.customerPortal', false),
    ('EMPLOYEE', 'section.feedback', false),
    ('EMPLOYEE', 'section.helpdesk', false),
    ('EMPLOYEE', 'section.inbox', false),
    ('EMPLOYEE', 'section.projects', false),
    ('EMPLOYEE', 'section.visits', false),
    ('EMPLOYEE', 'section.itAssets', false),
    ('EMPLOYEE', 'section.contactsLibrary', false),
    ('EMPLOYEE', 'section.vendors', false),
    ('EMPLOYEE', 'section.resellers', false),
    ('EMPLOYEE', 'section.commissionParties', false),
    ('EMPLOYEE', 'section.marketing', false),
    ('EMPLOYEE', 'section.forms', false),
    ('EMPLOYEE', 'section.booking', false),
    ('EMPLOYEE', 'section.visitors', false),
    ('EMPLOYEE', 'section.signatures', false),
    ('EMPLOYEE', 'section.vault', false),
    ('EMPLOYEE', 'section.targets', false),
    ('EMPLOYEE', 'section.incentives', false),
    ('EMPLOYEE', 'section.reports', false),
    ('EMPLOYEE', 'section.automate', false)
)
INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
SELECT s."role", s."permission", s."allowed", now()
FROM starting s JOIN new_roles n ON n."key" = s."role";
