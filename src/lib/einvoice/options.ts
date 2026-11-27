/**
 * The e-invoice choices and rules the screens read (owner, 25 Oct 2026: split from provider.ts, whose NIC path
 * now encrypts with node:crypto and must not reach the browser). provider.ts re-exports them for the server.
 */

export const EINVOICE_PROVIDERS = [
  { value: "mock", label: "Mock (no portal — for testing)" },
  { value: "nic_sandbox", label: "NIC sandbox" },
  { value: "nic_production", label: "NIC production" },
] as const;

/**
 * Security audit round three, 14 Nov 2026 (R3-08): the portals that are not the government's — the mock, which makes
 * IRNs and e-way bill numbers up, and NIC's sandbox, whose numbers aren't reported to the GST system. A live workspace
 * could pick either and print numbers the government never issued.
 */
export const TEST_PROVIDERS = ["mock", "nic_sandbox"] as const;

export function isTestProvider(provider: string | null | undefined): boolean {
  return !!provider && (TEST_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Whether this server may use a test portal: anywhere but production, or where EINVOICE_ALLOW_TEST_PROVIDERS=1 says
 * so (a staging server runs as production). Read on the server; covers e-way bills too.
 */
export function testProvidersAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.EINVOICE_ALLOW_TEST_PROVIDERS === "1" || env.NODE_ENV !== "production";
}

/** The refusal when a registration is on a test portal this server may not use. */
export function testProviderRefusal(provider: string, gstin?: string | null): string {
  return `${gstin ? `GSTIN ${gstin} is` : "This GSTIN is"} connected to ${provider === "mock" ? "the mock portal" : "NIC's sandbox"}, which isn't the government's — numbers from it are never reported to the GST portal. Choose NIC production in Settings → e-Invoicing.`;
}

/**
 * Whether a document's IRN came from a test portal, to be printed as such: its registration is on one, or its signed
 * QR isn't the IRP's signed token (the mock's is plain Base64 JSON). Deskzo keeps no note of which portal issued each
 * number, so a registration moved off the sandbox afterwards is read by the QR alone.
 */
export function isTestEInvoice(doc: { signedQrCode?: string | null; origin?: string | null }, provider: string | null | undefined): boolean {
  // Brought across from the old system (owner, 21 Nov 2026): its IRN came from the portal that system used, not from
  // this workspace's registration — so this workspace being on a sandbox says nothing about it.
  if (doc.origin === "IMPORTED") return false;
  if (isTestProvider(provider)) return true;
  const qr = doc.signedQrCode?.trim();
  return !!qr && qr.split(".").length !== 3;
}

/** The mark printed on such a document. */
export const TEST_EINVOICE_MARK = "TEST — not reported to the GST portal";

/** The portal only accepts these codes, and only within 24 hours of generating the IRN. */
export const CANCEL_REASONS = [
  { value: "1", label: "Duplicate" },
  { value: "2", label: "Data entry mistake" },
  { value: "3", label: "Order cancelled" },
  { value: "4", label: "Other" },
] as const;

export const CANCELLATION_WINDOW_HOURS = 24;

/** Whether the portal will still accept a cancellation for an IRN acknowledged at this time. */
export function isWithinCancellationWindow(ackDate: Date | string | null | undefined) {
  if (!ackDate) return false;
  const hours = (Date.now() - new Date(ackDate).getTime()) / (1000 * 60 * 60);
  return hours <= CANCELLATION_WINDOW_HOURS;
}
