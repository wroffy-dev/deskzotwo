import { db } from "@/lib/db";
import { RENDER_PARAM, newRenderToken, verifyRenderToken } from "@/lib/documents/render-token";
import { renderPdf } from "@/lib/documents/pdf";
import { renderTarget } from "@/lib/tenancy/render-target";
import { statementSubject, type StatementSide } from "./paths";

export { statementSubject, type StatementSide };

/**
 * A one-time pass for the server's headless browser to open a statement's print page, to make the PDF a statement email
 * carries (owner, 31 Oct 2026) — the same arrangement as a document's (src/lib/documents/render-grant.ts): the send
 * action, having checked this person may see this account, mints a pass for this statement, this person, two minutes,
 * once. The proxy lets the print request carrying a genuine pass through (`statementPrintSubject`); the page spends it.
 */

export async function mintStatementGrant(side: StatementSide, companyId: string, userId: string): Promise<string> {
  const now = new Date();
  // Nothing reads an expired pass, so none is kept.
  await db.renderGrant.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 60_000) } } });
  const subject = statementSubject(side, companyId);
  const { token, nonce, expiresAt } = await newRenderToken(subject, now.getTime());
  await db.renderGrant.create({ data: { id: nonce, subject, userId, expiresAt } });
  return token;
}

/** Spends a pass: the id of the person it was minted for, or null — used, expired, forged or for another statement. */
export async function spendStatementGrant(token: string | null | undefined, side: StatementSide, companyId: string): Promise<string | null> {
  const subject = statementSubject(side, companyId);
  const nonce = await verifyRenderToken(token, subject);
  if (!nonce) return null;
  const now = new Date();
  const spent = await db.renderGrant.updateMany({ where: { id: nonce, subject, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
  if (spent.count !== 1) return null;
  return (await db.renderGrant.findUnique({ where: { id: nonce }, select: { userId: true } }))?.userId ?? null;
}

/**
 * The statement's PDF — its own print page, printed by the server's browser as this person would see it. The caller has
 * checked they may (`maySeeStatement`, src/lib/statements/print-data.ts).
 */
export async function statementPdf(viewerId: string, side: StatementSide, companyId: string, view: { from?: string | null; to?: string | null; show?: string | null }): Promise<Buffer> {
  const token = await mintStatementGrant(side, companyId, viewerId);
  const query = new URLSearchParams();
  if (view.from) query.set("from", view.from);
  if (view.to) query.set("to", view.to);
  if (view.show === "outstanding") query.set("show", "outstanding");
  query.set(RENDER_PARAM, token);
  const target = await renderTarget(`/statements/${side}/${companyId}/print?${query.toString()}`);
  return renderPdf(target.url, { hostRules: target.hostRules });
}

/** "Statement-Acme-2026-10-01-to-2026-10-31.pdf". */
export function statementFilename(partyName: string, view: { from?: string | null; to?: string | null }): string {
  const party = partyName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "statement";
  const span = view.from || view.to ? `-${view.from ?? "start"}-to-${view.to ?? "today"}` : "";
  // Whatever a caller passes, only letters, digits and dashes reach the header (security audit SEC-41).
  return `Statement-${party}${span.replace(/[^A-Za-z0-9-]+/g, "").slice(0, 40)}.pdf`;
}
