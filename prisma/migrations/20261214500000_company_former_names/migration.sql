-- A company's former names, one per line (src/lib/companies/former-names.ts): a duplicate merged into it, or a rename.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "formerNames" TEXT;

-- Every merge already made: the duplicate's name, oldest first, where it isn't the kept company's own name.
UPDATE "companies" c
SET "formerNames" = m.names
FROM (
  SELECT "intoCompanyId", string_agg(DISTINCT "fromName", E'\n') AS names
  FROM "company_merges"
  GROUP BY "intoCompanyId"
) m
WHERE c."id" = m."intoCompanyId" AND c."formerNames" IS NULL;

-- Never its own name among them.
UPDATE "companies"
SET "formerNames" = NULLIF(array_to_string(array(
  SELECT n FROM unnest(string_to_array("formerNames", E'\n')) AS n WHERE lower(trim(n)) <> lower(trim("name")) AND trim(n) <> ''
), E'\n'), '')
WHERE "formerNames" IS NOT NULL;
