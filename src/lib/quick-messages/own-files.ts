/**
 * The sender's own files on a quick-message email (owner, 16 Nov 2026): the limits, shared by the window and the
 * server. Kept apart from src/lib/quick-messages/extras.ts, which reaches the database, so the window can import it.
 */
export const OWN_FILES = { maxFiles: 5, maxBytes: 3 * 1024 * 1024 } as const;
/** For `<input accept>`: a hint to the picker only — every file is checked on the server. */
export const OWN_FILE_ACCEPT = ".pdf,application/pdf";
