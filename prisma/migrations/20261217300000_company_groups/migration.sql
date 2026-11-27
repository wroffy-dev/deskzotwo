-- Customer groups: legal entities that are one customer (owner, 17 Nov 2026 — src/lib/companies/groups.ts).
ALTER TYPE "JournalSource" ADD VALUE IF NOT EXISTS 'GROUP_TRANSFER';

CREATE TABLE "company_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "company_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "company_group_members" (
    "companyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "addedById" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "company_group_members_pkey" PRIMARY KEY ("companyId")
);

CREATE INDEX "company_group_members_groupId_idx" ON "company_group_members"("groupId");

ALTER TABLE "company_group_members" ADD CONSTRAINT "company_group_members_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "company_group_members" ADD CONSTRAINT "company_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "company_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
