-- Security audit round three, 14 Nov 2026 (R3-11): the account the net pay goes to, copied onto each payslip when its
-- run is locked, so the salary bank file pays the account that was locked rather than the one on the employee record
-- on the day the file is downloaded. Payslips locked before this stay empty, and the bank file reads the record for them.
ALTER TABLE "payslips" ADD COLUMN "bankAccountNumber" TEXT;
ALTER TABLE "payslips" ADD COLUMN "bankIfsc" TEXT;
ALTER TABLE "payslips" ADD COLUMN "bankName" TEXT;
ALTER TABLE "payslips" ADD COLUMN "bankHolderName" TEXT;
