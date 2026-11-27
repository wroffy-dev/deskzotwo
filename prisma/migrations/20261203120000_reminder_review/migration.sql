-- Who payment reminders come from, and steps reviewed before they go (owner, 3 Nov 2026).
ALTER TYPE "PaymentReminderStatus" ADD VALUE IF NOT EXISTS 'AWAITING';

ALTER TABLE "collection_settings" ADD COLUMN "senderMode" TEXT NOT NULL DEFAULT 'PERSON';
ALTER TABLE "collection_settings" ADD COLUMN "collectionsFromName" TEXT;
ALTER TABLE "collection_settings" ADD COLUMN "collectionsEmail" TEXT;

ALTER TABLE "payment_reminders" ADD COLUMN "snoozedUntil" TIMESTAMP(3);
ALTER TABLE "payment_reminders" ADD COLUMN "subject" TEXT;
ALTER TABLE "payment_reminders" ADD COLUMN "body" TEXT;
ALTER TABLE "payment_reminders" ADD COLUMN "decidedByUserId" TEXT;
CREATE INDEX "payment_reminders_status_idx" ON "payment_reminders"("status");
