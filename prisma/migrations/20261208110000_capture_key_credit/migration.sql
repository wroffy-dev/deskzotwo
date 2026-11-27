-- Who a website form's leads are raised by (owner, 9 Nov 2026): nobody, with a name of the admin's choosing shown
-- instead; the key's maker; or a person. Nothing set is nobody, shown as "Website" — as since 20261208100000.
ALTER TABLE "lead_capture_keys" ADD COLUMN "creditMode" TEXT;
ALTER TABLE "lead_capture_keys" ADD COLUMN "creditUserId" TEXT;
ALTER TABLE "lead_capture_keys" ADD COLUMN "creditLabel" TEXT;
