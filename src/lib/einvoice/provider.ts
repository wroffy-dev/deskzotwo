import { buildEInvoicePayload, eInvoiceValue, type EInvoiceDocument } from "@/lib/einvoice/payload";
import { isTestProvider, testProviderRefusal, testProvidersAllowed } from "@/lib/einvoice/options";
import { authBody, decryptedData, encryptedBody, infoDetails, newAppKey, nicErrors, nicPublicKey, sessionKey, succeeded, type NicError } from "@/lib/einvoice/nic-crypto";
import { indiaClock } from "@/lib/time/zone";

/**
 * The IRP behind one interface, so the app never talks to the portal directly.
 *
 * Two implementations ship: `mock`, which produces a well-formed IRN locally for development and
 * demos, and `nic`, which calls the real NIC API (sandbox or production, same shape — only the
 * base URL differs). Swapping between them is a settings change, not a code change.
 */

export type EInvoiceResult =
  | { ok: true; irn: string; ackNo: string; ackDate: Date; signedQrCode: string }
  | { ok: false; error: string };

export type CancelResult = { ok: true } | { ok: false; error: string };

/** What the e-invoice system holds for a GSTIN (src/lib/gstin/lookup.ts). */
export type GstinDetails = {
  status: string;
  legalName: string | null;
  tradeName: string | null;
  address: string | null;
  stateCode: string | null;
  pincode: string | null;
  taxpayerType: string | null;
  blocked: boolean;
};
export type GstinLookupResult = { ok: true; details: GstinDetails } | { ok: false; notFound: true } | { ok: false; notFound?: false; error: string };

export type ProviderConfig = {
  provider: string;
  username?: string | null;
  password?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  gstin?: string | null;
};

export interface EInvoiceProvider {
  readonly name: string;
  generate(doc: EInvoiceDocument): Promise<EInvoiceResult>;
  cancel(irn: string, reason: string, remark: string): Promise<CancelResult>;
  /** A customer's or vendor's GSTIN as the GST system holds it — the e-invoice API's "Get GSTIN details". */
  gstinDetails(gstin: string): Promise<GstinLookupResult>;
}

/**
 * Local stand-in. Produces the same 64-character IRN shape the portal returns (a SHA-256 of
 * GSTIN + document type + number + financial year, which is exactly how the real IRN is derived),
 * so downstream code, storage and display are exercised for real without portal access.
 */
class MockProvider implements EInvoiceProvider {
  readonly name = "mock";

  constructor(private config: ProviderConfig) {}

  async generate(doc: EInvoiceDocument): Promise<EInvoiceResult> {
    const { createHash } = await import("node:crypto");
    const seed = `${this.config.gstin ?? doc.seller.gstin ?? "UNKNOWN"}${doc.docType}${doc.docNumber}`;
    const irn = createHash("sha256").update(seed).digest("hex");
    const ackDate = new Date();
    // The portal's QR is a signed JWT; a base64 payload is enough to prove the plumbing works.
    const signedQrCode = Buffer.from(
      JSON.stringify({
        SellerGstin: doc.seller.gstin,
        BuyerGstin: doc.buyer.gstin ?? "URP",
        DocNo: doc.docNumber,
        DocTyp: doc.docType === "CREDIT_NOTE" ? "CRN" : doc.docType === "DEBIT_NOTE" ? "DBN" : "INV",
        // India's day, as the IRP dates a document — not the UTC one.
        DocDt: indiaClock.dateKey(doc.issueDate),
        TotInvVal: eInvoiceValue(doc),
        Irn: irn,
      }),
    ).toString("base64");

    return {
      ok: true,
      irn,
      ackNo: String(Date.now()).slice(-10),
      ackDate,
      signedQrCode,
    };
  }

  async cancel(): Promise<CancelResult> {
    return { ok: true };
  }

  /**
   * Active, with a made-up name — except the PAN digits 0000 (no such GSTIN), 9999 (cancelled) and 7777
   * (blocked from e-way bills), so a demo and the suites can show each answer. The screens say it came from
   * the mock portal: it is never a real check.
   */
  async gstinDetails(gstin: string): Promise<GstinLookupResult> {
    const digits = gstin.slice(7, 11);
    if (digits === "0000") return { ok: false, notFound: true };
    return {
      ok: true,
      details: {
        status: digits === "9999" ? "CNL" : "ACT",
        legalName: `Mock taxpayer ${gstin.slice(2, 12)}`,
        tradeName: null,
        address: "Mock address",
        stateCode: gstin.slice(0, 2),
        pincode: null,
        taxpayerType: "REG",
        blocked: digits === "7777",
      },
    };
  }
}

