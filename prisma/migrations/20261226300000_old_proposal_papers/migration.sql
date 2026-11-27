-- The papers beside an old proposal: order forms, purchase orders (owner, 25 Nov 2026 — src/lib/old-proposals).
ALTER TABLE "old_proposals" ADD COLUMN "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[];
