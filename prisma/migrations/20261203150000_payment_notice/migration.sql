-- A payment reminder about one order, from the Payments list (owner, 3 Nov 2026).
ALTER TYPE "CustomerNoticeKind" ADD VALUE IF NOT EXISTS 'PAYMENT';
