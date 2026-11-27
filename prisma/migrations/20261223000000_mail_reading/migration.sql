-- Reading connected mailboxes for the AI teammates (owner, 23 Nov 2026): the admin's switch, which agent reads whose
-- mailbox, how far each mailbox has been read, the emails kept (only those with known parties) and every agent read.

-- CreateTable
CREATE TABLE "mail_read_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_read_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_read_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_read_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_read_cursors" (
    "userId" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "kept" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "mail_read_cursors_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "mail_messages" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "threadId" TEXT,
    "direction" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "toEmails" TEXT[],
    "ccEmails" TEXT[],
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "companyId" TEXT,
    "leadId" TEXT,
    "contactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_read_logs" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_read_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_read_grants_userId_agent_key" ON "mail_read_grants"("userId", "agent");
CREATE UNIQUE INDEX "mail_messages_userId_providerId_key" ON "mail_messages"("userId", "providerId");
CREATE INDEX "mail_messages_companyId_sentAt_idx" ON "mail_messages"("companyId", "sentAt");
CREATE INDEX "mail_messages_leadId_sentAt_idx" ON "mail_messages"("leadId", "sentAt");
CREATE INDEX "mail_messages_userId_sentAt_idx" ON "mail_messages"("userId", "sentAt");
CREATE INDEX "mail_read_logs_messageId_idx" ON "mail_read_logs"("messageId");
CREATE INDEX "mail_read_logs_agent_at_idx" ON "mail_read_logs"("agent", "at");

-- AddForeignKey
ALTER TABLE "mail_read_grants" ADD CONSTRAINT "mail_read_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mail_read_cursors" ADD CONSTRAINT "mail_read_cursors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "mail_read_logs" ADD CONSTRAINT "mail_read_logs_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "mail_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
