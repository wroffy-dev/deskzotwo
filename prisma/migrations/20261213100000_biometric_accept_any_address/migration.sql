-- Security audit, Nov 2026: a terminal with no address list has its uploads refused unless HR ticks "accept from
-- any address" (src/app/api/biometric/iclock/[[...path]]/route.ts). New terminals start with it off.
ALTER TABLE "biometric_devices" ADD COLUMN "acceptAnyAddress" BOOLEAN NOT NULL DEFAULT false;

-- Terminals already sending with no list are carried over switched on, so attendance doesn't stop on deploy;
-- Biometric warns about each until it is given a list or the box is unticked.
UPDATE "biometric_devices" SET "acceptAnyAddress" = true WHERE cardinality("allowedIps") = 0;
