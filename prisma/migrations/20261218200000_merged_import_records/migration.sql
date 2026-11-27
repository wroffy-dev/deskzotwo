-- Companies merged before 18 Nov 2026 left the old systems' ids (legacy_import_records) on the duplicate, which is
-- gone: a Zoho payment naming that id found no company, and pulling customers again made the duplicate afresh. Each
-- now names the company it was merged into, following a merge into a company merged later (src/lib/companies/merge.ts
-- moves them at the merge from now on). Data only.
DO $$
BEGIN
  FOR i IN 1..20 LOOP
    UPDATE "legacy_import_records" r
       SET "recordId" = m."intoCompanyId"
      FROM "company_merges" m
     WHERE r."recordId" = m."fromCompanyId";
    EXIT WHEN NOT FOUND;
  END LOOP;
END $$;
