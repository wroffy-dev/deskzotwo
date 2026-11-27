-- The company's social pages, as its homepage links them, found by the free website lookup (src/lib/domain-intel).
ALTER TABLE "domain_profiles" ADD COLUMN "socialLinks" JSONB;
