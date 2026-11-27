-- ---------------------------------------------------------------------------------------------
-- One lead per request: the New lead form's token, or the app's or an API caller's Idempotency-Key,
-- kept on the lead it made so the same request sent again gets that lead back instead of a second
-- one (createLead, src/actions/lead.ts). Null for every lead made before, and for leads made any
-- other way; a unique index allows any number of nulls.
-- ---------------------------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "leads_idempotencyKey_key" ON "leads"("idempotencyKey");
