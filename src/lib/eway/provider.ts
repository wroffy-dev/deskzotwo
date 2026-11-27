import { createHmac, timingSafeEqual } from "node:crypto";
import { buildEwayPayload, type EwayDocument } from "@/lib/eway/payload";
import { aesDecrypt, aesEncrypt, newAppKey, nicPublicKey, plainJson, sealedJson } from "@/lib/einvoice/nic-crypto";
import { ewayErrorText } from "@/lib/eway/nic-errors";
import { indiaClock } from "@/lib/time/zone";
import { validityFor } from "@/lib/eway/rules";
import { isTestProvider, testProviderRefusal, testProvidersAllowed } from "@/lib/einvoice/options";

/** Under the claim's stale window, as the e-invoice calls are (src/lib/einvoice/provider.ts). */
const NIC_TIMEOUT_MS = 60_000;

/**
 * The e-way bill portal behind one interface, so the app never talks to it directly.
 *
 * The same shape as `einvoice/provider.ts`, deliberately — same portal operator, same credentials,
 * same auth dance, and somebody who has read one should not have to learn a second. Two
 * implementations ship: `mock`, which issues a well-formed bill locally, and `nic`, which calls the
 * real API.
 *
 * ## Three operations, not one
 *
 * Generating is the obvious one. The other two are what make the module usable in a warehouse:
 *
 *   · **Part B** — the vehicle. A bill is routinely raised in the morning against a transporter id
 *     and the lorry assigned at four, so updating the vehicle on an existing bill is the ordinary
 *     case rather than a correction.
 *   · **Cancel**, within 24 hours, which is what happens when a despatch is called off.
 *
 * ## Not yet run against the real portal
 *
 * As with the IRP provider: the NIC path follows the published API — encrypted as it asks since
 * 25 Oct 2026, when it was found sending plain JSON to a sandbox host that doesn't exist — and every
 * failure path returns a readable message rather than throwing. It is checked against a stand-in
 * (check:nic-eway), never the real portal: sandbox credentials are needed before it can be called
 * working, and the settings screen should be left on `mock` until somebody has.
 */

export type EwayResult =
  | { ok: true; ewayBillNumber: string; ewayBillDate: Date; validUntil: Date }
  | { ok: false; error: string };

export type EwayActionResult = { ok: true } | { ok: false; error: string };

/** What the portal holds against a bill number somebody raised there. */
export type EwayFetchResult =
  | {
      ok: true;
      ewayBillNumber: string;
      ewayBillDate: Date;
      validUntil: Date;
      status: "GENERATED" | "CANCELLED";
      documentNumber: string | null;
      vehicleNumber: string | null;
      transporterName: string | null;
    }
  | { ok: false; error: string };

export type EwayProviderConfig = {
  provider: string;
  username?: string | null;
  password?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  gstin?: string | null;
};

export interface EwayProvider {
  readonly name: string;
  generate(doc: EwayDocument): Promise<EwayResult>;
  /** Part B. Adds or changes the vehicle on a bill already issued. */
  updateVehicle(input: {
    ewayBillNumber: string;
    vehicleNumber: string;
    reasonCode: string;
    reasonNote: string;
    fromPlace: string;
    fromStateCode: string;
    transportMode: EwayDocument["transportMode"];
  }): Promise<EwayActionResult>;
  cancel(ewayBillNumber: string, reasonCode: string, remark: string): Promise<EwayActionResult>;
  /**
   * Read back a bill raised on the portal directly.
   *
   * So that recording one costs typing twelve digits rather than transcribing a number, a date and
   * an expiry off a screenshot — three chances to get it wrong, and the dates are the two that
   * matter, because an expiry typed a day long is a bill that reads valid here and expired at a
   * checkpoint.
   */
  fetch(ewayBillNumber: string): Promise<EwayFetchResult>;
}

/**
 * Local stand-in.
 *
 * Issues a 12-digit number in the portal's own shape and works out the validity with the real rule
 * from `rules.ts` — so the dates on screen, the expiry badge and the "extend it" prompt are all
 * exercised for real without portal access. The only thing that is fake is the number.
 */
