/**
 * Every workspace column that holds a file's content, for the move into the storage box (scripts/storage-box.ts), the
 * sweep that clears files no row points at (src/lib/storage/sweep.ts) and the status the console shows. A file column
 * added later belongs here, with its writer using src/lib/storage/files.ts — scripts/check-storage-box.ts fails on a
 * Bytes column or a data-URL column that isn't listed or excused below.
 *
 * `kind` names the folder the files go in (workspaces/<id>/files/<kind>/…); `typeColumn`, where the row keeps its
 * file's type, is what a Bytes column's file is stored as.
 */

export type FileColumn = {
  model: string;
  table: string;
  id: string;
  column: string;
  shape: "dataUrl" | "bytes";
  kind: string;
  typeColumn: string | null;
};

export const FILE_COLUMNS: readonly FileColumn[] = [
  // Documents
  { model: "EmployeeDocument", table: "employee_documents", id: "id", column: "fileDataUrl", shape: "dataUrl", kind: "employee-documents", typeColumn: "mimeType" },
  { model: "ProjectDocument", table: "project_documents", id: "id", column: "fileDataUrl", shape: "dataUrl", kind: "project-documents", typeColumn: "mimeType" },
  { model: "CloseTaskAttachment", table: "close_task_attachments", id: "id", column: "fileDataUrl", shape: "dataUrl", kind: "close-attachments", typeColumn: "mimeType" },
  { model: "SupportEmailAttachment", table: "support_email_attachments", id: "id", column: "dataUrl", shape: "dataUrl", kind: "support-email", typeColumn: "mimeType" },
  { model: "ArchivedDocumentFile", table: "books_archived_document_files", id: "id", column: "data", shape: "bytes", kind: "archived-documents", typeColumn: "contentType" },
  { model: "OldProposalFile", table: "old_proposal_files", id: "id", column: "data", shape: "bytes", kind: "old-proposals", typeColumn: "contentType" },
  { model: "CustomFieldFile", table: "custom_field_files", id: "id", column: "data", shape: "bytes", kind: "custom-field-files", typeColumn: "contentType" },
  { model: "QuickTemplateFile", table: "quick_template_files", id: "id", column: "data", shape: "bytes", kind: "quick-templates", typeColumn: "mimeType" },
  { model: "Expense", table: "expenses", id: "id", column: "receiptDataUrl", shape: "dataUrl", kind: "expense-receipts", typeColumn: null },
  // A vendor's bill as uploaded for Arjun to read (owner, 20 Nov 2026 — src/lib/bill-reader).
  { model: "BillReading", table: "bill_readings", id: "id", column: "fileDataUrl", shape: "dataUrl", kind: "bill-readings", typeColumn: "contentType" },
  // A Smart List's Files column (owner, 20 Nov 2026 — src/lib/smart-lists/files.ts).
  { model: "WorkbookFile", table: "workbook_files", id: "id", column: "data", shape: "bytes", kind: "smart-list-files", typeColumn: "contentType" },
  // People and pictures
  { model: "UserPhoto", table: "user_photos", id: "userId", column: "dataUrl", shape: "dataUrl", kind: "user-photos", typeColumn: "mimeType" },
  { model: "VisitorEntry", table: "visitor_entries", id: "id", column: "photoDataUrl", shape: "dataUrl", kind: "visitor-photos", typeColumn: null },
  { model: "VisitorCompanion", table: "visitor_companions", id: "id", column: "photoDataUrl", shape: "dataUrl", kind: "visitor-photos", typeColumn: null },
  { model: "Celebration", table: "celebrations", id: "id", column: "imageDataUrl", shape: "dataUrl", kind: "celebrations", typeColumn: null },
  { model: "Prize", table: "prizes", id: "id", column: "imageDataUrl", shape: "dataUrl", kind: "prizes", typeColumn: null },
  // A winner keeps the prize's picture as it was when they won (src/lib/wins) — a copy of the Prize's value, often the same reference.
  { model: "PrizeWinner", table: "prize_winners", id: "id", column: "prizeImage", shape: "dataUrl", kind: "prizes", typeColumn: null },
  // Conversations and attachments
  { model: "TaskAttachment", table: "task_attachments", id: "id", column: "data", shape: "bytes", kind: "task-attachments", typeColumn: "mimeType" },
  // A help desk request's files (owner, 25 Nov 2026 — src/lib/desks).
  { model: "DeskRequestFile", table: "desk_request_files", id: "id", column: "data", shape: "bytes", kind: "desk-request-files", typeColumn: "mimeType" },
  { model: "ChatAttachment", table: "chat_attachments", id: "id", column: "data", shape: "bytes", kind: "chat-attachments", typeColumn: "mimeType" },
  { model: "ConversationFile", table: "conversation_files", id: "id", column: "bytes", shape: "bytes", kind: "inbox-files", typeColumn: "mime" },
  { model: "MarketingAsset", table: "marketing_assets", id: "id", column: "data", shape: "bytes", kind: "marketing-assets", typeColumn: "mimeType" },
];

/**
 * File columns left in the database on purpose, each with its reason. Small pictures read on every page, or a single
 * row per workspace: in the box they would cost a fetch per page for no space saved.
 */
export const KEPT_IN_DATABASE: Readonly<Record<string, string>> = {
  "OldProposalImport.source": "The prepared list an old-proposals import reads at each step: half a megabyte, one a run.",
  "BrandingSettings.logoDataUrl": "one logo per workspace, at most 256 KB, drawn on every page",
  "BrandingSettings.faviconDataUrl": "one icon per workspace, at most 256 KB, drawn on every page",
  "OrganisationSettings.signatureDataUrl": "one stamp per workspace, at most 256 KB",
  "OrganisationSettings.letterheadLogoDataUrl": "one letterhead logo per workspace, at most 256 KB",
  "OrganisationSettings.letterSignatureDataUrl": "one signature per workspace, at most 256 KB",
  "Branch.logoDataUrl": "one logo per branch, at most 256 KB",
  "Branch.signatureDataUrl": "one stamp per branch, at most 256 KB",
  "EmployeeLetter.signatureDataUrl": "a copy of the workspace's signature, at most 256 KB, taken when the letter is issued",
  "ChatIcon.dataUrl": "a group's icon, at most 96 KB",
  "SignatureBanner.imageData": "an email signature banner, at most 1 MB, a handful per workspace",
};
