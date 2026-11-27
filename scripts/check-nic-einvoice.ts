/**
 * check:nic-einvoice — the NIC e-invoice API's encryption (src/lib/einvoice/nic-crypto.ts) and the provider that
 * speaks it (src/lib/einvoice/provider.ts), against a stand-in that decrypts, checks and answers as NIC does
 * (scripts/lib/nic-standin.ts):
 *
 *   · the pieces: AES-ECB both ways, NIC's public key as PEM, escaped PEM or bare Base64, the portal's errors
 *     however it sends them, its Status however it writes it;
 *   · signing in: no public key on the server named, wrong credentials named as the portal names them, the
 *     right ones carrying a 32-byte AppKey under NIC's key; one sign-in for a provider's calls;
 *   · an IRN generated with the invoice encrypted under the session key and the answer decrypted; the same
 *     invoice again after a lost answer gets the IRN the portal already gave; a cancellation at
 *     /eicore/v1.03/Invoice/Cancel; a GSTIN's details, and one the portal doesn't know.
 *
 * No real portal is called and nothing is written to a database.
 */
import "dotenv/config";
import { NicStandin } from "./lib/nic-standin";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const KEY_ENV = "EINVOICE_NIC_PUBLIC_KEY_SANDBOX";

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nicCrypto = require("../src/lib/einvoice/nic-crypto") as typeof import("../src/lib/einvoice/nic-crypto");
  const provider = require("../src/lib/einvoice/provider") as typeof import("../src/lib/einvoice/provider");
  const { buildEInvoicePayload } = require("../src/lib/einvoice/payload") as typeof import("../src/lib/einvoice/payload");
  const { gstinCheckCharacter } = require("../src/lib/gst-engine") as typeof import("../src/lib/gst-engine");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const gstin = (first14: string) => `${first14}${gstinCheckCharacter(first14)}`;
  const seller = gstin("27AAACW1234F1Z");
  const buyer = gstin("29AAACB5678K1Z");

  const login = { userName: "zz_api_user", password: "zz pass word", clientId: "zz-client-id", clientSecret: "zz-client-secret" };
  const nic = new NicStandin(login);
  const config = { provider: "nic_sandbox", username: login.userName, password: login.password, clientId: login.clientId, clientSecret: login.clientSecret, gstin: seller };

  section("The pieces");
  const key32 = Buffer.alloc(32, 7);
  const sealed = nicCrypto.aesEncrypt(Buffer.from("{\"a\":\"ü\"}"), key32);
  ok("AES-256-ECB both ways, in Base64", nicCrypto.aesDecrypt(sealed, key32).toString() === "{\"a\":\"ü\"}" && /^[A-Za-z0-9+/]+=*$/.test(sealed));
  ok("  a 16-byte key is AES-128", nicCrypto.aesDecrypt(nicCrypto.aesEncrypt(Buffer.from("x"), Buffer.alloc(16, 1)), Buffer.alloc(16, 1)).toString() === "x");
  ok("  a key of another length is refused", (() => {
    try {
      nicCrypto.aesEncrypt(Buffer.from("x"), Buffer.alloc(20));
      return false;
    } catch {
      return true;
    }
  })());
  const pem = nicCrypto.nicPublicKey(nic.publicKeyPem);
  const escaped = nicCrypto.nicPublicKey(nic.publicKeyPem.replace(/\n/g, "\\n"));
  const bare = nicCrypto.nicPublicKey(nic.publicKeyBase64);
  ok("NIC's key read as PEM, as PEM with \\n written out (an env var), and as bare Base64", [pem, escaped, bare].every((k) => k.asymmetricKeyType === "rsa") && pem.export({ type: "spki", format: "der" }).equals(bare.export({ type: "spki", format: "der" })));
  ok("the portal's errors as an array", nicCrypto.nicErrors({ ErrorDetails: [{ ErrorCode: "2150", ErrorMessage: "Duplicate IRN" }] })[0]?.code === "2150");
  ok("  as Base64 JSON, as the 1.03 calls send them", nicCrypto.nicErrors({ ErrorDetails: Buffer.from(JSON.stringify([{ ErrorCode: 3001, ErrorMessage: "Requested data is not available" }])).toString("base64") })[0]?.code === "3001");
  ok("  as one message", nicCrypto.nicErrors({ ErrorMessage: "Service unavailable" })[0]?.message === "Service unavailable");
  ok("Status 1 as a number or a string, either casing; 0 isn't", nicCrypto.succeeded({ Status: 1 }) && nicCrypto.succeeded({ Status: "1" }) && nicCrypto.succeeded({ status: "1" }) && !nicCrypto.succeeded({ status: "0" }) && !nicCrypto.succeeded(null));

  const realFetch = globalThis.fetch;
  globalThis.fetch = nic.fetch as typeof fetch;
  const savedKey = process.env[KEY_ENV];
  try {
    section("Signing in");
    delete process.env[KEY_ENV];
    const noKey = await provider.createEInvoiceProvider(config).gstinDetails(buyer);
    ok("no public key on the server: said, naming the setting, and nothing sent", !noKey.ok && "error" in noKey && noKey.error.includes(KEY_ENV) && nic.calls.length === 0, noKey);
    process.env[KEY_ENV] = nic.publicKeyPem;
    const wrong = await provider.createEInvoiceProvider({ ...config, password: "not it" }).gstinDetails(buyer);
    ok("wrong credentials: the portal's own words", !wrong.ok && "error" in wrong && /Invalid login credentials/.test(wrong.error), wrong);
    nic.gstins.set(buyer, { Gstin: buyer, TradeName: "Bright Retail", LegalName: "BRIGHT RETAIL PRIVATE LIMITED", AddrBnm: "Bright House", AddrBno: "4", AddrFlno: "", AddrSt: "4th Cross", AddrLoc: "Bengaluru", StateCode: 29, AddrPncd: 560038, TxpType: "REG", Status: "ACT", BlkStatus: "" });
    const p = provider.createEInvoiceProvider(config);
    const before = nic.signIns;
    const details = await p.gstinDetails(buyer);
    const signIn = nic.lastSignIn ?? {};
    ok("signed in with the user, the password and a 32-byte AppKey, all under NIC's key", signIn.UserName === login.userName && signIn.Password === login.password && String(signIn.AppKey).length === 44 && Buffer.from(String(signIn.AppKey), "base64").length === 32 && signIn.ForceRefreshAccessToken === false, signIn);
    const asked = nic.calls.at(-1)!;
    ok("the call carries the session's token, the user, the GSTIN and the client", asked.headers.AuthToken?.length > 0 && asked.headers.user_name === login.userName && asked.headers.Gstin === seller && asked.headers.client_id === login.clientId);

    section("A GSTIN's details");
    ok("the answer decrypted and read: names, address, state, PIN, type, status", details.ok && details.details.legalName === "BRIGHT RETAIL PRIVATE LIMITED" && details.details.address === "Bright House, 4, 4th Cross, Bengaluru" && details.details.stateCode === "29" && details.details.pincode === "560038" && details.details.status === "ACT" && !details.details.blocked, details);
    const unknown = await p.gstinDetails(gstin("33AAACT1234Q1Z"));
    ok("one the portal doesn't know: not found", !unknown.ok && unknown.notFound === true, unknown);
    ok("  both on one sign-in", nic.signIns === before + 1, { signIns: nic.signIns, before });

    section("An IRN");
    const doc = {
      docType: "INVOICE" as const,
      docNumber: "ZZ/2026-27/0007",
      issueDate: new Date("2026-10-25T06:00:00Z"),
      reverseCharge: false,
      placeOfSupplyCode: "29",
      seller: { gstin: seller, legalName: "Zz Sellers Pvt Ltd", address1: "1 Road", city: "Pune", pincode: "411001", stateCode: "27" },
      buyer: { gstin: buyer, legalName: "Bright Retail", address1: "4th Cross", city: "Bengaluru", pincode: "560038", stateCode: "29" },
      lines: [{ description: "Laptop", isService: false, hsnCode: "84713010", quantity: 1, unit: "NOS", unitPrice: 50000, grossAmount: 50000, discountAmount: 0, taxableValue: 50000, taxRatePercent: 18, cgstAmount: 0, sgstAmount: 0, igstAmount: 9000, lineTotal: 59000 }],
      taxableValue: 50000,
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: 9000,
      roundOff: 0,
      total: 59000,
    };
    const made = await p.generate(doc);
    ok("generated: the IRN, the acknowledgement and the signed QR, decrypted", made.ok && /^[0-9a-f]{64}$/.test(made.irn) && made.ackNo.length > 0 && made.ackDate instanceof Date && !Number.isNaN(made.ackDate.getTime()) && made.signedQrCode === "zz.signed.qr.ZZ/2026-27/0007", made);
    ok("  the invoice the portal read is exactly the payload Deskzo builds", JSON.stringify(nic.lastInvoice) === JSON.stringify(buildEInvoicePayload(doc)));
    ok("  still the one sign-in", nic.signIns === before + 1);

    const lost = { ...doc, docNumber: "ZZ/2026-27/0008" };
    nic.loseNextAnswer = true;
    const timedOut = await provider.createEInvoiceProvider(config).generate(lost);
    ok("an answer lost on the way (the IRN made all the same): a readable failure", !timedOut.ok && /timed out/.test(timedOut.error), timedOut);
    const retried = await provider.createEInvoiceProvider(config).generate(lost);
    ok("  tried again: the portal says duplicate, and the IRN it gave is read back", retried.ok && retried.signedQrCode === "zz.signed.qr.ZZ/2026-27/0008", retried);
    ok("  through GET /eicore/v1.03/Invoice/irn/{IRN}", nic.calls.some((c) => c.method === "GET" && c.path.startsWith("/eicore/v1.03/Invoice/irn/")));

    section("Cancelling");
    const cancelled = made.ok ? await p.cancel(made.irn, "2", "Wrong rate") : { ok: false as const, error: "no IRN" };
    ok("cancelled at POST /eicore/v1.03/Invoice/Cancel, the reason and remark encrypted", cancelled.ok && nic.calls.at(-1)?.path === "/eicore/v1.03/Invoice/Cancel" && nic.lastCancel?.CnlRsn === "2" && nic.lastCancel?.CnlRem === "Wrong rate", { cancelled, last: nic.lastCancel });
    const notOurs = await p.cancel("f".repeat(64), "1", "zz");
    ok("  one the portal won't cancel: its reason", !notOurs.ok && /cancellation time limit/.test(notOurs.error), notOurs);

    section("The key as NIC's portal also gives it");
    process.env[KEY_ENV] = nic.publicKeyBase64;
    const viaBare = await provider.createEInvoiceProvider(config).gstinDetails(buyer);
    ok("bare Base64 in the setting signs in too", viaBare.ok);
    process.env[KEY_ENV] = nic.publicKeyPem.replace(/\n/g, "\\n");
    const viaEscaped = await provider.createEInvoiceProvider(config).gstinDetails(buyer);
    ok("  and PEM with \\n written out", viaEscaped.ok);
  } finally {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = savedKey;
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAll NIC e-invoice checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
