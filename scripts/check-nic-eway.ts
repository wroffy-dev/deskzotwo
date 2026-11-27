/**
 * check:nic-eway — the NIC e-way bill API as its API document says it (src/lib/eway/provider.ts, the helpers in
 * src/lib/einvoice/nic-crypto.ts), against a stand-in that decrypts, checks and answers the same way
 * (scripts/lib/nic-standin.ts):
 *
 *   · the portal's refusals read into words: {"errorCodes": 240}, the same as Base64 JSON, a comma list, a code
 *     it doesn't list, a message;
 *   · signing in at /v1.03/auth: no public key on the server named; wrong credentials named; the right ones
 *     sealed under the e-way bill system's key with a 32-byte app key; one sign-in for a provider's calls;
 *   · a bill generated with GENEWAYBILL under the session key, its number and dates read from the answer; Part B
 *     (VEHEWB); a cancellation (CANEWB); a bill the portal won't touch, refused with its reason;
 *   · GetEwayBill's answer under a one-time key, checked by its HMAC, and refused when the HMAC is wrong;
 *   · the sandbox address is ewaybill2.nic.in under /ewaybillapi.
 *
 * No real portal is called and nothing is written to a database.
 */
import "dotenv/config";
import { NicEwayStandin } from "./lib/nic-standin";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const KEY_ENV = "EWAY_NIC_PUBLIC_KEY_SANDBOX";

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const errors = require("../src/lib/eway/nic-errors") as typeof import("../src/lib/eway/nic-errors");
  const eway = require("../src/lib/eway/provider") as typeof import("../src/lib/eway/provider");
  const { buildEwayPayload } = require("../src/lib/eway/payload") as typeof import("../src/lib/eway/payload");
  const { gstinCheckCharacter } = require("../src/lib/gst-engine") as typeof import("../src/lib/gst-engine");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const gstin = (first14: string) => `${first14}${gstinCheckCharacter(first14)}`;
  const seller = gstin("29AAACW1234F1Z");

  section("The portal's refusals, in words");
  ok("{errorCodes: 240}", errors.ewayErrorText({ status: "0", error: { errorCodes: 240 } }) === "Couldn't generate the e-way bill; contact the e-way bill helpdesk (240)");
  ok("  the same as Base64 JSON, with a comma list", errors.ewayErrorText({ status: "0", error: Buffer.from(JSON.stringify({ errorCodes: "238,108," })).toString("base64") }) === "Invalid auth token (238); Invalid login credentials (108)");
  ok("  a code the document doesn't list keeps its number", errors.ewayErrorText({ error: { errorCodes: "999" } }) === "error 999");
  ok("  a message as it came", errors.ewayErrorText({ error: [{ message: "Service down" }] }) === "Service down" && errors.ewayErrorText({ message: "Gateway timeout" }) === "Gateway timeout");
  ok("  nothing at all: a plain refusal", errors.ewayErrorText({}) === "The e-way bill system refused the request.");

  const login = { userName: "zz_ewb_user", password: "zz ewb pass", clientId: "zz-ewb-client", clientSecret: "zz-ewb-secret" };
  const nic = new NicEwayStandin(login);
  const config = { provider: "nic_sandbox", username: login.userName, password: login.password, clientId: login.clientId, clientSecret: login.clientSecret, gstin: seller };
  const doc = {
    supplyType: "OUTWARD" as const,
    subSupplyType: "SUPPLY" as const,
    documentType: "INVOICE" as const,
    documentNumber: "ZZ/2026-27/0042",
    documentDate: new Date("2026-10-25T06:00:00Z"),
    from: { gstin: seller, tradeName: "Zz Sellers", address1: "1 Road", place: "Bengaluru", pincode: "560001", stateCode: "29" },
    to: { gstin: gstin("27AAACB5678K1Z"), tradeName: "Zz Buyers", address1: "2 Road", place: "Pune", pincode: "411001", stateCode: "27" },
    items: [{ productName: "Laptop", hsnCode: "84713010", quantity: 2, unit: "NOS", taxableValue: 100000, igstRate: 18 }],
    totalValue: 100000,
    igstValue: 18000,
    totalInvoiceValue: 118000,
    transportMode: "ROAD" as const,
    distanceKm: 840,
    vehicleNumber: "KA01AB1234",
    vehicleType: "REGULAR" as const,
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = nic.fetch as typeof fetch;
  const savedKey = process.env[KEY_ENV];
  try {
    section("Signing in");
    delete process.env[KEY_ENV];
    const noKey = await eway.createEwayProvider(config).generate(doc);
    ok("no public key on the server: said, naming the setting, and nothing sent", !noKey.ok && noKey.error.includes(KEY_ENV) && nic.calls.length === 0, noKey);
    process.env[KEY_ENV] = nic.publicKeyPem;
    const wrong = await eway.createEwayProvider({ ...config, password: "not it" }).generate(doc);
    ok("wrong credentials: named, with the portal's code", !wrong.ok && /Invalid login credentials \(108\)/.test(wrong.error), wrong);

    const p = eway.createEwayProvider(config);
    const before = nic.signIns;
    const made = await p.generate(doc);
    const signIn = nic.lastSignIn ?? {};
    ok("signed in at the sandbox's /ewaybillapi/v1.03/auth", nic.calls.some((c) => c.method === "POST" && c.path === "/ewaybillapi/v1.03/auth"));
    ok("  as ACCESSTOKEN with the user, the password and a 32-byte app key, sealed under the e-way bill system's key", signIn.action === "ACCESSTOKEN" && signIn.username === login.userName && signIn.password === login.password && Buffer.from(String(signIn.app_key), "base64").length === 32, signIn);
    const acted = nic.calls.find((c) => c.path === "/ewaybillapi/v1.03/ewayapi");
    ok("  then acts with the session's token, the client and the GSTIN", !!acted?.headers.authtoken && acted.headers["client-id"] === login.clientId && acted.headers.gstin === seller, acted?.headers);

    section("A bill");
    ok("generated: the number and both dates read from the decrypted answer", made.ok && /^\d{12}$/.test(made.ewayBillNumber) && made.validUntil.getTime() - made.ewayBillDate.getTime() > 23 * 3_600_000, made);
    ok("  the bill the portal read is exactly the payload Deskzo builds, as GENEWAYBILL", nic.lastAction?.action === "GENEWAYBILL" && JSON.stringify(nic.lastAction.payload) === JSON.stringify(buildEwayPayload(doc)));
    const number = made.ok ? made.ewayBillNumber : "";
    const vehicle = await p.updateVehicle({ ewayBillNumber: number, vehicleNumber: "KA01CD5678", reasonCode: "1", reasonNote: "Break down", fromPlace: "Hosur", fromStateCode: "29", transportMode: "ROAD" });
    ok("Part B: the new vehicle sent as VEHEWB and confirmed", vehicle.ok && nic.lastAction?.action === "VEHEWB" && nic.lastAction.payload.vehicleNo === "KA01CD5678" && nic.lastAction.payload.ewbNo === Number(number), { vehicle, sent: nic.lastAction });

    section("Reading one back");
    const read = await p.fetch(number);
    ok("GetEwayBill: decrypted under its one-time key, the HMAC checked", read.ok && read.ewayBillNumber === number && read.vehicleNumber === "KA01CD5678" && read.status === "GENERATED", read);
    ok("  asked with the number in the query", nic.calls.some((c) => c.method === "GET" && c.path === `/ewaybillapi/v1.03/ewayapi/GetEwayBill?ewbNo=${number}`));
    nic.tamperNextRead = true;
    const tampered = await p.fetch(number);
    ok("an answer whose HMAC doesn't match is refused", !tampered.ok && /integrity check/.test(tampered.error), tampered);
    const missing = await p.fetch("331999999999");
    ok("a number the portal doesn't know: its reason", !missing.ok && /Couldn't retrieve the data \(325\)/.test(missing.error), missing);

    section("Cancelling");
    const cancelled = await p.cancel(number, "3", "Data entry mistake");
    ok("cancelled as CANEWB with the reason and remark", cancelled.ok && nic.lastAction?.action === "CANEWB" && nic.lastAction.payload.cancelRsnCode === 3 && nic.lastAction.payload.cancelRmrk === "Data entry mistake", { cancelled, sent: nic.lastAction });
    const again = await p.cancel(number, "3", "Again");
    ok("  cancelling it again: the portal's reason", !again.ok && /cancelled \(312\)/.test(again.error), again);
    const afterwards = await p.fetch(number);
    ok("  and it reads back cancelled", afterwards.ok && afterwards.status === "CANCELLED", afterwards);
    ok("all of it on one sign-in", nic.signIns === before + 1, { signIns: nic.signIns, before });
  } finally {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = savedKey;
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAll NIC e-way bill checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
