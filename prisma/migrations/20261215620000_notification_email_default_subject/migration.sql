-- A subject for every notification email, unless a kind has its own (16 Nov 2026) — "[{company}] {title}". Read by
-- name, and listed in NOT_YET_EVERYWHERE (src/lib/tenancy/clients.ts) until every workspace has it.
ALTER TABLE "notification_email_layout" ADD COLUMN "subject" TEXT;
