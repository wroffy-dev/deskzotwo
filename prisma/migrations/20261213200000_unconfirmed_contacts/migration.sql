-- Security audit round two, 13 Nov 2026 (R2-14): a contact a visitor added to a company that already existed — through
-- a website form, the booking page or a digital card — is marked with where it came from, and is left out of automatic
-- recipients until staff confirm it (src/lib/contacts/unconfirmed.ts). Existing contacts stay confirmed (null).
ALTER TABLE "contacts" ADD COLUMN "unconfirmedFrom" TEXT;
