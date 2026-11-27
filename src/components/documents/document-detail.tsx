import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import type { OrderStatus, TradeDocumentType } from "@prisma/client";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getTradeDocument } from "@/actions/trade-document";
import { MsmeBillNotice } from "@/components/documents/msme-bill-notice";
import {
  getInvoiceSettlement,
  getCreditNoteBalance,
  listAvailableCredits,
  listOpenInvoices,
} from "@/actions/receivable";
import { hasEffectivePermission } from "@/actions/permission";
import { isModuleEntitled, moduleAccessFor } from "@/lib/modules-access";
import { workspacePack } from "@/lib/country-pack";
import { getOrganisation } from "@/lib/organisation";
import { isMultiBranch } from "@/lib/branches/identity";
import { branchLabel } from "@/lib/branches/format";
import { Card, CardContent, CardHeader, Badge } from "@/components/ui/card";
import { DocumentActions } from "@/components/documents/document-actions";
import { DocumentEmailHistory } from "@/components/documents/document-email-history";
import { viewerHas } from "@/actions/permission";
import { isEmailable } from "@/lib/documents/email-template";
import { DocumentApprovalBar } from "@/components/documents/document-approval-bar";
import { approvalContext } from "@/actions/document-approval";
import { InvoiceSettlementPanel, CreditNoteApplications } from "@/components/documents/invoice-settlement";
import { NextStepActions } from "@/components/documents/next-step-actions";
import { ApprovedByLine } from "@/components/documents/approved-by-line";
import { BillInStages } from "@/components/documents/bill-in-stages";
import { billingProgress } from "@/lib/documents/progress-billing";
import { liveOrder, ordersOfQuote, quoteForOrder } from "@/lib/orders/from-quote";
import { proformaAdvances } from "@/lib/receivables/proforma-advance";
import { ProformaAdvances } from "@/components/documents/proforma-advances";
import { conversionTargets } from "@/lib/trade-documents";
import { InvoicePayLink } from "@/components/collect/invoice-pay-link";
import { invoicePayLinkState } from "@/actions/payment-collection";
import { BillSettlementPanel } from "@/components/documents/bill-settlement";
import { BillPoCheckCard } from "@/components/documents/bill-po-check";
import { readingOfDocument } from "@/lib/bill-reader/server";
import { billPoCheck } from "@/lib/purchase/bill-check";
import { followUpPanel } from "@/actions/collections";
import { FollowUpPanel } from "@/components/collections/follow-up-panel";
import { getBillSettlement } from "@/actions/payable";
import { formatCalendarDay, indiaClock } from "@/lib/time/zone";
import { workspaceClock } from "@/lib/time/workspace";
import { cancellationOf } from "@/lib/documents/cancellation";
import { baseCurrency, formatMoney, formatRate, isBaseCurrency, toBase } from "@/lib/currency";
import { GST_STATE_CODES, amountInWords } from "@/lib/gst-engine";
import { gstTreatmentLabels } from "@/lib/gst";
import { isDraftNumber } from "@/lib/document-numbering";
import { isWithinCancellationWindow } from "@/lib/einvoice/options";
import { ewayForDocument } from "@/actions/eway";
import { carriesGoods } from "@/lib/eway/documents";
import { transporterOptions } from "@/actions/transporter";
import { EwayPanel } from "@/components/logistics/eway-panel";
import { nextStepFor } from "@/lib/document-next-step";
import { descriptionStatesPeriod, formatServicePeriod, showsServicePeriod } from "@/lib/documents/service-period";
import { isModuleEnabled } from "@/actions/module";
import { listSchedules } from "@/actions/revenue";
import { ScheduleLineNote } from "@/components/revenue/schedule-line-note";
import {
  documentDirection,
  documentListPath,
  isEInvoiceEligible,
  statusTone,
  tradeDocumentLabels,
  tradeDocumentStatusLabels,
} from "@/lib/trade-documents";
import { companyPath, leadPath, orderPath } from "@/lib/record-links";
import { formatOrderId } from "@/lib/order-id";
import { getWording } from "@/lib/terms/server";
import { orderStatusLabel, slot } from "@/lib/terms/dictionary";
import { documentWriteKey } from "@/lib/documents/write-permission";
import { DocumentLeadLink } from "@/components/documents/document-lead-link";
import { leadsInPlan } from "@/lib/leads/shown";
import { accessLevel, mayAccess } from "@/lib/authz/access";
import { requireUser } from "@/lib/session";

/**
 * A document's full detail. Rendered on its own page and again inside the split view on a document
 * list, so the two can't drift apart — `embedded` only drops the chrome that the split view
 * already provides.
 */
