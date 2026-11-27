/**
 * check:gstin — a customer's or vendor's GSTIN checked before they're onboarded (src/lib/gstin).
 *
 *   · what the number says by itself, as the form says it: a mistyped check character, a GSTIN from another
 *     state than the address, another company's PAN, a treatment that doesn't fit, a registered business with
 *     no GSTIN; a right one says nothing;
 *   · the e-invoice system's "Get GSTIN details": the mock portal's answers, and the real portal's read from
 *     a stand-in for its replies — name, address, state, type, status, e-way blocking, "no such GSTIN", an error;
 *   · the lookup on a scratch workspace database (<db>_gstin_check, built from the migrations and dropped at
 *     the end): no e-invoice login refused with where to add one; an answer kept and reused; asked afresh only
 *     after 10 minutes; a GSTIN that can't be one never sent; a person's 60 an hour; the action;
 *   · the badge and the side rail's lookup, rendered.
 *
 * No real portal is called: the NIC path talks to a stand-in `fetch`.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { NicStandin } from "./lib/nic-standin";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: "PROFILE", name: "Zz Checker", email: `${actorId}@zzgstin.invalid` } : null);
    return {
      requireUser: async () => {
        const u = await user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: user,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const engine = require("../src/lib/gst-engine") as typeof import("../src/lib/gst-engine");
  const notes = require("../src/lib/gstin/notes") as typeof import("../src/lib/gstin/notes");
  const provider = require("../src/lib/einvoice/provider") as typeof import("../src/lib/einvoice/provider");
  /* eslint-enable @typescript-eslint/no-require-imports */

  // A GSTIN with the right check character, from its first fourteen.
  const gstin = (first14: string) => `${first14}${engine.gstinCheckCharacter(first14)}`;
  const acme = gstin("27AAACZ1234F1Z");
  const wrong = `${acme.slice(0, 14)}${acme[14] === "A" ? "B" : "A"}`;

  section("What the number says by itself");
  ok("a right GSTIN at an address in its state says nothing", notes.gstinNotes({ gstin: acme, state: "Maharashtra", companyPan: "AAACZ1234F", treatment: "REGISTERED_REGULAR" }).length === 0);
  ok("  spaces and lower case are read as the GSTIN", notes.gstinNotes({ gstin: ` ${acme.toLowerCase().slice(0, 7)} ${acme.toLowerCase().slice(7)}`, state: "Maharashtra" }).length === 0);
  ok("a mistyped check character is named", notes.gstinNotes({ gstin: wrong }).some((n) => /last character/.test(n)));
  ok("another state than the address's", notes.gstinNotes({ gstin: acme, state: "Karnataka" }).some((n) => /Maharashtra \(27\).*Karnataka/.test(n)));
  ok("another company's PAN", notes.gstinNotes({ gstin: acme, companyPan: "AAACB9999K" }).some((n) => /AAACZ1234F.*AAACB9999K/.test(n)));
  ok("a GSTIN on an unregistered treatment", notes.gstinNotes({ gstin: acme, treatment: "UNREGISTERED" }).some((n) => /treatment/.test(n)));
  ok("a registered treatment with no GSTIN", notes.gstinNotes({ gstin: "", treatment: "REGISTERED_REGULAR" }).some((n) => /add it/.test(n)));
  ok("nothing typed and nothing registered says nothing", notes.gstinNotes({ gstin: "", treatment: "UNREGISTERED" }).length === 0);
  ok("too short: counted", notes.gstinNotes({ gstin: "27AAACZ" })[0] === "A GSTIN is 15 characters; this is 7.");
  ok("the wrong shape: the shape described", /two digits for the state/.test(notes.gstinNotes({ gstin: "2AAAACZ1234F1ZV" })[0] ?? ""));
  ok("only a right one is worth asking the GST system about", notes.lookupReady(acme) && !notes.lookupReady(wrong) && !notes.lookupReady("27AAACZ"));
  ok("the taxpayer type points to the treatment", notes.treatmentForTaxpayerType("REG") === "REGISTERED_REGULAR" && notes.treatmentForTaxpayerType("COM") === "REGISTERED_COMPOSITION" && notes.treatmentForTaxpayerType("XYZ") === null);

  section("The mock portal");
  const mock = provider.createEInvoiceProvider({ provider: "mock" });
  const fine = await mock.gstinDetails(acme);
  ok("an ordinary GSTIN: active, its state, regular", fine.ok && fine.details.status === "ACT" && fine.details.stateCode === "27" && fine.details.taxpayerType === "REG" && !fine.details.blocked, fine);
  const cancelled = await mock.gstinDetails(gstin("29AAACB9999K1Z"));
  ok("PAN digits 9999: cancelled", cancelled.ok && cancelled.details.status === "CNL");
  const blocked = await mock.gstinDetails(gstin("29AAACB7777K1Z"));
  ok("7777: blocked for e-way bills", blocked.ok && blocked.details.blocked);
  const none = await mock.gstinDetails(gstin("29AAACB0000K1Z"));
  ok("0000: no such GSTIN", !none.ok && none.notFound === true);

  section("The real portal, through a stand-in");
  // The stand-in decrypts and answers as NIC does (scripts/lib/nic-standin.ts; the scheme is check:nic-einvoice's).
  const login = { userName: "zz", password: "zz", clientId: "cid", clientSecret: "cs" };
  const standin = new NicStandin(login);
  const realFetch = globalThis.fetch;
  const savedKey = process.env.EINVOICE_NIC_PUBLIC_KEY_SANDBOX;
  globalThis.fetch = standin.fetch as typeof fetch;
  process.env.EINVOICE_NIC_PUBLIC_KEY_SANDBOX = standin.publicKeyPem;
  try {
    const nic = provider.createEInvoiceProvider({ provider: "nic_sandbox", username: login.userName, password: login.password, clientId: login.clientId, clientSecret: login.clientSecret, gstin: acme });
    standin.gstins.set(acme, { Gstin: acme, TradeName: "Acme Traders", LegalName: "ACME TRADERS PRIVATE LIMITED", AddrBnm: "Acme House", AddrBno: "12", AddrFlno: "", AddrSt: "MG Road", AddrLoc: "Pune", StateCode: 27, AddrPncd: 411001, TxpType: "REG", Status: "ACT", BlkStatus: "U" });
    const read = await nic.gstinDetails(acme);
    const asked = standin.calls.find((c) => c.path.includes("/Master/gstin/"));
    ok("it asks GET /eivital/v1.03/Master/gstin/{GSTIN} with the login's token", asked?.method === "GET" && asked.path === `/eivital/v1.03/Master/gstin/${acme}` && (asked.headers.AuthToken ?? "").length > 0 && asked.headers.Gstin === acme, asked);
    ok("  and reads the names, the address joined, the state, the PIN, the type and the status", read.ok && read.details.legalName === "ACME TRADERS PRIVATE LIMITED" && read.details.tradeName === "Acme Traders" && read.details.address === "Acme House, 12, MG Road, Pune" && read.details.stateCode === "27" && read.details.pincode === "411001" && read.details.status === "ACT" && !read.details.blocked, read);
    standin.gstins.set(acme, { Gstin: acme, LegalName: "X", Status: "CNL", BlkStatus: "B", StateCode: "07" });
    const cnl = await nic.gstinDetails(acme);
    ok("  cancelled and blocked read as such", cnl.ok && cnl.details.status === "CNL" && cnl.details.blocked && cnl.details.stateCode === "07");
    standin.gstins.delete(acme);
    const missing = await nic.gstinDetails(acme);
    ok("  error 3001 is no such GSTIN", !missing.ok && missing.notFound === true);
    const failed = await provider.createEInvoiceProvider({ provider: "nic_sandbox", username: login.userName, clientId: login.clientId, clientSecret: login.clientSecret, password: "not it", gstin: acme }).gstinDetails(acme);
    ok("  any other error comes back as the portal said it", !failed.ok && !failed.notFound && "error" in failed && /Invalid login credentials/.test(failed.error), failed);
  } finally {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.EINVOICE_NIC_PUBLIC_KEY_SANDBOX;
    else process.env.EINVOICE_NIC_PUBLIC_KEY_SANDBOX = savedKey;
  }

  await scratch(acme, wrong, gstin);
}

