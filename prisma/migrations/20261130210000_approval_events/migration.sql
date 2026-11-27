-- Every approval decision, in one place (src/lib/approvals/log.ts). Filled here from what each record kept:
-- its latest decision only, marked backfilled.
CREATE TABLE "approval_events" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "href" TEXT,
    "note" TEXT,
    "requestedById" TEXT,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "backfilled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "approval_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "approval_events_decidedAt_idx" ON "approval_events"("decidedAt");
CREATE INDEX "approval_events_kind_decidedAt_idx" ON "approval_events"("kind", "decidedAt");
CREATE INDEX "approval_events_decidedById_decidedAt_idx" ON "approval_events"("decidedById", "decidedAt");
CREATE INDEX "approval_events_requestedById_decidedAt_idx" ON "approval_events"("requestedById", "decidedAt");
CREATE INDEX "approval_events_recordId_idx" ON "approval_events"("recordId");

-- Orders, by accounts.
INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'order', CASE WHEN p."orderStatus" = 'REJECTED' THEN 'REJECTED' ELSE 'APPROVED' END, p."id",
       'ORD-' || lpad(p."orderSeq"::text, 6, '0') || ' — ' || c."name", '/orders/ORD-' || lpad(p."orderSeq"::text, 6, '0'),
       p."accountsNotes", p."addedByUserId", p."accountsApprovedByUserId", p."accountsApprovedAt", true
FROM "company_products" p JOIN "companies" c ON c."id" = p."companyId"
WHERE p."accountsApprovedByUserId" IS NOT NULL AND p."accountsApprovedAt" IS NOT NULL;

-- Selling below cost.
INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'orderLoss', 'APPROVED', p."id",
       'ORD-' || lpad(p."orderSeq"::text, 6, '0') || ' — ' || c."name", '/orders/ORD-' || lpad(p."orderSeq"::text, 6, '0'),
       p."lossApprovalNote", p."addedByUserId", p."lossApprovedById", p."lossApprovedAt", true
FROM "company_products" p JOIN "companies" c ON c."id" = p."companyId"
WHERE p."lossApprovedById" IS NOT NULL AND p."lossApprovedAt" IS NOT NULL;

-- Quotations, proformas, invoices and the rest that need approving.
INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'document', CASE WHEN d."approvalStatus" = 'REJECTED' THEN 'SENT_BACK' ELSE 'APPROVED' END, d."id",
       d."docNumber", '/documents/' || d."id", d."approvalNote", d."submittedById", d."approvedById", d."approvedAt", true
FROM "trade_documents" d
WHERE d."approvedById" IS NOT NULL AND d."approvedAt" IS NOT NULL AND d."approvalStatus" IN ('APPROVED', 'REJECTED');

-- Expense claims: the manager's step, then the final one.
INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'expenseManager', 'APPROVED', e."id",
       'EXP-' || lpad(e."expenseSeq"::text, 6, '0') || ' — ' || u."name", '/expenses/EXP-' || lpad(e."expenseSeq"::text, 6, '0'),
       NULL, e."userId", e."managerApproverId", e."managerApprovedAt", true
FROM "expenses" e JOIN "users" u ON u."id" = e."userId"
WHERE e."managerApproverId" IS NOT NULL AND e."managerApprovedAt" IS NOT NULL;

INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'expense', CASE WHEN e."status" = 'REJECTED' THEN 'REJECTED' ELSE 'APPROVED' END, e."id",
       'EXP-' || lpad(e."expenseSeq"::text, 6, '0') || ' — ' || u."name", '/expenses/EXP-' || lpad(e."expenseSeq"::text, 6, '0'),
       e."decisionNote", e."userId", e."approverUserId", e."decidedAt", true
FROM "expenses" e JOIN "users" u ON u."id" = e."userId"
WHERE e."approverUserId" IS NOT NULL AND e."decidedAt" IS NOT NULL AND e."status" IN ('APPROVED', 'REJECTED', 'REIMBURSED');

-- Leave, short leave and attendance corrections.
INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'leave', r."status"::text, r."id",
       'Leave ' || to_char(r."fromDate", 'DD Mon YYYY') || CASE WHEN r."toDate"::date <> r."fromDate"::date THEN ' – ' || to_char(r."toDate", 'DD Mon YYYY') ELSE '' END || ' — ' || u."name",
       NULL, r."decisionNote", r."userId", r."approverId", r."decidedAt", true
FROM "leave_requests" r JOIN "users" u ON u."id" = r."userId"
WHERE r."approverId" IS NOT NULL AND r."decidedAt" IS NOT NULL AND r."status" IN ('APPROVED', 'REJECTED');

INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'shortLeave', r."status"::text, r."id",
       'Short leave ' || to_char(r."date", 'DD Mon YYYY') || ' — ' || u."name", NULL, r."decisionNote", r."userId", r."approverId", r."decidedAt", true
FROM "short_leave_requests" r JOIN "users" u ON u."id" = r."userId"
WHERE r."approverId" IS NOT NULL AND r."decidedAt" IS NOT NULL AND r."status" IN ('APPROVED', 'REJECTED');

INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'regularisation', r."status"::text, r."id",
       'Attendance for ' || to_char(r."date", 'DD Mon YYYY') || ' — ' || u."name", NULL, r."decisionNote", r."userId", r."approverId", r."decidedAt", true
FROM "attendance_regularisations" r JOIN "users" u ON u."id" = r."userId"
WHERE r."approverId" IS NOT NULL AND r."decidedAt" IS NOT NULL AND r."status" IN ('APPROVED', 'REJECTED');

-- Working away from the office, and new devices (a revoked device is left out: revoking overwrote who approved it).
INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'attendanceException', CASE WHEN r."status" = 'REJECTED' THEN 'REJECTED' ELSE 'APPROVED' END, r."id",
       'Away from the office — ' || u."name", NULL, r."decisionNote", r."requestedById", r."decidedById", r."decidedAt", true
FROM "attendance_exceptions" r JOIN "users" u ON u."id" = r."userId"
WHERE r."decidedById" IS NOT NULL AND r."decidedAt" IS NOT NULL AND r."status" IN ('APPROVED', 'REJECTED', 'REVOKED');

INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'device', CASE WHEN r."status" = 'REJECTED' THEN 'REJECTED' ELSE 'APPROVED' END, r."id",
       coalesce(nullif(r."label", ''), 'A new device') || ' — ' || u."name", NULL, r."decisionNote", r."userId", r."decidedById", r."decidedAt", true
FROM "user_devices" r JOIN "users" u ON u."id" = r."userId"
WHERE r."decidedById" IS NOT NULL AND r."decidedAt" IS NOT NULL AND r."status" IN ('APPROVED', 'REJECTED');

-- Accounts and stock.
INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'voucher', 'APPROVED', v."id", 'Voucher ' || v."number", '/accounting/vouchers/' || v."id", NULL, v."submittedById", v."approvedById", v."approvedAt", true
FROM "account_vouchers" v
WHERE v."approvedById" IS NOT NULL AND v."approvedAt" IS NOT NULL;

INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'stockDocument', 'APPROVED', s."id", 'Stock document ' || s."number", NULL, NULL, s."submittedById", s."approvedById", s."approvedAt", true
FROM "stock_documents" s
WHERE s."approvedById" IS NOT NULL AND s."approvedAt" IS NOT NULL;

INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'revenueSchedule', 'APPROVED', r."id", 'Revenue schedule', '/accounting/revenue/' || r."id", r."note", r."createdById", r."approvedById", r."approvedAt", true
FROM "revenue_schedules" r
WHERE r."approvedById" IS NOT NULL AND r."approvedAt" IS NOT NULL;

-- Marketing, incentives and settlements.
INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'campaign', 'APPROVED', m."id", m."reference" || ' — ' || m."name", NULL, NULL, m."createdById", m."approvedById", m."approvedAt", true
FROM "marketing_campaigns" m
WHERE m."approvedById" IS NOT NULL AND m."approvedAt" IS NOT NULL;

INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'incentive', 'APPROVED', i."id", coalesce(nullif(i."label", ''), 'Incentive') || ' — ' || u."name", '/incentives', i."note", i."createdById", i."approvedById", i."approvedAt", true
FROM "incentive_earnings" i JOIN "users" u ON u."id" = i."userId"
WHERE i."approvedById" IS NOT NULL AND i."approvedAt" IS NOT NULL;

INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'settlement', 'APPROVED', f."id", 'Final settlement — ' || u."name", '/people/' || f."userId" || '/settlement', f."note", f."createdById", f."approvedById", f."approvedAt", true
FROM "final_settlements" f JOIN "users" u ON u."id" = f."userId"
WHERE f."approvedById" IS NOT NULL AND f."approvedAt" IS NOT NULL;

-- Workflow approval steps.
INSERT INTO "approval_events" ("id", "kind", "decision", "recordId", "label", "href", "note", "requestedById", "decidedById", "decidedAt", "backfilled")
SELECT gen_random_uuid()::text, 'workflow', a."status"::text, a."id", a."title", '/approvals', a."comment", NULL, a."decidedById", a."decidedAt", true
FROM "approval_requests" a
WHERE a."decidedById" IS NOT NULL AND a."decidedAt" IS NOT NULL AND a."status" IN ('APPROVED', 'REJECTED');
