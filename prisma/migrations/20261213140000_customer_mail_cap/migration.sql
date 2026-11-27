-- The most emails one customer gets in 24 hours (owner, 13 Nov 2026 — src/lib/customer-mail-cap.ts): the limit, and
-- what it counts.
ALTER TABLE "customer_email_settings" ADD COLUMN "maxPerRecipientPerDay" INTEGER;

CREATE TABLE "customer_mail_sends" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "via" TEXT NOT NULL,

    CONSTRAINT "customer_mail_sends_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_mail_sends_address_sentAt_idx" ON "customer_mail_sends"("address", "sentAt");
CREATE INDEX "customer_mail_sends_sentAt_idx" ON "customer_mail_sends"("sentAt");
