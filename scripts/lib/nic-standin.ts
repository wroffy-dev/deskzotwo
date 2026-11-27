import { constants, createCipheriv, createDecipheriv, createHash, createHmac, generateKeyPairSync, privateDecrypt, randomBytes, type KeyObject } from "node:crypto";

/**
 * Stand-ins for NIC's APIs, for the suites. The first, for its e-invoice API (https://einv-apisandbox.nic.in),
 * decrypts, checks and answers as NIC does — a sign-in RSA-encrypted under its public key, every later body and answer AES-256-ECB
 * under the session key it hands out — so a client that gets the scheme wrong fails here as it would there.
 * It never touches the network: install `fetch` on globalThis for the length of a test.
 *
 * Node refuses PKCS#1 v1.5 for private decryption (CVE-2023-46809), so the stand-in decrypts the raw block and
 * takes the padding off itself: 0x00 0x02, at least eight non-zero bytes, 0x00, then the message.
 */

type Session = { sek: Buffer; userName: string };
export type StandinCall = { method: string; path: string; headers: Record<string, string> };

const aes = (key: Buffer) => `aes-${key.length * 8}-ecb`;
const encrypt = (plain: Buffer, key: Buffer) => {
  const c = createCipheriv(aes(key), key, null);
  return Buffer.concat([c.update(plain), c.final()]).toString("base64");
};
const decrypt = (base64: string, key: Buffer) => {
  const d = createDecipheriv(aes(key), key, null);
  return Buffer.concat([d.update(Buffer.from(base64, "base64")), d.final()]);
};

function unpadPkcs1(block: Buffer): Buffer {
  if (block[0] !== 0x00 || block[1] !== 0x02) throw new Error("Not PKCS#1 v1.5 padding.");
  const end = block.indexOf(0x00, 2);
  if (end < 10) throw new Error("PKCS#1 v1.5 padding too short.");
  return block.subarray(end + 1);
}

/** The IRP's time, "yyyy-MM-dd HH:mm:ss", in India. */
const irpTime = (at: Date) => new Date(at.getTime() + 330 * 60_000).toISOString().replace("T", " ").slice(0, 19);

export class NicStandin {
  readonly publicKeyPem: string;
  private readonly privateKey: KeyObject;
  readonly calls: StandinCall[] = [];
  private sessions = new Map<string, Session>();
  private irns = new Map<string, Record<string, unknown>>();
  private byDocument = new Map<string, string>();
  /** GSTINs the portal knows, with what it says about each. */
  gstins = new Map<string, Record<string, unknown>>();
  /** What the last sign-in carried, decrypted — for the suite to look at. */
  lastSignIn: Record<string, unknown> | null = null;
  /** What the last invoice and cancellation carried, decrypted. */
  lastInvoice: Record<string, unknown> | null = null;
  lastCancel: Record<string, unknown> | null = null;
  /** Drop the answer to the next invoice, as a timeout would — the IRN is made all the same. */
  loseNextAnswer = false;

