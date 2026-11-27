import { validGstin } from "@/lib/billing/tax-invoice";
import { GST_STATE_CODES, stateCodeFromGstin } from "@/lib/gst-engine";
import { GstinLookupRefused, lookupGstin } from "@/lib/gstin/lookup";
import { lookupReady, normalizeGstin } from "@/lib/gstin/notes";
import { controlDb } from "@/lib/platform/control-db";

/**
 * The GSTIN a workspace gives for Deskzo's own tax invoices to it (Settings › Plan & billing).
 *
 * Security audit round two, 13 Nov 2026 (B5): it was taken as typed, so a workspace could have Deskzo's invoices made
 * out to any business's GSTIN — and that business's input tax credit claimed on them. Now:
 *
 *   · a GSTIN must pass its check character and be registered in the billing state chosen;
 *   · once a tax invoice has been issued to the workspace, its GSTIN is locked — a change goes through Deskzo's staff
 *     (console › Workspace › Billing details), who can see what was invoiced to which;
 *   · where the workspace has an e-invoice login (src/lib/gstin/lookup.ts), the GST system is asked: a GSTIN it
 *     doesn't know, one cancelled, or one in another state is refused, and its registered (legal) name becomes the
 *     billing name the invoices carry. With no login, or the portal unreachable, it is kept unverified, as before.
 *
 * Another country's tax number (anything not shaped like a GSTIN) is kept as typed.
 */
export async function buyerGstinCheck(
  tenantId: string,
  taxId: string,
  state: string | undefined,
  userId: string,
): Promise<{ ok: true; legalName: string | null } | { ok: false; error: string }> {
  const before = await controlDb().tenant.findUnique({ where: { id: tenantId }, select: { taxId: true, billingState: true } });
  const held = before?.taxId ?? "";
  const unchanged = held === taxId;
  if (!unchanged && held) {
    const issued = await controlDb().invoice.count({ where: { tenantId, taxNumber: { not: null }, billToPartnerId: null } });
    if (issued > 0) return { ok: false, error: "Tax invoices have already been issued to this GSTIN. To change it, write to Deskzo support — we'll check it and update it for you." };
  }
  if (!taxId || unchanged) return { ok: true, legalName: null };
  if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(taxId)) return { ok: true, legalName: null };
  const gstin = normalizeGstin(taxId);
  if (!lookupReady(gstin) || !validGstin(gstin)) return { ok: false, error: "That isn't a valid GSTIN — check each character. Its last one is a check over the others." };
  const billingState = state === undefined ? before?.billingState : state || null;
  const gstinState = stateCodeFromGstin(gstin)!;
  if (billingState && gstinState !== billingState) return { ok: false, error: `That GSTIN is registered in ${GST_STATE_CODES[gstinState] ?? gstinState} — choose that state, or check the GSTIN.` };
  try {
    const { check } = await lookupGstin(gstin, userId);
    if (check.status === "NOT_FOUND") return { ok: false, error: "The GST system doesn't know that GSTIN — check it." };
    if (check.status === "CNL") return { ok: false, error: "The GST system says that GSTIN is cancelled." };
    if (check.stateCode && check.stateCode !== gstinState) return { ok: false, error: "The GST system has that GSTIN in another state — check it." };
    return { ok: true, legalName: check.legalName?.trim() || null };
  } catch (err) {
    // No e-invoice login, another country, the hour's limit, the portal down: kept unverified, as before.
    if (!(err instanceof GstinLookupRefused)) console.warn("[billing] GSTIN check failed; kept unverified:", err instanceof Error ? err.message : err);
    return { ok: true, legalName: null };
  }
}
