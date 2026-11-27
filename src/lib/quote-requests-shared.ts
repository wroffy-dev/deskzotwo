/** What both sides of a quote request read (src/lib/quote-requests.ts) — no server code, so the forms may import it. */

export const LIMITS = { lines: 50, text: 300, notes: 2000, perLinkPerDay: 20, fileBytes: 5 * 1024 * 1024 } as const;
export const RFQ_FILE_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg";

export const formatRequestId = (seq: number) => `RFQ-${String(seq).padStart(6, "0")}`;
