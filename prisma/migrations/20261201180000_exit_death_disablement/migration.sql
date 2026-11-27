-- Exits by death or permanent disablement: gratuity is paid whatever the years of service (src/lib/hr/settlement.ts).
ALTER TYPE "ExitType" ADD VALUE IF NOT EXISTS 'DECEASED';
ALTER TYPE "ExitType" ADD VALUE IF NOT EXISTS 'DISABLED';
