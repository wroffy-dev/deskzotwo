-- The currency each customer or vendor is quoted and billed in (owner, 30 Oct 2026). Null is the workspace's own.
ALTER TABLE "companies" ADD COLUMN "defaultCurrency" TEXT;

-- What a foreign currency was worth on a day, base per unit (src/lib/finance/rates.ts): fetched once a day by the
-- heartbeat, or typed in Settings › Currencies — a typed one is never overwritten by a fetch.
CREATE TABLE "exchange_rates" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "rate" DECIMAL(14,6) NOT NULL,
    "source" TEXT NOT NULL,
    "setById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "exchange_rates_day_currency_key" ON "exchange_rates"("day", "currency");
CREATE INDEX "exchange_rates_currency_day_idx" ON "exchange_rates"("currency", "day");
