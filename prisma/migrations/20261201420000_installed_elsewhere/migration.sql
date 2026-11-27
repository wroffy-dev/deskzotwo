-- Installed elsewhere: what a customer uses that it didn't buy from us (owner, 2 Nov 2026).
CREATE TABLE "installed_elsewhere" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "itemId" TEXT,
    "category" TEXT,
    "quantity" INTEGER,
    "boughtFrom" TEXT,
    "renewsOn" DATE,
    "yearlyValue" DECIMAL(14,2),
    "source" TEXT NOT NULL DEFAULT 'CUSTOMER_SAID',
    "notes" TEXT,
    "remindDays" INTEGER DEFAULT 90,
    "remindedFor" DATE,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installed_elsewhere_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "installed_elsewhere_companyId_idx" ON "installed_elsewhere"("companyId");
CREATE INDEX "installed_elsewhere_renewsOn_idx" ON "installed_elsewhere"("renewsOn");

ALTER TABLE "installed_elsewhere" ADD CONSTRAINT "installed_elsewhere_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
