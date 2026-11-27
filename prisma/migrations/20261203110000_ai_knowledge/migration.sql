-- ---------------------------------------------------------------------------------------------
-- AI Knowledge (owner, 3 Nov 2026 — src/lib/ai-knowledge): the company's own .md and .txt files that Deskzo AI
-- answers from — the copilot's search_knowledge tool, and the Customer inbox's bot where a channel ticks
-- "Use AI Knowledge". Each file is kept whole, and in chunks of about 800 characters cut at its headings.
--
-- A chunk's `search` is Postgres full-text search over its heading (weight A) and its text (weight B), made by the
-- database from those two columns — so it is never stale, whoever writes the chunk — and GIN-indexed, so a
-- question is one indexed lookup however many files there are. English stemming: "leads" finds "lead",
-- "invoicing" finds "invoice".
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "ai_knowledge_files" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL,
    "chars" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_knowledge_files_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_knowledge_chunks" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "heading" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL,
    "search" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, heading), 'A'::"char") || setweight(to_tsvector('english'::regconfig, text), 'B'::"char")) STORED,

    CONSTRAINT "ai_knowledge_chunks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_knowledge_files_name_key" ON "ai_knowledge_files"("name");

CREATE INDEX "ai_knowledge_chunks_search_idx" ON "ai_knowledge_chunks" USING GIN ("search");

CREATE UNIQUE INDEX "ai_knowledge_chunks_fileId_position_key" ON "ai_knowledge_chunks"("fileId", "position");

ALTER TABLE "ai_knowledge_files" ADD CONSTRAINT "ai_knowledge_files_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "ai_knowledge_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
