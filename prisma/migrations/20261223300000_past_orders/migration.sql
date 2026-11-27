-- Orders entered after the fact (owner, 23 Nov 2026 — temporary; src/actions/past-order.ts).
CREATE TABLE "past_order_entries" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "past_order_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "past_order_entries_orderId_key" ON "past_order_entries"("orderId");

ALTER TABLE "past_order_entries" ADD CONSTRAINT "past_order_entries_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "company_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
