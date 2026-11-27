import type { TradeDocumentType } from "@prisma/client";
import { docKey, docRefusal, type DocAction, type DocPermissionKey } from "@/lib/documents/permission-keys";

/**
 * Which permission doing this to a document of this type asks for: one per type and action since 9 Nov 2026
 * (src/lib/documents/permission-keys.ts) — create, edit, issue, delete, cancel, approve. One place, so the actions
 * and the buttons that lead to them can't disagree. Dependency-free, for server pages and actions alike.
 */
export function documentWriteKey(docType: TradeDocumentType, action: DocAction): DocPermissionKey {
  return docKey(docType, action);
}

/** The refusal for somebody without it, in words. */
export function documentWriteRefusal(docType: TradeDocumentType, action: DocAction): string {
  return docRefusal(docType, action);
}