export async function DocumentDetail({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const [document, org, viewer, multiBranch, clock] = await Promise.all([
    getTradeDocument(id),
    getOrganisation(),
    requireUser(),
    isMultiBranch(),
    workspaceClock(),
  ]);
  if (!document) notFound();
  // Why it was cancelled, by whom and when (src/lib/documents/cancellation.ts).
  const cancellation = document.status === "CANCELLED" ? await cancellationOf(document.id) : null;

  /**
   * Which of the two GSTIN snapshots is ours. On a sale we are the seller; on a purchase we are the
   * buyer and the vendor's GSTIN is the seller's (spec §5.2) — so "seller" and "buyer" would name
   * the right numbers only half the time.
   */
  const isSales = document.direction === "SALES";
  const ourGstin = isSales ? document.sellerGstin : document.buyerGstin;
  const partyGstin = isSales ? document.buyerGstin : document.sellerGstin;
  // Named only where it tells somebody something: a single-branch company raises everything from its
  // head office. A null branch is a document written before branches — the head office's.
  const showBranch = multiBranch || (document.branch !== null && !document.branch.isHeadOffice);

  // Settlement only exists for an issued invoice or credit note — a quote has nothing to settle.
  // A debit note is settled, chased and paid online as an invoice is (src/lib/trade-documents.ts `RECEIVABLE_TYPES`).
  const isOpenInvoice = (document.docType === "INVOICE" || document.docType === "DEBIT_NOTE") && document.status !== "DRAFT" && document.status !== "CANCELLED";
  const isOpenCreditNote = document.docType === "CREDIT_NOTE" && document.status !== "DRAFT" && document.status !== "CANCELLED";
  // The other side of the ledger, which had no way to be settled at all — see bill-settlement.tsx.
  const isOpenBill = document.docType === "BILL" && document.status !== "DRAFT" && document.status !== "CANCELLED";
  // Settling is Receivables' and Payables' work: a plan without them shows the document alone.
  const [receivablesInPlan, payablesInPlan] = await Promise.all([isModuleEntitled("receivables"), isModuleEntitled("payables")]);
  const settleInvoice = isOpenInvoice && receivablesInPlan;
  const settleCreditNote = isOpenCreditNote && receivablesInPlan;
  const billCheck = document.docType === "BILL" && document.status !== "CANCELLED" ? await billPoCheck(document.id) : null;
  // The vendor's own file, where Arjun read this bill from one (owner, 20 Nov 2026 — src/lib/bill-reader).
  const billReading = document.docType === "BILL" ? await readingOfDocument(document.id) : null;
  const [settlement, billSettlement, availableCredits, creditBalance, openInvoices, canRecord, canRemove] = await Promise.all([
    settleInvoice ? getInvoiceSettlement(document.id) : Promise.resolve(null),
    isOpenBill && payablesInPlan ? getBillSettlement(document.id) : Promise.resolve(null),
    settleInvoice ? listAvailableCredits(document.companyId) : Promise.resolve([]),
    settleCreditNote ? getCreditNoteBalance(document.id) : Promise.resolve(null),
    settleCreditNote ? listOpenInvoices(document.companyId) : Promise.resolve([]),
    hasEffectivePermission(viewer.id, "payments.record"),
    accessLevel(viewer.id, "payments", "delete").then((level) => level !== "NONE"),
  ]);

  // Only asked for once the document is loaded, because it needs the type to find the policy.
  const approval = await approvalContext(document.id);

  // Paying online (owner, 23 Oct 2026 — src/lib/collect): an invoice with something left to pay, where a gateway is
  // connected. In another currency (owner, 30 Oct 2026) where the gateway takes international payments — else the
  // card says why not.
  const payOnline = settlement && settlement.balance >= 1 ? await invoicePayLinkState(document.id) : null;

  // Which deal a proposal is for (owner, 19 Oct 2026; src/actions/document-lead.ts): linked or changed
  // here by whoever may write proposals and see leads — draft or issued, since it is no part of what was sent.
  const canLinkLead =
    document.docType === "PROPOSAL" &&
    document.status !== "CANCELLED" &&
    (await leadsInPlan()) &&
    (await viewerHas("leads.view")) &&
    (await viewerHas(documentWriteKey("PROPOSAL", "edit"))) &&
    (await mayAccess((await requireUser()).id, "documents", "edit", document.id));

  // Collections: what sales and accounts have said to the customer about paying this invoice, and any
  // promise — for anybody who can see the account's money (null otherwise). Receivables' own, so only
  // where the plan has it.
  const followUps =
    (document.docType === "INVOICE" || document.docType === "DEBIT_NOTE") && document.status !== "DRAFT" && receivablesInPlan ? await followUpPanel({ documentId: document.id }) : null;

  // Revenue & Close: an issued invoice's deferring lines each link to their revenue schedule — where
  // the add-on is available, and for somebody who may read revenue (the link would refuse anyone else).
  const lineSchedules =
    document.docType === "INVOICE" &&
    document.status !== "DRAFT" &&
    (await isModuleEnabled("revenue_close")) &&
    ((await viewerHas("revenue.viewReports")) || (await viewerHas("revenue.manage")))
      ? new Map((await listSchedules({ documentId: document.id, take: 500 })).rows.map((s) => [s.lineId, s]))
      : null;

  /** Every figure on screen, in the currency the document was written in — see the print page. */
  const money = (value: number | string | null | undefined) => formatMoney(value, document.currency);
  const foreign = !isBaseCurrency(document.currency);
  const rate = Number(document.exchangeRate) || 1;

  const isIntraState = document.cgstAmount > 0 || document.sgstAmount > 0;
  // GSTIN, place of supply and HSN are India's; another country's pack shows its one tax by name (src/lib/country-pack.ts).
  const pack = workspacePack();
  const singleTax = pack.india ? "IGST" : pack.tax.name;
  const eligible = isEInvoiceEligible(document.docType);
  /**
   * The e-way bill, for the documents goods actually travel on.
   *
   * A refusal is treated as "not your business" rather than an error — somebody who can read an
   * invoice but not despatch against it has no use for a panel of portal buttons. Nothing is
   * fetched at all for a proposal or a proforma, which move no goods.
   */
  // Not for one brought from the old system: its goods moved before Deskzo.
  const eway = carriesGoods(document.docType, document.status) && document.origin !== "IMPORTED" ? await ewayForDocument(document.id) : null;
  const transporters = eway?.ok ? await transporterOptions() : null;

  const qrDataUrl = document.signedQrCode
    ? await QRCode.toDataURL(document.signedQrCode, { margin: 1, width: 160 }).catch(() => null)
    : null;

  const awaitingApproval = Boolean(approval?.required) && document.approvalStatus !== "APPROVED";
  const nextStep = nextStepFor({
    awaitingApproval,
    docType: document.docType,
    status: document.status,
    dueDate: document.dueDate,
    issueDate: document.issueDate,
    validUntil: document.validUntil,
    balance: settlement?.balance ?? null,
    creditRemaining: creditBalance?.remaining ?? null,
    // Not applicable: never reported — a document brought from the old system (src/lib/documents/imported.ts).
    needsIrn: eligible && org.einvoiceEnabled && document.status !== "DRAFT" && !document.irn && document.einvoiceStatus !== "CANCELLED" && document.einvoiceStatus !== "NOT_APPLICABLE",
    asOf: new Date(),
  });
  // What "What's next?" offers to do about it, for whoever may (src/components/documents/next-step-actions.tsx): the
  // page's own actions, the one the words call for.
  const live = document.status !== "CANCELLED" && document.status !== "REJECTED" && document.status !== "DRAFT";
  // Progress invoicing (src/lib/documents/progress-billing.ts): a sent or accepted quote can be billed in stages.
  // Billing a quote in stages, or converting it, raises an invoice — "Create tax invoices".
  const canBill = await viewerHas("docs.createInvoice");
  // The types this person may create, for the Convert buttons (src/lib/documents/permission-keys.ts).
  const creatable: TradeDocumentType[] = [];
  for (const t of conversionTargets[document.docType] ?? []) if (await viewerHas(documentWriteKey(t, "create"))) creatable.push(t);
  // The orders punched from a quote's or proforma's lines (src/lib/orders/from-quote.ts) — listed on it, so the two stay
  // in step; a proforma with any still standing is invoiced from them, never converted whole as well (owner, 17 Nov 2026).
  const punched = document.docType === "PROPOSAL" || document.docType === "PROFORMA" ? await ordersOfQuote(document.id) : [];
  const wording = punched.length ? await getWording() : null;
  // Advances received against a proforma (owner, 17 Nov 2026; src/lib/receivables/proforma-advance.ts), and recording
  // one — for whoever records payments, where Payments is open to them, on a live proforma.
  const advances = document.docType === "PROFORMA" && document.status !== "DRAFT" ? await proformaAdvances(document.id) : [];
  const canRecordAdvance =
    document.docType === "PROFORMA" &&
    ["ISSUED", "ACCEPTED", "PARTIALLY_PAID", "PAID"].includes(document.status) &&
    canRecord &&
    (await moduleAccessFor(viewer.id, "payments")) === "available";
  if (document.docType === "PROFORMA" && punched.some(liveOrder)) creatable.splice(0, creatable.length, ...creatable.filter((t) => t !== "INVOICE"));
  // A delivery challan from a sent proposal, proforma or invoice (owner, 16 Nov 2026), for whoever creates and issues them.
  const canMakeChallan =
    live &&
    !awaitingApproval &&
    (document.docType === "PROPOSAL" || document.docType === "PROFORMA" || document.docType === "INVOICE") &&
    (await viewerHas(documentWriteKey("DELIVERY_CHALLAN", "create"))) &&
    (await viewerHas(documentWriteKey("DELIVERY_CHALLAN", "issue")));
  const progress =
    document.docType === "PROPOSAL" && (document.status === "ISSUED" || document.status === "ACCEPTED") && !awaitingApproval ? await billingProgress(document.id) : null;
  const staged = !!progress && (progress.billedPercent > 0 || progress.stages.length > 0);
  // Billed in stages, "What's next?" says how far it has got and which stage comes next.
  const step =
    staged && progress
      ? progress.leftPercent <= 0
        ? { headline: "Billed in full.", detail: "Every stage of this quote is invoiced — follow the invoices for payment.", tone: "success" as const }
        : {
            headline: `Billing in stages — ${progress.billedPercent}% billed.`,
            detail: progress.next ? `Invoice the next stage, "${progress.next.label}", when it's due.` : `${progress.leftPercent}% of the quote is still to bill.`,
            tone: "info" as const,
          }
      : nextStep;
  const nextActions = {
    convertTo:
      live && !awaitingApproval && (document.docType === "PROPOSAL" || document.docType === "PROFORMA")
        ? // Billed in stages: the rest is billed from its stages, not by converting it whole again.
          creatable.filter((t) => !(staged && t === "INVOICE"))
        : [],
    // A quote's or an issued proforma's lines to orders (src/lib/orders/from-quote.ts), while any is still without one.
    orderHref:
      (document.docType === "PROPOSAL" || document.docType === "PROFORMA") && live && !awaitingApproval && (await isModuleEnabled("orders")) && (await quoteForOrder(document.id, (await requireUser()).id))?.next
        ? `/orders/new?fromQuote=${document.id}`
        : null,
    // On a proforma it reads "Punch order" — what the team calls it (owner, 16 Nov 2026).
    orderLabel: document.docType === "PROFORMA" ? "order" : "sales order",
    nextStage: canBill && progress?.next ? { id: progress.next.id, label: progress.next.label } : null,
    markable:
      document.docType === "PROPOSAL" && live && document.status !== "ACCEPTED" && (await viewerHas(documentWriteKey(document.docType, "issue")))
        ? (["ACCEPTED", "REJECTED"] as const).slice()
        : [],
    projectHref:
      document.docType === "PROPOSAL" && live && (await isModuleEnabled("projects")) && (await viewerHas("projects.manage")) ? `/projects/new?companyId=${document.companyId}` : null,
    payable: !!settlement && settlement.balance >= 1 && canRecord,
    remindable: !!settlement && settlement.balance >= 1 && (document.status === "ISSUED" || document.status === "PARTIALLY_PAID") && !!followUps?.canLog,
  };

  const related = [
    ...(document.sourceDocument ? [{ ...document.sourceDocument, relation: "Converted from" as const }] : []),
    ...(document.againstDocument ? [{ ...document.againstDocument, relation: "Raised against" as const }] : []),
    ...document.conversions.map((d) => ({ ...d, relation: "Converted to" as const })),
    ...document.creditNotes.map((d) => ({ ...d, relation: "Credit note" as const })),
  ];

  return (
    <div className={`@container ${embedded ? "" : "animate-fade-rise"}`}>
      {!embedded && (
        <Link href={documentListPath[document.docType]} className="text-sm text-muted hover:text-text">
          ← {tradeDocumentLabels[document.docType]}s
        </Link>
      )}

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">
              {isDraftNumber(document.docNumber)
                ? `Draft ${tradeDocumentLabels[document.docType].toLowerCase()}`
                : document.docNumber}
            </h1>
            <Badge tone={statusTone[document.status]}>{tradeDocumentStatusLabels[document.status]}</Badge>
            {document.reverseCharge && <Badge tone="amber">Reverse charge</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            <CompanyLink href={companyPath(document.company.companySeq)} className="hover:underline">
              {document.company.name}
            </CompanyLink>
            {" · "}
            {formatCalendarDay(document.issueDate)}
            {document.reference ? ` · Ref ${document.reference}` : ""}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold text-text">{money(document.total)}</div>
          <div className="text-xs text-subtle">{isIntraState ? "CGST + SGST" : singleTax}</div>
        </div>
      </div>

      {cancellation && (
        <div className="mt-4 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-sm">
          <span className="font-medium text-text">
            Cancelled
            {cancellation.at ? ` on ${clock.date(cancellation.at)}` : ""}
            {cancellation.by ? ` by ${cancellation.by}` : ""}
          </span>
          <span className="text-muted"> — {cancellation.reason ?? "no reason was recorded (cancelled before reasons were asked for)."}</span>
        </div>
      )}

      {/* Where the "What's next?" banner would be, and instead of it while sign-off is outstanding. */}
      {/* Approval is on for the type, but this one is under its limits — say so, once, and quietly. */}
      {approval?.enabled && !approval.required && document.status === "DRAFT" && (
        <p className="mt-4 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">{approval.why}</p>
      )}

      {/* Signed off and gone out: one quiet line, as Zoho shows it (owner, 3 Nov 2026), in place of the bar. */}
      {document.approvalStatus === "APPROVED" && document.status !== "DRAFT" && document.approvedBy && (
        <ApprovedByLine
          approvedBy={document.approvedBy.name}
          approvedAt={document.approvedAt}
          submittedBy={document.submittedBy?.name ?? null}
          submittedAt={document.submittedAt}
          note={document.approvalNote}
        />
      )}

      {approval?.required && !(document.approvalStatus === "APPROVED" && document.status !== "DRAFT") && (
        <DocumentApprovalBar
          id={document.id}
          status={document.approvalStatus}
          submittedBy={document.submittedBy?.name ?? null}
          submittedAt={document.submittedAt}
          approvedBy={document.approvedBy?.name ?? null}
          approvedAt={document.approvedAt}
          note={document.approvalNote}
          mayApprove={approval.mayApprove}
          maySubmit={approval.maySubmit}
        />
      )}
      {approval?.noApprover && document.approvalStatus !== "APPROVED" && (
        <p className="mt-2 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">{approval.noApprover}</p>
      )}

      {step && (
        <div
          className={`mt-5 rounded-xl border px-4 py-3 ${
            step.tone === "warning"
              ? "border-warning/40 bg-warning-bg"
              : step.tone === "success"
                ? "border-success/40 bg-success-bg"
                : "border-line bg-surface-sunken"
          }`}
        >
          <div className="text-xs uppercase tracking-wide text-subtle">What&apos;s next?</div>
          <p className="mt-1 text-sm text-text">
            <span className="font-medium">{step.headline}</span>{" "}
            <span className="text-muted">{step.detail}</span>
          </p>
          {/* The action itself, beside the words (owner, 3 Nov 2026 — as Zoho's "What's next?" has it). */}
          <NextStepActions id={document.id} {...nextActions} />
        </div>
      )}

      <Card className="mt-4">
        <CardContent>
          <DocumentActions
            id={document.id}
            docType={document.docType}
            status={document.status}
            einvoiceStatus={document.einvoiceStatus}
            hasIrn={!!document.irn}
            einvoiceEnabled={org.einvoiceEnabled}
            canCancelIrn={isWithinCancellationWindow(document.ackDate)}
            canIssue={await viewerHas(documentWriteKey(document.docType, "issue"))}
            canEdit={await viewerHas(documentWriteKey(document.docType, "edit"))}
            canDelete={await viewerHas(documentWriteKey(document.docType, "delete"))}
            canCancel={await viewerHas(documentWriteKey(document.docType, "cancel"))}
            canCreate={creatable}
            canMakeChallan={canMakeChallan}
            canEmail={
              isEmailable(document.docType) &&
              document.status !== "DRAFT" &&
              document.status !== "CANCELLED" &&
              (await viewerHas("documents.send"))
            }
          />
        </CardContent>
      </Card>

      {isEmailable(document.docType) && <DocumentEmailHistory documentId={document.id} />}

      {eligible && document.einvoiceStatus === "FAILED" && document.einvoiceError && (
        <Card className="mt-4 border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">
          <span className="font-medium">The portal rejected this invoice:</span> {document.einvoiceError}
        </Card>
      )}

      {eway?.ok && (
        <div className="mt-4">
          <EwayPanel view={eway.data} transporters={transporters?.ok ? transporters.data : []} />
        </div>
      )}

      {/* A micro or small vendor's bill: the last day the MSMED Act gives to pay it (owner, 17 Nov 2026 — src/lib/payables/msme.ts). */}
      {document.docType === "BILL" && document.status !== "CANCELLED" && pack.india && (
        <MsmeBillNotice
          bill={{
            companyId: document.companyId,
            companySeq: document.company.companySeq,
            issueDate: document.issueDate,
            dueDate: document.dueDate,
            unpaid: billSettlement ? billSettlement.balance >= 0.01 : document.status !== "PAID",
            draft: document.status === "DRAFT",
          }}
        />
      )}

      {billReading && (
        <p className="mt-4 rounded-base border border-line bg-surface-sunken px-4 py-2 text-sm text-muted">
          Read from the vendor&apos;s file by Arjun —{" "}
          <a href={`/api/bill-readings/${billReading.id}`} target="_blank" rel="noopener" className="font-medium text-brand hover:underline">
            open {billReading.fileName}
          </a>
          {document.status === "DRAFT" ? " to check it against this draft." : "."}
        </p>
      )}

      {/* A vendor's bill against our PO: item, quantity, price and GST, line by line (owner, 16 Nov 2026 — src/lib/purchase/bill-check.ts). */}
      {billCheck && (
        <div className="mt-4">
          <BillPoCheckCard check={billCheck} />
        </div>
      )}

      {billSettlement && (
        <div className="mt-4">
          <BillSettlementPanel billId={document.id} settlement={billSettlement} canRecord={canRecord} />
        </div>
      )}

      {progress && <BillInStages quoteId={document.id} progress={progress} canBill={canBill} />}

      {settlement && (
        <div className="mt-4 scroll-mt-20" id="payments">
          <InvoiceSettlementPanel
            invoiceId={document.id}
            settlement={settlement}
            availableCredits={availableCredits}
            canRecord={canRecord}
            canRemove={canRemove}
            canWriteOff={await hasEffectivePermission(viewer.id, "payments.manage")}
          />
        </div>
      )}

      {payOnline?.ok && (payOnline.data.gateway || payOnline.data.unavailable || payOnline.data.held) && (
        <div className="mt-4">
          <InvoicePayLink
            invoiceId={document.id}
            initial={payOnline.data.link}
            gateway={payOnline.data.gateway}
            unavailable={payOnline.data.unavailable}
            held={payOnline.data.held}
            mayMake={payOnline.data.mayMake}
          />
        </div>
      )}

      {/* Nothing to say on a settled invoice nobody chased: the card appears with a history or a debt. */}
      {followUps && (followUps.history.length > 0 || followUps.canLog) && (
        <div className="mt-4">
          <FollowUpPanel panel={followUps} />
        </div>
      )}

      {creditBalance && (
        <div className="mt-4">
          <CreditNoteApplications
            creditNoteId={document.id}
            balance={creditBalance}
            openInvoices={openInvoices}
            canRecord={canRecord}
          />
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-5 @4xl:grid-cols-3">
        <div className="space-y-5 @4xl:col-span-2">
          {/* Kept within its card: a long item name wraps, and on a narrow screen the table scrolls rather than
              running past the card's edge (owner, 8 Oct 2026). */}
          <Card className="@container overflow-x-auto p-0">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-2.5 pl-4 pr-2">#</th>
                  <th className="px-2 py-2.5">Description</th>
                  {pack.india && <th className="hidden px-2 py-2.5 @2xl:table-cell">HSN</th>}
                  <th className="px-2 py-2.5 text-right">Qty</th>
                  <th className="px-2 py-2.5 text-right">Rate</th>
                  <th className="hidden px-2 py-2.5 text-right @2xl:table-cell">Taxable</th>
                  <th className="px-2 py-2.5 text-right">{pack.tax.name}</th>
                  <th className="py-2.5 pl-2 pr-4 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {document.lines.map((line, index) => (
                  <tr key={line.id} className="border-b border-line last:border-0">
                    <td className="py-2.5 pl-4 pr-2 align-top text-subtle">{index + 1}</td>
                    <td className="break-words px-2 py-2.5 align-top text-text [overflow-wrap:anywhere]">
                      {line.name}
                      {line.description && (
                        <div className="mt-0.5 whitespace-pre-line text-xs text-muted">{line.description}</div>
                      )}
                      {/* Unless the description already says it, as a renewal quote's does. */}
                      {showsServicePeriod(document.docType) &&
                        line.servicePeriodFrom &&
                        line.servicePeriodTo &&
                        !descriptionStatesPeriod(line.description, line.servicePeriodFrom, line.servicePeriodTo) && (
                          <div className="mt-0.5 text-xs text-muted">
                            Service period: {formatServicePeriod(line.servicePeriodFrom, line.servicePeriodTo)}
                          </div>
                        )}
                      {lineSchedules?.get(line.id) && <ScheduleLineNote schedule={lineSchedules.get(line.id)!} />}
                      {pack.india && line.hsnCode && (
                        <div className="font-mono text-xs text-subtle @2xl:hidden">HSN {line.hsnCode}</div>
                      )}
                    </td>
                    {pack.india && (
                      <td className="hidden px-2 py-2.5 align-top font-mono text-xs text-muted @2xl:table-cell">
                        {line.hsnCode ?? "—"}
                      </td>
                    )}
                    <td className="whitespace-nowrap px-2 py-2.5 text-right align-top text-muted">
                      {line.quantity}
                      {line.unit ? ` ${line.unit}` : ""}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right align-top text-muted">
                      {money(line.unitPrice)}
                    </td>
                    <td className="hidden whitespace-nowrap px-2 py-2.5 text-right align-top text-muted @2xl:table-cell">
                      {money(line.taxableValue)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right align-top text-muted">
                      {line.taxRatePercent}%
                      <div className="text-xs text-subtle">
                        {money(line.cgstAmount + line.sgstAmount + line.igstAmount)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pl-2 pr-4 text-right align-top font-medium text-text">
                      {money(line.lineTotal)}
                      <div className="text-xs font-normal text-subtle @2xl:hidden">
                        {money(line.taxableValue)} + GST
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {(document.notes || document.terms) && (
            <Card>
              <CardContent className="space-y-3 text-sm">
                {document.notes && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-subtle">Notes</div>
                    <p className="mt-1 whitespace-pre-wrap text-muted">{document.notes}</p>
                  </div>
                )}
                {document.terms && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-subtle">Terms</div>
                    <p className="mt-1 whitespace-pre-wrap text-muted">{document.terms}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {(document.lead || canLinkLead) && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">{document.docType === "PROPOSAL" ? "For lead" : "Raised from"}</CardHeader>
              <CardContent className="space-y-2 py-3">
                {document.lead ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={leadPath(document.lead.leadSeq)} className="text-sm text-text hover:underline">
                      {document.lead.title}
                    </Link>
                    <Badge tone="default">{document.lead.status.replaceAll("_", " ")}</Badge>
                  </div>
                ) : (
                  <p className="text-sm text-muted">Not linked to a lead, so no lead shows it as its quotation.</p>
                )}
                {canLinkLead && <DocumentLeadLink documentId={document.id} companyId={document.companyId} currentId={document.lead?.id ?? null} />}
              </CardContent>
            </Card>
          )}

          {document.docType === "PROFORMA" && (
            <ProformaAdvances
              proformaId={document.id}
              total={Number(document.total)}
              currency={document.currency}
              canRecord={canRecordAdvance}
              advances={advances.map((a) => ({ ...a, paidOn: a.paidOn.toISOString().slice(0, 10) }))}
            />
          )}

          {punched.length > 0 && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">{wording ? slot(wording, document.docType === "PROFORMA" ? "Orders punched from this proforma" : "Orders from this quote", "order", document.docType === "PROFORMA" ? "{many} punched from this proforma" : "{many} from this quote") : null}</CardHeader>
              <CardContent className="divide-y divide-line">
                {punched.map((o) => (
                  <div key={o.orderSeq} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <Link href={orderPath(o.orderSeq)} className="font-mono text-sm text-text hover:underline">
                        {formatOrderId(o.orderSeq)}
                      </Link>
                      <p className="truncate text-xs text-muted">{o.line}</p>
                    </div>
                    <Badge tone={liveOrder(o) ? (o.status === "FULFILLED" ? "green" : o.status === "PENDING_APPROVAL" ? "amber" : "blue") : "default"}>{wording ? orderStatusLabel(wording, o.status as OrderStatus) : o.status}</Badge>
                  </div>
                ))}
                {document.docType === "PROFORMA" && punched.some(liveOrder) && (
                  <p className="pt-2.5 text-xs text-subtle">Approval, purchase, delivery and the tax invoice carry on from these orders.</p>
                )}
              </CardContent>
            </Card>
          )}

          {related.length > 0 && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Related documents</CardHeader>
              <CardContent className="divide-y divide-line">
                {related.map((rel) => (
                  <div key={`${rel.relation}-${rel.id}`} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-subtle">{rel.relation}</div>
                      <Link href={`/documents/${rel.id}`} className="text-sm text-text hover:underline">
                        {isDraftNumber(rel.docNumber) ? `Draft ${tradeDocumentLabels[rel.docType].toLowerCase()}` : rel.docNumber}
                      </Link>
                    </div>
                    <Badge tone="default">{tradeDocumentLabels[rel.docType]}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Summary</CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Subtotal" value={money(document.subtotal)} />
              {document.discountTotal > 0 && <Row label="Discount" value={`− ${money(document.discountTotal)}`} />}
              {document.shippingCharge > 0 && (
                <Row label="Shipping charges" value={money(document.shippingCharge)} />
              )}
              <Row label="Taxable value" value={money(document.taxableValue)} />
              {isIntraState ? (
                <>
                  <Row label="CGST" value={money(document.cgstAmount)} />
                  <Row label="SGST" value={money(document.sgstAmount)} />
                </>
              ) : (
                <Row label={singleTax} value={money(document.igstAmount)} />
              )}
              {document.withholdingMode !== "NONE" && (
                <Row
                  label={`${document.withholdingMode}${document.withholdingSection ? ` (${document.withholdingSection})` : ""} @ ${document.withholdingRatePercent}%`}
                  value={`${document.withholdingAmount < 0 ? "− " : "+ "}${money(Math.abs(document.withholdingAmount))}`}
                />
              )}
              {document.adjustment !== 0 && (
                <Row label={document.adjustmentLabel || "Adjustment"} value={money(document.adjustment)} />
              )}
              {document.roundOff !== 0 && <Row label="Round off" value={money(document.roundOff)} />}
              <div className="flex items-center justify-between border-t border-line pt-2 text-base font-semibold text-text">
                <span>Total{foreign ? ` (${document.currency})` : ""}</span>
                <span>{money(document.total)}</span>
              </div>
              {foreign && (
                <div className="flex items-center justify-between text-xs text-subtle">
                  <span>1 {document.currency} = {formatRate(rate)}</span>
                  <span>{formatMoney(toBase(document.total, rate), baseCurrency())}</span>
                </div>
              )}
              <p className="pt-1 text-xs text-subtle">{amountInWords(document.total, document.currency)}</p>
            </CardContent>
          </Card>

          {(pack.india || showBranch) && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">{pack.india ? "GST details" : "Branch"}</CardHeader>
              <CardContent className="space-y-2 text-sm">
                {showBranch && (
                  <Row
                    label={isSales ? "Branch" : "Buying branch"}
                    value={
                      <>
                        {document.branch ? branchLabel(document.branch) : "Head office"}
                        {document.branch && !document.branch.active && (
                          <Badge tone="default" className="ml-2">
                            Inactive
                          </Badge>
                        )}
                      </>
                    }
                  />
                )}
                {pack.india && (
                  <>
                    <Row label="Our GSTIN" value={ourGstin ?? "—"} />
                    <Row label="Party GSTIN" value={partyGstin ?? "Unregistered"} />
                    <Row
                      label="Place of supply"
                      value={
                        document.placeOfSupplyCode
                          ? `${document.placeOfSupplyCode} — ${GST_STATE_CODES[document.placeOfSupplyCode] ?? "Unknown"}`
                          : "Not set"
                      }
                    />
                    <Row label="Supply type" value={isIntraState ? "Intra-state" : "Inter-state"} />
                    <Row label="GST treatment" value={gstTreatmentLabels[document.gstTreatment]} />
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {eligible && document.irn && (
            <Card>
              <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
                <span>e-Invoice</span>
                <Badge tone={document.einvoiceStatus === "CANCELLED" ? "default" : "green"}>
                  {document.einvoiceStatus === "CANCELLED" ? "Cancelled" : "Registered"}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {qrDataUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={qrDataUrl} alt="Signed e-invoice QR code" className="rounded-base border border-line bg-white p-1" />
                )}
                <div>
                  <div className="text-xs uppercase tracking-wide text-subtle">IRN</div>
                  <p className="mt-0.5 break-all font-mono text-xs text-muted">{document.irn}</p>
                </div>
                <Row label="Ack no." value={document.ackNo ?? "—"} />
                {/* The IRP's dates are statutory: India's, in every workspace. */}
                <Row label="Ack date" value={indiaClock.date(document.ackDate)} />
                {document.einvoiceCancelledAt && (
                  <>
                    <Row label="Cancelled" value={indiaClock.date(document.einvoiceCancelledAt)} />
                    {document.einvoiceCancelReason && (
                      <p className="text-xs text-subtle">{document.einvoiceCancelReason}</p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="text-sm font-medium text-text">Record</CardHeader>
            <CardContent className="space-y-2 text-sm">
              {/* Named the way the printed document resolves it, not the way the column reads.
                  "Unassigned" beside a quote that went out carrying the account owner's phone
                  number tells whoever is looking the opposite of what the customer received. */}
              {documentDirection[document.docType] === "SALES" && (
                <Row
                  label="Salesperson"
                  value={
                    document.salesperson?.name ??
                    (document.company.owner ? `${document.company.owner.name} — account owner` : "Unassigned")
                  }
                />
              )}
              <Row label="Created by" value={document.createdBy.name} />
              <Row label="Created" value={clock.date(document.createdAt)} />
              <Row label="Issued" value={document.issuedAt ? clock.date(document.issuedAt) : "Not yet issued"} />
              {/* The days typed on the document, held as midnight UTC. */}
              {document.dueDate && <Row label="Due" value={formatCalendarDay(document.dueDate)} />}
              {document.validUntil && <Row label="Valid until" value={formatCalendarDay(document.validUntil)} />}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-muted">
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 break-words text-text">{value}</span>
    </div>
  );
}
