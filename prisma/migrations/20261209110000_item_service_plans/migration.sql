-- The plan an item's orders start when approved (owner, 9 Nov 2026). A new table only.
CREATE TABLE "item_service_plans" (
    "itemId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "item_service_plans_pkey" PRIMARY KEY ("itemId")
);
CREATE INDEX "item_service_plans_templateId_idx" ON "item_service_plans"("templateId");
ALTER TABLE "item_service_plans" ADD CONSTRAINT "item_service_plans_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "item_service_plans" ADD CONSTRAINT "item_service_plans_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "service_cycle_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
