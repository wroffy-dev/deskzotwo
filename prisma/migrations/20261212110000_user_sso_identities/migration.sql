-- Which Microsoft, Google or Zoho identity each account signs in with (security audit 11 Nov 2026, SEC-02 —
-- src/lib/workplace/sign-in.ts). New table only.
CREATE TABLE "user_sso_identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_sso_identities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_sso_identities_userId_provider_key" ON "user_sso_identities"("userId", "provider");
CREATE UNIQUE INDEX "user_sso_identities_provider_subject_key" ON "user_sso_identities"("provider", "subject");
ALTER TABLE "user_sso_identities" ADD CONSTRAINT "user_sso_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
