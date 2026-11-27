-- A/B tests and resends to those who didn't open (owner, 1 Nov 2026 — src/lib/marketing/campaign-options.ts). New tables
-- only: a campaign reads the same in a workspace not migrated yet.
CREATE TABLE "marketing_campaign_options" (
    "campaignId" TEXT NOT NULL,
    "abTest" JSONB,
    "resend" JSONB,
    "subject" TEXT,
    "recipientIds" JSONB,
    "parentId" TEXT,
    "sendTime" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_campaign_options_pkey" PRIMARY KEY ("campaignId")
);
CREATE INDEX "marketing_campaign_options_parentId_idx" ON "marketing_campaign_options"("parentId");
ALTER TABLE "marketing_campaign_options" ADD CONSTRAINT "marketing_campaign_options_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "marketing_ab_variants" (
    "messageId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "variant" TEXT NOT NULL,

    CONSTRAINT "marketing_ab_variants_pkey" PRIMARY KEY ("messageId")
);
CREATE INDEX "marketing_ab_variants_campaignId_idx" ON "marketing_ab_variants"("campaignId");
ALTER TABLE "marketing_ab_variants" ADD CONSTRAINT "marketing_ab_variants_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "marketing_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
