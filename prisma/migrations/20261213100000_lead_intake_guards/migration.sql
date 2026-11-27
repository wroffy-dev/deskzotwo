-- Lead intake guards (owner, 12 Nov 2026 — Phase 4 lead limits, wave 2: audit M-17, D.6.5, D.6.6). Columns only, each
-- nullable or defaulted; nothing existing changes.

-- A lead's idempotency key now also remembers what was asked (a hash of the body), so the same key with a different
-- body is refused (src/actions/lead.ts `createLead`).
ALTER TABLE "leads" ADD COLUMN "idempotencyHash" TEXT;

-- A capture key's minute, counted atomically on every request (src/lib/lead-capture/receive.ts `countSubmission`).
ALTER TABLE "lead_capture_keys" ADD COLUMN "rateWindowStart" TIMESTAMP(3),
ADD COLUMN "rateWindowCount" INTEGER NOT NULL DEFAULT 0;

-- Rows imported on the workspace's business day, for the per-day import cap (src/actions/data-import.ts).
ALTER TABLE "organisation_settings" ADD COLUMN "importDay" TEXT,
ADD COLUMN "importRows" INTEGER NOT NULL DEFAULT 0;