class MockEwayProvider implements EwayProvider {
  readonly name = "mock";

  constructor(private config: EwayProviderConfig) {}

  async generate(doc: EwayDocument): Promise<EwayResult> {
    const { createHash } = await import("node:crypto");
    const seed = `${this.config.gstin ?? doc.from.gstin ?? "UNKNOWN"}${doc.documentNumber}${doc.documentDate.toISOString()}`;
    // The portal's numbers are 12 digits beginning 3 — close enough that anything validating the
    // shape downstream is genuinely exercised. Eleven hex digits stay inside a safe integer, so no
    // BigInt is needed and the build target stays where it is.
    const digits = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 11), 16) % 100000000000;
    const ewayBillNumber = `3${String(digits).padStart(11, "0")}`;

    const ewayBillDate = new Date();
    const { validUntil } = validityFor(ewayBillDate, doc.distanceKm, doc.vehicleType);

    return { ok: true, ewayBillNumber, ewayBillDate, validUntil };
  }

  async updateVehicle(): Promise<EwayActionResult> {
    return { ok: true };
  }

  async cancel(): Promise<EwayActionResult> {
    return { ok: true };
  }

  async fetch(ewayBillNumber: string): Promise<EwayFetchResult> {
    if (!/^\d{12}$/.test(ewayBillNumber)) return { ok: false, error: "An e-way bill number is 12 digits." };
    // Raised today and good for a day, which is the shortest a real one can be — so anything that
    // treats a fetched bill as comfortably in date gets caught here rather than on the road.
    const ewayBillDate = new Date();
    const { validUntil } = validityFor(ewayBillDate, 100, "REGULAR");
    return {
      ok: true,
      ewayBillNumber,
      ewayBillDate,
      validUntil,
      status: "GENERATED",
      documentNumber: null,
      vehicleNumber: null,
      transporterName: null,
    };
  }
}

/**
 * NIC's e-way bill API, version 1.03. The sandbox is ewaybill2.nic.in under /ewaybillapi; production has no
 * such segment. (The sandbox host written here before, ewb-apisandbox.nic.in, doesn't exist.)
 */
const NIC_BASE_URLS: Record<string, string> = {
  nic_sandbox: "https://ewaybill2.nic.in/ewaybillapi",
  nic_production: "https://api.ewaybillgst.gov.in",
};

/**
 * The e-way bill system's public key for each environment, set on the server: its own, not the e-invoice
 * system's, the same for every taxpayer, and downloaded from NIC. PEM text or bare Base64.
 */
export const EWAY_PUBLIC_KEY_ENV: Record<string, string> = {
  nic_sandbox: "EWAY_NIC_PUBLIC_KEY_SANDBOX",
  nic_production: "EWAY_NIC_PUBLIC_KEY_PRODUCTION",
};

// The screens' reasons, in a module the browser can load (it has no crypto).
export { CANCEL_REASONS, VEHICLE_UPDATE_REASONS } from "./options";

type EwaySession = { token: string; sek: Buffer; expiresAt: number };
type EwayAnswer = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

const succeeded = (body: unknown) => String((body as { status?: unknown; Status?: unknown } | null)?.status ?? (body as { Status?: unknown } | null)?.Status ?? "") === "1";
const toRecord = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});

