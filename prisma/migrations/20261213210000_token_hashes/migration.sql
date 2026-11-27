-- Security audit round two, 13 Nov 2026 (O6): portal links and reception-desk (kiosk) links were stored in clear.
-- A visit now finds its row by the SHA-256 of the token (tokenHash), and the link staff copy again is kept encrypted
-- with the workspace's key (tokenCipher, written by the app — SQL has no key). Existing links keep working: their
-- hashes are filled in here from the tokens they hold. The plain token column stays for those older rows until a
-- later release contracts it; new rows leave it empty, so it may now be null.

ALTER TABLE "portal_logins" ADD COLUMN "tokenHash" TEXT;
ALTER TABLE "portal_logins" ADD COLUMN "tokenCipher" TEXT;
ALTER TABLE "portal_logins" ALTER COLUMN "token" DROP NOT NULL;
UPDATE "portal_logins" SET "tokenHash" = encode(sha256(convert_to("token", 'UTF8')), 'hex') WHERE "token" IS NOT NULL AND "tokenHash" IS NULL;
CREATE UNIQUE INDEX "portal_logins_tokenHash_key" ON "portal_logins"("tokenHash");

ALTER TABLE "visitor_kiosks" ADD COLUMN "tokenHash" TEXT;
ALTER TABLE "visitor_kiosks" ADD COLUMN "tokenCipher" TEXT;
ALTER TABLE "visitor_kiosks" ALTER COLUMN "token" DROP NOT NULL;
UPDATE "visitor_kiosks" SET "tokenHash" = encode(sha256(convert_to("token", 'UTF8')), 'hex') WHERE "token" IS NOT NULL AND "tokenHash" IS NULL;
CREATE UNIQUE INDEX "visitor_kiosks_tokenHash_key" ON "visitor_kiosks"("tokenHash");
