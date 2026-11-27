-- A code before a new browser opens a customer's portal link (owner, 29 Oct 2026 — src/lib/portal/device.ts): off
-- until the workspace turns it on. Codes kept only as hashes; a trusted browser by its cookie's hash.
-- Empty is off: nullable, so it stays out of an insert until it is set.
ALTER TABLE "portal_settings" ADD COLUMN "requireCode" BOOLEAN;

CREATE TABLE "portal_codes" (
    "id" TEXT NOT NULL,
    "loginId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_codes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "portal_codes_loginId_createdAt_idx" ON "portal_codes"("loginId", "createdAt");
ALTER TABLE "portal_codes" ADD CONSTRAINT "portal_codes_loginId_fkey" FOREIGN KEY ("loginId") REFERENCES "portal_logins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "portal_devices" (
    "id" TEXT NOT NULL,
    "loginId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "portal_devices_secretHash_key" ON "portal_devices"("secretHash");
CREATE INDEX "portal_devices_loginId_idx" ON "portal_devices"("loginId");
ALTER TABLE "portal_devices" ADD CONSTRAINT "portal_devices_loginId_fkey" FOREIGN KEY ("loginId") REFERENCES "portal_logins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