  constructor(private readonly login: { userName: string; password: string; clientId: string; clientSecret: string }) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    this.publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  /** The bare Base64 of the key, as NIC's portal also hands it out. */
  get publicKeyBase64(): string {
    return this.publicKeyPem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k, String(v)]));
    this.calls.push({ method, path: url.pathname, headers });
    const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    const refuse = (code: string, message: string, extra: Record<string, unknown> = {}) =>
      answer({ Status: "0", ErrorDetails: Buffer.from(JSON.stringify([{ ErrorCode: code, ErrorMessage: message }])).toString("base64"), InfoDtls: null, ...extra });
    if (headers.client_id !== this.login.clientId || headers.client_secret !== this.login.clientSecret) return refuse("1004", "Invalid Client Id or Client Secret");
    const body = init?.body ? (JSON.parse(String(init.body)) as { Data?: string }) : {};

    if (method === "POST" && url.pathname === "/eivital/v1.04/auth") {
      let signIn: Record<string, unknown>;
      try {
        const block = privateDecrypt({ key: this.privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(String(body.Data), "base64"));
        signIn = JSON.parse(Buffer.from(unpadPkcs1(block).toString("utf8"), "base64").toString("utf8"));
      } catch {
        return answer({ Status: 0, ErrorDetails: [{ ErrorCode: "1006", ErrorMessage: "Invalid data format" }] });
      }
      this.lastSignIn = signIn;
      if (signIn.UserName !== this.login.userName || signIn.Password !== this.login.password) {
        return answer({ Status: 0, ErrorDetails: [{ ErrorCode: "1005", ErrorMessage: "Invalid login credentials" }] });
      }
      const appKey = Buffer.from(String(signIn.AppKey), "base64");
      if (appKey.length !== 32) return answer({ Status: 0, ErrorDetails: [{ ErrorCode: "1006", ErrorMessage: "Invalid AppKey" }] });
      const sek = randomBytes(32);
      const token = randomBytes(12).toString("hex");
      this.sessions.set(token, { sek, userName: String(signIn.UserName) });
      return answer({ Status: 1, Data: { ClientId: this.login.clientId, UserName: signIn.UserName, AuthToken: token, Sek: encrypt(sek, appKey), TokenExpiry: irpTime(new Date(Date.now() + 360 * 60_000)) }, ErrorDetails: null, InfoDtls: null });
    }

    const session = this.sessions.get(headers.AuthToken ?? "");
    if (!session || headers.user_name !== session.userName) return refuse("1005", "Invalid Token");
    const sealed = (data: unknown) => answer({ Status: "1", Data: encrypt(Buffer.from(JSON.stringify(data)), session.sek), ErrorDetails: null, InfoDtls: null });
    const opened = () => JSON.parse(decrypt(String(body.Data), session.sek).toString("utf8")) as Record<string, unknown>;

    if (method === "POST" && url.pathname === "/eicore/v1.03/Invoice") {
      const invoice = opened();
      this.lastInvoice = invoice;
      const docNo = String((invoice.DocDtls as { No?: unknown } | undefined)?.No ?? "");
      const seller = String((invoice.SellerDtls as { Gstin?: unknown } | undefined)?.Gstin ?? "");
      const made = this.byDocument.get(`${seller}|${docNo}`);
      if (made) {
        const info = this.irns.get(made)!;
        return refuse("2150", "Duplicate IRN", { InfoDtls: [{ InfCd: "DUPIRN", Desc: { AckNo: info.AckNo, AckDt: info.AckDt, Irn: info.Irn } }] });
      }
      const irn = createHash("sha256").update(`${seller}${docNo}`).digest("hex");
      const record = { AckNo: 112610000000000 + this.irns.size + 1, AckDt: irpTime(new Date()), Irn: irn, SignedInvoice: "zz.signed.invoice", SignedQRCode: `zz.signed.qr.${docNo}`, Status: "ACT", EwbNo: null, EwbDt: null, EwbValidTill: null, Remarks: null };
      this.irns.set(irn, record);
      this.byDocument.set(`${seller}|${docNo}`, irn);
      if (this.loseNextAnswer) {
        this.loseNextAnswer = false;
        throw new Error("The request timed out.");
      }
      return sealed(record);
    }
    if (method === "GET" && url.pathname.startsWith("/eicore/v1.03/Invoice/irn/")) {
      const record = this.irns.get(decodeURIComponent(url.pathname.split("/").at(-1) ?? ""));
      return record ? sealed(record) : refuse("2283", "IRN details are not found");
    }
    if (method === "POST" && url.pathname === "/eicore/v1.03/Invoice/Cancel") {
      const cancel = opened();
      this.lastCancel = cancel;
      const record = this.irns.get(String(cancel.Irn));
      if (!record) return refuse("2270", "The allowed cancellation time limit is crossed, you cannot cancel the IRN");
      if (!["1", "2", "3", "4"].includes(String(cancel.CnlRsn))) return refuse("2236", "Invalid cancellation reason");
      record.Status = "CNL";
      return sealed({ Irn: cancel.Irn, CancelDate: irpTime(new Date()) });
    }
    if (method === "GET" && url.pathname.startsWith("/eivital/v1.03/Master/gstin/")) {
      const found = this.gstins.get(decodeURIComponent(url.pathname.split("/").at(-1) ?? ""));
      return found ? sealed(found) : refuse("3001", "Requested data is not available");
    }
    return refuse("404", `No such call: ${method} ${url.pathname}`);
  };

  /** How many times the client signed in. */
  get signIns(): number {
    return this.calls.filter((c) => c.path === "/eivital/v1.04/auth").length;
  }
}

