/** A statement's print-page subjects — plain, for the proxy as much as the pages (src/lib/statements/render.ts). */

export type StatementSide = "AR" | "AP";

/** What a pass opens: this party's statement, from this side. */
export const statementSubject = (side: StatementSide, companyId: string) => `statement:${side}:${companyId}`;

/** The subject a print path asks for — `/statements/<AR|AP>/<companyId>/print` and nothing else — or null. */
export function statementPrintSubject(pathname: string): string | null {
  const match = pathname.match(/^\/statements\/(AR|AP)\/([A-Za-z0-9_-]{1,64})\/print$/);
  return match ? statementSubject(match[1] as StatementSide, match[2]!) : null;
}
