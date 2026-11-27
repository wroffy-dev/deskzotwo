/**
 * What can be approved, in the words Approvals › History shows (owner, 30 Oct 2026). Plain data, for the page's filter
 * as much as the server; each key is what `recordApproval` (src/lib/approvals/log.ts) is told.
 */
export const APPROVAL_KINDS = {
  order: "Order",
  orderLoss: "Selling below cost",
  orderPrice: "Purchase's higher price",
  document: "Quotation, proforma or invoice",
  expenseManager: "Expense claim — manager",
  expense: "Expense claim",
  leave: "Leave",
  shortLeave: "Short leave",
  regularisation: "Attendance correction",
  attendanceException: "Working away from the office",
  device: "New device",
  voucher: "Voucher",
  stockDocument: "Stock document",
  revenueSchedule: "Revenue schedule",
  campaign: "Campaign",
  incentive: "Incentive",
  settlement: "Final settlement",
  workflow: "Workflow approval",
} as const;

export type ApprovalKind = keyof typeof APPROVAL_KINDS;
export type ApprovalDecision = "APPROVED" | "REJECTED" | "SENT_BACK";

export const APPROVAL_DECISIONS: Record<ApprovalDecision, string> = {
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SENT_BACK: "Sent back",
};

export const isApprovalKind = (v: unknown): v is ApprovalKind => typeof v === "string" && Object.hasOwn(APPROVAL_KINDS, v);
