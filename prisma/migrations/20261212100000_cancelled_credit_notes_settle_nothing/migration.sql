-- A cancelled credit note settles nothing (security audit 11 Nov 2026, SEC-04 — src/actions/trade-document.ts). Cancelling one
-- used to leave its applications, so the invoices it had been applied to still read PAID with nothing received. Data only.

CREATE TEMP TABLE "_reopened" ON COMMIT DROP AS
SELECT DISTINCT a."invoiceId" AS id
FROM "credit_note_applications" a
JOIN "trade_documents" cn ON cn."id" = a."creditNoteId"
WHERE cn."status"::text = 'CANCELLED';

DELETE FROM "credit_note_applications" a
USING "trade_documents" cn
WHERE cn."id" = a."creditNoteId" AND cn."status"::text = 'CANCELLED';

-- Each invoice's status re-derived as src/lib/receivables.ts does: settled within a paisa is PAID, anything received or
-- credited is PARTIALLY_PAID, otherwise ISSUED. Drafts and cancelled invoices are left alone.
WITH settled AS (
  SELECT d."id",
         d."total",
         d."paidBefore"
           + COALESCE((SELECT SUM(p."amount") FROM "payment_allocations" p WHERE p."documentId" = d."id"), 0) AS paid,
         COALESCE((SELECT SUM(c."amount") FROM "credit_note_applications" c WHERE c."invoiceId" = d."id"), 0) AS credited
  FROM "trade_documents" d
  JOIN "_reopened" r ON r.id = d."id"
  WHERE d."status"::text IN ('PAID', 'PARTIALLY_PAID', 'ISSUED')
)
UPDATE "trade_documents" d
SET "status" = (CASE
    WHEN s."total" - s.paid - s.credited < 0.01 THEN 'PAID'
    WHEN s.paid > 0 OR s.credited > 0 THEN 'PARTIALLY_PAID'
    ELSE 'ISSUED'
  END)::"TradeDocumentStatus"
FROM settled s
WHERE s."id" = d."id";