/**
 * The real NIC e-way bill API, encrypted as its API document asks (the helpers are the e-invoice ones,
 * src/lib/einvoice/nic-crypto.ts):
 *
 *   · **Sign in** at /v1.03/auth: {action: ACCESSTOKEN, username, password, app_key (Base64 of 32 random
 *     bytes)}, sealed with the e-way bill system's public key as {"Data": …}. The answer's sek is the session
 *     key, AES-256-ECB encrypted with the app key; the token lasts 360 minutes.
 *   · **Act** at /v1.03/ewayapi: {action, data}, the data the JSON AES-encrypted with the session key; the
 *     answer's data the same way back.
 *   · **Read** with a GET under /v1.03/ewayapi: the answer's data is encrypted with a one-time key (rek), the
 *     rek with the session key, and an HMAC-SHA256 of the Base64 plaintext under the rek proves it arrived as
 *     sent. An answer whose HMAC doesn't match is refused.
 *
 * The session lasts as long as this provider, which is one action's. Every failure path returns a readable
 * message — the portal's error codes in words (nic-errors.ts) — rather than throwing.
 *
 * Not yet run against the real portal: it is checked against a stand-in that encrypts and answers as NIC's
 * document says (check:nic-eway).
 */
class NicEwayProvider implements EwayProvider {
  readonly name = "nic";
  private session: EwaySession | null = null;

