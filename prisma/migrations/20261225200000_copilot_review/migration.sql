-- ---------------------------------------------------------------------------------------------
-- Deskzo AI's chats, reviewed by the workspace's admins (owner, 23 Nov 2026 — "proper history: the tenant admin can
-- see all the chats, and each employee's usage, on a proper dashboard"). A chat its owner deletes is hidden from them
-- and kept for review; every time an admin opens somebody's chat is recorded.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "copilot_conversations" ADD COLUMN IF NOT EXISTS "hiddenAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "copilot_reviews" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_reviews_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "copilot_reviews_createdAt_idx" ON "copilot_reviews"("createdAt");
CREATE INDEX IF NOT EXISTS "copilot_reviews_ownerId_createdAt_idx" ON "copilot_reviews"("ownerId", "createdAt");
