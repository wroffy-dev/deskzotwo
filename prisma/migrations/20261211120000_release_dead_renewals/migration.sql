-- A renewal order that was cancelled, or refused at approval, renews nothing (owner, 11 Nov 2026 — src/lib/renewal-release.ts).
-- Its link stayed, so the subscription read as renewed for good: no reminders, never lapsed, and Renew refused. Data only.

-- Auto-renew off on those subscriptions first: left on, the next billing run would raise the same renewal again.
DELETE FROM "recurring_billings" rb
USING "company_products" r
WHERE r."renewedFromId" = rb."companyProductId"
  AND rb."mode"::text = 'AUTO_RENEW'
  AND r."orderStatus"::text IN ('CANCELLED', 'REJECTED');

UPDATE "company_products"
SET "renewedFromId" = NULL
WHERE "renewedFromId" IS NOT NULL
  AND "orderStatus"::text IN ('CANCELLED', 'REJECTED');
