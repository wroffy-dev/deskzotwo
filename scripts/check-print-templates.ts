/**
 * check:print-templates — how each kind of document looks on paper (owner, 30 Oct 2026; Settings › Document templates,
 * src/lib/documents/print-template.ts, src/lib/documents/print-template-server.ts, src/actions/print-template.ts and the
 * print page, src/app/(print)/documents/[id]/print/page.tsx).
 *
 *   · The options: the schema's defaults are today's page, a bad value costs only itself, an unsaved preview's
 *     options survive their trip through the address, and what GST requires on a type can't be switched off there.
 *   · The built-in Standard is today's page, and a template of defaults prints exactly what it does.
 *   · One default a type, whatever is set; a deleted default falls back to the built-in.
 *   · Somebody without settings.manage is refused by every action.
 *   · On the paper: a template hiding the bank details and the HSN column prints neither on a proforma, while a tax
 *     invoice keeps its HSN column, our GSTIN, reverse charge, title and e-invoice QR whatever its template says.
 *   · `?draft=` previews for somebody who may change templates, and is ignored for anybody else.
 *
 * Against the database in DATABASE_URL (the copy, never a workspace's own). Everything it makes is named ZZPRINT_TPL
 * and removed in a `finally`; templates that were there before are left as they were, defaults included.
 *
 *   npm run check:print-templates
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";
import { gstinCheckCharacter } from "../src/lib/gst-engine";
import { renderHtml } from "./lib/render-html";
import {
  DEFAULT_ACCENT,
  DEFAULT_PRINT_OPTIONS,
  PRINT_SHOW_KEYS,
  decodePrintDraft,
  effectivePrintOptions,
  encodePrintDraft,
  optionsFor,
  printOptionsSchema,
  resolvePrintOptions,
  type PrintOptions,
} from "../src/lib/documents/print-template";

const TAG = "ZZPRINT_TPL";
const MAIL = "@zzprint-tpl.invalid";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The page and the actions need a session: whoever `actor` names, as the other suites substitute one. */
let actor: { id: string; name: string; email: string; role: string } | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      notFound: () => { throw new Error("NOT_FOUND"); },
      redirect: () => {},
      useRouter: () => ({ push() {}, refresh() {}, replace() {} }),
      usePathname: () => "/documents/x/print",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return {
      requireUser: async () => {
        if (!actor) throw new Error("Unauthorized");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

/** Options with these switches off. */
const hiding = (...keys: (typeof PRINT_SHOW_KEYS)[number][]): PrintOptions => ({
  ...structuredClone(DEFAULT_PRINT_OPTIONS),
  show: { ...DEFAULT_PRINT_OPTIONS.show, ...Object.fromEntries(keys.map((k) => [k, false])) },
});

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  await db.documentPrintTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companies.map((c) => c.id) } } });
  await db.organisationBankAccount.deleteMany({ where: { label: { startsWith: TAG } } });
  await db.company.deleteMany({ where: { id: { in: companies.map((c) => c.id) } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  section("The options");
  const blank = resolvePrintOptions(undefined);
  ok("nothing stored is the built-in Standard: today's page", same(blank, DEFAULT_PRINT_OPTIONS) && blank.layout === "standard" && blank.paper === "A4" && blank.font === "sans" && blank.accentColor === DEFAULT_ACCENT);
  ok("  every part shown, every label and text blank", PRINT_SHOW_KEYS.every((k) => blank.show[k]) && Object.values(blank.labels).every((v) => v === "") && !blank.title && !blank.footerText && !blank.defaultTerms);
  ok(
    "a colour that isn't #RRGGBB, an unknown layout, an overlong label are refused on save",
    ["red; background:url(x)", "#12345", "javascript:alert(1)"].every((accentColor) => !printOptionsSchema.safeParse({ accentColor }).success) &&
      !printOptionsSchema.safeParse({ layout: "fancy" }).success &&
      !printOptionsSchema.safeParse({ labels: { billTo: "x".repeat(41) } }).success,
  );
  const mixed = resolvePrintOptions({ accentColor: "url(javascript:x)", layout: "modern", font: "comic", show: { hsnColumn: false, logo: "no" }, labels: { terms: "T&C", billTo: 7 } });
  ok(
    "  a stored template keeps its good values and loses only its bad ones",
    mixed.layout === "modern" && mixed.accentColor === DEFAULT_ACCENT && mixed.font === "sans" && !mixed.show.hsnColumn && mixed.show.logo && mixed.labels.terms === "T&C" && mixed.labels.billTo === "",
    mixed,
  );
  ok("  and nothing at all, or not an object, is today's page", same(resolvePrintOptions("junk"), DEFAULT_PRINT_OPTIONS) && same(resolvePrintOptions(null), DEFAULT_PRINT_OPTIONS));
  const rich = { ...hiding("bankDetails"), layout: "modern" as const, accentColor: "#0a7d5a", footerText: "धन्यवाद — thank you", labels: { ...DEFAULT_PRINT_OPTIONS.labels, billTo: "Customer" } };
  ok("a preview's options come back from the address exactly, Hindi and all", same(decodePrintDraft(encodePrintDraft(rich)), rich));
  ok(
    "  and anything else in its place is nothing",
    decodePrintDraft("not base64!") === null && decodePrintDraft("") === null && decodePrintDraft(Buffer.from(JSON.stringify({ accentColor: "red" })).toString("base64url")) === null,
  );

  const invoice = optionsFor("INVOICE");
  const lockedOn = (t: Parameters<typeof optionsFor>[0]): string[] => optionsFor(t).switches.filter((s) => s.locked).map((s) => s.key).sort();
  ok(
    "a tax invoice can't hide our address and GSTIN, HSN, unit, tax rates, place of supply, reverse charge, the e-invoice QR or the signatory",
    same(lockedOn("INVOICE"), ["companyAddress", "einvoiceQr", "forCompany", "hsnColumn", "lineTaxPercent", "ourGstin", "placeOfSupply", "quantityUnit", "reverseCharge"]),
    lockedOn("INVOICE"),
  );
  ok("  or retitle itself — a tax invoice, or a bill of supply, says which it is", invoice.titleLocked !== null);
  ok("  but its bank details, words and logo are the business's", ["bankDetails", "amountInWords", "logo", "contact", "upiQr"].every((k) => invoice.switches.find((s) => s.key === k)?.locked === null));
  ok("a credit note keeps our GSTIN, tax rates, e-invoice QR and signatory", ["ourGstin", "lineTaxPercent", "einvoiceQr", "forCompany"].every((k) => lockedOn("CREDIT_NOTE").includes(k)), lockedOn("CREDIT_NOTE"));
  ok("a delivery challan keeps our GSTIN, HSN, tax rates and place of supply", ["ourGstin", "hsnColumn", "lineTaxPercent", "placeOfSupply"].every((k) => lockedOn("DELIVERY_CHALLAN").includes(k)), lockedOn("DELIVERY_CHALLAN"));
  ok(
    "a proposal, proforma, purchase order or vendor bill — none a GST document — may switch off anything, and be retitled",
    (["PROPOSAL", "PROFORMA", "PURCHASE_ORDER", "BILL"] as const).every((t) => lockedOn(t).length === 0 && optionsFor(t).titleLocked === null),
  );
  ok(
    "  and isn't offered what it never prints: no bank or UPI code on a purchase, no e-invoice block without an IRN",
    !optionsFor("PURCHASE_ORDER").switches.some((s) => s.key === "bankDetails" || s.key === "upiQr") && !optionsFor("PROPOSAL").switches.some((s) => s.key === "einvoiceQr" || s.key === "upiQr"),
  );
  const forced = effectivePrintOptions({ ...hiding(...PRINT_SHOW_KEYS), title: "Invoice" }, "INVOICE");
  ok(
    "whatever a template says, a tax invoice prints what the law requires, and only that is forced",
    lockedOn("INVOICE").every((k) => forced.show[k as keyof typeof forced.show]) && !forced.show.bankDetails && !forced.show.logo && forced.title === "",
  );

  // ── The database ───────────────────────────────────────────────────────────────────────────────
  const before = await db.documentPrintTemplate.findMany({ select: { id: true, docType: true, isDefault: true } });
  await cleanup();
  try {
    const mk = (name: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `${TAG} ${name}`,
          email: `${name.toLowerCase()}${MAIL}`,
          role: "SALES",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const admin = await mk("Admin", { "settings.manage": true, "documents.view": true, "companies.viewAll": true });
    const viewer = await mk("Viewer", { "settings.manage": false, "documents.view": true, "companies.viewAll": true });
    const as = (u: { id: string; name: string; email: string; role: string }) => {
      actor = { id: u.id, name: u.name, email: u.email, role: u.role };
    };

    const actions = await import("../src/actions/print-template");
    const { printTemplateFor } = await import("../src/lib/documents/print-template-server");
    const PrintPage = (await import("../src/app/(print)/documents/[id]/print/page")).default;

    // ── Fixtures: a proforma and a tax invoice, each paying into a bank account of their own ────
    const bank = await db.organisationBankAccount.create({ data: { label: `${TAG} HDFC`, bankName: "HDFC Bank", accountNumber: "50200099887766", ifsc: "HDFC0000999", active: true } });
    const company = await db.company.create({ data: { name: `${TAG} Juniper Pharma`, normalizedName: `${TAG.toLowerCase()} juniper pharma`, relationshipType: "CLIENT", createdById: admin.id, ownerUserId: admin.id } });
    const ours = `27ZZPTP0000Z1Z${gstinCheckCharacter("27ZZPTP0000Z1Z")}`;
    const run = Date.now().toString(36).toUpperCase();
    const doc = (docType: "INVOICE" | "PROFORMA", extra: Record<string, unknown> = {}) =>
      db.tradeDocument.create({
        data: {
          docType, direction: "SALES", status: "ISSUED", docNumber: `ZZTPL/${docType.slice(0, 3)}/${run}`, companyId: company.id, createdById: admin.id,
          issueDate: new Date("2026-10-01T00:00:00Z"), placeOfSupplyCode: "27", sellerGstin: ours, bankAccountId: bank.id,
          subtotal: 1000, taxableValue: 1000, igstAmount: 180, total: 1180,
          lines: { create: [{ name: "Zz Laptop stand", quantity: 1, unit: "Nos", unitPrice: 1000, hsnCode: "8473", taxRatePercent: 18, taxableValue: 1000, igstAmount: 180, lineTotal: 1180 }] },
          ...extra,
        },
        select: { id: true },
      });
    const proforma = await doc("PROFORMA");
    const taxInvoice = await doc("INVOICE", { irn: `zz${run.toLowerCase()}${"0".repeat(48)}`.slice(0, 64), ackNo: "112610000000001", ackDate: new Date("2026-10-01T10:00:00Z"), signedQrCode: "zz.signed.qr", einvoiceStatus: "GENERATED" });
    const render = (id: string, sp: Record<string, string> = {}) => renderHtml(PrintPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ embed: "1", ...sp }) }));

    as(admin);
    const proformaDefault = (await db.documentPrintTemplate.findFirst({ where: { docType: "PROFORMA", isDefault: true }, select: { id: true } }))?.id ?? null;
    // From the built-in, whatever this database had: put back in the finally.
    await actions.setDefaultPrintTemplate({ docType: "PROFORMA", id: null });
    await actions.setDefaultPrintTemplate({ docType: "INVOICE", id: null });

    section("The built-in Standard");
    const builtIn = await printTemplateFor("PROFORMA");
    ok("a type with no default prints the built-in Standard, with today's options", builtIn.builtIn && builtIn.id === null && same(builtIn.options, DEFAULT_PRINT_OPTIONS));
    const today = await render(proforma.id);
    ok("  which prints the page as it always was: bank details, HSN column, the footer line", today.includes("Bank details") && today.includes("HSN/SAC") && today.includes("This is a computer-generated proforma invoice."), today.length);
    const plain = await actions.createPrintTemplate({ name: `${TAG} Plain`, docType: "PROFORMA", layout: "standard", makeDefault: true });
    ok("a template made from Standard can be the default", plain.ok);
    if (!plain.ok) return;
    const viaTemplate = await render(proforma.id);
    ok("  and prints exactly the built-in's HTML, byte for byte", viaTemplate === today, { built: today.length, template: viaTemplate.length });

    section("One default a type");
    const second = await actions.createPrintTemplate({ name: `${TAG} Second`, docType: "PROFORMA", layout: "compact" });
    if (!second.ok) return void ok("a second template is made", false, second.error);
    const defaults = async () => (await db.documentPrintTemplate.findMany({ where: { docType: "PROFORMA", isDefault: true }, select: { id: true } })).map((r) => r.id);
    ok("a new template isn't the default unless asked", same(await defaults(), [plain.data.id]));
    await actions.setDefaultPrintTemplate({ docType: "PROFORMA", id: second.data.id });
    ok("setting another default leaves exactly one: the new one", same(await defaults(), [second.data.id]));
    await actions.setDefaultPrintTemplate({ docType: "PROFORMA", id: plain.data.id });
    ok("  and back again", same(await defaults(), [plain.data.id]));
    const sneaked = await db.documentPrintTemplate.update({ where: { id: second.data.id }, data: { isDefault: true } }).then(() => true, () => false);
    ok("  the database itself refuses a second default (document_print_templates_one_default)", !sneaked);
    const wrongType = await actions.setDefaultPrintTemplate({ docType: "INVOICE", id: plain.data.id });
    ok("  a template can't be the default of a type it isn't", !wrongType.ok);
    await actions.setDefaultPrintTemplate({ docType: "PROFORMA", id: null });
    ok("  and the built-in can be the default again, with every template kept", (await defaults()).length === 0 && (await printTemplateFor("PROFORMA")).builtIn);

    section("A deleted default falls back to the built-in");
    await actions.setDefaultPrintTemplate({ docType: "PROFORMA", id: second.data.id });
    ok("the compact one is the default and prints", (await printTemplateFor("PROFORMA")).id === second.data.id && (await render(proforma.id)).includes("px-1.5 py-1"));
    const deleted = await actions.deletePrintTemplate(second.data.id);
    ok("deleting it says it was the default", deleted.ok && deleted.data.wasDefault);
    const after = await printTemplateFor("PROFORMA");
    ok("  and the type prints the built-in Standard again — not the other template", after.builtIn && same(await defaults(), []) && (await render(proforma.id)) === today);

    section("Without settings.manage, every action is refused");
    const copy = await actions.duplicatePrintTemplate(plain.data.id);
    ok("(a copy to try them on)", copy.ok && copy.data.name === `${TAG} Plain (copy)`, copy);
    as(viewer);
    const refusals = {
      list: (await actions.listPrintTemplates()) === null,
      get: (await actions.getPrintTemplate(plain.data.id)) === null,
      create: !(await actions.createPrintTemplate({ name: `${TAG} Sneaky`, docType: "PROFORMA" })).ok,
      update: !(await actions.updatePrintTemplate({ id: plain.data.id, name: `${TAG} Renamed`, options: hiding("bankDetails") })).ok,
      setDefault: !(await actions.setDefaultPrintTemplate({ docType: "PROFORMA", id: plain.data.id })).ok,
      duplicate: !(await actions.duplicatePrintTemplate(plain.data.id)).ok,
      delete: copy.ok ? !(await actions.deletePrintTemplate(copy.data.id)).ok : false,
    };
    ok("list, open, create, change, set default, duplicate and delete all refuse", Object.values(refusals).every(Boolean), refusals);
    const untouched = await db.documentPrintTemplate.findUnique({ where: { id: plain.data.id }, select: { name: true, isDefault: true } });
    ok("  and nothing changed", untouched?.name === `${TAG} Plain` && !untouched.isDefault && (await db.documentPrintTemplate.count({ where: { name: { startsWith: TAG } } })) === 2);
    actor = null;
    ok("  nor without anybody signed in", await actions.listPrintTemplates().then(() => false, () => true));
    as(admin);

    section("On the paper");
    const bare = await actions.updatePrintTemplate({ id: plain.data.id, name: `${TAG} Plain`, options: hiding("bankDetails", "hsnColumn") });
    ok("a template hiding the bank details and the HSN column saves", bare.ok);
    const bareProforma = await render(proforma.id, { template: plain.data.id });
    ok("  a proforma printed with it has neither", !bareProforma.includes("Bank details") && !bareProforma.includes("HSN/SAC") && !bareProforma.includes("8473") && bareProforma.includes("Zz Laptop stand"));
    ok("  while its default still prints both", (await render(proforma.id)).includes("Bank details"));
    const rejected = await actions.updatePrintTemplate({ id: plain.data.id, name: `${TAG} Plain`, options: { ...DEFAULT_PRINT_OPTIONS, accentColor: "red;}body{display:none" } });
    ok("  a colour that isn't one is refused on save", !rejected.ok);

    const strict = await actions.createPrintTemplate({ name: `${TAG} Bare invoice`, docType: "INVOICE", layout: "standard" });
    if (!strict.ok) return void ok("an invoice template is made", false, strict.error);
    await actions.updatePrintTemplate({
      id: strict.data.id,
      name: `${TAG} Bare invoice`,
      options: { ...hiding("hsnColumn", "ourGstin", "companyAddress", "reverseCharge", "placeOfSupply", "einvoiceQr", "lineTaxPercent", "forCompany", "quantityUnit", "bankDetails"), title: "ZZ Not an invoice" },
    });
    const taxed = await render(taxInvoice.id, { template: strict.data.id });
    ok("a tax invoice printed with a template hiding everything still has its HSN column", taxed.includes("HSN/SAC") && taxed.includes("8473"));
    ok("  our GSTIN in the letterhead", new RegExp(`GSTIN:\\s*${ours}`).test(taxed));
    ok("  place of supply and reverse charge", taxed.includes("Place of supply") && taxed.includes("Reverse charge"));
    ok("  the tax rate and the unit", taxed.includes("18%") && taxed.includes("1 Nos"));
    ok("  the signed e-invoice QR, and the signatory", taxed.includes("Signed e-invoice QR code") && taxed.includes("IRN:") && /For\s/.test(taxed));
    ok("  and its own title, not the template's", !taxed.includes("ZZ Not an invoice") && /Tax invoice/i.test(taxed));
    ok("  but not the bank details, which are the business's to leave off", !taxed.includes("Bank details"));
    ok("a template of another type, asked for by name, is ignored", (await render(taxInvoice.id, { template: plain.data.id })).includes("Bank details"));

    const styled = await actions.updatePrintTemplate({
      id: plain.data.id,
      name: `${TAG} Plain`,
      options: { ...DEFAULT_PRINT_OPTIONS, layout: "modern", accentColor: "#0A7D5A", paper: "Letter", font: "serif", title: "Quotation for payment", headerNote: "ZZ CIN U72900", footerText: "ZZ Thank you for your business.", labels: { ...DEFAULT_PRINT_OPTIONS.labels, billTo: "ZZ Customer", signatory: "ZZ Director" } },
    });
    ok("a Modern, green, Letter, serif template saves", styled.ok);
    const modern = await render(proforma.id, { template: plain.data.id });
    ok("  the band and the table header are its colour, kept when printing", (modern.match(/background-color:#0a7d5a/g) ?? []).length === 2 && modern.includes("print-color-adjust:exact"));
    ok("  on Letter, in serif", modern.includes("@page { size: letter") && modern.includes("font-serif"));
    ok("  with its own title, header line, footer and labels", ["Quotation for payment", "ZZ CIN U72900", "ZZ Thank you for your business.", "ZZ Customer", "ZZ Director"].every((t) => modern.includes(t)) && !modern.includes("computer-generated"));

    section("The editor's preview (?draft=)");
    const draft = encodePrintDraft({ ...hiding("bankDetails"), layout: "compact" });
    as(viewer);
    const viewerPlain = await render(proforma.id);
    ok("somebody without settings.manage gets the page as it is, draft or no draft", viewerPlain.includes("Bank details") && (await render(proforma.id, { draft })) === viewerPlain);
    as(admin);
    const previewed = await render(proforma.id, { draft });
    ok("somebody who may change templates sees the unsaved options", !previewed.includes("Bank details") && previewed.includes("px-1.5 py-1"));
    ok("  and a draft that isn't one is ignored", (await render(proforma.id, { draft: "zz-not-a-draft" })) === (await render(proforma.id)));
    const lockedDraft = await render(taxInvoice.id, { draft: encodePrintDraft(hiding("hsnColumn", "ourGstin")) });
    ok("  and can't hide what a tax invoice must carry either", lockedDraft.includes("HSN/SAC") && new RegExp(`GSTIN:\\s*${ours}`).test(lockedDraft));

    section("The print bar");
    const bar = await render(proforma.id, { embed: "0" });
    ok("with several templates for the type, the print bar offers a Template picker", bar.includes('aria-label="Template"') && bar.includes(`${TAG} Plain`) && bar.includes("Standard (built in) (default)"));
    if (proformaDefault) await actions.setDefaultPrintTemplate({ docType: "PROFORMA", id: proformaDefault });
  } finally {
    actor = null;
    await cleanup();
    // What was there before: its defaults as they were.
    for (const row of before.filter((r) => r.isDefault)) {
      await db.documentPrintTemplate.updateMany({ where: { docType: row.docType, isDefault: true, id: { not: row.id } }, data: { isDefault: false } }).catch(() => {});
      await db.documentPrintTemplate.update({ where: { id: row.id }, data: { isDefault: true } }).catch(() => {});
    }
    const left = await db.documentPrintTemplate.count({ where: { name: { startsWith: TAG } } });
    const users = await db.user.count({ where: { email: { endsWith: MAIL } } });
    ok("the fixture cleaned up after itself", left === 0 && users === 0, { templates: left, users });
  }
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? "\nAll print template checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
