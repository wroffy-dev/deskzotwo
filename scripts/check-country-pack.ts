/**
 * That a workspace outside India gets its own country pack (owner, 30 Oct 2026; src/lib/country-pack.ts):
 * its currency, one tax by its own name, and none of India's GSTIN, place of supply, HSN or TDS — while an
 * Indian workspace's quotes and invoices stay exactly as they were.
 *
 * The real pages are rendered — the new-document form and the printable copy — for the same workspace
 * read once as the UAE and once as India, and their HTML is read back (as check:document-print does).
 * A document is raised through the real action, so the server's rules are checked too: a UAE
 * document is not refused for want of a GSTIN, and is written in dirhams.
 *
 *   npm run check:country-pack
 */
import "dotenv/config";
import Module from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "../src/lib/db";
import { legacyTenant } from "../src/lib/tenancy/registry";
import { runAsTenant } from "../src/lib/tenancy/resolve";
import type { Tenant } from "../src/lib/tenancy/state";

const TAG = "ZZPROBE_PACK";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};

/** A session, the cache and navigation, substituted as the other page-rendering suites do. */
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    return {
      requireUser: async () => ({ id: actorId, name: "Probe" }),
      currentUser: async () => ({ id: actorId, name: "Probe" }),
    };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => { throw new Error("NOT_FOUND_CALLED"); },
      redirect: () => {},
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      usePathname: () => "/documents/new",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

/** Awaits nested async server components, which renderToStaticMarkup cannot (see check-item-import). */
async function resolveAsync(node: unknown): Promise<unknown> {
  const { isValidElement, cloneElement } = await import("react");
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as React.ReactElement<{ children?: unknown }>;
  const type = el.type as { constructor?: { name?: string } } & ((props: unknown) => unknown);
  if (typeof type === "function" && type.constructor?.name === "AsyncFunction") {
    return resolveAsync(await type(el.props));
  }
  if (el.props && "children" in el.props && el.props.children !== undefined) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...kids) : cloneElement(el, undefined, kids as React.ReactNode);
  }
  return el;
}

