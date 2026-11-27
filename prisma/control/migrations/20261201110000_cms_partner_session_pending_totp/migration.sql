-- Security audit (Nov 2026): as for the console, the authenticator secret shown while a CMS or partner
-- portal user enrols is kept on the session that asked, not on the account. Nullable columns only.

-- AlterTable
ALTER TABLE "cms_sessions" ADD COLUMN "pendingTotpCipher" TEXT;
ALTER TABLE "partner_sessions" ADD COLUMN "pendingTotpCipher" TEXT;

-- Secrets left pending on accounts that never finished enrolling may already have been seen by another
-- session; they are discarded, and anybody mid-enrolment simply sees a fresh one.
UPDATE "cms_users" SET "totpSecretCipher" = NULL WHERE "totpEnabledAt" IS NULL AND "totpSecretCipher" IS NOT NULL;
UPDATE "partner_users" SET "totpSecretCipher" = NULL WHERE "totpEnabledAt" IS NULL AND "totpSecretCipher" IS NOT NULL;
