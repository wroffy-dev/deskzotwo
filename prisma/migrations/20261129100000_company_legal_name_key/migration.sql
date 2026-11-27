-- ---------------------------------------------------------------------------------------------
-- A company's name as an import matches it (owner, 29 Oct 2026): "Ingram Micro India Pvt. Ltd." and "Ingram Micro
-- India Private Limited" are one company. Worked out by the database from the name, so it is never stale whoever
-- writes the company, and the ones already here are filled as the column is made. The same rules as legalNameKey in
-- src/lib/company-name.ts, which check:company-name-key compares name for name: lower case, "(P)" as "pvt", "&" as
-- "and", punctuation as spaces, a leading "the" let go, and each legal form one way.
--
-- An import's match by name in another legal form is then one indexed lookup (src/lib/companies/by-name.ts), where
-- it scanned every name containing the first word and stopped at 500 — and so could miss on "Shree" or "Sri".
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION company_legal_name_key(name text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(string_agg(
    CASE w
      WHEN 'private' THEN 'pvt' WHEN 'pvt' THEN 'pvt'
      WHEN 'limited' THEN 'ltd' WHEN 'ltd' THEN 'ltd'
      WHEN 'company' THEN 'co' WHEN 'co' THEN 'co'
      WHEN 'corporation' THEN 'corp' WHEN 'corp' THEN 'corp'
      WHEN 'incorporated' THEN 'inc' WHEN 'inc' THEN 'inc'
      ELSE w
    END, ' ' ORDER BY i), '')
  FROM unnest(string_to_array(
    btrim(regexp_replace(replace(regexp_replace(lower(coalesce(name, '')), '\(\s*p\s*\)', ' pvt ', 'g'), '&', ' and '), '[^a-z0-9]+', ' ', 'g')),
    ' ')) WITH ORDINALITY AS t(w, i)
  WHERE w <> '' AND NOT (i = 1 AND w = 'the');
$$;

ALTER TABLE "companies" ADD COLUMN "legalNameKey" TEXT GENERATED ALWAYS AS (company_legal_name_key("name")) STORED;
CREATE INDEX "companies_legalNameKey_idx" ON "companies"("legalNameKey");

-- An address by its GSTIN, across companies: a vendor that is a Zoho customer too, found by the GSTIN they share.
CREATE INDEX "company_locations_gstNumber_idx" ON "company_locations"("gstNumber");
