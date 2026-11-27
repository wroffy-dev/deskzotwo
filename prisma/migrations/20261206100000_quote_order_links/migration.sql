-- Which order a quote's line became: a sales order from a quote, one a line (owner, 6 Nov 2026).
CREATE TABLE "quote_order_links" (
    "lineId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_order_links_pkey" PRIMARY KEY ("lineId")
);

CREATE INDEX "quote_order_links_quoteId_idx" ON "quote_order_links"("quoteId");
