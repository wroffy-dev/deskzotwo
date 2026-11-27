-- Per-document permissions (owner, 9 Nov 2026: "create, edit, issue, delete, cancel and approve, all separate permissions
-- for separate documents"; src/lib/documents/permission-keys.ts). Every stored grant and denial of the four keys they
-- replace is copied onto the keys that now cover the same ground, so nobody can do more or less than yesterday until an
-- admin changes it. Built-in roles with nothing stored hold the new keys by default, as they held the old ones.
-- Certificates borrowed "Raise and issue" and "Delete or cancel"; they get keys of their own the same way. Approve is
-- new and copied from nothing: the approvers Settings › Document approvals names still approve.
-- The old rows are left where they are; nothing reads them now.

CREATE TEMP TABLE "_doc_key_map" ("old" TEXT NOT NULL, "new" TEXT NOT NULL);
INSERT INTO "_doc_key_map" ("old", "new") VALUES
  ('documents.issue', 'docs.createProposal'),
  ('documents.issue', 'docs.editProposal'),
  ('documents.issue', 'docs.issueProposal'),
  ('documents.issue', 'docs.createProforma'),
  ('documents.issue', 'docs.editProforma'),
  ('documents.issue', 'docs.issueProforma'),
  ('documents.issue', 'docs.createInvoice'),
  ('documents.issue', 'docs.editInvoice'),
  ('documents.issue', 'docs.issueInvoice'),
  ('documents.issue', 'docs.createDeliveryChallan'),
  ('documents.issue', 'docs.editDeliveryChallan'),
  ('documents.issue', 'docs.issueDeliveryChallan'),
  ('documents.issue', 'docs.createBill'),
  ('documents.issue', 'docs.editBill'),
  ('documents.issue', 'docs.issueBill'),
  ('documents.void', 'docs.deleteProposal'),
  ('documents.void', 'docs.cancelProposal'),
  ('documents.void', 'docs.deleteProforma'),
  ('documents.void', 'docs.cancelProforma'),
  ('documents.void', 'docs.deleteInvoice'),
  ('documents.void', 'docs.cancelInvoice'),
  ('documents.void', 'docs.deleteCreditNote'),
  ('documents.void', 'docs.cancelCreditNote'),
  ('documents.void', 'docs.deleteDebitNote'),
  ('documents.void', 'docs.cancelDebitNote'),
  ('documents.void', 'docs.deleteDeliveryChallan'),
  ('documents.void', 'docs.cancelDeliveryChallan'),
  ('documents.void', 'docs.deleteBill'),
  ('documents.void', 'docs.cancelBill'),
  ('documents.notes', 'docs.createCreditNote'),
  ('documents.notes', 'docs.editCreditNote'),
  ('documents.notes', 'docs.issueCreditNote'),
  ('documents.notes', 'docs.createDebitNote'),
  ('documents.notes', 'docs.editDebitNote'),
  ('documents.notes', 'docs.issueDebitNote'),
  ('purchase.raiseOrders', 'docs.createPurchaseOrder'),
  ('purchase.raiseOrders', 'docs.editPurchaseOrder'),
  ('purchase.raiseOrders', 'docs.issuePurchaseOrder'),
  ('purchase.raiseOrders', 'docs.deletePurchaseOrder'),
  ('purchase.raiseOrders', 'docs.cancelPurchaseOrder'),
  ('documents.issue', 'certificates.issue'),
  ('documents.void', 'certificates.withdraw');

INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
SELECT rp."role", m."new", rp."allowed", CURRENT_TIMESTAMP
FROM "role_permissions" rp
JOIN "_doc_key_map" m ON m."old" = rp."permission"
ON CONFLICT ("role", "permission") DO NOTHING;

INSERT INTO "user_permissions" ("userId", "permission", "allowed", "reason", "grantedById", "expiresAt", "createdAt", "updatedAt")
SELECT up."userId", m."new", up."allowed",
       COALESCE(up."reason", 'Copied from ' || up."permission" || ' when documents got a permission per type and action'),
       up."grantedById", up."expiresAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "user_permissions" up
JOIN "_doc_key_map" m ON m."old" = up."permission"
ON CONFLICT ("userId", "permission") DO NOTHING;

DROP TABLE "_doc_key_map";
