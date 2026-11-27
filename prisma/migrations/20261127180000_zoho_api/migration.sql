-- CreateTable
CREATE TABLE "books_archived_document_files" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'application/pdf',
    "data" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "books_archived_document_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zoho_connections" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "dataCentre" TEXT NOT NULL DEFAULT 'in',
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "refreshToken" TEXT,
    "accessToken" TEXT,
    "accessExpiresAt" TIMESTAMP(3),
    "organizationId" TEXT,
    "organizationName" TEXT,
    "planName" TEXT,
    "connectedById" TEXT,
    "connectedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zoho_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zoho_pulls" (
    "id" TEXT NOT NULL,
    "migrationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'FETCHING',
    "progress" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "outcome" JSONB,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "zoho_pulls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zoho_pull_pages" (
    "id" TEXT NOT NULL,
    "pullId" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "rows" JSONB NOT NULL,

    CONSTRAINT "zoho_pull_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "books_archived_document_files_documentId_key" ON "books_archived_document_files"("documentId");

-- CreateIndex
CREATE INDEX "zoho_pulls_migrationId_startedAt_idx" ON "zoho_pulls"("migrationId", "startedAt");

-- CreateIndex
CREATE INDEX "zoho_pull_pages_pullId_file_seq_idx" ON "zoho_pull_pages"("pullId", "file", "seq");

-- AddForeignKey
ALTER TABLE "books_archived_document_files" ADD CONSTRAINT "books_archived_document_files_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "books_archived_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zoho_pulls" ADD CONSTRAINT "zoho_pulls_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "books_migrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zoho_pull_pages" ADD CONSTRAINT "zoho_pull_pages_pullId_fkey" FOREIGN KEY ("pullId") REFERENCES "zoho_pulls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
