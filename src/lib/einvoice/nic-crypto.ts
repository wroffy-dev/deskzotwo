import { constants, createCipheriv, createDecipheriv, createPublicKey, publicEncrypt, randomBytes, type KeyObject } from "node:crypto";

/**
 * The encryption NIC's e-invoice API asks of a direct caller — and, with its own sign-in and envelope, its
 * e-way bill API (src/lib/eway/provider.ts) (https://einv-apisandbox.nic.in, version 1.04
 * auth, 1.03 calls). Without it the portal answers nothing: it was missing until 25 Oct 2026, so the NIC
 * path had never worked against the real portal.
 *
 *   1. **Sign in.** A random 32-byte AppKey for the session. The JSON {UserName, Password, AppKey (Base64,
 *      44 characters), ForceRefreshAccessToken} is Base64-encoded, and that text RSA-encrypted (PKCS#1 v1.5)
 *      with NIC's public key: the body is {"Data": <Base64 of the ciphertext>}.
 *   2. **The session key.** The answer's Sek is the Session Encryption Key, AES-256-ECB (PKCS#7) encrypted
 *      with the AppKey, in Base64.
 *   3. **Every call after.** The request JSON is AES-256-ECB encrypted with the SEK, sent as {"Data": <Base64>};
 *      the answer's Data is the same, decrypted to the JSON.
 *
 * As NIC's published scheme and an open-source client that follows it (Mittal-Analytics/gst-e-invoicing)
 * read it. ECB and PKCS#1 v1.5 are NIC's choice, not ours.
 */

/** NIC's public key as given: a PEM file's text, or the bare Base64 of its DER, "\n" escapes allowed (an env var). */
export function nicPublicKey(text: string): KeyObject {
  const value = text.replace(/\\n/g, "\n").trim();
  if (value.includes("-----BEGIN")) return createPublicKey(value);
  return createPublicKey({ key: Buffer.from(value.replace(/\s+/g, ""), "base64"), format: "der", type: "spki" });
}

/** A fresh session's AppKey: 32 random bytes. */
export const newAppKey = (): Buffer => randomBytes(32);

const aesName = (key: Buffer) => {
  if (key.length === 32) return "aes-256-ecb";
  if (key.length === 24) return "aes-192-ecb";
  if (key.length === 16) return "aes-128-ecb";
  throw new Error(`An AES key is 16, 24 or 32 bytes; this one is ${key.length}.`);
};

/** AES-ECB with PKCS#7 padding, the ciphertext in Base64. */
export function aesEncrypt(plain: Buffer, key: Buffer): string {
  const cipher = createCipheriv(aesName(key), key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");
}

/** The other way: Base64 ciphertext to the plain bytes. */
export function aesDecrypt(base64: string, key: Buffer): Buffer {
  const decipher = createDecipheriv(aesName(key), key, null);
  return Buffer.concat([decipher.update(Buffer.from(base64, "base64")), decipher.final()]);
}

/** A sign-in's JSON as NIC takes it: Base64-encoded, that text RSA-encrypted (PKCS#1 v1.5), the ciphertext in Base64. */
export function sealedJson(value: unknown, publicKey: KeyObject): string {
  const encoded = Buffer.from(Buffer.from(JSON.stringify(value), "utf8").toString("base64"), "utf8");
  return publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, encoded).toString("base64");
}

/** The e-invoice sign-in body: the credentials and the AppKey, sealed with NIC's key. */
export function authBody(input: { userName: string; password: string; appKey: Buffer; forceRefresh?: boolean }, publicKey: KeyObject): { Data: string } {
  return {
    Data: sealedJson(
      { UserName: input.userName, Password: input.password, AppKey: input.appKey.toString("base64"), ForceRefreshAccessToken: input.forceRefresh ?? false },
      publicKey,
    ),
  };
}

/**
 * Decrypted bytes read as JSON. NIC's documents write the plaintext as "Base64(JSON)", where its own sample code
 * means the JSON's bytes; JSON that arrives Base64-wrapped all the same is read too.
 */
export function plainJson(plain: Buffer): unknown {
  const text = plain.toString("utf8").trim();
  if (text.startsWith("{") || text.startsWith("[")) return JSON.parse(text);
  return JSON.parse(Buffer.from(text, "base64").toString("utf8"));
}

/** The session key from the sign-in's answer. */
export const sessionKey = (sek: string, appKey: Buffer): Buffer => aesDecrypt(sek, appKey);

/** A call's body: its JSON encrypted with the session key. */
export const encryptedBody = (payload: unknown, sek: Buffer): { Data: string } => ({ Data: aesEncrypt(Buffer.from(JSON.stringify(payload), "utf8"), sek) });

/** An answer's Data, decrypted with the session key and read as JSON. */
export const decryptedData = (data: string, sek: Buffer): unknown => plainJson(aesDecrypt(data, sek));

/** Whether the portal said yes: Status 1, written as a number or a string, with either casing of the key. */
export function succeeded(body: unknown): boolean {
  const record = (body ?? {}) as { Status?: unknown; status?: unknown };
  return String(record.Status ?? record.status ?? "") === "1";
}

export type NicError = { code: string; message: string };

/**
 * The portal's errors, however it sent them: an array of {ErrorCode, ErrorMessage}, the same as a Base64 JSON
 * string (as the 1.03 calls send them), or one message.
 */
export function nicErrors(body: unknown): NicError[] {
  const record = (body ?? {}) as { ErrorDetails?: unknown; ErrorMessage?: unknown; message?: unknown };
  let details: unknown = record.ErrorDetails;
  if (typeof details === "string") {
    const text = details;
    try {
      details = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
    } catch {
      try {
        details = JSON.parse(text);
      } catch {
        return [{ code: "", message: text }];
      }
    }
  }
  const list = Array.isArray(details) ? details : details && typeof details === "object" ? [details] : [];
  const errors = list
    .map((e: { ErrorCode?: unknown; ErrorMessage?: unknown }) => ({ code: String(e?.ErrorCode ?? "").trim(), message: String(e?.ErrorMessage ?? "").trim() }))
    .filter((e) => e.code || e.message);
  if (errors.length === 0 && typeof (record.ErrorMessage ?? record.message) === "string") errors.push({ code: "", message: String(record.ErrorMessage ?? record.message) });
  return errors;
}

/** The portal's "InfoDtls": what it adds beside an answer — for a duplicate IRN, the IRN it already gave. */
export function infoDetails(body: unknown): { code: string; desc: unknown }[] {
  const raw = (body as { InfoDtls?: unknown } | null)?.InfoDtls;
  const list = Array.isArray(raw) ? raw : [];
  return list.map((i: { InfCd?: unknown; Desc?: unknown }) => {
    let desc = i?.Desc;
    if (typeof desc === "string") {
      try {
        desc = JSON.parse(desc);
      } catch {
        // A plain message stays as it is.
      }
    }
    return { code: String(i?.InfCd ?? ""), desc };
  });
}
