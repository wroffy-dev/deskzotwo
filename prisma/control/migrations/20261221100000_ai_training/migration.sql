-- ---------------------------------------------------------------------------------------------
-- AI training from the console (owner, 20 Nov 2026 — src/lib/ai-training): .md/.txt guides Deskzo's staff upload at
-- admin.<domain> for Deskzo AI's teammates — for every workspace or chosen ones, every teammate or chosen ones. No
-- workspace ever reads these tables directly or lists them; a teammate's prompt is given a few chunks of them.
-- Chunks are searched the way a workspace's AI Knowledge is: a generated tsvector with a GIN index.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "platform_ai_training_files" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL,
    "chars" INTEGER NOT NULL DEFAULT 0,
    "agents" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tenantIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "always" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_ai_training_files_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_ai_training_chunks" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "heading" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL,
    "search" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, heading), 'A'::"char") || setweight(to_tsvector('english'::regconfig, text), 'B'::"char")) STORED,

    CONSTRAINT "platform_ai_training_chunks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_ai_training_files_name_key" ON "platform_ai_training_files"("name");

CREATE INDEX "platform_ai_training_chunks_search_idx" ON "platform_ai_training_chunks" USING GIN ("search");

CREATE UNIQUE INDEX "platform_ai_training_chunks_fileId_position_key" ON "platform_ai_training_chunks"("fileId", "position");

-- Which files reach a teammate in a workspace is asked on every answer: the arrays are GIN-indexed.
CREATE INDEX "platform_ai_training_files_agents_idx" ON "platform_ai_training_files" USING GIN ("agents");
CREATE INDEX "platform_ai_training_files_tenantIds_idx" ON "platform_ai_training_files" USING GIN ("tenantIds");

ALTER TABLE "platform_ai_training_chunks" ADD CONSTRAINT "platform_ai_training_chunks_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "platform_ai_training_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
