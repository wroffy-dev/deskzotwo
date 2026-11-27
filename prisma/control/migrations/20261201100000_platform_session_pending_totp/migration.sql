-- Security audit (Nov 2026): the authenticator secret shown while a staff member enrols is kept on the
-- session that asked, not on the account, so a session that only passed the password step can no longer
-- see the secret another session later enrols. Nullable column only.

-- AlterTable
ALTER TABLE "platform_sessions" ADD COLUMN "pendingTotpCipher" TEXT;

-- Secrets left pending on accounts that never finished enrolling may already have been seen by another
-- session; they are discarded, and anybody mid-enrolment simply sees a fresh one.
UPDATE "platform_users" SET "totpSecretCipher" = NULL WHERE "totpEnabledAt" IS NULL AND "totpSecretCipher" IS NOT NULL;
