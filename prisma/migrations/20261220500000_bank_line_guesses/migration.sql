-- Arjun reading a bank statement's money-in lines (owner, 20 Nov 2026 — src/lib/bank-match): what Deskzo AI read for a
-- line the rules couldn't place, kept so each line is asked about once.
CREATE TABLE "bank_line_guesses" (
    "statementLineId" TEXT NOT NULL,
    "companyId" TEXT,
    "documentIds" TEXT[],
    "why" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_line_guesses_pkey" PRIMARY KEY ("statementLineId")
);

ALTER TABLE "bank_line_guesses" ADD CONSTRAINT "bank_line_guesses_statementLineId_fkey" FOREIGN KEY ("statementLineId") REFERENCES "bank_statement_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