async function scratch(acme: string, wrong: string, gstin: (first14: string) => string) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is needed.");
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("Only against a local database server.");
  const scratchName = `${new URL(url).pathname.slice(1)}_gstin_check`;
  const scratchUrl = withDatabase(url, scratchName);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });

  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from its migrations", true);
    // The scratch database is the workspace; no control plane is consulted. Off by value, never deleted.
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = " ";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    await lookups(acme, wrong, gstin);
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${scratchName}`;
    ok("the scratch workspace is dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }
}

async function lookups(acme: string, wrong: string, gstin: (first14: string) => string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const lookup = require("../src/lib/gstin/lookup") as typeof import("../src/lib/gstin/lookup");
  const actions = require("../src/actions/gstin") as typeof import("../src/actions/gstin");
  const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
  const { GstinBadge } = require("../src/components/companies/gstin-badge") as typeof import("../src/components/companies/gstin-badge");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const React = await import("react");

  const user = await db.user.create({ data: { name: "Zz Checker", email: "checker@zzgstin.invalid", role: "PROFILE", passwordHash: "x".repeat(60) } });
  const other = await db.user.create({ data: { name: "Zz Other", email: "other@zzgstin.invalid", role: "PROFILE", passwordHash: "x".repeat(60) } });
  const refusal = (p: Promise<unknown>) => p.then(() => "", (e: unknown) => (e instanceof Error ? e.message : String(e)));

  section("Asking the GST system");
  ok("with no e-invoice login: refused, saying where to add one", /Settings → e-Invoicing/.test(await refusal(lookup.lookupGstin(acme, user.id))));
  await db.gstRegistration.create({ data: { gstin: gstin("27AAACW1234F1Z"), stateCode: "27", code: "MH", einvoiceProvider: "mock" } });

  ok("a GSTIN whose check character is wrong is never sent", /check each character/.test(await refusal(lookup.lookupGstin(wrong, user.id))));
  ok("  nor is one that isn't a GSTIN", /check each character/.test(await refusal(lookup.lookupGstin("hello", user.id))));
  ok("  and nothing was kept for either", (await db.gstinCheck.count()) === 0);

  const t0 = new Date("2026-10-25T06:00:00Z");
  const first = await lookup.lookupGstin(acme.toLowerCase(), user.id, { now: t0 });
  ok("the first check asks, and keeps the answer: active, by whom, through the mock portal", !first.reused && first.check.status === "ACT" && first.check.source === "mock", first);
  const row = await db.gstinCheck.findUnique({ where: { gstin: acme } });
  ok("  kept under the GSTIN as written, with who and when", row?.checkedById === user.id && row.checkedAt.getTime() === t0.getTime());
  const later = await lookup.lookupGstin(acme, other.id, { now: new Date(t0.getTime() + 20 * 86_400_000) });
  ok("asked again 20 days later: the kept answer, no new lookup", later.reused && (await db.gstinCheck.findUnique({ where: { gstin: acme } }))?.checkedById === user.id);
  const soon = await lookup.lookupGstin(acme, other.id, { fresh: true, now: new Date(t0.getTime() + 5 * 60_000) });
  ok("asked afresh 5 minutes after: still the kept answer", soon.reused);
  const fresh = await lookup.lookupGstin(acme, other.id, { fresh: true, now: new Date(t0.getTime() + 11 * 60_000) });
  ok("asked afresh after 10 minutes: a new lookup, kept as the other person's", !fresh.reused && (await db.gstinCheck.findUnique({ where: { gstin: acme } }))?.checkedById === other.id);
  const stale = await lookup.lookupGstin(acme, user.id, { now: new Date(t0.getTime() + 31 * 86_400_000) });
  ok("older than 30 days: asked again", !stale.reused);

  const gone = await lookup.lookupGstin(gstin("29AAACB0000K1Z"), user.id, { now: t0 });
  ok("no such GSTIN is an answer too: kept as not found", gone.check.status === "NOT_FOUND" && !gone.reused);
  const cnl = await lookup.lookupGstin(gstin("29AAACB9999K1Z"), user.id, { now: t0 });
  ok("a cancelled one is kept as cancelled", cnl.check.status === "CNL");

  section("A person's limit");
  const now = new Date();
  await db.gstinCheck.createMany({
    data: Array.from({ length: lookup.LOOKUPS_PER_HOUR }, (_, i) => ({ gstin: `ZZFILL${String(i).padStart(9, "0")}`, status: "ACT", source: "mock", checkedById: user.id, checkedAt: new Date(now.getTime() - 60_000) })),
  });
  ok(`${lookup.LOOKUPS_PER_HOUR} fresh lookups in the last hour: the next is refused`, /limit/.test(await refusal(lookup.lookupGstin(gstin("33AAACT1234Q1Z"), user.id))));
  ok("  a kept answer is still given", (await lookup.lookupGstin(acme, user.id)).reused);
  ok("  and somebody else may still look one up", !(await lookup.lookupGstin(gstin("33AAACT1234Q1Z"), other.id)).reused);

  section("The action and the saved checks");
  actorId = other.id;
  const viaAction = await actions.checkGstin({ gstin: acme });
  ok("Check with GST answers with the check", viaAction.ok && viaAction.data.check.gstin === acme, viaAction);
  const refused = await actions.checkGstin({ gstin: wrong });
  ok("  a refusal comes back as a message, not an error page", !refused.ok && /check each character/.test(refused.error));
  const saved = await lookup.savedGstinChecks([acme, ` ${gstin("29AAACB9999K1Z").toLowerCase()} `, null, "", wrong]);
  ok("the saved checks for a page, by GSTIN, only those that have one", Object.keys(saved).length === 2 && saved[acme]?.status === "ACT" && saved[gstin("29AAACB9999K1Z")]?.status === "CNL", Object.keys(saved));

  section("On the page");
  const activeBadge = await renderHtml(React.createElement(GstinBadge, { check: saved[acme]! }));
  const cancelledBadge = await renderHtml(React.createElement(GstinBadge, { check: saved[gstin("29AAACB9999K1Z")]! }));
  const unchecked = await renderHtml(React.createElement(GstinBadge, { check: null }));
  ok("the badge says Active, Cancelled, or that it was never checked", activeBadge.includes("Active") && cancelledBadge.includes("Cancelled") && unchecked.includes("not checked with GST"));
  ok("  and a mock answer says it's the mock portal's", activeBadge.includes("mock portal"));
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAll GSTIN checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
