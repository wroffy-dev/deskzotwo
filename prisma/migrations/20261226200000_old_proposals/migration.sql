-- The proposals made in Excel before Zoho (owner, 25 Nov 2026 — src/lib/old-proposals).

CREATE TABLE "old_proposal_imports" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IMPORTING',
    "source" BYTEA NOT NULL,
    "plan" JSONB NOT NULL,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "backupId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,

    CONSTRAINT "old_proposal_imports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "old_proposal_imports_status_idx" ON "old_proposal_imports"("status");

CREATE TABLE "old_proposals" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "year" TEXT NOT NULL,
    "date" DATE,
    "status" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "madeBy" TEXT NOT NULL,
    "madeFor" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "remarks" TEXT NOT NULL,
    "total" DECIMAL(14,2),
    "lines" JSONB NOT NULL DEFAULT '[]',
    "paths" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "old_proposals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "old_proposals_key_key" ON "old_proposals"("key");
CREATE INDEX "old_proposals_companyId_date_idx" ON "old_proposals"("companyId", "date");
CREATE INDEX "old_proposals_importId_idx" ON "old_proposals"("importId");

CREATE TABLE "old_proposal_files" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "old_proposal_files_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "old_proposal_files_proposalId_path_key" ON "old_proposal_files"("proposalId", "path");

CREATE TABLE "old_proposal_made" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,

    CONSTRAINT "old_proposal_made_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "old_proposal_made_recordId_key" ON "old_proposal_made"("recordId");
CREATE INDEX "old_proposal_made_importId_kind_idx" ON "old_proposal_made"("importId", "kind");

ALTER TABLE "old_proposals" ADD CONSTRAINT "old_proposals_importId_fkey" FOREIGN KEY ("importId") REFERENCES "old_proposal_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "old_proposals" ADD CONSTRAINT "old_proposals_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "old_proposal_files" ADD CONSTRAINT "old_proposal_files_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "old_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "old_proposal_made" ADD CONSTRAINT "old_proposal_made_importId_fkey" FOREIGN KEY ("importId") REFERENCES "old_proposal_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
