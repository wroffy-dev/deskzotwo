-- Which ID card of a person's is the valid one (security audit 11 Nov 2026, SEC-66): raised when a card is lost, so
-- the old one's QR no longer checks out. Every card printed so far is version 0 and stays valid.
ALTER TABLE "employee_profiles" ADD COLUMN "idCardVersion" INTEGER NOT NULL DEFAULT 0;
