-- The PF return's figures on each payslip, as the run worked them out (owner, 31 Oct 2026).
ALTER TABLE "payslips" ADD COLUMN "pfWages" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "payslips" ADD COLUMN "epsWages" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "payslips" ADD COLUMN "epsEmployer" DECIMAL(12,2) NOT NULL DEFAULT 0;