  constructor(
    private config: EwayProviderConfig,
    private baseUrl: string,
    private publicKeyEnv: string,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      "Content-Type": "application/json",
      "client-id": this.config.clientId ?? "",
      "client-secret": this.config.clientSecret ?? "",
      gstin: this.config.gstin ?? "",
      ...extra,
    };
  }

  private async signIn(): Promise<EwaySession | { error: string }> {
    if (this.session && this.session.expiresAt > Date.now()) return this.session;
    const keyText = process.env[this.publicKeyEnv]?.trim();
    if (!keyText) return { error: `The e-way bill system's public key isn't set on this server (${this.publicKeyEnv}). Ask Deskzo support.` };
    try {
      const appKey = newAppKey();
      const credentials = { action: "ACCESSTOKEN", username: this.config.username ?? "", password: this.config.password ?? "", app_key: appKey.toString("base64") };
      const response = await fetch(`${this.baseUrl}/v1.03/auth`, {
        signal: AbortSignal.timeout(NIC_TIMEOUT_MS),
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ Data: sealedJson(credentials, nicPublicKey(keyText)) }),
      });
      const body = await response.json();
      // {status, authtoken, sek} as the e-way bill system answers; the e-invoice system's shape read too.
      const token = body?.authtoken ?? body?.Data?.AuthToken;
      const sek = body?.sek ?? body?.Data?.Sek;
      if (!succeeded(body) || !token || !sek) return { error: `Couldn't sign in to the e-way bill system: ${ewayErrorText(body)}` };
      // 360 minutes from now; given up 15 minutes early rather than racing the end.
      this.session = { token: String(token), sek: aesDecrypt(String(sek), appKey), expiresAt: Date.now() + 345 * 60_000 };
      return this.session;
    } catch (err) {
      return { error: err instanceof Error ? `Couldn't sign in to the e-way bill system: ${err.message}` : "Couldn't reach the e-way bill system." };
    }
  }

  /** An action — generate, Part B, cancel — its JSON encrypted with the session key, the answer decrypted. */
  private async act(action: string, payload: unknown): Promise<EwayAnswer> {
    const session = await this.signIn();
    if ("error" in session) return { ok: false, error: session.error };
    const response = await fetch(`${this.baseUrl}/v1.03/ewayapi`, {
      signal: AbortSignal.timeout(NIC_TIMEOUT_MS),
      method: "POST",
      headers: this.headers({ authtoken: session.token }),
      body: JSON.stringify({ action, data: aesEncrypt(Buffer.from(JSON.stringify(payload), "utf8"), session.sek) }),
    });
    const body = await response.json();
    if (!succeeded(body) || typeof body?.data !== "string") return { ok: false, error: ewayErrorText(body) };
    return { ok: true, data: toRecord(plainJson(aesDecrypt(body.data, session.sek))) };
  }

  /** A read — a GET under /v1.03/ewayapi — its answer under a one-time key, checked by its HMAC. */
  private async read(path: string): Promise<EwayAnswer> {
    const session = await this.signIn();
    if ("error" in session) return { ok: false, error: session.error };
    const response = await fetch(`${this.baseUrl}/v1.03/ewayapi/${path}`, { method: "GET", headers: this.headers({ authtoken: session.token }), signal: AbortSignal.timeout(NIC_TIMEOUT_MS) });
    const body = await response.json();
    if (!succeeded(body) || typeof body?.data !== "string") return { ok: false, error: ewayErrorText(body) };
    if (typeof body.rek !== "string" || !body.rek) return { ok: true, data: toRecord(plainJson(aesDecrypt(body.data, session.sek))) };
    const rek = aesDecrypt(body.rek, session.sek);
    const plain = aesDecrypt(body.data, rek);
    if (typeof body.hmac === "string" && body.hmac) {
      const expected = createHmac("sha256", rek).update(plain.toString("base64"), "utf8").digest();
      const given = Buffer.from(body.hmac, "base64");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return { ok: false, error: "The e-way bill system's answer failed its integrity check. Try again." };
      }
    }
    return { ok: true, data: toRecord(plainJson(plain)) };
  }

  async generate(doc: EwayDocument): Promise<EwayResult> {
    try {
      const answer = await this.act("GENEWAYBILL", buildEwayPayload(doc));
      if (!answer.ok) return answer;
      const data = answer.data;
      if (!data.ewayBillNo) return { ok: false, error: "The e-way bill system answered without a bill number." };
      /**
       * The portal's own validity is taken over ours when it gives one.
       *
       * Ours is computed from the same published rule, but a disagreement between the two must be
       * resolved in favour of the document that would be produced at a roadside check.
       */
      const ewayBillDate = parsePortalDate(data.ewayBillDate) ?? new Date();
      const validUntil = parsePortalDate(data.validUpto) ?? validityFor(ewayBillDate, doc.distanceKm, doc.vehicleType).validUntil;
      return { ok: true, ewayBillNumber: String(data.ewayBillNo), ewayBillDate, validUntil };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the e-way bill system." };
    }
  }

  async updateVehicle(input: Parameters<EwayProvider["updateVehicle"]>[0]): Promise<EwayActionResult> {
    try {
      const answer = await this.act("VEHEWB", {
        ewbNo: Number(input.ewayBillNumber),
        vehicleNo: input.vehicleNumber,
        fromPlace: input.fromPlace,
        fromState: Number(input.fromStateCode),
        reasonCode: input.reasonCode,
        reasonRem: input.reasonNote,
        transDocNo: "",
        transDocDate: "",
        transMode: input.transportMode === "ROAD" ? "1" : input.transportMode === "RAIL" ? "2" : input.transportMode === "AIR" ? "3" : "4",
      });
      if (!answer.ok) return answer;
      if (!answer.data.vehUpdDate) return { ok: false, error: "The e-way bill system didn't confirm the vehicle." };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the e-way bill system." };
    }
  }

  async cancel(ewayBillNumber: string, reasonCode: string, remark: string): Promise<EwayActionResult> {
    try {
      const answer = await this.act("CANEWB", { ewbNo: Number(ewayBillNumber), cancelRsnCode: Number(reasonCode), cancelRmrk: remark });
      if (!answer.ok) return answer;
      if (!answer.data.cancelDate) return { ok: false, error: "The e-way bill system didn't confirm the cancellation." };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the e-way bill system." };
    }
  }

  /**
   * `GetEwayBill` — the read side, and the only one of these that is a GET.
   *
   * The portal will only return bills raised on our own GSTIN, which is the whole reason this is
   * safe to expose: somebody typing a number they found cannot read a stranger's consignment out
   * of it. A number the portal does not recognise comes back as an error, which is the answer.
   */
  async fetch(ewayBillNumber: string): Promise<EwayFetchResult> {
    if (!/^\d{12}$/.test(ewayBillNumber)) return { ok: false, error: "An e-way bill number is 12 digits." };
    try {
      const answer = await this.read(`GetEwayBill?ewbNo=${ewayBillNumber}`);
      if (!answer.ok) return answer;
      const data = answer.data;
      if (!data.ewbNo) return { ok: false, error: "The e-way bill system answered without the bill." };

      const ewayBillDate = parsePortalDate(data.ewayBillDate);
      const validUntil = parsePortalDate(data.validUpto);
      // Both dates or nothing. A bill recorded with a guessed expiry reads valid here and is
      // refused at a checkpoint, which is worse than not recording it at all.
      if (!ewayBillDate || !validUntil) {
        return { ok: false, error: "The portal returned that bill without usable dates." };
      }
      const vehicles = Array.isArray(data.VehiclListDetails) ? (data.VehiclListDetails as { vehicleNo?: unknown }[]) : [];
      return {
        ok: true,
        ewayBillNumber: String(data.ewbNo),
        ewayBillDate,
        validUntil,
        status: String(data.status ?? "").toUpperCase() === "CNL" ? "CANCELLED" : "GENERATED",
        documentNumber: data.docNo ? String(data.docNo) : null,
        vehicleNumber: (vehicles.at(-1)?.vehicleNo as string | undefined) ?? (data.vehicleNo ? String(data.vehicleNo) : null),
        transporterName: data.transporterName ? String(data.transporterName) : null,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the e-way bill system." };
    }
  }
}

