-- Customer inbox: the website pages a channel's AI answers from (owner, 31 Oct 2026 — src/lib/inbox/knowledge.ts).
CREATE TABLE "inbox_knowledge_pages" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_knowledge_pages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inbox_knowledge_pages_channelId_url_key" ON "inbox_knowledge_pages"("channelId", "url");

ALTER TABLE "inbox_knowledge_pages" ADD CONSTRAINT "inbox_knowledge_pages_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "inbox_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
