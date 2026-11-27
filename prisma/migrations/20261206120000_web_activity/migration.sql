-- Website activity, part of the Customer inbox's website chat (owner, 6 Nov 2026): the pages a visitor who agreed to
-- being remembered opened, tied to the contact once they chat, send a form or click a campaign email.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WEBSITE_VISIT';

CREATE TABLE "web_visitors" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "contactId" TEXT,
    "identifiedBy" TEXT,
    "identifiedAt" TIMESTAMP(3),
    "conversationId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "visits" INTEGER NOT NULL DEFAULT 1,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "firstSource" TEXT,
    "firstCampaign" TEXT,
    "lastAlertAt" TIMESTAMP(3),

    CONSTRAINT "web_visitors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "web_page_views" (
    "id" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT,
    "referrerHost" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_page_views_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "web_visitors_tokenHash_key" ON "web_visitors"("tokenHash");
CREATE INDEX "web_visitors_contactId_idx" ON "web_visitors"("contactId");
CREATE INDEX "web_visitors_conversationId_idx" ON "web_visitors"("conversationId");
CREATE INDEX "web_visitors_lastSeenAt_idx" ON "web_visitors"("lastSeenAt");
CREATE INDEX "web_page_views_visitorId_at_idx" ON "web_page_views"("visitorId", "at");
CREATE INDEX "web_page_views_at_idx" ON "web_page_views"("at");
CREATE INDEX "web_page_views_host_idx" ON "web_page_views"("host");

ALTER TABLE "web_visitors" ADD CONSTRAINT "web_visitors_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "inbox_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "web_visitors" ADD CONSTRAINT "web_visitors_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "web_visitors" ADD CONSTRAINT "web_visitors_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "web_page_views" ADD CONSTRAINT "web_page_views_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "web_visitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
