-- CreateEnum
CREATE TYPE "TelephonyProvider" AS ENUM ('CALLERDESK');

-- CreateEnum
CREATE TYPE "TelephonyCallState" AS ENUM ('REQUESTED', 'LIVE', 'ENDED');

-- AlterEnum
ALTER TYPE "CallSource" ADD VALUE 'CLOUD';

-- CreateTable
CREATE TABLE "telephony_connections" (
    "id" TEXT NOT NULL,
    "provider" "TelephonyProvider" NOT NULL,
    "authCodeEnc" TEXT NOT NULL,
    "deskphone" TEXT NOT NULL,
    "accountName" TEXT,
    "webhookTokenHash" TEXT NOT NULL,
    "webhookTokenEnc" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "missedCallsUserId" TEXT,
    "syncedThrough" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "checkedAt" TIMESTAMP(3),
    "connectedByUserId" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telephony_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telephony_agents" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "memberName" TEXT NOT NULL,
    "memberNumber" TEXT NOT NULL,
    "numberKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telephony_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telephony_calls" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "providerCallId" TEXT,
    "campaignId" TEXT,
    "state" "TelephonyCallState" NOT NULL,
    "direction" "CallDirection" NOT NULL,
    "customerNumber" TEXT NOT NULL,
    "customerKey" TEXT,
    "virtualNumber" TEXT,
    "agentNumber" TEXT,
    "agentName" TEXT,
    "agentUserId" TEXT,
    "requestedByUserId" TEXT,
    "status" TEXT,
    "outcome" "CallOutcome",
    "startedAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "talkSeconds" INTEGER NOT NULL DEFAULT 0,
    "ringSeconds" INTEGER,
    "recordingUrl" TEXT,
    "callGroup" TEXT,
    "keyPressed" TEXT,
    "companyId" TEXT,
    "contactId" TEXT,
    "leadId" TEXT,
    "ticketId" TEXT,
    "companyProductId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "callLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telephony_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telephony_connections_provider_key" ON "telephony_connections"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "telephony_connections_webhookTokenHash_key" ON "telephony_connections"("webhookTokenHash");

-- CreateIndex
CREATE INDEX "telephony_agents_connectionId_numberKey_idx" ON "telephony_agents"("connectionId", "numberKey");

-- CreateIndex
CREATE UNIQUE INDEX "telephony_agents_connectionId_userId_key" ON "telephony_agents"("connectionId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "telephony_agents_connectionId_memberId_key" ON "telephony_agents"("connectionId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "telephony_calls_callLogId_key" ON "telephony_calls"("callLogId");

-- CreateIndex
CREATE INDEX "telephony_calls_connectionId_startedAt_idx" ON "telephony_calls"("connectionId", "startedAt");

-- CreateIndex
CREATE INDEX "telephony_calls_connectionId_state_createdAt_idx" ON "telephony_calls"("connectionId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "telephony_calls_customerKey_idx" ON "telephony_calls"("customerKey");

-- CreateIndex
CREATE INDEX "telephony_calls_agentUserId_startedAt_idx" ON "telephony_calls"("agentUserId", "startedAt");

-- CreateIndex
CREATE INDEX "telephony_calls_campaignId_idx" ON "telephony_calls"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "telephony_calls_connectionId_providerCallId_key" ON "telephony_calls"("connectionId", "providerCallId");

-- AddForeignKey
ALTER TABLE "telephony_connections" ADD CONSTRAINT "telephony_connections_missedCallsUserId_fkey" FOREIGN KEY ("missedCallsUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telephony_agents" ADD CONSTRAINT "telephony_agents_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "telephony_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telephony_agents" ADD CONSTRAINT "telephony_agents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telephony_calls" ADD CONSTRAINT "telephony_calls_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "telephony_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telephony_calls" ADD CONSTRAINT "telephony_calls_agentUserId_fkey" FOREIGN KEY ("agentUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telephony_calls" ADD CONSTRAINT "telephony_calls_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telephony_calls" ADD CONSTRAINT "telephony_calls_callLogId_fkey" FOREIGN KEY ("callLogId") REFERENCES "call_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
