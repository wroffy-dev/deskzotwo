-- UAE payroll (owner, 15 Nov 2026 — src/lib/uae): the WPS setup, each person's UAE pay and documents, and the monthly
-- runs whose payslips make the WPS salary file. New tables only.

CREATE TABLE "uae_wps_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "establishmentId" TEXT,
    "payingRoutingCode" TEXT,
    "payingIban" TEXT,
    "employerReference" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "uae_wps_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "uae_employees" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mohrePersonId" TEXT,
    "iban" TEXT,
    "routingCode" TEXT,
    "basic" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "housing" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "transport" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherAllowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "passportNumber" TEXT,
    "passportExpiry" DATE,
    "visaExpiry" DATE,
    "emiratesId" TEXT,
    "emiratesIdExpiry" DATE,
    "labourCardNumber" TEXT,
    "labourCardExpiry" DATE,
    "insuranceExpiry" DATE,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "uae_employees_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uae_employees_userId_key" ON "uae_employees"("userId");

CREATE TABLE "uae_payroll_runs" (
    "id" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "lockedAt" TIMESTAMP(3),
    "lockedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "uae_payroll_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uae_payroll_runs_month_year_key" ON "uae_payroll_runs"("month", "year");

CREATE TABLE "uae_payslips" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthDays" INTEGER NOT NULL,
    "payStart" DATE NOT NULL,
    "payEnd" DATE NOT NULL,
    "unpaidDays" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "basic" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "housing" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "transport" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherAllowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "overtime" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "bonus" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "fixed" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "mohrePersonId" TEXT,
    "iban" TEXT,
    "routingCode" TEXT,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "uae_payslips_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uae_payslips_runId_userId_key" ON "uae_payslips"("runId", "userId");
CREATE INDEX "uae_payslips_userId_idx" ON "uae_payslips"("userId");
ALTER TABLE "uae_payslips" ADD CONSTRAINT "uae_payslips_runId_fkey" FOREIGN KEY ("runId") REFERENCES "uae_payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
