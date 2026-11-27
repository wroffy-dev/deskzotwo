import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getTradeDocument } from "@/actions/trade-document";
import { findTradeDocumentFor } from "@/lib/documents/load";
import { spendRenderGrant } from "@/lib/documents/render-grant";
import { can } from "@/lib/authz/resolve";
import { foreignCountry } from "@/lib/organisation";
import { branchIdentity, isMultiBranch } from "@/lib/branches/identity";
import { printedBankAccount } from "@/lib/banking/organisation-accounts";
import { getBranding } from "@/actions/branding";
import { PrintButton } from "@/components/documents/print-button";
import { formatCalendarDay, indiaClock } from "@/lib/time/zone";
import { baseCurrency, formatMoney, formatRate, isBaseCurrency, toBase } from "@/lib/currency";
import { workspacePack } from "@/lib/country-pack";
import { GST_STATE_CODES, amountInWords } from "@/lib/gst-engine";
import { documentDirection, tradeDocumentLabels } from "@/lib/trade-documents";
import { gstTreatmentLabels } from "@/lib/gst";
import { formatAddress } from "@/lib/document-draft";
import { approvalDocumentFor, approvalPolicyFor } from "@/lib/documents/approval-policy";
import { approvalRequirement, approvalWatermark } from "@/lib/documents/approval";
import { descriptionStatesPeriod, formatServicePeriod, showsServicePeriod } from "@/lib/documents/service-period";
import { getWording } from "@/lib/terms/server";
import { copiesToPrint, printedTitle, simplifiedAllowed, ruleCopies, upiPayLink } from "@/lib/documents/print-extras";
import { slot } from "@/lib/terms/dictionary";
import { DEFAULT_ACCENT, PAPER_RULES, PRINT_LABEL_DEFAULTS, PRINT_SKINS, effectivePrintOptions } from "@/lib/documents/print-template";
import { draftPrintOptions, printTemplateChoices, printTemplateFor } from "@/lib/documents/print-template-server";
import { lineTaxCategories } from "@/lib/vat/lines";
import { lineCategory, taxCategoryLabels } from "@/lib/vat/rules";
import { db } from "@/lib/db";
import { TEST_EINVOICE_MARK, isTestEInvoice } from "@/lib/einvoice/options";

/**
 * The page that becomes the PDF. It deliberately ignores the app's dark mode and semantic tokens —
 * an invoice is printed on white paper, and a document that renders differently depending on the
 * viewer's theme is not a document you can send to a customer.
 */
