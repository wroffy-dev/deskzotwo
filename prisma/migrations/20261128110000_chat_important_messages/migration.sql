-- Settings › Chat (owner, 28 Oct 2026): important messages — those starting with "!" — switched on or off for the
-- workspace. On until an admin says otherwise.

-- AlterTable
ALTER TABLE "chat_settings" ADD COLUMN "importantAllowed" BOOLEAN NOT NULL DEFAULT true;
