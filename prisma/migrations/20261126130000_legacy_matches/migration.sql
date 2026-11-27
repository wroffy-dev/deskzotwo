-- The old-system migration's master lists (owner, 26 Oct 2026): Zoho's and WroffyCRM's records paired. New table only.

-- CreateTable
CREATE TABLE "legacy_matches" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "list" TEXT NOT NULL,
    "zohoId" TEXT,
    "oldId" TEXT,
    "zohoLabel" TEXT,
    "oldLabel" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "parentId" TEXT,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legacy_matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legacy_matches_importId_list_status_idx" ON "legacy_matches"("importId", "list", "status");

-- CreateIndex
CREATE INDEX "legacy_matches_parentId_idx" ON "legacy_matches"("parentId");

-- AddForeignKey
ALTER TABLE "legacy_matches" ADD CONSTRAINT "legacy_matches_importId_fkey" FOREIGN KEY ("importId") REFERENCES "legacy_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
