-- Resignations (owner, 31 Oct 2026): handed in by the employee, accepted or turned down by their manager or HR.
ALTER TYPE "NotificationType" ADD VALUE 'RESIGNATION_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'RESIGNATION_DECIDED';

CREATE TYPE "ResignationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');

CREATE TABLE "resignations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ResignationStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "submittedOn" DATE NOT NULL,
    "noticeDays" INTEGER NOT NULL,
    "requestedLastDay" DATE NOT NULL,
    "acceptedLastDay" DATE,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resignations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "resignations_userId_status_idx" ON "resignations"("userId", "status");
CREATE INDEX "resignations_status_idx" ON "resignations"("status");

ALTER TABLE "resignations" ADD CONSTRAINT "resignations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "resignations" ADD CONSTRAINT "resignations_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
