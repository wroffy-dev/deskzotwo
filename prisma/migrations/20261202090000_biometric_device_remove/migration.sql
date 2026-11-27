-- A terminal removed from Biometric (owner, 2 Nov 2026): hidden and refused, its punches kept.
ALTER TABLE "biometric_devices" ADD COLUMN "removedAt" TIMESTAMP(3);
ALTER TABLE "biometric_devices" ADD COLUMN "removedById" TEXT;