export default async function PrintDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `embed=1` drops the print button — the preview pane has its own, and a button inside a
   *  preview of a printed page is one more thing that isn't on the printed page.
   *  `template` prints with that template of the type rather than its default; `draft` with unsaved options, for the
   *  template editor's preview (src/lib/documents/print-template-server.ts). */
  searchParams: Promise<{ embed?: string; render?: string; copies?: string; template?: string; draft?: string }>;
}) {
  const [{ id }, { embed, render, copies, template, draft }] = await Promise.all([params, searchParams]);
  const [document, branding] = await Promise.all([loadForPrint(id, render), getBranding()]);
  if (!document) notFound();
  // Outside India each line's VAT category (src/lib/vat): a zero-rated, exempt or out-of-scope line says which.
  const categories = await lineTaxCategories([document.id]);

  /**
   * How it looks (Settings › Document templates): the template asked for, else the type's default, else the built-in
   * Standard — this page as it always printed. The editor's unsaved options preview in its place, for somebody who may
   * change templates. Whatever either says, what GST requires on this type stays on (effectivePrintOptions).
   */
  const [printTemplate, draftOptions] = await Promise.all([
    printTemplateFor(document.docType, typeof template === "string" ? template : null),
    typeof draft === "string" ? draftPrintOptions(draft) : null,
  ]);
  const o = effectivePrintOptions(draftOptions ?? printTemplate.options, document.docType);
  const skin = PRINT_SKINS[o.layout];
  const { labels } = o;
  // GSTIN, GST treatment, place of supply and HSN are India's; another country's pack prints one tax under its own
  // name and no registration (src/lib/country-pack.ts, owner 30 Oct 2026).
  const pack = workspacePack();
  const show = pack.india ? o.show : { ...o.show, ourGstin: false, gstTreatment: false, placeOfSupply: false, hsnColumn: false };
  const singleTax = pack.india ? "IGST" : pack.tax.name;
  const base = baseCurrency();
  // Modern's band: the accent behind the letterhead and the table's header, kept when printing (browsers drop
  // background colours unless told). The colour is the schema's #RRGGBB, never anything else.
  const band = skin.band ? { backgroundColor: o.accentColor, WebkitPrintColorAdjust: "exact" as const, printColorAdjust: "exact" as const } : undefined;
  // Elsewhere the accent inks the title and the total; today's ink adds no style at all.
  const accentInk = o.accentColor !== DEFAULT_ACCENT ? { color: o.accentColor } : undefined;
  const templateChoices = embed !== "1" ? await printTemplateChoices(document.docType) : [];

  /**
   * Who "we" are on this paper: the branch it was raised from (or, on a purchase, bought by), with
   * whatever the branch leaves blank taken from the organisation. A null branch — a document written
   * before branches — is the head office, which with every override blank prints what the company
   * always printed. Neither read throws: a page that cannot find its branch still prints the company.
   */
  const [identity, multiBranch] = await Promise.all([
    branchIdentity(document.branchId),
    isMultiBranch().catch(() => false),
  ]);

  /**
   * Every figure on the page, in the currency the customer agreed to pay in.
   *
   * The whole document is stored in that currency — lines, tax and total alike — so this is a
   * relabelling, not a conversion. The conversion is the block below the total.
   */
  const money = (value: number | string | null | undefined) => formatMoney(value, document.currency);

  /**
   * The rupee equivalents, for a document written in anything else.
   *
   * Not decoration. The books post in rupees at the document's own rate, and an Indian export
   * invoice is expected to carry the rate and the rupee value it was converted at — so the figure
   * the ledger holds should be legible on the document itself rather than only in the system that
   * produced it. Converted at the rate stored on the document, never a live one: reprinting a
   * six-month-old invoice must produce the same paper it produced the first time.
   */
  const foreign = !isBaseCurrency(document.currency);
  const rate = Number(document.exchangeRate) || 1;
  const inr = {
    taxableValue: toBase(document.taxableValue, rate),
    tax: toBase(document.cgstAmount + document.sgstAmount + document.igstAmount, rate),
    total: toBase(document.total, rate),
  };

  /**
   * Who the recipient rings about this document.
   *
   * Falls back to the account owner when nobody was named, because that is exactly what the form's
   * blank option says it will do and what `createTradeDocument` already resolves it to — a document
   * that prints no contact when the form promised one is the form telling a lie.
   *
   * The phone is printed only when the person has entered one. That is the arrangement their own
   * profile page states: the number is optional, and leaving it blank gives the customer the email
   * alone rather than exposing a mobile nobody chose to publish.
   */
  const contact = document.salesperson ?? document.company.owner;

  const isIntraState = document.cgstAmount > 0 || document.sgstAmount > 0;
  const isSales = documentDirection[document.docType] === "SALES";
  // The document's own pick, else its branch's default, else the organisation's primary. Sales only:
  // a purchase order printing our account would invite the vendor to pay us.
  const bank = isSales ? await printedBankAccount(document.id, identity) : null;
  // Scan to pay by UPI (owner, 29 Oct 2026): the printed account's UPI ID, the amount, the number (print-extras.ts).
  const upiLink = bank ? upiPayLink(document, bank.upiId, identity.legalName || branding.appName) : null;
  const upiQrDataUrl = upiLink ? await QRCode.toDataURL(upiLink, { margin: 1, width: 150 }).catch(() => null) : null;
  // Rule 48's copies, each on its own page and named; the original alone unless all are asked for.
  const allCopies = ruleCopies(document.docType, document.lines);
  const sheets = copiesToPrint(allCopies, copies);
  // A bill of supply when nothing on it is taxed (print-extras.ts): the same invoice, called what it is. A template's own
  // title only where the type's isn't fixed by law (optionsFor).
  // A simplified tax invoice where the template asks for one and the FTA allows it (the UAE's — print-extras.ts).
  const simplified = simplifiedAllowed({ docType: document.docType, buyerTrn: document.buyerGstin, totalInAed: Number(document.total) * rate }, o.show.fullTaxInvoice);
  const { title: printed, declaration } = printedTitle(document, tradeDocumentLabels[document.docType], simplified);
  const title = o.title || printed;
  const qrDataUrl = document.signedQrCode
    ? await QRCode.toDataURL(document.signedQrCode, { margin: 1, width: 150 }).catch(() => null)
    : null;
  /**
   * Security audit round three, 14 Nov 2026 (R3-08): an IRN from the mock portal or NIC's sandbox is not the
   * government's, and paper carrying one looked exactly like a registered e-invoice. Such a document says so where its
   * IRN is printed (`isTestEInvoice`, src/lib/einvoice/options.ts).
   */
  const testEInvoice =
    !!document.irn &&
    isTestEInvoice(
      document,
      document.gstRegistration?.id
        ? (await db.gstRegistration.findUnique({ where: { id: document.gstRegistration.id }, select: { einvoiceProvider: true } }))?.einvoiceProvider
        : null,
    );

  const placeOfSupplyLabel = document.placeOfSupplyCode
    ? `${GST_STATE_CODES[document.placeOfSupplyCode] ?? "Unknown"} (${document.placeOfSupplyCode})`
    : "Not set";

  /**
   * Our GSTIN as the document recorded it — `sellerGstin` on a sale, `buyerGstin` on a purchase — not
   * the registration's value today. A GSTIN is replaced or a branch moves to another registration,
   * and an invoice reprinted afterwards must still carry the number it was issued under. The live one
   * only fills in for a document that recorded none.
   */
  const ourGstin = (isSales ? document.sellerGstin : document.buyerGstin) || identity.gstin;
  // One quiet line saying which branch this is, where there is more than one to tell apart. The head
  // office goes unnamed, so a single-branch company's paper reads exactly as it always has.
  const branchLine = multiBranch && !identity.isHeadOffice ? `Branch: ${identity.name}` : null;
  // The branch's own logo when it has one; otherwise the app's, as every document printed before.
  const logoDataUrl = identity.logoDataUrl ?? branding.logoDataUrl;

  const ourLines = [
    identity.addressLine1,
    identity.addressLine2,
    [identity.city, identity.pincode].filter(Boolean).join(" — "),
    identity.state,
    foreignCountry(identity),
  ];
  const billingLines = formatAddress({
    attention: document.billingAttention,
    line1: document.billingLine1,
    line2: document.billingLine2,
    city: document.billingCity,
    state: document.billingState,
    pincode: document.billingPincode,
    country: document.billingCountry,
  });
  const shippingLines = formatAddress({
    attention: document.shippingAttention,
    line1: document.shippingLine1,
    line2: document.shippingLine2,
    city: document.shippingCity,
    state: document.shippingState,
    pincode: document.shippingPincode,
    country: document.shippingCountry,
  });

  const counterparty = {
    // The name it was issued under, if the party has since been merged into another company.
    name: document.partyName ?? document.company.name,
    gstin: isSales ? document.buyerGstin : document.sellerGstin,
    lines: billingLines.length > 0 ? billingLines : ourLines,
  };

  // A shipping address only earns its space when it actually differs from the billing one.
  const showShipping = !document.shippingSameAsBilling && shippingLines.length > 0;

  /**
   * Whom the counterparty box names. "Bill to" and a vendor bill's "Vendor" are a tax document's words
   * and stay the app's; a purchase order is our own paper, not a tax document, so its vendor is called
   * what the workspace calls one (Settings → Wording) — "Supplier" for a workspace that says so.
   */
  const partyTitle = labels.billTo || (isSales ? "Bill to" : document.docType === "PURCHASE_ORDER" ? slot(await getWording(), "Vendor", "vendor", "{one}") : "Vendor");
  // Printed when the document has none of its own.
  const terms = document.terms || o.defaultTerms;

  /**
   * The watermark, where this document has not been signed off.
   *
   * Only for types that actually require approval — a watermark on every draft would be noise, and
   * noise on a document is worse than nothing because people stop reading it.
   *
   * It is printed, not merely shown. The risk is entirely in the saved PDF: somebody previews an
   * unapproved quotation, saves it and emails it, and the customer holds a price nobody signed off.
   * A `print:hidden` watermark would vanish at exactly the moment it mattered.
   */
  // And only on a document that needs it: a quote under the approval limit is not waiting for anybody.
  const [approvalPolicy, approvalFacts] = await Promise.all([approvalPolicyFor(document.docType), approvalDocumentFor(document.id)]);
  const needsSignOff = approvalFacts ? approvalRequirement(approvalPolicy, approvalFacts).required : approvalPolicy.enabled;
  const watermark = approvalWatermark(needsSignOff, document);

  return (
    <div className={`relative mx-auto max-w-[820px] bg-white p-8 ${skin.base} text-neutral-900 print:max-w-none print:p-0${o.font === "serif" ? " font-serif" : ""}`}>
      {PAPER_RULES[o.paper] && <style>{PAPER_RULES[o.paper]}</style>}
      {embed !== "1" && (
        <div className="mb-4 flex justify-end print:hidden">
          <PrintButton
            copies={
              allCopies
                ? [
                    { value: "original", label: "Original for recipient", current: copies !== "all" },
                    { value: "all", label: `All ${allCopies.length} copies (Rule 48)`, current: copies === "all" },
                  ]
                : undefined
            }
            templates={
              templateChoices.length > 1
                ? templateChoices.map((t) => ({ value: t.id ?? "", label: t.isDefault ? `${t.name} (default)` : t.name, current: draftOptions ? false : t.id === printTemplate.id }))
                : undefined
            }
          />
        </div>
      )}

      {sheets.map((copyLabel, sheet) => (
      // One sheet a copy: a page of its own when printed, a gap between them on screen.
      <div key={copyLabel ?? sheet} className={`relative ${sheet > 0 ? "mt-10 print:mt-0" : ""}`} style={sheet < sheets.length - 1 ? { breakAfter: "page" } : undefined}>
      {watermark && (
        /**
         * Across the page, behind the content.
         *
         * `pointer-events-none` so it never blocks selecting or clicking the document underneath,
         * and `print-color-adjust` because browsers drop background and faint colour when printing
         * unless told not to — without it the watermark is on screen and missing from the paper,
         * which is the one place it has to be.
         */
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden"
          style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}
        >
          <span
            className="select-none whitespace-nowrap text-[68px] font-bold uppercase tracking-[0.12em] text-neutral-400"
            style={{ transform: "rotate(-30deg)", opacity: 0.22 }}
          >
            {watermark}
          </span>
        </div>
      )}

      {/* Clips nothing in practice — every part keeps to the frame — but a long word never draws past its border. */}
      <div className="relative z-0 overflow-hidden border border-neutral-300">
        <div className={`flex items-start justify-between gap-6 border-b border-neutral-300 ${skin.pad}${band ? " text-white" : ""}`} style={band}>
          <div className="flex items-start gap-3">
            {show.logo && logoDataUrl && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={logoDataUrl} alt="" className={skin.logo} />
            )}
            <div>
              <div className="text-base font-semibold">{identity.legalName || branding.appName}</div>
              {identity.tradeName && <div className={skin.ink.muted}>{identity.tradeName}</div>}
              <div className={`mt-1 leading-5 ${skin.ink.muted}`}>
                {show.companyAddress && [identity.addressLine1, identity.addressLine2].filter(Boolean).join(", ")}
                {show.companyAddress && identity.city && (
                  <div>{[identity.city, identity.state, identity.pincode, foreignCountry(identity)].filter(Boolean).join(", ")}</div>
                )}
                {show.branchLine && branchLine && <div className={`text-[11px] ${skin.ink.faint}`}>{branchLine}</div>}
                {show.ourGstin && ourGstin && <div>GSTIN: {ourGstin}</div>}
                {pack.country === "AE" && ourGstin && <div>TRN: {ourGstin}</div>}
                {show.phone && identity.phone && <div>{identity.phone}</div>}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold uppercase tracking-wide" style={band ? undefined : accentInk}>
              {title}
            </div>
            {copyLabel && <div className={`mt-0.5 text-[10px] font-semibold uppercase tracking-wide ${skin.ink.faint}`}>{copyLabel}</div>}
            <div className={`mt-1 font-mono ${skin.ink.number}`}>{document.docNumber}</div>
            {/* A document's dates are typed days, kept as their midnight UTC: the day itself, in any zone. */}
            <div className={skin.ink.muted}>Dated {formatCalendarDay(document.issueDate)}</div>
            {/**
              * A draft says so, on the paper.
              *
              * This page is reachable before a document is issued, which is the point — you read it
              * over before committing to it. But it otherwise renders exactly like the finished
              * article, and the number on it is not final: issuing assigns the real one. Without
              * this, the obvious next step after previewing is to save the PDF and send it, and the
              * customer receives a quote carrying a number that will belong to a different document.
              *
              * Deliberately not `print:hidden` — the whole risk is the printed copy.
              */}
            {document.status === "DRAFT" && (
              <div className={`mt-2 inline-block border ${skin.ink.rule} px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${skin.ink.faint}`}>
                Draft — not issued
              </div>
            )}
          </div>
        </div>
        {o.headerNote && <div className={`whitespace-pre-line border-b border-neutral-300 ${skin.declPad} text-[11px] text-neutral-600`}>{o.headerNote}</div>}

        {/* On a sales document the letterhead above already is the supplier, so the remaining boxes
            carry the counterparty, where it ships, and the document's own details. */}
        <div className={`grid border-b border-neutral-300 ${showShipping ? "grid-cols-3" : "grid-cols-2"}`}>
          <Party
            title={partyTitle}
            party={counterparty}
            showGstin={pack.india}
            showTrn={pack.country === "AE"}
            pad={skin.pad}
            className="border-r border-neutral-300"
          />
          {showShipping && (
            <Party
              title={labels.shipTo || "Ship to"}
              party={{ name: "", gstin: document.shippingGstin, lines: shippingLines }}
              showGstin={pack.india}
              showTrn={pack.country === "AE"}
              pad={skin.pad}
              className="border-r border-neutral-300"
            />
          )}
          <div className={`space-y-1 ${skin.pad}`}>
            <div className="text-[11px] uppercase tracking-wide text-neutral-500">{labels.details || "Details"}</div>
            {show.placeOfSupply && <DetailRow label="Place of supply" value={placeOfSupplyLabel} />}
            {document.reference && <DetailRow label={isSales ? "Your reference" : "Our reference"} value={document.reference} />}
            {document.dueDate && <DetailRow label="Payment due" value={formatCalendarDay(document.dueDate)} />}
            {document.validUntil && <DetailRow label="Valid until" value={formatCalendarDay(document.validUntil)} />}
            {show.gstTreatment && <DetailRow label="GST treatment" value={gstTreatmentLabels[document.gstTreatment]} />}
            {show.reverseCharge && <DetailRow label="Reverse charge" value={document.reverseCharge ? "Yes" : "No"} />}
            {document.dispatchFromAddress && (
              <DetailRow label="Dispatch from" value={document.dispatchFromAddress.split("\n").join(", ")} />
            )}
            {document.againstDocument && (
              <DetailRow
                label="Against invoice"
                value={`${document.againstDocument.docNumber} — ${formatCalendarDay(document.againstDocument.issueDate)}`}
              />
            )}
          </div>
        </div>

        {/*
          Fixed columns (owner, 8 Oct 2026): an automatic table grew past the bordered frame whenever its
          amounts needed more room than the page had — on A4 in the PDF above all — and its borders no
          longer met the frame's. The amounts keep their own widths on one line; the description takes what
          is left and wraps.
        */}
        <table className="w-full table-fixed">
          <colgroup>
            <col className="w-7" />
            <col />
            {show.hsnColumn && <col className="w-16" />}
            <col className="w-12" />
            <col className="w-[5.5rem]" />
            <col className="w-[5.75rem]" />
            {isIntraState ? (
              <>
                <col className="w-[4.75rem]" />
                <col className="w-[4.75rem]" />
              </>
            ) : (
              <col className="w-[5.25rem]" />
            )}
            <col className="w-24" />
          </colgroup>
          <thead className={skin.thead} style={band}>
            <tr>
              <th className={skin.cell}>#</th>
              <th className={skin.cell}>Description</th>
              {show.hsnColumn && <th className={skin.cell}>HSN/SAC</th>}
              <th className={`${skin.cell} text-right`}>Qty</th>
              <th className={`${skin.cell} text-right`}>Rate</th>
              <th className={`${skin.cell} text-right`}>Taxable</th>
              {isIntraState ? (
                <>
                  <th className={`${skin.cell} text-right`}>CGST</th>
                  <th className={`${skin.cell} text-right`}>SGST</th>
                </>
              ) : (
                <th className={`${skin.cell} text-right`}>{singleTax}</th>
              )}
              <th className={`${skin.cell} text-right`}>Amount</th>
            </tr>
          </thead>
          <tbody className={skin.lines}>
            {document.lines.map((line, index) => (
              <tr key={line.id} className="border-b border-neutral-200 align-top">
                <td className={`${skin.cell} text-neutral-500`}>{index + 1}</td>
                <td className={`break-words ${skin.cell}`}>
                  {line.name}
                  {show.lineDescriptions && line.description && (
                    <div className="mt-0.5 whitespace-pre-line text-[11px] text-neutral-600">{line.description}</div>
                  )}
                  {/* The period the customer is paying for, unless the description already says it. */}
                  {showsServicePeriod(document.docType) &&
                    line.servicePeriodFrom &&
                    line.servicePeriodTo &&
                    !descriptionStatesPeriod(line.description, line.servicePeriodFrom, line.servicePeriodTo) && (
                      <div className="mt-0.5 text-[11px] text-neutral-600">
                        Service period: {formatServicePeriod(line.servicePeriodFrom, line.servicePeriodTo)}
                      </div>
                    )}
                </td>
                {show.hsnColumn && <td className={`break-all ${skin.cell} font-mono text-[10px]`}>{line.hsnCode ?? "—"}</td>}
                <td className={`break-words ${skin.cell} text-right`}>
                  {line.quantity}
                  {show.quantityUnit && line.unit ? ` ${line.unit}` : ""}
                </td>
                <td className={`whitespace-nowrap ${skin.cell} text-right text-[11px]`}>{money(line.unitPrice)}</td>
                <td className={`whitespace-nowrap ${skin.cell} text-right text-[11px]`}>
                  {money(line.taxableValue)}
                  {show.discountNote && line.discountAmount > 0 && (
                    <div className="text-[10px] text-neutral-500">less {money(line.discountAmount)}</div>
                  )}
                </td>
                {isIntraState ? (
                  <>
                    <td className={`whitespace-nowrap ${skin.cell} text-right text-[11px]`}>
                      {money(line.cgstAmount)}
                      {show.lineTaxPercent && <div className="text-[10px] text-neutral-500">{line.taxRatePercent / 2}%</div>}
                    </td>
                    <td className={`whitespace-nowrap ${skin.cell} text-right text-[11px]`}>
                      {money(line.sgstAmount)}
                      {show.lineTaxPercent && <div className="text-[10px] text-neutral-500">{line.taxRatePercent / 2}%</div>}
                    </td>
                  </>
                ) : (
                  <td className={`whitespace-nowrap ${skin.cell} text-right text-[11px]`}>
                    {money(line.igstAmount)}
                    {show.lineTaxPercent && <div className="text-[10px] text-neutral-500">{line.taxRatePercent}%</div>}
                    {!pack.india && lineCategory(categories.get(line.id), line.taxRatePercent) !== "STANDARD" && (
                      <div className="text-[10px] text-neutral-500">{taxCategoryLabels[lineCategory(categories.get(line.id), line.taxRatePercent)]}</div>
                    )}
                  </td>
                )}
                <td className={`whitespace-nowrap ${skin.cell} text-right text-[11px] font-medium`}>{money(line.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="grid grid-cols-[1fr_280px] border-t border-neutral-300">
          <div className={`space-y-3 border-r border-neutral-300 ${skin.pad}`}>
            {show.amountInWords && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-neutral-500">{labels.amountInWords || "Amount in words"}</div>
                <div className="font-medium">{amountInWords(document.total, document.currency)}</div>
              </div>
            )}

            {/* On by law wherever an IRN can exist (Rule 48(4) — effectivePrintOptions): only a type without one could hide it, and it never has one.
                Printed whenever the document has an IRN (owner, 21 Nov 2026: "this is an old invoice so why not showing irn in print pdf"):
                an invoice brought across from the old system keeps its IRN and acknowledgement, but Zoho's backup has no signed QR —
                so the IRN prints without it, saying so, rather than the whole e-invoice block going missing. */}
            {document.irn && show.einvoiceQr && (
              <div className="flex items-start gap-3">
                {qrDataUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={qrDataUrl} alt="Signed e-invoice QR code" className="h-[110px] w-[110px]" />
                ) : (
                  <div className="flex h-[110px] w-[110px] shrink-0 items-center justify-center border border-dashed border-neutral-300 p-2 text-center text-[9px] leading-4 text-neutral-500">
                    Signed QR not in the records brought across
                  </div>
                )}
                <div className="text-[11px] leading-5 text-neutral-600">
                  <div className="font-medium text-neutral-800">e-Invoice</div>
                  {testEInvoice && <div className="font-semibold uppercase text-red-700">{TEST_EINVOICE_MARK}</div>}
                  <div className="break-all">IRN: {document.irn}</div>
                  {document.ackNo && <div>Ack no: {document.ackNo}</div>}
                  {/* The IRP's acknowledgement: an e-invoice date, so India's (statutory, every workspace). */}
                  {document.ackDate && <div>Ack date: {indiaClock.date(document.ackDate)}</div>}
                </div>
              </div>
            )}

            {show.contact && contact && (
              <div className="text-[11px] leading-5 text-neutral-600">
                <div className="text-[11px] uppercase tracking-wide text-neutral-500">Your contact</div>
                <div className="font-medium text-neutral-800">{contact.name}</div>
                {contact.email && <div>{contact.email}</div>}
                {contact.phone && <div>{contact.phone}</div>}
              </div>
            )}

            {/* One account, whole — never one account's IFSC under another's number. */}
            {show.bankDetails && bank && (
              <div className="text-[11px] leading-5 text-neutral-600">
                <div className="text-[11px] uppercase tracking-wide text-neutral-500">{labels.bankDetails || "Bank details"}</div>
                {bank.accountHolderName && <div>{bank.accountHolderName}</div>}
                {bank.bankName && <div>{bank.bankName}{bank.branchName ? ` — ${bank.branchName}` : ""}</div>}
                {bank.accountNumber && <div>A/c: {bank.accountNumber}</div>}
                {bank.ifsc && <div>IFSC: {bank.ifsc}</div>}
                {bank.swift && <div>SWIFT: {bank.swift}</div>}
                {bank.upiId && <div>UPI: {bank.upiId}</div>}
              </div>
            )}

            {show.upiQr && upiQrDataUrl && (
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={upiQrDataUrl} alt="UPI QR code to pay this document" className="h-[96px] w-[96px]" />
                <div className="text-[11px] leading-5 text-neutral-600">
                  <div className="font-medium text-neutral-800">Scan to pay by UPI</div>
                  <div>{document.status === "PARTIALLY_PAID" ? "Enter the amount still due" : money(document.total)}</div>
                  <div className="text-[10px]">Any UPI app — GPay, PhonePe, Paytm, BHIM</div>
                </div>
              </div>
            )}

            {show.terms && terms && (
              <div className="text-[11px] leading-5 text-neutral-600">
                <div className="text-[11px] uppercase tracking-wide text-neutral-500">{labels.terms || "Terms"}</div>
                <div className="whitespace-pre-wrap">{terms}</div>
              </div>
            )}
          </div>

          <div className={skin.pad}>
            <PrintRow label="Subtotal" value={money(document.subtotal)} />
            {document.discountTotal > 0 && <PrintRow label="Discount" value={`− ${money(document.discountTotal)}`} />}
            {document.shippingCharge > 0 && (
              <PrintRow label="Shipping charges" value={money(document.shippingCharge)} />
            )}
            <PrintRow label="Taxable value" value={money(document.taxableValue)} />
            {isIntraState ? (
              <>
                <PrintRow label="CGST" value={money(document.cgstAmount)} />
                <PrintRow label="SGST" value={money(document.sgstAmount)} />
              </>
            ) : (
              <PrintRow label={singleTax} value={money(document.igstAmount)} />
            )}
            {document.withholdingMode !== "NONE" && (
              <PrintRow
                label={`${document.withholdingMode}${document.withholdingSection ? ` (${document.withholdingSection})` : ""} @ ${document.withholdingRatePercent}%`}
                value={`${document.withholdingAmount < 0 ? "− " : "+ "}${money(Math.abs(document.withholdingAmount))}`}
              />
            )}
            {document.adjustment !== 0 && (
              <PrintRow
                label={document.adjustmentLabel || "Adjustment"}
                value={money(document.adjustment)}
              />
            )}
            {document.roundOff !== 0 && <PrintRow label="Round off" value={money(document.roundOff)} />}
            <div className="mt-2 flex items-center justify-between border-t border-neutral-300 pt-2 text-[15px] font-semibold" style={accentInk}>
              <span>Total{foreign ? ` (${document.currency})` : ""}</span>
              <span>{money(document.total)}</span>
            </div>

            {foreign && (
              <div className="mt-2 space-y-1 border-t border-neutral-200 pt-2 text-[11px] leading-5 text-neutral-600">
                <div>Exchange rate: 1 {document.currency} = {formatRate(rate)}</div>
                <PrintRow label={`Taxable value (${base})`} value={formatMoney(inr.taxableValue, base)} />
                {(inr.tax > 0 || pack.country === "AE") && <PrintRow label={`${pack.india ? "Tax" : pack.tax.name} (${base})`} value={formatMoney(inr.tax, base)} />}
                <div className="flex items-center justify-between font-semibold text-neutral-800">
                  <span>Total ({base})</span>
                  <span>{formatMoney(inr.total, base)}</span>
                </div>
              </div>
            )}

            <div className={`${skin.sign} text-right text-[11px] text-neutral-600`}>
              {show.signature && identity.signatureDataUrl && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={identity.signatureDataUrl} alt="" className="ml-auto h-14 w-auto object-contain" />
              )}
              {show.forCompany && <div className="mt-1">For {identity.legalName || branding.appName}</div>}
              <div className="mt-6 border-t border-neutral-300 pt-1">{labels.signatory || PRINT_LABEL_DEFAULTS.signatory}</div>
            </div>
          </div>
        </div>

        {declaration && <div className={`border-t border-neutral-300 ${skin.declPad} text-[11px] font-medium text-neutral-700`}>{declaration}</div>}
        {show.notes && (document.notes || identity.invoiceNotes) && (
          <div className={`border-t border-neutral-300 ${skin.notePad} text-[11px] leading-5 text-neutral-600`}>
            {document.notes && <div className="whitespace-pre-wrap">{document.notes}</div>}
            {identity.invoiceNotes && <div className="mt-1 whitespace-pre-wrap">{identity.invoiceNotes}</div>}
          </div>
        )}
      </div>

      {show.footer && (
        <p className="mt-3 text-center text-[11px] text-neutral-500">
          {o.footerText ? o.footerText : <>This is a computer-generated {title.toLowerCase()}.</>}
        </p>
      )}
      </div>
      ))}
    </div>
  );
}

