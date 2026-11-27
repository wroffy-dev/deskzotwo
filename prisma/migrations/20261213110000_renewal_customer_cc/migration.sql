-- Who is copied on the renewal reminder the customer gets by itself (owner, 13 Nov 2026 — src/lib/renewal-customer-reminders.ts):
-- fixed addresses, and the renewal's manager. Nobody, the default, as before.
ALTER TABLE "renewal_settings" ADD COLUMN "customerReminderCc" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], ADD COLUMN "customerReminderCcManager" BOOLEAN;
