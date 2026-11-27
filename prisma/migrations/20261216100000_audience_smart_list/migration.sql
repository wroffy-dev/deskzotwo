-- A marketing audience may follow a Smart List (owner, 16 Nov 2026).
ALTER TABLE "marketing_audiences" ADD COLUMN "smartListId" TEXT;
CREATE INDEX "marketing_audiences_smartListId_idx" ON "marketing_audiences"("smartListId");
ALTER TABLE "marketing_audiences" ADD CONSTRAINT "marketing_audiences_smartListId_fkey" FOREIGN KEY ("smartListId") REFERENCES "workbooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
