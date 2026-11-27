-- Putting back the leads' Updated date (owner, 5 Nov 2026 — "why all leads showing 5th Nov?"). Rescoring moved it: the
-- sweep every 12 hours and opening a lead both did, so every open lead read as worked today. The true dates are gone;
-- this rebuilds each from the last real thing that happened to the lead — an edit or change on record, an activity, a
-- call, a requirement, a new owner, a stage move — or the day it was added. It only ever moves the date back.

WITH last_work AS (
  SELECT "leadId", max(at) AS at FROM (
    SELECT "leadId", "occurredAt" AS at FROM "activities"
    UNION ALL SELECT "leadId", "startedAt" FROM "call_logs" WHERE "leadId" IS NOT NULL
    UNION ALL SELECT "leadId", "createdAt" FROM "lead_requirements"
    UNION ALL SELECT "leadId", "assignedAt" FROM "lead_assignments"
    UNION ALL SELECT "leadId", "createdAt" FROM "audit_logs" WHERE "leadId" IS NOT NULL
  ) AS work
  GROUP BY "leadId"
)
UPDATE "leads" l
SET "updatedAt" = GREATEST(l."createdAt", l."stageChangedAt", w.at)
FROM (SELECT l2."id", lw.at FROM "leads" l2 LEFT JOIN last_work lw ON lw."leadId" = l2."id") w
WHERE w."id" = l."id"
  AND GREATEST(l."createdAt", l."stageChangedAt", w.at) < l."updatedAt";
