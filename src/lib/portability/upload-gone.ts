/**
 * What an import window answers when the file it was kept under has gone (a restart): the screen sends the file again
 * (src/components/settings/import-dialog.tsx, src/actions/data-import.ts). Its own module, as a "use server" file may
 * export only actions.
 */
export const UPLOAD_GONE = "The file isn't kept any more — sending it again.";
