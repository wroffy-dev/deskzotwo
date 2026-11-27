-- Performance management (owner, 31 Oct 2026): review cycles, goals, self-assessment and the reviewer's rating.
ALTER TYPE "NotificationType" ADD VALUE 'REVIEW_STARTED';
ALTER TYPE "NotificationType" ADD VALUE 'REVIEW_SELF_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'REVIEW_COMPLETED';

CREATE TYPE "ReviewCycleStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "PerformanceReviewStatus" AS ENUM ('AWAITING_SELF', 'AWAITING_MANAGER', 'COMPLETED');
CREATE TYPE "GoalStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'DROPPED');

CREATE TABLE "review_cycles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "selfDueOn" DATE,
    "managerDueOn" DATE,
    "status" "ReviewCycleStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_cycles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "performance_reviews" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "status" "PerformanceReviewStatus" NOT NULL DEFAULT 'AWAITING_SELF',
    "selfRating" INTEGER,
    "selfComments" TEXT,
    "selfSubmittedAt" TIMESTAMP(3),
    "managerRating" INTEGER,
    "managerComments" TEXT,
    "managerSubmittedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performance_reviews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "status" "GoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "selfRating" INTEGER,
    "managerRating" INTEGER,
    "setById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "review_cycles_status_idx" ON "review_cycles"("status");
CREATE UNIQUE INDEX "performance_reviews_cycleId_userId_key" ON "performance_reviews"("cycleId", "userId");
CREATE INDEX "performance_reviews_userId_idx" ON "performance_reviews"("userId");
CREATE INDEX "performance_reviews_reviewerId_status_idx" ON "performance_reviews"("reviewerId", "status");
CREATE INDEX "goals_userId_cycleId_idx" ON "goals"("userId", "cycleId");
CREATE INDEX "goals_cycleId_idx" ON "goals"("cycleId");

ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "goals" ADD CONSTRAINT "goals_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goals" ADD CONSTRAINT "goals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goals" ADD CONSTRAINT "goals_setById_fkey" FOREIGN KEY ("setById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
