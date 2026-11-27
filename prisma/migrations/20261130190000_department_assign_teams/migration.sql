-- Departments whose members may be a company's caller, account manager or renewal manager (src/lib/companies/assign-teams.ts).
ALTER TABLE "departments" ADD COLUMN "callerTeam" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "departments" ADD COLUMN "accountManagerTeam" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "departments" ADD COLUMN "renewalManagerTeam" BOOLEAN NOT NULL DEFAULT false;