const NIC_BASE_URLS: Record<string, string> = {
  nic_sandbox: "https://einv-apisandbox.nic.in",
  nic_production: "https://einvoice1.gst.gov.in",
};

/**
 * NIC's public key for each environment, set on the server: it is NIC's, the same for every taxpayer, and
 * downloaded from NIC's portal (the sandbox's from its developer portal). PEM text or bare Base64.
 */
export const NIC_PUBLIC_KEY_ENV: Record<string, string> = {
  nic_sandbox: "EINVOICE_NIC_PUBLIC_KEY_SANDBOX",
  nic_production: "EINVOICE_NIC_PUBLIC_KEY_PRODUCTION",
};

type NicSession = { token: string; sek: Buffer; expiresAt: number };
type NicCall = { ok: true; data: Record<string, unknown>; body: unknown } | { ok: false; errors: NicError[]; body: unknown; error?: string };

const messageOf = (call: Extract<NicCall, { ok: false }>, fallback: string) =>
  call.error ?? (call.errors.map((e) => e.message).filter(Boolean).join("; ") || fallback);

/** An IRN as the portal gives it, on generating or on reading one back. */
function irnResult(data: Record<string, unknown>): EInvoiceResult {
  if (typeof data.Irn !== "string" || !data.Irn) return { ok: false, error: "The e-invoice system answered without an IRN." };
  return { ok: true, irn: data.Irn, ackNo: String(data.AckNo ?? ""), ackDate: irpTime(data.AckDt), signedQrCode: String(data.SignedQRCode ?? "") };
}

/**
 * The real NIC API — the direct one, with the taxpayer's own API login — encrypted as NIC asks
 * (src/lib/einvoice/nic-crypto.ts): signed in with a fresh AppKey, then each call's body and answer under that
 * session's key. The session lasts as long as this provider, which is one action's. Every failure path returns
 * a readable message rather than throwing, because a portal outage must leave the invoice saved and
 * retryable, never lose it.
 *
 * Not yet run against the real portal: it is checked against a stand-in that encrypts and answers as NIC does
 * (check:nic-einvoice). Where NIC's pages leave the scheme open (the RSA padding, Base64 before RSA), it follows
 * an open-source client written against the sandbox.
 */
class NicProvider implements EInvoiceProvider {
  readonly name = "nic";
  private session: NicSession | null = null;

