-- Invitations emailed from the console (owner, 13 Nov 2026 — src/lib/platform/invite-mail.ts): to whom, when, by whom,
-- and whether it went. New table only.

-- CreateTable
CREATE TABLE "signup_invite_sends" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentBy" TEXT,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,

    CONSTRAINT "signup_invite_sends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signup_invite_sends_codeHash_sentAt_idx" ON "signup_invite_sends"("codeHash", "sentAt");
