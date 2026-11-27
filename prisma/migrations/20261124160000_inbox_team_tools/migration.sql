-- The Customer inbox's team tools (owner, 24 Oct 2026): private notes, tags, the customer's rating, emailed
-- follow-ups, saved replies, who is available, and blocked visitors. New tables, an enum value, and columns
-- on conversations kept out of select-less queries until every workspace has migrated.

-- CreateEnum
CREATE TYPE "InboxAvailability" AS ENUM ('ONLINE', 'AWAY');

-- AlterEnum
ALTER TYPE "ConversationAuthor" ADD VALUE 'NOTE';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "followUpAt" TIMESTAMP(3),
ADD COLUMN     "ratedAt" TIMESTAMP(3),
ADD COLUMN     "rating" TEXT,
ADD COLUMN     "ratingAskedAt" TIMESTAMP(3),
ADD COLUMN     "ratingComment" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "inbox_saved_replies" (
    "id" TEXT NOT NULL,
    "shortcut" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbox_saved_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_agent_status" (
    "userId" TEXT NOT NULL,
    "status" "InboxAvailability" NOT NULL DEFAULT 'ONLINE',
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbox_agent_status_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "inbox_blocks" (
    "id" TEXT NOT NULL,
    "kind" "InboxChannelKind" NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbox_saved_replies_shortcut_key" ON "inbox_saved_replies"("shortcut");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_blocks_kind_value_key" ON "inbox_blocks"("kind", "value");