async function main() {
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;
  const home = await legacyTenant();
  if (!home) throw new Error("no workspace to act as");
  // The same workspace and database, read as the UAE's — only its country decides the pack.
  const uae: Tenant = { ...home, country: "AE" };
  const india: Tenant = { ...home, country: "IN" };

  const { createTradeDocument } = await import("../src/actions/trade-document");
  const PrintPage = (await import("../src/app/(print)/documents/[id]/print/page")).default;
  const NewDocumentPage = (await import("../src/app/(dashboard)/documents/new/page")).default;

  const printed = async (id: string) => {
    const element = await PrintPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
    return renderToStaticMarkup(element as React.ReactElement);
  };
  const newInvoiceForm = async (companyId: string) => {
    const element = await NewDocumentPage({ searchParams: Promise.resolve({ type: "INVOICE", companyId }) });
    return renderToStaticMarkup((await resolveAsync(element)) as React.ReactElement);
  };

  // The financial year (owner, 14 Nov 2026: "January 1 to December 31 is the financial year of uae").
  const fy = await import("../src/lib/india-time");
  const numbering = await import("../src/lib/gst-engine");
  const metrics = await import("../src/lib/targets/metrics");
  const july = new Date("2026-07-15T08:00:00Z");
  const feb = new Date("2027-02-10T08:00:00Z");
  await runAsTenant(uae, async () => {
    ok("UAE: the financial year is the calendar year", JSON.stringify(fy.financialYearBounds(july)) === JSON.stringify({ from: "2026-01-01", to: "2026-12-31", label: "2026" }), fy.financialYearBounds(july));
    ok("  February is in the year it falls in", fy.financialYearStartOf(feb) === 2027);
    ok("  numbering's {FY} and {FY2}: 2026 and 26", numbering.financialYearOf(july) === "2026" && numbering.shortFinancialYear(july) === "26");
    ok("  a target's Q1 is January to March", metrics.quarterWindow(2026, 1).fromDate === "2026-01-01" && metrics.quarterWindow(2026, 1).toDate === "2026-03-31");
  });
  await runAsTenant(india, async () => {
    ok("India: still April to March", JSON.stringify(fy.financialYearBounds(july)) === JSON.stringify({ from: "2026-04-01", to: "2027-03-31", label: "2026-27" }) && fy.financialYearStartOf(feb) === 2026, fy.financialYearBounds(july));
    ok("  numbering's {FY} and {FY2}: 2026-27 and 2627", numbering.financialYearOf(july) === "2026-27" && numbering.shortFinancialYear(july) === "2627");
  });

  const created: { documents: string[]; companies: string[] } = { documents: [], companies: [] };
  try {
    const company = await db.company.create({
      data: {
        name: `${TAG} Gulf Traders`,
        normalizedName: `${TAG.toLowerCase()} gulf traders`,
        createdById: actorId,
        ownerUserId: actorId,
        locations: {
          create: { label: "Head office", address: "Office 1204, Bay Square", city: "Dubai", country: "United Arab Emirates", gstTreatment: "UNREGISTERED", isPrimary: true },
        },
      },
      select: { id: true },
    });
    created.companies.push(company.id);
    const address = { attention: "", line1: "Office 1204, Bay Square", line2: "", city: "Dubai", state: "", stateCode: "", pincode: "", country: "United Arab Emirates", phone: "" };
    const input = (extra: Record<string, unknown>) => ({
      docType: "INVOICE",
      companyId: company.id,
      issueDate: new Date().toISOString().slice(0, 10),
      billing: address,
      shipping: address,
      shippingSameAsBilling: true,
      lines: [{ name: `${TAG} Microsoft 365 Business Premium`, quantity: 10, unitPrice: 100, discountValue: 0, taxRatePercent: 5 }],
      ...extra,
    });

    console.log("\n— A UAE workspace —\n");
    await runAsTenant(uae, async () => {
      // A registered treatment with no GSTIN: refused in India, nothing to ask for in the UAE.
      const made = await createTradeDocument(input({ gstTreatment: "REGISTERED_REGULAR", placeOfSupplyCode: "" }));
      ok("An invoice is raised without a GSTIN or place of supply", made.ok, made.ok ? "" : made.error);
      if (!made.ok) return;
      created.documents.push(made.data.id);
      const doc = await db.tradeDocument.findUniqueOrThrow({ where: { id: made.data.id }, select: { currency: true, cgstAmount: true, sgstAmount: true, igstAmount: true, total: true } });
      ok("  written in dirhams", doc.currency === "AED", doc.currency);
      ok("  with one tax and no state split: 5% of 1,000", Number(doc.igstAmount) === 50 && Number(doc.cgstAmount) === 0 && Number(doc.sgstAmount) === 0, `${doc.igstAmount}`);

      const paper = await printed(made.data.id);
      ok("Its printed copy names the tax VAT", paper.includes(">VAT<"));
      ok("  shows dirhams", paper.includes("AED"));
      ok("  and prints no GSTIN, IGST, place of supply or HSN", !/GSTIN|IGST|CGST|Place of supply|HSN/.test(paper), (paper.match(/GSTIN|IGST|CGST|Place of supply|HSN/g) ?? []).join(", "));
      ok("  nor a rupee conversion", !paper.includes("(INR)") && !paper.includes("₹"));

      const form = await newInvoiceForm(company.id);
      ok("The new-invoice form offers VAT 5%", form.includes("VAT 5%"));
      ok("  and asks for no GST treatment, GSTIN, place of supply, HSN or TDS", !/GST treatment|Place of supply|HSN\/SAC|No TDS\/TCS|GSTIN/.test(form), (form.match(/GST treatment|Place of supply|HSN\/SAC|No TDS\/TCS|GSTIN/g) ?? []).join(", "));
      ok("  nor warns that it will be taxed as IGST", !form.includes("inter-state (IGST)"));
    });

    console.log("\n— The same workspace as India's —\n");
    await runAsTenant(india, async () => {
      const refused = await createTradeDocument(input({ gstTreatment: "REGISTERED_REGULAR", placeOfSupplyCode: "" }));
      ok("A registered party without a GSTIN is still refused", !refused.ok);
      if (refused.ok) created.documents.push(refused.data.id);
      const made = await createTradeDocument(input({ gstTreatment: "OVERSEAS", placeOfSupplyCode: "96" }));
      ok("An export invoice is raised", made.ok, made.ok ? "" : made.error);
      if (!made.ok) return;
      created.documents.push(made.data.id);
      const doc = await db.tradeDocument.findUniqueOrThrow({ where: { id: made.data.id }, select: { currency: true } });
      ok("  in rupees", doc.currency === "INR", doc.currency);
      const paper = await printed(made.data.id);
      ok("Its printed copy still carries GSTIN and IGST", paper.includes("GSTIN") && paper.includes("IGST"));
      const form = await newInvoiceForm(company.id);
      ok("The form still asks for GST treatment and place of supply, at GST rates", form.includes("GST treatment") && form.includes("Place of supply") && form.includes("GST 18%"));
    });
  } finally {
    if (created.documents.length) {
      await db.tradeDocumentLine.deleteMany({ where: { documentId: { in: created.documents } } });
      await db.tradeDocument.deleteMany({ where: { id: { in: created.documents } } });
    }
    if (created.companies.length) {
      await db.companyLocation.deleteMany({ where: { companyId: { in: created.companies } } });
      await db.company.deleteMany({ where: { id: { in: created.companies } } });
    }
  }

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll country pack checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
