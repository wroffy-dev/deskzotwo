-- Internal help desk (owner, 25 Nov 2026 — src/lib/desks): the desks employees ask, what each may be asked for, the
-- requests with their conversation and files, and the three notification kinds. Apart from customers' tickets.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DESK_REQUEST_NEW';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DESK_REQUEST_UPDATE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DESK_REQUEST_OVERDUE';

CREATE TABLE "desks" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "departmentId" TEXT,
    "routing" TEXT NOT NULL DEFAULT 'POOL',
    "personId" TEXT,
    "leadId" TEXT,
    "turnLastId" TEXT,
    "times" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "desks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "desk_request_types" (
    "id" TEXT NOT NULL,
    "deskId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "asksAsset" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "desk_request_types_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "desk_requests" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "deskId" TEXT NOT NULL,
    "typeId" TEXT,
    "requesterId" TEXT NOT NULL,
    "raisedById" TEXT,
    "title" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "level" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assignedToId" TEXT,
    "assetId" TEXT,
    "replyDueAt" TIMESTAMP(3),
    "fixDueAt" TIMESTAMP(3),
    "firstRepliedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "replyLateToldAt" TIMESTAMP(3),
    "fixLateToldAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "desk_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "desk_request_messages" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "authorId" TEXT,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desk_request_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "desk_request_files" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "messageId" TEXT,
    "uploadedById" TEXT,
    "deskOnly" BOOLEAN NOT NULL DEFAULT false,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desk_request_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "desks_seq_key" ON "desks"("seq");
CREATE UNIQUE INDEX "desks_name_key" ON "desks"("name");
CREATE INDEX "desks_departmentId_idx" ON "desks"("departmentId");
CREATE INDEX "desk_request_types_deskId_idx" ON "desk_request_types"("deskId");
CREATE UNIQUE INDEX "desk_requests_seq_key" ON "desk_requests"("seq");
CREATE INDEX "desk_requests_requesterId_createdAt_idx" ON "desk_requests"("requesterId", "createdAt");
CREATE INDEX "desk_requests_deskId_status_idx" ON "desk_requests"("deskId", "status");
CREATE INDEX "desk_requests_assignedToId_idx" ON "desk_requests"("assignedToId");
CREATE INDEX "desk_requests_status_fixDueAt_idx" ON "desk_requests"("status", "fixDueAt");
CREATE INDEX "desk_request_messages_requestId_createdAt_idx" ON "desk_request_messages"("requestId", "createdAt");
CREATE INDEX "desk_request_files_requestId_idx" ON "desk_request_files"("requestId");

ALTER TABLE "desks" ADD CONSTRAINT "desks_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "desk_request_types" ADD CONSTRAINT "desk_request_types_deskId_fkey" FOREIGN KEY ("deskId") REFERENCES "desks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "desk_requests" ADD CONSTRAINT "desk_requests_deskId_fkey" FOREIGN KEY ("deskId") REFERENCES "desks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "desk_requests" ADD CONSTRAINT "desk_requests_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "desk_request_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "desk_requests" ADD CONSTRAINT "desk_requests_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "desk_requests" ADD CONSTRAINT "desk_requests_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "desk_requests" ADD CONSTRAINT "desk_requests_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "desk_requests" ADD CONSTRAINT "desk_requests_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "desk_request_messages" ADD CONSTRAINT "desk_request_messages_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "desk_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "desk_request_messages" ADD CONSTRAINT "desk_request_messages_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "desk_request_files" ADD CONSTRAINT "desk_request_files_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "desk_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "desk_request_files" ADD CONSTRAINT "desk_request_files_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "desk_request_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "desk_request_files" ADD CONSTRAINT "desk_request_files_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
