-- Whose members may own a lead (src/lib/companies/assign-teams.ts). Listed in NOT_YET_EVERYWHERE.
ALTER TABLE "departments" ADD COLUMN "leadOwnerTeam" BOOLEAN NOT NULL DEFAULT false;
