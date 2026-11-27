-- Billing plans (16 Nov 2026 — "monthly payment with annual commitment … nothing gets missed"): a half-yearly cycle,
-- and a plan that keeps renewing on itself. The column is read by name and listed in NOT_YET_EVERYWHERE
-- (src/lib/tenancy/clients.ts) until every workspace has it.
ALTER TYPE "BillingCycle" ADD VALUE IF NOT EXISTS 'HALF_YEARLY' BEFORE 'ANNUAL';

ALTER TABLE "recurring_billings" ADD COLUMN "keepRenewing" BOOLEAN NOT NULL DEFAULT false;