/** The e-way bill portal's time, "dd/mm/yyyy hh:mm:ss AM", in India. */
function portalTime(at: Date): string {
  const t = new Date(at.getTime() + 330 * 60_000);
  const two = (n: number) => String(n).padStart(2, "0");
  const h = t.getUTCHours();
  return `${two(t.getUTCDate())}/${two(t.getUTCMonth() + 1)}/${t.getUTCFullYear()} ${two(h % 12 === 0 ? 12 : h % 12)}:${two(t.getUTCMinutes())}:${two(t.getUTCSeconds())} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * A stand-in for NIC's e-way bill API (version 1.03), as its API document describes it: a sign-in sealed
 * under the e-way bill system's public key, actions as {action, data} under the session key, reads under a
 * one-time key with an HMAC. Same rules as NicStandin: no network, `fetch` installed for a test's length.
 */
export class NicEwayStandin {
  readonly publicKeyPem: string;
  private readonly privateKey: KeyObject;
  readonly calls: StandinCall[] = [];
  private sessions = new Map<string, Buffer>();
  private bills = new Map<string, Record<string, unknown>>();
  lastSignIn: Record<string, unknown> | null = null;
  lastAction: { action: string; payload: Record<string, unknown> } | null = null;
  /** Spoil the next read's HMAC, as a tampered answer would arrive. */
  tamperNextRead = false;

  constructor(private readonly login: { userName: string; password: string; clientId: string; clientSecret: string }) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    this.publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k, String(v)]));
    this.calls.push({ method, path: `${url.pathname}${url.search}`, headers });
    const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    const refuse = (codes: string) => answer({ status: "0", error: Buffer.from(JSON.stringify({ errorCodes: codes })).toString("base64") });
    if (headers["client-id"] !== this.login.clientId || headers["client-secret"] !== this.login.clientSecret) return refuse("110");
    const body = init?.body ? (JSON.parse(String(init.body)) as { Data?: string; action?: string; data?: string }) : {};

    if (method === "POST" && url.pathname.endsWith("/v1.03/auth")) {
      let signIn: Record<string, unknown>;
      try {
        const block = privateDecrypt({ key: this.privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(String(body.Data), "base64"));
        signIn = JSON.parse(Buffer.from(unpadPkcs1(block).toString("utf8"), "base64").toString("utf8"));
      } catch {
        return refuse("109");
      }
      this.lastSignIn = signIn;
      if (signIn.action !== "ACCESSTOKEN") return refuse("239");
      if (signIn.username !== this.login.userName || signIn.password !== this.login.password) return refuse("108");
      const appKey = Buffer.from(String(signIn.app_key), "base64");
      if (appKey.length !== 32) return refuse("109");
      const sek = randomBytes(32);
      const token = randomBytes(12).toString("hex");
      this.sessions.set(token, sek);
      return answer({ status: "1", authtoken: token, sek: encrypt(sek, appKey) });
    }

    const sek = this.sessions.get(headers.authtoken ?? "");
    if (!sek) return refuse("238");

    if (method === "POST" && url.pathname.endsWith("/v1.03/ewayapi")) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(decrypt(String(body.data), sek).toString("utf8"));
      } catch {
        return refuse("109");
      }
      const action = String(body.action ?? "");
      this.lastAction = { action, payload };
      const sealed = (data: unknown) => answer({ status: "1", data: encrypt(Buffer.from(JSON.stringify(data)), sek) });
      if (action === "GENEWAYBILL") {
        if (!Array.isArray(payload.itemList) || payload.itemList.length === 0) return refuse("233");
        const ewbNo = String(331000000000 + this.bills.size + 1);
        const now = new Date();
        const record = { ewbNo, ewayBillDate: portalTime(now), validUpto: portalTime(new Date(now.getTime() + 86_400_000)), status: "ACT", docNo: payload.docNo, vehicleNo: payload.vehicleNo ?? "", transporterName: payload.transporterName ?? "" };
        this.bills.set(ewbNo, record);
        return sealed({ ewayBillNo: Number(ewbNo), ewayBillDate: record.ewayBillDate, validUpto: record.validUpto, alert: "" });
      }
      const bill = this.bills.get(String(payload.ewbNo));
      if (action === "VEHEWB") {
        if (!bill || bill.status !== "ACT") return refuse("312");
        bill.vehicleNo = payload.vehicleNo;
        return sealed({ vehUpdDate: portalTime(new Date()), validUpto: bill.validUpto });
      }
      if (action === "CANEWB") {
        if (!bill || bill.status !== "ACT") return refuse("312");
        bill.status = "CNL";
        return sealed({ ewayBillNo: Number(bill.ewbNo), cancelDate: portalTime(new Date()) });
      }
      return refuse("239");
    }

    if (method === "GET" && url.pathname.endsWith("/v1.03/ewayapi/GetEwayBill")) {
      const bill = this.bills.get(url.searchParams.get("ewbNo") ?? "");
      if (!bill) return refuse("325");
      const plain = Buffer.from(JSON.stringify(bill));
      const rek = randomBytes(32);
      let hmac = createHmac("sha256", rek).update(plain.toString("base64"), "utf8").digest("base64");
      if (this.tamperNextRead) {
        this.tamperNextRead = false;
        hmac = createHmac("sha256", rek).update("something else").digest("base64");
      }
      return answer({ status: "1", data: encrypt(plain, rek), rek: encrypt(rek, sek), hmac });
    }
    return refuse("239");
  };

  /** How many times the client signed in. */
  get signIns(): number {
    return this.calls.filter((c) => c.path.endsWith("/v1.03/auth")).length;
  }
}