function Party({
  title,
  party,
  showGstin,
  showTrn = false,
  pad,
  className,
}: {
  title: string;
  party: { name: string; gstin: string | null; lines: (string | null | undefined)[]; extra?: (string | null | undefined)[] };
  /** India's GSTIN line, "Unregistered" when there is none; not printed in another country's pack. */
  showGstin: boolean;
  /** The UAE's TRN line, only when the party has one (src/lib/vat): an unregistered buyer simply has none. */
  showTrn?: boolean;
  /** The layout's padding (PRINT_SKINS) — "p-5", as always, on Standard. */
  pad: string;
  className?: string;
}) {
  return (
    <div className={`${pad} ${className ?? ""}`}>
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">{title}</div>
      {party.name && <div className="mt-1 font-semibold">{party.name}</div>}
      <div className="leading-5 text-neutral-600">
        {party.lines.filter(Boolean).map((line, index) => (
          <div key={index}>{line}</div>
        ))}
        {party.extra?.filter(Boolean).map((line, index) => (
          <div key={`extra-${index}`}>{line}</div>
        ))}
        {showGstin && <div className="mt-1">GSTIN: {party.gstin ?? "Unregistered"}</div>}
        {showTrn && party.gstin && <div className="mt-1">TRN: {party.gstin}</div>}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 leading-5">
      <span className="w-28 shrink-0 text-neutral-500">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function PrintRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-neutral-700">
      <span>{label}</span>
      <span className="text-neutral-900">{value}</span>
    </div>
  );
}

/**
 * The document, for whoever is looking.
 *
 * Normally that is the person signed in. When the server's own browser is printing it for an email,
 * there is no session, only a render pass (src/lib/documents/render-grant.ts): spent here, once, it
 * names the person who pressed send, and the document is loaded as they would see it — their
 * permission and their accounts, checked again now rather than trusted from a minute ago.
 */
async function loadForPrint(id: string, render: string | undefined) {
  if (!render) return getTradeDocument(id);
  const userId = await spendRenderGrant(render, id);
  if (!userId || !(await can(userId, "documents.view"))) return null;
  return findTradeDocumentFor(userId, id);
}
