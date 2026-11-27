-- Projects on the customer portal (owner, 16 Nov 2026 — projects phase 2).
CREATE TABLE "project_portals" (
    "projectId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_portals_pkey" PRIMARY KEY ("projectId")
);
ALTER TABLE "project_portals" ADD CONSTRAINT "project_portals_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "project_portal_stages" (
    "milestoneId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "needsApproval" BOOLEAN NOT NULL DEFAULT false,
    "link" TEXT,
    "approvalRequestedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_portal_stages_pkey" PRIMARY KEY ("milestoneId")
);
CREATE INDEX "project_portal_stages_projectId_idx" ON "project_portal_stages"("projectId");
ALTER TABLE "project_portal_stages" ADD CONSTRAINT "project_portal_stages_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "project_milestones"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_portal_stages" ADD CONSTRAINT "project_portal_stages_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "project_portal_shares" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "updateId" TEXT,
    "documentId" TEXT,
    "sharedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_portal_shares_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_portal_shares_one_thing" CHECK (("updateId" IS NULL) <> ("documentId" IS NULL))
);
CREATE UNIQUE INDEX "project_portal_shares_updateId_key" ON "project_portal_shares"("updateId");
CREATE UNIQUE INDEX "project_portal_shares_documentId_key" ON "project_portal_shares"("documentId");
CREATE INDEX "project_portal_shares_projectId_idx" ON "project_portal_shares"("projectId");
ALTER TABLE "project_portal_shares" ADD CONSTRAINT "project_portal_shares_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_portal_shares" ADD CONSTRAINT "project_portal_shares_updateId_fkey" FOREIGN KEY ("updateId") REFERENCES "project_updates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_portal_shares" ADD CONSTRAINT "project_portal_shares_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "project_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "project_stage_reviews" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "byName" TEXT NOT NULL,
    "portalLoginId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_stage_reviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "project_stage_reviews_milestoneId_idx" ON "project_stage_reviews"("milestoneId");
CREATE INDEX "project_stage_reviews_projectId_idx" ON "project_stage_reviews"("projectId");
ALTER TABLE "project_stage_reviews" ADD CONSTRAINT "project_stage_reviews_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_stage_reviews" ADD CONSTRAINT "project_stage_reviews_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "project_milestones"("id") ON DELETE CASCADE ON UPDATE CASCADE;
