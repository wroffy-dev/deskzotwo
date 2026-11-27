import type { PaymentGateway } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { notMigratedYet } from "@/lib/not-migrated";
import type { GatewayKeys } from "@/lib/collect/gateway-api";

/**
 * The gateways a workspace has connected (src/lib/collect/gateway-api.ts): at most one Razorpay and one
 * Cashfree, each with the business's own keys, kept encrypted with the workspace's key.
 */

export type ConnectedGateway = Pick<PaymentGateway, "id" | "provider" | "mode" | "keyId" | "bankAccountId" | "isDefault" | "active">;

const SELECT = { id: true, provider: true, mode: true, keyId: true, bankAccountId: true, isDefault: true, active: true } as const;

/** Every gateway connected and switched on. None where the workspace isn't migrated. */
export async function activeGateways(): Promise<ConnectedGateway[]> {
  try {
    return await db.paymentGateway.findMany({ where: { active: true }, orderBy: [{ isDefault: "desc" }, { connectedAt: "asc" }], select: SELECT });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** The one new links are made in: the default, else the only one. */
export async function linkGateway(): Promise<ConnectedGateway | null> {
  return (await activeGateways())[0] ?? null;
}

/**
 * The currency both gateways settle to the business in: Indian gateways pay an Indian merchant's bank in rupees,
 * whatever the customer paid in (owner, 30 Oct 2026). A link in any other currency is an international payment.
 */
export const GATEWAY_HOME_CURRENCY = "INR";

/**
 * The connected gateways an admin has said take international payments (`internationalOn`, owner, 30 Oct 2026).
 * Read on its own so a workspace not migrated to 20261201140000_foreign_pay_links reads as none, not as no gateways.
 */
export async function internationalGatewayIds(): Promise<Set<string>> {
  try {
    const rows = await db.paymentGateway.findMany({ where: { active: true, internationalOn: true }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  } catch (err) {
    if (notMigratedYet(err)) return new Set();
    throw err;
  }
}

export type GatewayChoice = { ok: true; gateway: ConnectedGateway } | { ok: false; error: string; reason: "none" | "international" };

/**
 * The gateway a link in `currency` is made in. Rupees: the default, as before. Another currency: the default if it
 * takes international payments, else the other connected one that does — and, where none does, why not, for the
 * place the Pay button would be. Which currencies a gateway account accepts is the gateway's to say, not ours: a
 * currency it refuses comes back as its own error when the link is made.
 */
export async function gatewayFor(currency: string): Promise<GatewayChoice> {
  const gateways = await activeGateways();
  if (gateways.length === 0) return { ok: false, reason: "none", error: "No payment gateway is connected. An admin connects Razorpay or Cashfree under Settings › Payment collection." };
  if (currency === GATEWAY_HOME_CURRENCY) return { ok: true, gateway: gateways[0]! };
  const international = await internationalGatewayIds();
  const gateway = gateways.find((g) => international.has(g.id));
  if (gateway) return { ok: true, gateway };
  const names = gateways.map((g) => (g.provider === "RAZORPAY" ? "Razorpay" : "Cashfree")).join(" or ");
  return {
    ok: false,
    reason: "international",
    error: `No pay-now link for an invoice in ${currency}: international payments aren't switched on for ${names}. Once ${names} has enabled them on your account, an admin switches them on under Settings › Payment collection.`,
  };
}

/** A gateway's keys, decrypted for the call about to be made — never kept. */
export async function gatewayKeys(gatewayId: string): Promise<GatewayKeys | null> {
  const row = await db.paymentGateway.findUnique({ where: { id: gatewayId }, select: { provider: true, mode: true, keyId: true, secretEnc: true } });
  if (!row || !row.secretEnc) return null;
  return { provider: row.provider, mode: row.mode, keyId: row.keyId, secret: await decryptSecret(row.secretEnc) };
}
