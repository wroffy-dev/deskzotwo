-- Security audit, Nov 2026: an "app" handoff pass names the paired phone it was made for, and is spent
-- only by a browser holding that phone's device cookie (src/lib/platform/handoff-sign-in.ts).
ALTER TABLE "platform_handoff_tickets" ADD COLUMN "deviceId" TEXT;

-- Passes last sixty seconds; any "app" pass made before this has no phone to check, so it is spent now.
UPDATE "platform_handoff_tickets" SET "usedAt" = NOW() WHERE "purpose" = 'app' AND "usedAt" IS NULL;
