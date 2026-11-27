-- Loans and salary advances to employees, recovered from pay (owner, 31 Oct 2026).
-- CreateEnum
CREATE TYPE "LoanKind" AS ENUM ('LOAN', 'ADVANCE');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "payslips" ADD COLUMN     "loanRecovery" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "employee_loans" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "LoanKind" NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'REQUESTED',
    "amount" DECIMAL(12,2) NOT NULL,
    "instalments" INTEGER NOT NULL,
    "instalmentAmount" DECIMAL(12,2) NOT NULL,
    "firstMonth" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "disbursedOn" DATE,
    "disbursedFromCash" BOOLEAN NOT NULL DEFAULT false,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_repayments" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "on" DATE NOT NULL,
    "payslipId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_repayments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_loans_userId_status_idx" ON "employee_loans"("userId", "status");

-- CreateIndex
CREATE INDEX "employee_loans_status_idx" ON "employee_loans"("status");

-- CreateIndex
CREATE INDEX "loan_repayments_loanId_idx" ON "loan_repayments"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "loan_repayments_loanId_payslipId_key" ON "loan_repayments"("loanId", "payslipId");

-- AddForeignKey
ALTER TABLE "employee_loans" ADD CONSTRAINT "employee_loans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loans" ADD CONSTRAINT "employee_loans_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "employee_loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "payslips"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TYPE "NotificationType" ADD VALUE 'LOAN_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_DECIDED';
