-- Who is reminded about a renewal nobody looks after — no renewal manager or account manager still here (owner,
-- 30 Oct 2026 — src/lib/notify.ts). Empty: every admin, as before.
ALTER TABLE "renewal_settings" ADD COLUMN "nobodyRecipientIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
