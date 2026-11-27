-- An item's own price in a currency other than the workspace's (owner, 30 Oct 2026): a USD quote carries the item's
-- dollar list price instead of the base price converted at the day's rate (src/lib/items/currency-prices.ts).
CREATE TABLE "item_prices" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "sellingPrice" DECIMAL(12,2) NOT NULL,
    "costPrice" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "item_prices_itemId_currency_key" ON "item_prices"("itemId", "currency");

ALTER TABLE "item_prices" ADD CONSTRAINT "item_prices_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
