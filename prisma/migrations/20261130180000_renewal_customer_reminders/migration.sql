-- Renewal reminders the customer gets by themselves (owner, 30 Oct 2026 — src/lib/renewal-customer-reminders.ts): days
-- before a subscription ends. Empty, the default: none, as before — a reminder goes only when somebody sends it.
ALTER TABLE "renewal_settings" ADD COLUMN "customerReminderDays" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
