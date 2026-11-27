-- Messages a person sends a customer by hand (owner, 11 Nov 2026): ready-written email and WhatsApp templates for
-- "the account manager changed" and "after a call", and the customers not yet told of a new account manager.
-- Nothing here sends anything on its own. The starter templates are added by the app the first time the list is read.

CREATE TABLE "quick_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "moment" TEXT NOT NULL DEFAULT 'ANY',
    "callResult" TEXT NOT NULL DEFAULT 'ANY',
    "emailSubject" TEXT,
    "emailBody" TEXT,
    "whatsappBody" TEXT,
    "whatsappTemplateName" TEXT,
    "starterKey" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quick_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "quick_templates_starterKey_key" ON "quick_templates"("starterKey");
CREATE INDEX "quick_templates_moment_active_idx" ON "quick_templates"("moment", "active");

CREATE TABLE "account_manager_notices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "toUserId" TEXT NOT NULL,
    "changedById" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "toldAt" TIMESTAMP(3),
    "toldById" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "dismissedById" TEXT,

    CONSTRAINT "account_manager_notices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "account_manager_notices_companyId_key" ON "account_manager_notices"("companyId");
CREATE INDEX "account_manager_notices_toldAt_dismissedAt_idx" ON "account_manager_notices"("toldAt", "dismissedAt");