  constructor(
    private config: ProviderConfig,
    private baseUrl: string,
    private publicKeyEnv: string,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      "Content-Type": "application/json",
      client_id: this.config.clientId ?? "",
      client_secret: this.config.clientSecret ?? "",
      Gstin: this.config.gstin ?? "",
      ...extra,
    };
  }

  /** Signs in, or reuses this provider's session until 10 minutes before the portal says it ends. */
  private async signIn(): Promise<NicSession | { error: string }> {
    if (this.session && this.session.expiresAt > Date.now()) return this.session;
    const keyText = process.env[this.publicKeyEnv]?.trim();
    if (!keyText) return { error: `The e-invoice system's public key isn't set on this server (${this.publicKeyEnv}). Ask Deskzo support.` };
    try {
      const appKey = newAppKey();
      const response = await fetch(`${this.baseUrl}/eivital/v1.04/auth`, {
        signal: AbortSignal.timeout(NIC_TIMEOUT_MS),
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(authBody({ userName: this.config.username ?? "", password: this.config.password ?? "", appKey }, nicPublicKey(keyText))),
      });
      const body = await response.json();
      const data = body?.Data;
      if (!succeeded(body) || !data?.AuthToken || !data?.Sek) {
        const errors = nicErrors(body).map((e) => e.message).filter(Boolean);
        return { error: errors.length ? `Couldn't sign in to the e-invoice system: ${errors.join("; ")}` : "Couldn't sign in to the e-invoice system — check the credentials in Settings → e-Invoicing." };
      }
      const ends = data.TokenExpiry ? irpTime(data.TokenExpiry).getTime() : NaN;
      const expiresAt = (Number.isFinite(ends) ? ends : Date.now() + 60 * 60 * 1000) - 10 * 60 * 1000;
      this.session = { token: String(data.AuthToken), sek: sessionKey(String(data.Sek), appKey), expiresAt };
      return this.session;
    } catch (err) {
      return { error: err instanceof Error ? `Couldn't sign in to the e-invoice system: ${err.message}` : "Couldn't reach the e-invoice system." };
    }
  }

  /** One call: its body encrypted with the session key, the answer's Data decrypted; the portal's errors as they came. */
  private async call(path: string, init: { method: "GET" | "POST"; payload?: unknown }): Promise<NicCall> {
    const session = await this.signIn();
    if ("error" in session) return { ok: false, errors: [], body: null, error: session.error };
    const response = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(NIC_TIMEOUT_MS),
      method: init.method,
      headers: this.headers({ AuthToken: session.token, user_name: this.config.username ?? "" }),
      ...(init.payload !== undefined ? { body: JSON.stringify(encryptedBody(init.payload, session.sek)) } : {}),
    });
    const body = await response.json();
    if (!succeeded(body) || !body?.Data) return { ok: false, errors: nicErrors(body), body };
    const data = typeof body.Data === "string" ? decryptedData(body.Data, session.sek) : body.Data;
    return { ok: true, data: (data ?? {}) as Record<string, unknown>, body };
  }

  async generate(doc: EInvoiceDocument): Promise<EInvoiceResult> {
    try {
      const made = await this.call("/eicore/v1.03/Invoice", { method: "POST", payload: buildEInvoicePayload(doc) });
      if (made.ok) return irnResult(made.data);
      // Made already — a retry after an answer that never arrived (error 2150). The portal names the IRN it
      // gave in its InfoDtls; that IRN is read back whole, so the invoice gets it rather than being stuck.
      const duplicate = made.errors.some((e) => e.code === "2150") ? infoDetails(made.body).find((i) => i.code === "DUPIRN") : undefined;
      const irn = (duplicate?.desc as { Irn?: unknown } | undefined)?.Irn;
      if (typeof irn === "string" && irn) {
        const again = await this.call(`/eicore/v1.03/Invoice/irn/${encodeURIComponent(irn)}`, { method: "GET" });
        if (again.ok) {
          // Security audit round three, 14 Nov 2026 (tax lows): the IRN the portal holds is for this document number,
          // but not necessarily for these figures — a draft edited between a lost answer and the retry. Its signed QR
          // says what was registered; one that disagrees is not adopted, and the person is told why.
          const differs = registeredDifference(again.data.SignedQRCode, buildEInvoicePayload(doc));
          if (differs) return { ok: false, error: `The e-invoice system already holds IRN ${irn} for ${doc.docNumber}, but ${differs}. Cancel it on the portal, or correct the document to match, before trying again.` };
          return irnResult(again.data);
        }
      }
      return { ok: false, error: messageOf(made, "The e-invoice system rejected the invoice.") };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the e-invoice system." };
    }
  }

  async cancel(irn: string, reason: string, remark: string): Promise<CancelResult> {
    try {
      const done = await this.call("/eicore/v1.03/Invoice/Cancel", { method: "POST", payload: { Irn: irn, CnlRsn: reason, CnlRem: remark } });
      if (!done.ok) return { ok: false, error: messageOf(done, "The e-invoice system refused the cancellation.") };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the e-invoice system." };
    }
  }

  /**
   * GET /eivital/v1.03/Master/gstin/{GSTIN} (NIC's "Get GSTIN Details"): legal and trade name, address, state,
   * taxpayer type, status (ACT, CNL, INA, PRO) and e-way bill blocking (BlkStatus B). Error 3001 is "no such
   * GSTIN".
   */
  async gstinDetails(gstin: string): Promise<GstinLookupResult> {
    try {
      const got = await this.call(`/eivital/v1.03/Master/gstin/${encodeURIComponent(gstin)}`, { method: "GET" });
      if (!got.ok) {
        if (got.errors.some((e) => e.code === "3001")) return { ok: false, notFound: true };
        return { ok: false, error: messageOf(got, "The e-invoice system didn't answer for that GSTIN.") };
      }
      const data = got.data;
      const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
      const address = [data.AddrBnm, data.AddrBno, data.AddrFlno, data.AddrSt, data.AddrLoc].map(text).filter(Boolean).join(", ");
      return {
        ok: true,
        details: {
          status: String(data.Status ?? "").trim().toUpperCase() || "ACT",
          legalName: text(data.LegalName),
          tradeName: text(data.TradeName),
          address: address || null,
          stateCode: data.StateCode !== undefined && data.StateCode !== null ? String(data.StateCode).padStart(2, "0") : null,
          pincode: data.AddrPncd !== undefined && data.AddrPncd !== null ? String(data.AddrPncd) : null,
          taxpayerType: text(data.TxpType),
          blocked: String(data.BlkStatus ?? "").trim().toUpperCase() === "B",
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the e-invoice system." };
    }
  }
}

/**
 * What a registered IRN's signed QR says that the payload doesn't — or null when they agree, or when the QR can't be
 * read (then there is nothing to compare, and the IRN is adopted as before). The QR is a JWT whose payload's `data` is
 * the JSON of SellerGstin, BuyerGstin, DocNo, DocTyp, DocDt, TotInvVal and the IRN.
 */
export function registeredDifference(signedQr: unknown, payload: ReturnType<typeof buildEInvoicePayload>): string | null {
  if (typeof signedQr !== "string") return null;
  const parts = signedQr.split(".");
  if (parts.length !== 3) return null;
  let held: Record<string, unknown>;
  try {
    const body = JSON.parse(Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { data?: unknown };
    held = (typeof body.data === "string" ? JSON.parse(body.data) : body.data) as Record<string, unknown>;
    if (!held || typeof held !== "object") return null;
  } catch {
    return null;
  }
  if (held.SellerGstin !== undefined && String(held.SellerGstin) !== payload.SellerDtls.Gstin) return `it was registered for seller GSTIN ${String(held.SellerGstin)}`;
  if (held.BuyerGstin !== undefined && String(held.BuyerGstin) !== payload.BuyerDtls.Gstin) return `it was registered for buyer GSTIN ${String(held.BuyerGstin)}`;
  if (held.DocNo !== undefined && String(held.DocNo) !== payload.DocDtls.No) return `it was registered for document ${String(held.DocNo)}`;
  if (held.DocTyp !== undefined && String(held.DocTyp) !== payload.DocDtls.Typ) return `it was registered as a ${String(held.DocTyp)}`;
  const value = Number(held.TotInvVal);
  if (held.TotInvVal !== undefined && Number.isFinite(value) && Math.abs(value - payload.ValDtls.TotInvVal) > 1) {
    return `it was registered at ₹${value.toFixed(2)} and the document now comes to ₹${payload.ValDtls.TotInvVal.toFixed(2)}`;
  }
  return null;
}

/**
 * How long one call to NIC may take (tax lows): under the e-way bill claim's two minutes (`EWAY_CLAIM_STALE_MS`), so a
 * hung call gives up before a second request may take the claim over, and never holds the action open for ever.
 */
export const NIC_TIMEOUT_MS = 60_000;

/**
 * The IRP's acknowledgement time — "2026-10-02 18:30:00", India's, with no zone on it. `new Date()` read
 * that in the server's zone: five and a half hours late on a UTC server, which stretched the 24-hour
 * cancellation window past the portal's own. India's clock reads it to the minute and the seconds go
 * on after; anything else is taken as `Date` reads it, as before.
 */
function irpTime(value: unknown): Date {
  const text = String(value ?? "").trim();
  const bare = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/.exec(text);
  if (bare) {
    const minute = indiaClock.parseInput(`${bare[1]}T${bare[2]}`);
    if (minute) return new Date(minute.getTime() + Number(bare[3] ?? 0) * 1000);
  }
  return new Date(text);
}

/**
 * A portal this server may not use (R3-08): every call answers with why, and nothing is generated. The same failure
 * shape as a portal outage, so every caller already shows it and keeps the document.
 */
class RefusedProvider implements EInvoiceProvider {
  readonly name = "refused";
  constructor(private reason: string) {}
  async generate(): Promise<EInvoiceResult> {
    return { ok: false, error: this.reason };
  }
  async cancel(): Promise<CancelResult> {
    return { ok: false, error: this.reason };
  }
  async gstinDetails(): Promise<GstinLookupResult> {
    return { ok: false, error: this.reason };
  }
}

/**
 * Security audit round three, 14 Nov 2026 (R3-08): the mock and the sandbox only where this server may use test
 * portals (`testProvidersAllowed`) — a live workspace on either printed IRNs the IRP never issued. And a provider name
 * that isn't one of the three is refused, where it used to fall through to the mock.
 */
export function createEInvoiceProvider(config: ProviderConfig): EInvoiceProvider {
  if (isTestProvider(config.provider) && !testProvidersAllowed()) return new RefusedProvider(testProviderRefusal(config.provider, config.gstin));
  if (config.provider === "mock") return new MockProvider(config);
  const baseUrl = NIC_BASE_URLS[config.provider];
  if (!baseUrl) return new RefusedProvider(`The e-invoice connection "${config.provider}" isn't one Deskzo knows. Choose NIC production in Settings → e-Invoicing.`);
  return new NicProvider(config, baseUrl, NIC_PUBLIC_KEY_ENV[config.provider]!);
}

// The screens' choices and rules, in a module the browser can load (it has no crypto).
export { CANCEL_REASONS, CANCELLATION_WINDOW_HOURS, EINVOICE_PROVIDERS, TEST_EINVOICE_MARK, isTestEInvoice, isTestProvider, isWithinCancellationWindow, testProvidersAllowed } from "./options";
