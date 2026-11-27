-- Incentives for leads somebody raised and somebody else won — support passing on what it hears (owner, 1 Nov 2026).
ALTER TYPE "TargetMetric" ADD VALUE IF NOT EXISTS 'LEADS_RAISED_WON';
ALTER TYPE "TargetMetric" ADD VALUE IF NOT EXISTS 'LEAD_VALUE_RAISED_WON';
-- A lead's source: raised by the support team while helping a customer.
ALTER TYPE "LeadSource" ADD VALUE IF NOT EXISTS 'SUPPORT';
