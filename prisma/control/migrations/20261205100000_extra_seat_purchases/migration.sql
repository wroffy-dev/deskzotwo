-- More people part-way through a paid period (owner, 7 Nov 2026 — src/lib/billing/extra-seats.ts): bought on their own,
-- pro-rated to the day the period ends, and counted on top of the plans until then. New table only.

-- CreateEnum
CREATE TYPE "ExtraSeatStatus" AS ENUM ('WAITING', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "extra_seat_purchases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "gateway" "BillingGateway" NOT NULL,
    "status" "ExtraSeatStatus" NOT NULL DEFAULT 'WAITING',
    "externalId" TEXT,
    "proformaId" TEXT,
    "invoiceId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extra_seat_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "extra_seat_purchases_externalId_key" ON "extra_seat_purchases"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "extra_seat_purchases_proformaId_key" ON "extra_seat_purchases"("proformaId");

-- CreateIndex
CREATE UNIQUE INDEX "extra_seat_purchases_invoiceId_key" ON "extra_seat_purchases"("invoiceId");

-- CreateIndex
CREATE INDEX "extra_seat_purchases_tenantId_status_idx" ON "extra_seat_purchases"("tenantId", "status");

-- CreateIndex
CREATE INDEX "extra_seat_purchases_status_endsAt_idx" ON "extra_seat_purchases"("status", "endsAt");

-- AddForeignKey
ALTER TABLE "extra_seat_purchases" ADD CONSTRAINT "extra_seat_purchases_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extra_seat_purchases" ADD CONSTRAINT "extra_seat_purchases_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extra_seat_purchases" ADD CONSTRAINT "extra_seat_purchases_proformaId_fkey" FOREIGN KEY ("proformaId") REFERENCES "platform_proformas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extra_seat_purchases" ADD CONSTRAINT "extra_seat_purchases_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
