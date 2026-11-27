-- The company's own icon from its website, read by the domain lookup (owner, 15 Nov 2026 — src/lib/domain-intel/favicon.ts):
-- a small data URL shown beside the company's name. Read by name; listed in NOT_YET_EVERYWHERE until every workspace has it.
ALTER TABLE "domain_profiles" ADD COLUMN "favicon" TEXT;
