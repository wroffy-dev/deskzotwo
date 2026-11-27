-- Group insurance, learning and employee referrals (owner, 31 Oct 2026).
ALTER TYPE "NotificationType" ADD VALUE 'COURSE_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE 'REFERRAL_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'REFERRAL_UPDATED';

CREATE TYPE "InsuranceKind" AS ENUM ('HEALTH', 'ACCIDENT', 'LIFE', 'OTHER');

ALTER TABLE "candidates" ADD COLUMN "referredById" TEXT;

CREATE TABLE "insurance_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "InsuranceKind" NOT NULL DEFAULT 'HEALTH',
    "insurer" TEXT NOT NULL,
    "policyNumber" TEXT NOT NULL,
    "sumInsured" DECIMAL(14,2),
    "validFrom" DATE NOT NULL,
    "validTo" DATE NOT NULL,
    "helpline" TEXT,
    "notes" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "insurance_members" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "memberNumber" TEXT,
    "sumInsured" DECIMAL(14,2),
    "dependents" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "courses" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "link" TEXT,
    "durationMinutes" INTEGER,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "course_assignments" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dueOn" DATE,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "course_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "insurance_members_policyId_userId_key" ON "insurance_members"("policyId", "userId");
CREATE INDEX "insurance_members_userId_idx" ON "insurance_members"("userId");
CREATE UNIQUE INDEX "course_assignments_courseId_userId_key" ON "course_assignments"("courseId", "userId");
CREATE INDEX "course_assignments_userId_idx" ON "course_assignments"("userId");

ALTER TABLE "candidates" ADD CONSTRAINT "candidates_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "insurance_members" ADD CONSTRAINT "insurance_members_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "insurance_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "insurance_members" ADD CONSTRAINT "insurance_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "courses" ADD CONSTRAINT "courses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "course_assignments" ADD CONSTRAINT "course_assignments_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_assignments" ADD CONSTRAINT "course_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