/**
 * `dd/mm/yyyy hh:mm:ss AM` — the portal's own format, which is not ISO and not parseable by `Date`.
 *
 * Returns null rather than an Invalid Date, so a caller falls back to the computed validity instead
 * of storing `NaN` as an expiry and showing every bill as expired.
 *
 * The portal's times are India's, in every workspace. Read on India's clock (`indiaClock`) rather than
 * with `new Date(y, m, …)`, which reads them in the server's zone: on a UTC server a bill valid until
 * 23:59 IST was stored as valid until 05:29 the next morning.
 */
export function parsePortalDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i.exec(value.trim());
  if (!match) return null;

  const [, dd, mm, yyyy, hh, mi, ss, meridiem] = match;
  let hours = Number(hh ?? 0);
  if (meridiem?.toUpperCase() === "PM" && hours < 12) hours += 12;
  if (meridiem?.toUpperCase() === "AM" && hours === 12) hours = 0;

  // The clock reads to the minute; the seconds go on after.
  const minute = indiaClock.at(Number(yyyy), Number(mm) - 1, Number(dd), hours, Number(mi ?? 0));
  const date = new Date(minute.getTime() + Number(ss ?? 0) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A portal this server may not use (R3-08): every call answers with why. */
class RefusedEwayProvider implements EwayProvider {
  readonly name = "refused";
  constructor(private reason: string) {}
  async generate(): Promise<EwayResult> {
    return { ok: false, error: this.reason };
  }
  async updateVehicle(): Promise<EwayActionResult> {
    return { ok: false, error: this.reason };
  }
  async cancel(): Promise<EwayActionResult> {
    return { ok: false, error: this.reason };
  }
  async fetch(): Promise<EwayFetchResult> {
    return { ok: false, error: this.reason };
  }
}

/**
 * Security audit round three, 14 Nov 2026 (R3-08): the mock and the sandbox only where this server may use test
 * portals (`testProvidersAllowed`, src/lib/einvoice/options.ts) — a live workspace on the mock printed e-way bill
 * numbers NIC never issued, and a lorry stopped with one is a lorry without a bill. An unknown name is refused too,
 * where it used to fall through to the mock.
 */
export function createEwayProvider(config: EwayProviderConfig): EwayProvider {
  if (isTestProvider(config.provider) && !testProvidersAllowed()) return new RefusedEwayProvider(testProviderRefusal(config.provider, config.gstin));
  if (config.provider === "mock") return new MockEwayProvider(config);
  const baseUrl = NIC_BASE_URLS[config.provider];
  return baseUrl
    ? new NicEwayProvider(config, baseUrl, EWAY_PUBLIC_KEY_ENV[config.provider]!)
    : new RefusedEwayProvider(`The e-way bill connection "${config.provider}" isn't one Deskzo knows. Choose NIC production in Settings → e-Invoicing.`);
}
