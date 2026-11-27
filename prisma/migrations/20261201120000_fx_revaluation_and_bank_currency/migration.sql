-- Multi-currency phase 3 (owner, 30 Oct 2026).

-- The period-end restatement of foreign balances and its next-day reversal post under their own source, so the
-- receivables and payables tie-out (src/lib/close/tieout.ts) can tell them from everything else.
ALTER TYPE "JournalSource" ADD VALUE 'FX_REVALUATION';

-- A bank account kept in a foreign currency (EEFC). Null is the workspace's own.
ALTER TABLE "bank_accounts" ADD COLUMN "currency" TEXT;

-- One revaluation per day: the rates and totals it posted, and its two entries (src/lib/ledger/fx-revaluation.ts).
CREATE TABLE "fx_revaluations" (
    "id" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "rates" JSONB NOT NULL,
    "totals" JSONB NOT NULL,
    "net" DECIMAL(14,2) NOT NULL,
    "entryId" TEXT NOT NULL,
    "reversalEntryId" TEXT NOT NULL,
    "postedById" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_revaluations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fx_revaluations_asOf_key" ON "fx_revaluations"("asOf");
