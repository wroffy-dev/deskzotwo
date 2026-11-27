/**
 * check:portal-fields — licence keys and files on a subscription, and what the customer's portal shows of them (owner,
 * 29 Oct 2026 — src/lib/custom-fields/secure.ts, src/actions/portal-public.ts).
 *
 *   1. A secret is kept encrypted: never in the record as typed, the form holds only its last four, saved back it's
 *      kept, typed again it's replaced. Lists, exports and searches see only the mask.
 *   2. A file is checked by what it is, not its name; a record may name only a file its own person uploaded for that
 *      field.
 *   3. A reveal is recorded, by a person or a portal link.
 *   4. The portal shows only fields marked for it, never a restricted one; a secret masked, revealed only where the
 *      emailed code is asked for and given; files and invoice PDFs only of the customer's own.
 *
 * In a scratch workspace database built from the migrations, dropped after. The browser's cookies are a stub.
 *
 *   npm run check:portal-fields
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

const jar = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, parent: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined), set: (name: string, value: string) => void jar.set(name, value) }),
      headers: async () => new Headers(),
    };
  }
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};

const KEY = "M365-ABCD-EFGH-IJKL-9F2K";
const PDF = Buffer.from("%PDF-1.4\n% Zz licence certificate\n%%EOF\n");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname)) throw new Error("not a local database");
  const scratch = `${new URL(url).pathname.slice(1)}_portalfields`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
  let close: (() => Promise<void>) | null = null;
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = " ";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const R = require("../src/lib/custom-fields/rules") as typeof import("../src/lib/custom-fields/rules");
    const S = require("../src/lib/custom-fields/server") as typeof import("../src/lib/custom-fields/server");
    const X = require("../src/lib/custom-fields/secure") as typeof import("../src/lib/custom-fields/secure");
    const P = require("../src/actions/portal-public") as typeof import("../src/actions/portal-public");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const mail: string[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m.subject));

    // People, two customers, a subscription each.
    const boss = await db.user.create({ data: { name: "Zz Boss", email: "boss@zz-pf.invalid", passwordHash: "!", role: "ADMIN" }, select: { id: true } });
    const rep = await db.user.create({ data: { name: "Zz Rep", email: "rep@zz-pf.invalid", passwordHash: "!", role: "SALES" }, select: { id: true } });
    const item = await db.item.create({ data: { name: "Zz Microsoft 365", sku: "ZZ-M365", type: "SUBSCRIPTION", sellingPrice: 100, createdById: boss.id }, select: { id: true } });
    const company = async (name: string) => {
      const c = await db.company.create({ data: { name, normalizedName: name.toLowerCase(), relationshipType: "CLIENT", portalEnabled: true, createdById: boss.id }, select: { id: true } });
      const loc = await db.companyLocation.create({ data: { companyId: c.id, label: "Head office" }, select: { id: true } });
      const sub = await db.companyProduct.create({ data: { companyId: c.id, locationId: loc.id, itemId: item.id, addedByUserId: rep.id, quantity: 25, orderStatus: "FULFILLED", endDate: new Date("2027-03-31T00:00:00Z") }, select: { id: true } });
      return { id: c.id, sub: sub.id };
    };
    const acme = await company("Zz Acme");
    const other = await company("Zz Other");
    const def = (key: string, label: string, type: "TEXT" | "SECRET" | "FILE", extra: { restricted?: boolean; showInPortal?: boolean } = {}) =>
      db.customFieldDefinition.create({ data: { entity: "ORDER", key, label, type, restricted: !!extra.restricted, showInPortal: extra.showInPortal ?? null, createdById: boss.id } });
    await def("licence_key", "Licence key", "SECRET", { showInPortal: true });
    await def("certificate", "Certificate", "FILE", { showInPortal: true });
    await def("tenant", "Tenant", "TEXT", { showInPortal: true });
    await def("internal_note", "Internal note", "TEXT");
    await def("admin_password", "Admin password", "SECRET", { restricted: true, showInPortal: true });

    section("1. A secret is kept encrypted");
    ok("secret and file fields are offered on orders only", R.typesFor("ORDER").includes("SECRET") && R.typesFor("ORDER").includes("FILE") && !R.typesFor("COMPANY").includes("SECRET") && !R.typesFor("LEAD").includes("FILE"));
    const first = await S.prepareCustomFields({ entity: "ORDER", userId: boss.id, input: { licence_key: KEY, tenant: "zz.onmicrosoft.com" }, existing: {} });
    const stored = first.ok ? first.values.licence_key : undefined;
    ok("typed in, it's kept encrypted — the key is nowhere in what's stored", typeof stored === "string" && stored.startsWith("s1|") && !stored.includes(KEY) && !stored.includes("ABCD"), stored);
    await db.companyProduct.update({ where: { id: acme.sub }, data: { customFields: first.ok ? first.values : {} } });
    const values = await S.valuesFor("ORDER", acme.sub);
    const defs = await S.definitionsFor("ORDER");
    const keyDef = defs.find((d) => d.key === "licence_key")!;
    const form = R.formValues(defs, values);
    ok("  the form holds only its last four, never the cipher", form.licence_key === "s1|9F2K|", form.licence_key);
    ok("  shown, listed and exported as •••• 9F2K", R.formatValue(keyDef, values.licence_key) === "•••• 9F2K" && R.exportValue(keyDef, values.licence_key) === "•••• 9F2K");
    const kept = await S.prepareCustomFields({ entity: "ORDER", userId: boss.id, input: { licence_key: form.licence_key }, existing: values });
    ok("  saved back as the form holds it: kept exactly, nothing changed", kept.ok && kept.values.licence_key === values.licence_key && kept.changed.length === 0, kept);
    const replaced = await S.prepareCustomFields({ entity: "ORDER", userId: boss.id, input: { licence_key: "NEW-KEY-0000-7Q1Z" }, existing: values });
    ok("  typed again: replaced, and encrypted too", replaced.ok && R.secretTail(replaced.values.licence_key) === "7Q1Z" && replaced.values.licence_key !== values.licence_key && !String(replaced.values.licence_key).includes("NEW-KEY"));
    const forged = await S.prepareCustomFields({ entity: "ORDER", userId: boss.id, input: { licence_key: "s1|AAAA|" }, existing: {} });
    ok("  a made-up stored value for a record with none is refused", !forged.ok);
    const search = await S.customSearchWhere("ORDER", boss.id, "ABCD");
    ok("  a search never looks inside a secret", !JSON.stringify(search).includes("licence_key"));

    section("2. Files");
    const exe = await X.keepUploadedFile({ entity: "ORDER", fieldKey: "certificate", name: "certificate.pdf", bytes: Buffer.from("MZ\x90\x00 not a pdf"), userId: rep.id });
    ok("a program named .pdf is refused — checked by what it is", !exe.ok, exe);
    const big = await X.keepUploadedFile({ entity: "ORDER", fieldKey: "certificate", name: "big.pdf", bytes: Buffer.concat([PDF, Buffer.alloc(R.CUSTOM_FIELD_LIMITS.fileBytes)]), userId: rep.id });
    ok("  over 5 MB refused", !big.ok);
    const wrongField = await X.keepUploadedFile({ entity: "ORDER", fieldKey: "tenant", name: "x.pdf", bytes: PDF, userId: rep.id });
    ok("  a field that isn't a file field refused", !wrongField.ok);
    const up = await X.keepUploadedFile({ entity: "ORDER", fieldKey: "certificate", name: "Zz licence certificate", bytes: PDF, userId: rep.id });
    ok("a PDF is kept, named .pdf", up.ok && up.name === "Zz licence certificate.pdf", up);
    const value = up.ok ? up.value : "";
    const byOther = await S.prepareCustomFields({ entity: "ORDER", userId: boss.id, input: { certificate: value }, existing: {} });
    ok("  a record can't name a file somebody else uploaded", !byOther.ok, byOther);
    const byRep = await S.prepareCustomFields({ entity: "ORDER", userId: rep.id, input: { certificate: value }, existing: values });
    ok("  the person who uploaded it can", byRep.ok);
    if (byRep.ok) await db.companyProduct.update({ where: { id: acme.sub }, data: { customFields: byRep.values } });
    const delivered = await S.saveCustomFields("ORDER", acme.sub, rep.id, { tenant: "changed.onmicrosoft.com" }, { only: ["licence_key", "certificate"] });
    ok("a fulfilled order's save takes only its keys and files — the rest stays", delivered.ok && (await S.valuesFor("ORDER", acme.sub)).tenant === "zz.onmicrosoft.com", delivered);

    section("3. A reveal is recorded");
    const plain = await X.revealFieldSecret({ entity: "ORDER", recordId: acme.sub, fieldKey: "licence_key", by: { userId: boss.id } });
    ok("revealed in the clear", plain === KEY, plain);
    ok("  and recorded, by whom", (await db.customFieldReveal.count({ where: { recordId: acme.sub, byUserId: boss.id } })) === 1);
    ok("  a field that isn't a secret reveals nothing", (await X.revealFieldSecret({ entity: "ORDER", recordId: acme.sub, fieldKey: "tenant", by: { userId: boss.id } })) === null);

    section("4. The portal");
    await db.portalSettings.create({ data: { id: "global", enabled: true, access: "SELECTED", showSubscriptions: true, showInvoices: true } });
    const login = await db.portalLogin.create({ data: { token: randomBytes(24).toString("base64url"), companyId: acme.id, personName: "Zz Priya", personEmail: "priya@zz-pf.invalid", createdById: boss.id }, select: { id: true, token: true } });
    const subs = await P.portalSubscriptions(login.token);
    const fields = subs.find((s) => s.id === acme.sub)?.fields ?? [];
    ok("only the fields marked for the portal: licence key, certificate, tenant", fields.map((f) => f.key).sort().join() === "certificate,licence_key,tenant", fields);
    ok("  never the restricted one, nor one not marked", !fields.some((f) => f.key === "admin_password" || f.key === "internal_note"));
    const secretField = fields.find((f) => f.key === "licence_key");
    ok("  the key masked, and no Reveal while the portal asks for no code", secretField?.kind === "secret" && secretField.masked === "•••• 9F2K" && !secretField.canReveal, secretField);
    ok("  nowhere in the page's data in the clear", !JSON.stringify(subs).includes(KEY));
    const noCode = await P.portalRevealSecret(login.token, acme.sub, "licence_key");
    ok("  revealing it by hand is refused without the code", !noCode.ok, noCode);
    ok("  the certificate downloads; another company's file doesn't", (await P.portalFileAllowed(login.token, up.ok ? R.fileRef(value)!.id : "")) && !(await P.portalFileAllowed(login.token, "zzzzzzzzzzzzzzzzzzzzzzzz")));

    await db.portalSettings.update({ where: { id: "global" }, data: { requireCode: true } });
    ok("with the code asked for, an unconfirmed browser sees no subscriptions at all", (await P.portalSubscriptions(login.token)).length === 0);
    await P.sendPortalCode(login.token);
    // Eight digits since security audit round two (R2-20).
    const code = /^(\d{8})/.exec(mail.at(-1) ?? "")?.[1] ?? "";
    ok("  the code given", (await P.verifyPortalCode(login.token, code)).ok);
    const coded = (await P.portalSubscriptions(login.token)).find((s) => s.id === acme.sub)?.fields.find((f) => f.key === "licence_key");
    ok("  now the key offers Reveal", coded?.kind === "secret" && coded.canReveal);
    const shown = await P.portalRevealSecret(login.token, acme.sub, "licence_key");
    ok("  revealed in the clear", shown.ok && shown.data.secret === KEY, shown);
    ok("  recorded against the portal link", (await db.customFieldReveal.count({ where: { recordId: acme.sub, byPortalLogin: login.id } })) === 1);
    const theirs = await P.portalRevealSecret(login.token, other.sub, "licence_key");
    ok("  another company's subscription refused", !theirs.ok);
    const restricted = await P.portalRevealSecret(login.token, acme.sub, "admin_password");
    ok("  a restricted field refused, even marked for the portal", !restricted.ok);

    const mine = await db.tradeDocument.create({ data: { docType: "INVOICE", direction: "SALES", docNumber: "ZZ-INV-1", companyId: acme.id, status: "ISSUED", issueDate: new Date(), createdById: boss.id }, select: { id: true } }).catch((e: unknown) => ({ error: String(e) }));
    if ("id" in mine) {
      const draft = await db.tradeDocument.create({ data: { docType: "INVOICE", direction: "SALES", docNumber: "ZZ-DRAFT-1", companyId: acme.id, status: "DRAFT", issueDate: new Date(), createdById: boss.id }, select: { id: true } });
      const theirsInv = await db.tradeDocument.create({ data: { docType: "INVOICE", direction: "SALES", docNumber: "ZZ-INV-2", companyId: other.id, status: "ISSUED", issueDate: new Date(), createdById: boss.id }, select: { id: true } });
      ok("an invoice's PDF: their issued one yes; a draft or another company's no", (await P.portalInvoiceAllowed(login.token, mine.id)) && !(await P.portalInvoiceAllowed(login.token, draft.id)) && !(await P.portalInvoiceAllowed(login.token, theirsInv.id)));
    } else {
      ok("an invoice to try the PDF check on", false, mine.error);
    }
  } finally {
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }
  console.log(failures === 0 ? `\nAll ${passes} portal field checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
