-- Questionnaires on projects (owner, 16 Nov 2026).
ALTER TABLE "project_types" ADD COLUMN "questions" JSONB;

CREATE TABLE "project_questionnaires" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "contactId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "answers" JSONB,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),
    "savedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_questionnaires_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "project_questionnaires_tokenHash_key" ON "project_questionnaires"("tokenHash");
CREATE INDEX "project_questionnaires_projectId_idx" ON "project_questionnaires"("projectId");
ALTER TABLE "project_questionnaires" ADD CONSTRAINT "project_questionnaires_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
