-- A website's leads raised by nobody (owner, 9 Nov 2026 — "this came from our website, but why is my name in Raised by?").
-- A lead that came through a website's capture key was credited, as Raised by and Sourced by, to whoever made the key —
-- shown on the lead, and counted as theirs for "Leads raised" incentives. Where both still name that person (or the
-- super admin, for a key nobody made), they're cleared; a lead somebody has since re-credited by hand is left be.
UPDATE "leads" l
SET "createdByUserId" = NULL, "sourcedByUserId" = NULL
FROM "lead_capture_keys" k
WHERE l."captureKeyId" = k."id"
  AND l."createdByUserId" IS NOT DISTINCT FROM l."sourcedByUserId"
  AND (
    l."createdByUserId" = k."createdById"
    OR (k."createdById" IS NULL AND l."createdByUserId" IN (SELECT "id" FROM "users" WHERE "isSuperAdmin"))
  );
