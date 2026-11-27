-- Internal help desk, phase 2 (owner, 25 Nov 2026 — src/lib/desks): approval before a desk sees some kinds of request, or
-- asked for by the desk; the desk's own steps on a request. `approval` is in NOT_YET_EVERYWHERE until every workspace has it.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DESK_REQUEST_APPROVAL';

ALTER TABLE "desk_request_types" ADD COLUMN "approval" TEXT NOT NULL DEFAULT 'NONE';

CREATE TABLE "desk_approvals" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "askedById" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "comment" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desk_approvals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "desk_request_steps" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "assigneeId" TEXT,
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desk_request_steps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "desk_approvals_requestId_idx" ON "desk_approvals"("requestId");
CREATE INDEX "desk_approvals_approverId_status_idx" ON "desk_approvals"("approverId", "status");
CREATE INDEX "desk_request_steps_requestId_idx" ON "desk_request_steps"("requestId");
CREATE INDEX "desk_request_steps_assigneeId_doneAt_idx" ON "desk_request_steps"("assigneeId", "doneAt");
CREATE INDEX "desk_requests_assetId_idx" ON "desk_requests"("assetId");

ALTER TABLE "desk_approvals" ADD CONSTRAINT "desk_approvals_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "desk_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "desk_approvals" ADD CONSTRAINT "desk_approvals_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "desk_approvals" ADD CONSTRAINT "desk_approvals_askedById_fkey" FOREIGN KEY ("askedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "desk_approvals" ADD CONSTRAINT "desk_approvals_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "desk_request_steps" ADD CONSTRAINT "desk_request_steps_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "desk_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "desk_request_steps" ADD CONSTRAINT "desk_request_steps_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "desk_request_steps" ADD CONSTRAINT "desk_request_steps_doneById_fkey" FOREIGN KEY ("doneById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
