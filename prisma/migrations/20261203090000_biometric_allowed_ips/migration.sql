-- The addresses a biometric terminal may call from (owner, 2 Nov 2026 — Phase 1 security fixes, audit M-8).
-- Empty, the default, accepts it from any address, as every terminal was before.
ALTER TABLE "biometric_devices" ADD COLUMN "allowedIps" TEXT[] DEFAULT ARRAY[]::TEXT[];
