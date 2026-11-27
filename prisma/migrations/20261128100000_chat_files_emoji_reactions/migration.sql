-- Settings › Chat (owner, 28 Oct 2026): files, the emoji button and reactions, each switched on or off for the
-- workspace. All on, as before, until an admin says otherwise.

-- AlterTable
ALTER TABLE "chat_settings" ADD COLUMN "attachmentsAllowed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "emojiAllowed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "reactionsAllowed" BOOLEAN NOT NULL DEFAULT true;
