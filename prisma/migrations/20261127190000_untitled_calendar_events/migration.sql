-- ---------------------------------------------------------------------------------------------
-- Events with no subject in their own calendar were kept as "(No title)"; they are busy time, and
-- now say whose (owner, 26 Oct 2026 — untitledEvent in src/lib/calendar/types.ts): the ones already
-- kept are renamed the same way. Deskzo's own meetings always have a title and are untouched.
-- ---------------------------------------------------------------------------------------------
UPDATE "calendar_events"
SET "title" = 'Busy · ' || CASE "provider"
    WHEN 'MICROSOFT' THEN 'Outlook calendar'
    WHEN 'GOOGLE' THEN 'Google Calendar'
    WHEN 'ZOHO' THEN 'Zoho Calendar'
  END
WHERE "title" = '(No title)' AND "provider" IS NOT NULL;
