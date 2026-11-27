"use client";

import type { CategoryWithParent } from "@/lib/customers/categories";
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TradeDocumentType, CompanyRelationshipType } from "@prisma/client";
import { Plus, Trash2 } from "lucide-react";
import {
  createTradeDocument,
  updateTradeDocument,
  listPartyLocations,
  listDocumentItems,
  listCreditableInvoices,
  listPartyOrders,
} from "@/actions/trade-document";
import { getNumberSetting, previewNextNumber } from "@/actions/document-number";
import { listPartyLeads, type PartyLead } from "@/actions/document-lead";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, Badge } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import { AnchoredPopover, insideAnchoredPopover } from "@/components/ui/anchored-popover";
import { useComboboxKeyboard } from "@/components/ui/use-combobox-keyboard";
import { AddressEditor } from "@/components/documents/address-editor";
import { NumberSettingsDialog, type NumberSetting } from "@/components/documents/number-settings-dialog";
import { cn, formatCurrency } from "@/lib/utils";
import { computeDocument, resolveSupplyType, stateCodeFromGstin, GST_STATE_OPTIONS, OTHER_COUNTRY_CODE } from "@/lib/gst-engine";
import { isIndia } from "@/lib/geo/countries";
import { workspacePack } from "@/lib/country-pack";
import { gstTreatmentValues, gstTreatmentLabels } from "@/lib/gst";
import { baseCurrency, CURRENCIES, getCurrency, isBaseCurrency, rateHint } from "@/lib/currency";
import { exchangeRateFor, partyCurrencyFor } from "@/actions/exchange-rate";
import { ownPriceFor, type ItemCurrencyPrice } from "@/lib/items/own-price";
import { documentDirection, documentListPath, tradeDocumentLabels } from "@/lib/trade-documents";
import { lineCategory, TAX_CATEGORIES, taxCategoryLabels } from "@/lib/vat/rules";
import { registeredTreatments } from "@/lib/validation/trade-document";
import { blankLine, type AddressDraft, type DocumentFormDefaults, type LineDraft } from "@/lib/document-draft";
import { branchLabel, type BranchChoice } from "@/lib/branches/format";
import type { DocumentBankChoices } from "@/lib/banking/organisation-accounts";
import { GST_NUMBERED_TYPES, expandPrefix } from "@/lib/document-numbering";
import { indiaClock } from "@/lib/time/zone";
import { useClock } from "@/components/time/clock-provider";
import { BillTdsHelper } from "@/components/documents/bill-tds-helper";
import { formatOrderId } from "@/lib/order-id";
import { overBillingWarning } from "@/lib/orders/billing-rules";
import { HSN_PATTERN, normaliseHsn } from "@/lib/items/catalogue-import";
import {
  defaultServicePeriod,
  formatServicePeriod,
  nextLinePeriod,
  orderServicePeriod,
  servicePeriodProblem,
  showsServicePeriod,
  suggestsServicePeriod,
} from "@/lib/documents/service-period";
import { confirmAction } from "@/components/ui/confirm";

type Party = { id: string; name: string; relationshipType: CompanyRelationshipType; customerCategory?: CategoryWithParent | null };
type PartyLocation = Awaited<ReturnType<typeof listPartyLocations>>[number];
type CatalogItem = Awaited<ReturnType<typeof listDocumentItems>>[number];
type CreditableInvoice = Awaited<ReturnType<typeof listCreditableInvoices>>[number];
type PartyOrder = Awaited<ReturnType<typeof listPartyOrders>>[number];

const EMPTY_LOCATIONS: PartyLocation[] = [];
const EMPTY_ORDERS: PartyOrder[] = [];

/** A line's period after its item, order or date moved; never over one somebody typed (`nextLinePeriod`). */
const periodDefault = nextLinePeriod;

/** "ORD-000123 · Microsoft 365 × 10 · 1 Oct 2026 – 30 Sep 2027", for the order picker. */
function orderLabel(order: PartyOrder): string {
  // `orderServicePeriod` reads the order's stored start and end as the days of its term.
  const term = orderServicePeriod(order);
  return `${formatOrderId(order.orderSeq)} · ${order.item.name} × ${order.quantity}${term ? ` · ${formatServicePeriod(term.from, term.to)}` : ""}`;
}

// GST's slabs, 40 since 22 Sep 2025, and the special rates for precious stones (0.25) and gold and silver (3).
const GST_RATES = ["0", "0.25", "3", "5", "12", "18", "28", "40"];

/**
 * The rates a line or the shipping can pick: GST's in India, the workspace's country pack's elsewhere
 * (src/lib/country-pack.ts) — with the one already chosen kept, so an older document opens unchanged.
 */
function taxRateChoices(current: string): string[] {
  const pack = workspacePack();
  const rates = pack.india ? GST_RATES : pack.tax.rates.map(String);
  return current === "" || rates.includes(current) ? rates : [...rates, current];
}

/**
 * Whether a stored number is one this series generated: its prefix, expanded for the document's date,
 * then digits only. The server's own test (`isAutoNumberOf`) for renumbering a moved draft — a number
 * somebody typed is never renumbered. The financial year in a prefix is India's (a GST series runs
 * April to March), so the day is read on India's clock in every workspace.
 */
function generatedBy(setting: NumberSetting, docNumber: string, issueDate: string) {
  const prefix = expandPrefix(setting.prefix, indiaClock.startOfDay(issueDate) ?? new Date(), setting.ctx ?? {});
  return docNumber.startsWith(prefix) && /^\d+$/.test(docNumber.slice(prefix.length));
}

export function DocumentForm({
  docType,
  parties,
  branches,
  defaultTerms,
  roundOffTotals,
  numberSetting,
  salespeople,
  defaults,
  bank,
}: {
  docType: TradeDocumentType;
  parties: Party[];
  salespeople: { id: string; name: string; email?: string | null; phone?: string | null }[];
  /**
   * Where the document can be raised from (on a purchase, who is buying): the active branches, head
   * office first, plus an edited draft's own if it has since been deactivated. The picker shows only
   * when there is a choice, so a single-branch company sees the form it always had.
   */
  branches: BranchChoice[];
  /** The organisation's terms — the fallback for a branch without its own. */
  defaultTerms: string | null;
  roundOffTotals: boolean;
  /** The series the starting branch numbers from: `getNumberSetting(docType, defaults.branchId)`. */
  numberSetting: NumberSetting;
  defaults: DocumentFormDefaults;
  /**
   * The organisation's bank accounts a sales document may print (src/lib/banking/organisation-accounts.ts).
   * The picker shows only when there are any; left on "default", the branch's account or the primary prints.
   */
  bank?: DocumentBankChoices;
}) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // One key for every try of a new document — a double click or a retry makes one draft (src/lib/request-once.ts).
  const [requestId] = useState(() => crypto.randomUUID());
  /** Prefix for ids that tie captions to their controls, unique per mount of this form. */
  const fieldId = useId();

  const headOfficeId = branches.find((b) => b.isHeadOffice)?.id ?? "";
  /** Where this form started: the draft's branch, or the writer's own, else the head office. */
  const startBranchId = defaults.branchId || headOfficeId || branches[0]?.id || "";
  const [branchId, setBranchId] = useState(startBranchId);
  /** Declared after the state it reads, like `chosenSalesperson` below. Unset only for a credit note
   *  whose invoice came from a branch since deactivated, which the picker names without its details. */
  const selectedBranch = branches.find((b) => b.id === branchId);
  /** Our side's GST state: the branch's registration, else its address — what decides CGST+SGST or IGST. */
  const sellerStateCode = selectedBranch?.stateCode ?? null;
  const gstNumbered = GST_NUMBERED_TYPES.includes(docType);

  const [bankAccountId, setBankAccountId] = useState(bank?.current ?? "");
  const [docNumber, setDocNumber] = useState(defaults.docNumber);
  const [numberMode, setNumberMode] = useState(numberSetting.mode);
  /**
   * The series the chosen branch numbers from (what the gear edits) and its next number. Swapped when
   * the branch changes, since per-GSTIN or per-branch numbering gives each branch its own.
   */
  const [series, setSeries] = useState({ branchId: startBranchId, setting: numberSetting, preview: defaults.docNumber });
  /**
   * The number this form generated and put in the field, while it is still there — a new document's
   * preview, or one the gear produced. A number that no longer matches was typed, and is left alone
   * when the branch changes. Null on an edit: the stored number is the server's to renumber.
   */
  const [generatedNumber, setGeneratedNumber] = useState<string | null>(defaults.id ? null : defaults.docNumber);
  const [numberLoading, startNumberLookup] = useTransition();
  /** Which branch change is the latest, so a slower answer for an earlier one is dropped. */
  const numberRequest = useRef(0);
  const [companyId, setCompanyId] = useState(defaults.companyId);
  const [fetchedLocations, setFetchedLocations] = useState<{ companyId: string; rows: PartyLocation[] }>({
    companyId: "",
    rows: EMPTY_LOCATIONS,
  });
  const [locationId, setLocationId] = useState(defaults.locationId);
  /** India's GST fields, place of supply and TDS, or the one tax of another country's pack (owner, 30 Oct 2026). */
  const pack = workspacePack();
  const [gstTreatment, setGstTreatment] = useState(defaults.gstTreatment);
  const [currency, setCurrency] = useState(defaults.currency ?? baseCurrency());
  const [exchangeRate, setExchangeRate] = useState(String(defaults.exchangeRate ?? 1));
  const [rateNote, setRateNote] = useState<string | null>(null);
  const [rateLoading, startRateLookup] = useTransition();
  /** Set the moment somebody edits the field, so a later lookup never overwrites their figure. */
  const [rateTouched, setRateTouched] = useState(false);
  /**
   * Set once somebody picks the currency themselves, so picking the party afterwards never switches it to the party's
   * own (owner, 30 Oct 2026). A ref as well: the party's answer arrives in an async callback.
   */
  const currencyTouchedRef = useRef(false);
  const rateTouchedRef = useRef(rateTouched);
  rateTouchedRef.current = rateTouched;
  /** Which party pick is the latest, so a slower answer for an earlier one is dropped. */
  const partyCurrencyRequest = useRef(0);

  /** Every figure on this document, in the currency the customer will read it in. */
  const money = (value: number | string | null | undefined) => formatCurrency(value, currency);
  const symbol = getCurrency(currency).symbol;

  /**
   * A rupee catalogue price, in the currency of this document.
   *
   * Rounded to the currency's own precision rather than left at eight decimal places — a quote
   * reading $870.87 is one somebody can discuss; $870.8708708 is one they query.
   */
  /**
   * Ask what the currency was worth on the document's own date.
   *
   * Never overwrites a figure somebody typed: the looked-up rate is a starting point and the
   * agreed rate is the one that counts. Failure is reported in the hint line and nothing else
   * happens — the field still works.
   */
  function fetchRate(code: string, onDate: string, force = false) {
    if (isBaseCurrency(code) || !onDate) return;
    if (rateTouched && !force) return;
    setRateNote("Looking up the rate…");
    startRateLookup(async () => {
      // The workspace's exchange-rate table first (Settings › Currencies), looked up and kept where it has none.
      const result = await exchangeRateFor(code, onDate);
      if (!result.ok) {
        setRateNote(result.reason);
        return;
      }
      setExchangeRate(String(result.rate));
      setRateTouched(false);
      setRateNote(`${result.source}, ${result.onDate}`);
    });
  }

  /**
   * A new document starts in the party's own currency at the day's rate (owner, 30 Oct 2026) — unless somebody has
   * already chosen the currency or typed a rate, which stand. A party in the workspace's currency puts it back to that.
   * Never on an edit: the party can't change there, and a saved document keeps what it was written in.
   */
  function adoptPartyCurrency(partyId: string) {
    if (defaults.id || !partyId || currencyTouchedRef.current || rateTouchedRef.current) return;
    const request = ++partyCurrencyRequest.current;
    startRateLookup(async () => {
      const terms = await partyCurrencyFor(partyId, issueDate);
      if (!terms || request !== partyCurrencyRequest.current) return;
      if (currencyTouchedRef.current || rateTouchedRef.current) return;
      setCurrency(terms.currency);
      setExchangeRate(String(terms.exchangeRate));
      setRateTouched(false);
      setRateNote(isBaseCurrency(terms.currency) ? null : "Their own currency, at the day's rate");
    });
  }

  function catalogPriceInDocumentCurrency(rupees: number): number {
    const rate = Number(exchangeRate) || 1;
    if (isBaseCurrency(currency) || rate <= 0) return rupees;
    const places = getCurrency(currency).decimals;
    const factor = 10 ** places;
    return Math.round((rupees / rate) * factor) / factor;
  }
  const [buyerGstin, setBuyerGstin] = useState(defaults.buyerGstin);
  const [placeOverride, setPlaceOverride] = useState(defaults.placeOfSupplyCode);
  const [placeTouched, setPlaceTouched] = useState(!!defaults.placeOfSupplyCode);
  const [reverseCharge, setReverseCharge] = useState(defaults.reverseCharge);
  const [issueDate, setIssueDate] = useState(defaults.issueDate);
  const [dueDate, setDueDate] = useState(defaults.dueDate);
  const [validUntil, setValidUntil] = useState(defaults.validUntil);
  const [reference, setReference] = useState(defaults.reference);
  const [salespersonId, setSalespersonId] = useState(defaults.salespersonId);
  /** Declared after the state it reads: `.find()` runs during render, so hoisting it above the
   *  `useState` throws on the dead zone rather than reading an undefined. */
  const chosenSalesperson = salespeople.find((p) => p.id === salespersonId);
  const [notes, setNotes] = useState(defaults.notes);
  const [terms, setTerms] = useState(defaults.terms || selectedBranch?.invoiceTerms || defaultTerms || "");

  const [dispatchFrom, setDispatchFrom] = useState(defaults.dispatchFromAddress || selectedBranch?.dispatchAddress || "");
  const [billing, setBilling] = useState<AddressDraft>(defaults.billing);
  /**
   * Once someone edits the address by hand, an arriving location must not overwrite it. Held in a
   * ref as well as state because the locations effect reads it from inside an async callback, where
   * a captured state value would be whatever it was when the fetch started.
   */
  const [billingTouched, setBillingTouched] = useState(!!defaults.id);
  const billingTouchedRef = useRef(billingTouched);
  billingTouchedRef.current = billingTouched;
  const locationIdRef = useRef(defaults.locationId);
  const [shippingSame, setShippingSame] = useState(defaults.shippingSameAsBilling);
  const [shipping, setShipping] = useState<AddressDraft>(defaults.shipping);
  const [shippingGstin, setShippingGstin] = useState(defaults.shippingGstin);

  const [shippingCharge, setShippingCharge] = useState(defaults.shippingCharge);
  const [shippingTaxRate, setShippingTaxRate] = useState(defaults.shippingTaxRatePercent);
  const [withholdingMode, setWithholdingMode] = useState(defaults.withholdingMode);
  const [withholdingSection, setWithholdingSection] = useState(defaults.withholdingSection);
  const [withholdingRate, setWithholdingRate] = useState(defaults.withholdingRatePercent);
  const [adjustmentLabel, setAdjustmentLabel] = useState(defaults.adjustmentLabel);
  const [adjustment, setAdjustment] = useState(defaults.adjustment);

  const [againstDocumentId, setAgainstDocumentId] = useState(defaults.againstDocumentId);
  const [fetchedCreditable, setFetchedCreditable] = useState<{ companyId: string; rows: CreditableInvoice[] }>({
    companyId: "",
    rows: [],
  });
  const [fetchedOrders, setFetchedOrders] = useState<{ companyId: string; rows: PartyOrder[] }>({
    companyId: "",
    rows: EMPTY_ORDERS,
  });
  const [lines, setLines] = useState<LineDraft[]>(defaults.lines.length > 0 ? defaults.lines : [blankLine()]);

  const isSales = documentDirection[docType] === "SALES";

  /**
   * Lines priced from the catalogue on this form and not retyped since, by line key (owner, 30 Oct 2026): the item, its
   * base price and its own prices in other currencies. Changing the document's currency or rate re-prices these — the
   * item's own price in the new currency, else its base price converted — and leaves alone every line whose price was
   * typed, came from an order, or came with the page (a saved document's, an order's, a lead's).
   */
  const [catalogPicks, setCatalogPicks] = useState<Record<string, { itemId: string; basePrice: number; own: ItemCurrencyPrice[] }>>({});
  /** What the picked lines were last priced at, so a change of either is noticed during render (no effect needed). */
  const [pricedAt, setPricedAt] = useState({ currency, exchangeRate });

  /**
   * A catalogue item's price on this document: its own price in the document's currency (the cost price first on a
   * purchase), else its base price converted at the rate. Null where it has to convert and the rate isn't usable yet.
   */
  function catalogLinePrice(pick: { basePrice: number; own: readonly ItemCurrencyPrice[] }, code: string, rateText: string): number | null {
    if (isBaseCurrency(code)) return pick.basePrice;
    const own = ownPriceFor(pick.own, code, { purchase: !isSales });
    if (own !== null) return own;
    const rate = Number(rateText);
    if (!(rate > 0)) return null;
    const factor = 10 ** getCurrency(code).decimals;
    return Math.round((pick.basePrice / rate) * factor) / factor;
  }

  if (pricedAt.currency !== currency || pricedAt.exchangeRate !== exchangeRate) {
    // A currency changed on its own still has the old currency's rate (the new one is being looked up), so only lines
    // with their own price in it move now; the rest follow when the rate arrives. Both changed together (the party's
    // currency, back to the base) re-prices everything.
    const rateMoved = pricedAt.exchangeRate !== exchangeRate;
    setPricedAt({ currency, exchangeRate });
    if (Object.keys(catalogPicks).length > 0) {
      setLines((prev) =>
        prev.map((l) => {
          const pick = catalogPicks[l.key];
          if (!pick || pick.itemId !== l.itemId || l.companyProductId) return l;
          if (!rateMoved && !isBaseCurrency(currency) && ownPriceFor(pick.own, currency, { purchase: !isSales }) === null) return l;
          const price = catalogLinePrice(pick, currency, exchangeRate);
          return price === null ? l : { ...l, unitPrice: String(price) };
        }),
      );
    }
  }

  const isCreditNote = docType === "CREDIT_NOTE";
  // A credit or debit note is raised against an issued invoice (owner, 23 Oct 2026 for the debit note).
  const isNote = isCreditNote || docType === "DEBIT_NOTE";
  const isProposal = docType === "PROPOSAL";
  const [leadId, setLeadId] = useState(defaults.leadId);
  const [fetchedLeads, setFetchedLeads] = useState<{ companyId: string; rows: PartyLead[] }>({ companyId: "", rows: [] });
  const w = useWording();
  const gstinRequired = registeredTreatments.includes(gstTreatment as (typeof registeredTreatments)[number]);

  // Locations decide the default addresses and the place of supply, so they're fetched as soon as a
  // party is picked rather than shipping every company's down to the browser.
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    listPartyLocations(companyId).then((rows) => {
      if (cancelled) return;
      setFetchedLocations({ companyId, rows });
      const keep = rows.find((r) => r.id === locationIdRef.current);
      const chosen = keep ?? rows[0] ?? null;
      setLocationId(chosen?.id ?? "");
      // Only when nobody has hand-edited the address — re-adopting would discard their edit.
      if (!billingTouchedRef.current) adoptLocation(chosen);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  useEffect(() => {
    if (!isNote || !companyId) return;
    let cancelled = false;
    listCreditableInvoices(companyId).then((rows) => {
      if (!cancelled) setFetchedCreditable({ companyId, rows });
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, isNote]);

  // The customer's orders, for each line's "Bills order" picker. Sales only: a purchase is the
  // vendor's bill, not a charge against our customer's order.
  useEffect(() => {
    if (!isSales || !companyId) return;
    let cancelled = false;
    listPartyOrders(companyId, defaults.id).then((rows) => {
      if (!cancelled) setFetchedOrders({ companyId, rows });
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, isSales, defaults.id]);

  // Which deal a proposal is for (owner, 19 Oct 2026; src/actions/document-lead.ts): the customer's leads,
  // asked for once one is chosen. A new proposal for a customer with one open lead is that lead's; one
  // opened from a lead keeps it; a draft keeps what it has. Invoices never ask — they take the lead of what
  // they were made from.
  useEffect(() => {
    if (!isProposal || !companyId) return;
    let cancelled = false;
    listPartyLeads(companyId).then((rows) => {
      if (cancelled) return;
      setFetchedLeads({ companyId, rows });
      setLeadId((current) => {
        if (current && rows.some((r) => r.id === current)) return current;
        if (defaults.id || (current && current === defaults.leadId && companyId === defaults.companyId)) return current;
        const open = rows.filter((r) => r.open);
        return open.length === 1 ? open[0]!.id : "";
      });
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, isProposal, defaults.id, defaults.leadId, defaults.companyId]);

  locationIdRef.current = locationId;

  const locations = fetchedLocations.companyId === companyId ? fetchedLocations.rows : EMPTY_LOCATIONS;
  const creditable = fetchedCreditable.companyId === companyId ? fetchedCreditable.rows : [];
  const orders = fetchedOrders.companyId === companyId ? fetchedOrders.rows : EMPTY_ORDERS;
  // The open leads, and the one linked even if it has closed since.
  const leadChoices = (fetchedLeads.companyId === companyId ? fetchedLeads.rows : []).filter((l) => l.open || l.id === leadId);

  /**
   * On a tax invoice, each order its lines bill against what it has already been invoiced (owner, 15 Oct
   * 2026): billed in full, more than is left, or already on another draft. The lines say so; saving asks.
   */
  const orderWarnings = useMemo(() => {
    const out: Record<string, string> = {};
    if (docType !== "INVOICE") return out;
    const totals = new Map<string, number>();
    for (const l of lines) if (l.companyProductId) totals.set(l.companyProductId, (totals.get(l.companyProductId) ?? 0) + (Number(l.quantity) || 0));
    for (const [id, quantity] of totals) {
      const order = orders.find((o) => o.id === id);
      const warning = order ? overBillingWarning(order.billing, quantity) : null;
      if (warning) out[id] = `${formatOrderId(order!.orderSeq)}: ${warning}`;
    }
    return out;
  }, [docType, lines, orders]);
  /** A quote, proforma, invoice or credit note carries a service period per line; a purchase doesn't, for now. */
  const periodShown = showsServicePeriod(docType);

  const partyStateCode =
    billing.stateCode ||
    stateCodeFromGstin(buyerGstin) ||
    null;

  // The place of supply follows the billing state until someone overrides it — a bill-to/ship-to
  // split is real but uncommon, and defaulting it wrong taxes the whole document incorrectly. On a
  // purchase it is the buying branch's own state, as the server defaults it.
  const placeOfSupplyCode = placeTouched ? placeOverride : ((isSales ? partyStateCode : sellerStateCode) ?? "");
  const supplyType = resolveSupplyType(isSales ? sellerStateCode : partyStateCode, placeOfSupplyCode || null);

  // A credit or debit note is raised by the branch that issued its invoice; once one is chosen, the picker
  // shows that branch and can't be changed (the server refuses any other).
  const followsInvoice = isNote && Boolean(againstDocumentId);

  /**
   * Editing a draft: moving it to a branch that numbers in another series renumbers it when saved,
   * and the old number is left as a gap (owner decision Q9, CA question C2). The server's rule,
   * shown in advance — only for a number its old series generated, and only while it is left as stored.
   */
  const renumbering =
    defaults.id !== undefined &&
    series.branchId !== startBranchId &&
    series.setting.ownerKey !== numberSetting.ownerKey &&
    docNumber.trim() === defaults.docNumber &&
    generatedBy(numberSetting, defaults.docNumber, defaults.issueDate);

  /**
   * Moves the document to another branch. An event, so everything that follows the branch is set here
   * rather than mirrored in an effect. The dispatch-from address and the terms follow it unless
   * somebody wrote their own — text that still reads as the old branch filled it in, or is blank,
   * counts as untouched (on an edited draft too, where a flag set at load could only guess).
   */
  function chooseBranch(nextId: string) {
    if (!nextId || nextId === branchId) return;
    const from = selectedBranch;
    const to = branches.find((b) => b.id === nextId);
    setBranchId(nextId);
    if (to) {
      if (!dispatchFrom.trim() || dispatchFrom === (from?.dispatchAddress ?? "")) setDispatchFrom(to.dispatchAddress);
      const termsOf = (b: BranchChoice | undefined) => b?.invoiceTerms ?? defaultTerms ?? "";
      if (!terms.trim() || terms === termsOf(from)) setTerms(termsOf(to));
    }
    followSeries(nextId);
  }

  /**
   * The chosen branch's numbering: the series the gear edits and, when the field still holds the
   * number this form generated, that series' next number in its place (`adopt`). An answer that
   * arrives after a later change is dropped, as the locations effect drops a superseded party's.
   */
  function followSeries(forBranchId: string, adopt = true) {
    const ticket = ++numberRequest.current;
    const shown = docNumber;
    const replace = adopt && numberMode === "AUTO" && generatedNumber !== null && docNumber === generatedNumber;
    startNumberLookup(async () => {
      const [setting, preview] = await Promise.all([
        getNumberSetting(docType, forBranchId || null),
        previewNextNumber(docType, forBranchId || null),
      ]);
      if (ticket !== numberRequest.current) return;
      setSeries({ branchId: forBranchId, setting, preview });
      setNumberMode(setting.mode);
      if (replace && setting.mode === "AUTO" && preview) {
        // Only over the generated number: one typed while this was on its way is theirs.
        setDocNumber((current) => (current === shown ? preview : current));
        setGeneratedNumber(preview);
      }
    });
  }

  /** Pulls the billing address and GST details from a location the user just chose. */
  function adoptLocation(location: PartyLocation | null) {
    if (!location) return;
    const abroad = !isIndia(location.country);
    // Abroad is "Other Country" (96); a foreign state name is never matched against India's list.
    const stateCode =
      stateCodeFromGstin(location.gstNumber) ??
      (abroad ? OTHER_COUNTRY_CODE : GST_STATE_OPTIONS.find((s) => s.name.toLowerCase() === (location.state ?? "").trim().toLowerCase())?.code) ??
      "";
    const next: AddressDraft = {
      attention: "",
      line1: location.address ?? "",
      line2: "",
      city: location.city ?? "",
      state: location.state ?? "",
      stateCode,
      pincode: location.pincode ?? "",
      // The location's own country — this said "India" whatever the address was.
      country: abroad ? (location.country ?? "").trim() : "India",
      phone: "",
    };
    setBilling(next);
    if (shippingSame) setShipping(next);
    // The treatment follows the registration: a location with a GSTIN on file is a registered party.
    if (location.gstNumber) {
      setBuyerGstin(location.gstNumber);
      setGstTreatment("REGISTERED_REGULAR");
    } else {
      setBuyerGstin("");
      setGstTreatment("UNREGISTERED");
    }
  }

  const totals = useMemo(
    () =>
      computeDocument(
        lines.map((l) => ({
          quantity: Number(l.quantity) || 0,
          unitPrice: Number(l.unitPrice) || 0,
          discountMode: l.discountMode === "AMOUNT" ? ("AMOUNT" as const) : ("PERCENT" as const),
          discountValue: Number(l.discountValue) || 0,
          taxRatePercent: Number(l.taxRatePercent) || 0,
        })),
        supplyType,
        {
          shippingCharge: Number(shippingCharge) || 0,
          shippingTaxRatePercent: Number(shippingTaxRate) || 0,
          withholdingMode: withholdingMode as "NONE" | "TDS" | "TCS",
          withholdingRatePercent: Number(withholdingRate) || 0,
          adjustment: Number(adjustment) || 0,
          roundOff: roundOffTotals,
          taxSelfAssessed: !pack.india && reverseCharge && !isSales,
        },
      ),
    [lines, supplyType, shippingCharge, shippingTaxRate, withholdingMode, withholdingRate, adjustment, roundOffTotals, pack.india, reverseCharge, isSales],
  );

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function applyCatalogItem(key: string, item: CatalogItem) {
    const line = lines.find((l) => l.key === key);
    updateLine(key, {
      // A different item is no longer the order it was taken from.
      companyProductId: "",
      itemType: item.type,
      // A subscription starts with a year from the document's date — unless a period was
      // typed, or this type of document doesn't carry one (a purchase, for now).
      ...(line && periodShown ? periodDefault(line, defaultServicePeriod({ item, issueDate })) : {}),
      itemId: item.id,
      name: item.name,
      // The catalogue's own description seeds the line, and stays editable — a quote often needs
      // to say something about this sale that the catalogue can't know.
      description: item.description ?? "",
      hsnCode: item.hsnCode ?? "",
      unit: item.unit ?? "",
      // Converted, not copied. The catalogue is priced in rupees; dropping ₹72,500 straight into
      // a dollar quote makes it $72,500, which is the single most expensive mistake this form
      // could make and looks entirely normal on the way past. Unless the item has its own price
      // in this currency (owner, 30 Oct 2026) — a licence's real dollar list price — which it takes as it is.
      unitPrice: String(catalogLinePrice(pickOf(item), currency, exchangeRate) ?? catalogPriceInDocumentCurrency(item.sellingPrice ?? 0)),
      taxRatePercent: String(item.taxRatePercent ?? 0),
      taxCategory: item.taxCategory ?? "",
    });
    setCatalogPicks((now) => ({ ...now, [key]: { itemId: item.id, ...pickOf(item) } }));
  }

  function pickOf(item: CatalogItem) {
    return { basePrice: item.sellingPrice ?? 0, own: item.currencyPrices ?? [] };
  }

  /** The line is no longer the catalogue's to price: retyped, or taken from an order. */
  function forgetPick(key: string) {
    if (!catalogPicks[key]) return;
    setCatalogPicks((now) => {
      const next = { ...now };
      delete next[key];
      return next;
    });
  }

  /**
   * Bills one of the customer's orders on this line: fills it from the order, links it
   * (`companyProductId`), and takes the order's term as the service period unless one was typed.
   * Unlinking leaves the line as it reads, and drops a period that only came from the order.
   */
  function applyOrder(key: string, orderId: string) {
    const line = lines.find((l) => l.key === key);
    if (!line) return;
    const order = orders.find((o) => o.id === orderId);
    forgetPick(key);
    if (!order) {
      const fromItem = defaultServicePeriod({ item: { type: line.itemType }, issueDate });
      updateLine(key, { companyProductId: "", ...(line.periodSource === "order" ? periodDefault(line, fromItem) : {}) });
      return;
    }
    const item = order.item;
    updateLine(key, {
      companyProductId: order.id,
      itemId: item.id,
      itemType: item.type,
      name: item.name,
      description: line.description || item.description || "",
      hsnCode: item.hsnCode ?? "",
      unit: item.unit ?? "",
      quantity: String(order.quantity),
      // What was agreed on the order, else the catalogue's price — in this document's currency either way.
      unitPrice: String(catalogPriceInDocumentCurrency(order.unitPrice ?? item.sellingPrice ?? 0)),
      taxRatePercent: String(item.taxRatePercent ?? 0),
      taxCategory: "",
      ...periodDefault(line, defaultServicePeriod({ order, item, issueDate })),
    });
  }

  /** The document's date moved: a period that is one billing cycle from it moves with it. */
  function changeIssueDate(next: string) {
    setIssueDate(next);
    if (!periodShown || !clock.startOfDay(next)) return;
    setLines((prev) =>
      prev.map((l) =>
        l.periodSource === "item"
          ? { ...l, ...periodDefault(l, defaultServicePeriod({ item: { type: l.itemType }, issueDate: next })) }
          : l,
      ),
    );
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    // Billing an order again, or for more than is left (owner, 15 Oct 2026): said on the line, asked here.
    const overBilled = [...new Set(Object.values(orderWarnings))];
    if (overBilled.length > 0 && !(await confirmAction(`${overBilled.join("\n\n")}\n\nSave anyway?`))) return;

    const payload = {
      ...(defaults.id ? { id: defaults.id } : { requestId }),
      docType,
      docNumber,
      companyId,
      locationId,
      placeOfSupplyCode,
      gstTreatment,
      // The party's GSTIN, whichever side they are on — the payload keeps its historical name.
      buyerGstin,
      reverseCharge,
      // Blank where there was no choice to make: with one branch, or a credit note following its
      // invoice, the server applies the same answer itself.
      branchId: branches.length > 1 && !followsInvoice ? branchId : "",
      // Left out where there is no picker: the server then leaves the document's account as it was.
      ...(isSales && bank && bank.accounts.length > 0 ? { bankAccountId } : {}),
      currency,
      // Forced back to 1 on a rupee document rather than left at whatever was typed before
      // somebody switched back — the schema refuses the mismatch, and failing validation on a
      // field they have already hidden would be a dead end.
      exchangeRate: isBaseCurrency(currency) ? 1 : Number(exchangeRate) || 1,
      issueDate,
      dueDate,
      validUntil,
      reference,
      salespersonId,
      notes,
      terms,
      dispatchFromAddress: dispatchFrom,
      billing,
      shippingSameAsBilling: shippingSame,
      shipping: shippingSame ? billing : shipping,
      shippingGstin,
      shippingCharge,
      shippingTaxRatePercent: shippingTaxRate,
      withholdingMode,
      withholdingSection,
      withholdingRatePercent: withholdingRate,
      adjustmentLabel,
      adjustment,
      sourceDocumentId: defaults.sourceDocumentId,
      // A proposal's is chosen on the form ("For lead"). Anything else has no control for it: its deal is
      // where it was opened or made from, and a picker would only invite someone to attribute an invoice
      // to the wrong lead.
      leadId: isProposal ? leadId : defaults.leadId,
      againstDocumentId,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        // Carried through every save: the form replaces the lines wholesale, so a link it doesn't
        // send back is a link the edit deletes.
        companyProductId: l.companyProductId,
        servicePeriodFrom: l.servicePeriodFrom,
        servicePeriodTo: l.servicePeriodTo,
        billingMilestoneId: l.billingMilestoneId,
        name: l.name,
        description: l.description,
        hsnCode: l.hsnCode,
        unit: l.unit,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountMode: l.discountMode,
        discountValue: l.discountValue,
        taxRatePercent: l.taxRatePercent,
        taxCategory: pack.india ? "" : l.taxCategory,
      })),
    };

    startTransition(async () => {
      const result = defaults.id ? await updateTradeDocument(payload) : await createTradeDocument(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/documents/${result.data.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="animate-fade-rise space-y-5">
      {/* Here rather than on the page, so it follows the branch chosen below. */}
      {pack.india && selectedBranch && !sellerStateCode && (
        <Card className="border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          {branches.length > 1
            ? `${branchLabel(selectedBranch)} has no GSTIN or state set, so its documents will be taxed as inter-state (IGST).`
            : "Your organisation's GSTIN and state aren't set, so every document will be taxed as inter-state (IGST)."}{" "}
          Set your GSTIN under Settings → Organisation (head office) or Settings → Branches &amp; GST registrations.
        </Card>
      )}

      <Card>
        <CardHeader className="text-sm font-medium text-text">
          {isSales ? "Customer" : "Vendor"} &amp; addresses
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="companyId">
                {isSales ? "Customer name" : "Vendor name"} <span className="text-danger">*</span>
              </Label>
              <CompanyCombobox
                id="companyId"
                companies={parties.map((p) => ({
                  ...p,
                  hint: p.relationshipType === "RESELLER" ? "(reseller)" : undefined,
                }))}
                value={companyId}
                onSelect={(company) => {
                  setCompanyId(company?.id ?? "");
                  setBillingTouched(false);
                  if (company) adoptPartyCurrency(company.id);
                }}
                disabled={!!defaults.id}
                placeholder={isSales ? "Type to search customers…" : "Type to search vendors…"}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="locationId">Location on file</Label>
              <Select
                id="locationId"
                value={locationId}
                onChange={(e) => {
                  setLocationId(e.target.value);
                  setBillingTouched(false);
                  adoptLocation(locations.find((l) => l.id === e.target.value) ?? null);
                }}
              >
                <option value="">No location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                    {l.city ? ` — ${l.city}` : ""}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-subtle">Fills the billing address{pack.india ? " and GST details" : ""} below.</p>
            </div>

            {pack.india && (
              <div className="space-y-1.5">
                <Label htmlFor="placeOfSupplyCode">
                  Place of supply <span className="text-danger">*</span>
                </Label>
                <Select
                  id="placeOfSupplyCode"
                  value={placeOfSupplyCode}
                  onChange={(e) => {
                    setPlaceTouched(true);
                    setPlaceOverride(e.target.value);
                  }}
                >
                  <option value="">Not set</option>
                  {GST_STATE_OPTIONS.map((s) => (
                    <option key={s.code} value={s.code}>
                      [{s.code}] {s.name}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-subtle">
                  {supplyType === "INTRA_STATE" ? "Intra-state — CGST + SGST" : "Inter-state — IGST"}
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-5 border-t border-line pt-4 sm:grid-cols-3">
            <div className="space-y-1">
              {/* The caption is a styled `<span>`, not a `<label>`, so `aria-labelledby` points at it
                  rather than pairing it — that leaves the wording in one place and the styling alone. */}
              <span id={`${fieldId}-dispatch-from`} className="text-xs uppercase tracking-wide text-subtle">
                Dispatch from
              </span>
              <Textarea
                rows={4}
                value={dispatchFrom}
                onChange={(e) => setDispatchFrom(e.target.value)}
                placeholder="Where the goods leave from"
                aria-labelledby={`${fieldId}-dispatch-from`}
                className="text-sm"
              />
            </div>

            <AddressEditor
              title="Billing address"
              value={billing}
              onChange={(next) => {
                setBillingTouched(true);
                setBilling(next);
                if (shippingSame) setShipping(next);
              }}
              emptyText="Pick a location, or add one here."
            />

            <AddressEditor
              title="Shipping address"
              value={shippingSame ? billing : shipping}
              onChange={(next) => {
                setShippingSame(false);
                setShipping(next);
              }}
              disabled={shippingSame}
              emptyText="Same as billing."
              action={
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={shippingSame}
                    onChange={(e) => {
                      setShippingSame(e.target.checked);
                      if (e.target.checked) setShipping(billing);
                    }}
                    className="h-3.5 w-3.5 accent-[var(--brand)]"
                  />
                  Same as billing
                </label>
              }
            />
          </div>

          <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="currency">Currency</Label>
              <Select
                id="currency"
                value={currency}
                onChange={(e) => {
                  const next = e.target.value;
                  currencyTouchedRef.current = true;
                  setCurrency(next);
                  if (isBaseCurrency(next)) {
                    // Back to rupees: the rate must go back to 1 or the schema refuses the save,
                    // and leaving a stale 83.25 behind a hidden field is how that happens.
                    setExchangeRate("1");
                    setRateTouched(false);
                    setRateNote(null);
                    return;
                  }
                  fetchRate(next, issueDate, true);
                }}
              >
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.label}
                  </option>
                ))}
              </Select>
            </div>

            {/* Only when it is needed. A rate field on every rupee document is a field nobody
                fills in and one person eventually gets wrong. */}
            {!isBaseCurrency(currency) && (
              <div className="space-y-1.5">
                <Label htmlFor="exchangeRate">Exchange rate</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="exchangeRate"
                    type="number"
                    step="0.0001"
                    min="0"
                    value={exchangeRate}
                    onChange={(e) => {
                      setRateTouched(true);
                      setRateNote(null);
                      setExchangeRate(e.target.value);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fetchRate(currency, issueDate, true)}
                    disabled={rateLoading}
                    className="shrink-0 text-xs text-brand hover:underline disabled:opacity-50"
                  >
                    {rateLoading ? "Looking up…" : "Use the day's rate"}
                  </button>
                </div>
                <p className="text-xs text-subtle">
                  {rateHint(currency, Number(exchangeRate) || 0)} · the ledger posts the {baseCurrency()} equivalent at
                  this rate.{rateNote ? ` ${rateNote}.` : ""}
                </p>
              </div>
            )}

            {pack.india && (
              <div className="space-y-1.5">
                <Label htmlFor="gstTreatment">GST treatment</Label>
                <Select
                  id="gstTreatment"
                  value={gstTreatment}
                  onChange={(e) => {
                    setGstTreatment(e.target.value);
                    // An unregistered party has no GSTIN to carry, so clearing it avoids printing a
                    // stale number on a document that shouldn't have one.
                    if (!registeredTreatments.includes(e.target.value as (typeof registeredTreatments)[number])) {
                      setBuyerGstin("");
                    }
                  }}
                >
                  {gstTreatmentValues.map((t) => (
                    <option key={t} value={t}>
                      {gstTreatmentLabels[t]}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            {pack.india && gstinRequired && (
              <div className="space-y-1.5">
                <Label htmlFor="buyerGstin">
                  GSTIN <span className="text-danger">*</span>
                </Label>
                <Input
                  id="buyerGstin"
                  value={buyerGstin}
                  onChange={(e) => setBuyerGstin(e.target.value.toUpperCase())}
                  placeholder="27AABCW1234F1ZV"
                  className="font-mono"
                />
              </div>
            )}

            {pack.india && !shippingSame && gstinRequired && (
              <div className="space-y-1.5">
                <Label htmlFor="shippingGstin">Shipping GSTIN</Label>
                <Input
                  id="shippingGstin"
                  value={shippingGstin}
                  onChange={(e) => setShippingGstin(e.target.value.toUpperCase())}
                  className="font-mono"
                />
              </div>
            )}

            {pack.country === "AE" && (
              <div className="space-y-1.5">
                <Label htmlFor="buyerGstin">{isSales ? "Customer's TRN" : "Vendor's TRN"}</Label>
                <Input
                  id="buyerGstin"
                  value={buyerGstin}
                  onChange={(e) => setBuyerGstin(e.target.value)}
                  placeholder="From their address, if it has one"
                  inputMode="numeric"
                  className="font-mono"
                />
              </div>
            )}

            <label className="flex items-center gap-2 self-end pb-2 text-sm text-text">
              <input
                type="checkbox"
                checked={reverseCharge}
                onChange={(e) => setReverseCharge(e.target.checked)}
                className="h-4 w-4 accent-[var(--brand)]"
              />
              Reverse charge applies
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Document details</CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Only when there is a choice: a single-branch company sees the form it always had. */}
          {branches.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="branchId">{isSales ? "Branch" : "Buying branch"}</Label>
              <Select id="branchId" value={branchId} onChange={(e) => chooseBranch(e.target.value)} disabled={followsInvoice}>
                {/* The invoice's branch, since deactivated, is not among the choices — but it is the answer. */}
                {!selectedBranch && <option value={branchId}>The invoice&apos;s branch (inactive)</option>}
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {branchLabel(b)}
                    {b.active ? "" : " (inactive)"}
                    {gstNumbered && !b.canIssueTaxDocuments ? " — can't issue tax invoices" : ""}
                  </option>
                ))}
              </Select>
              {followsInvoice ? (
                <p className="text-xs text-subtle">Follows the invoice.</p>
              ) : selectedBranch && !selectedBranch.active ? (
                <p className="text-xs text-warning">This branch is inactive: the draft can be saved, but move it to an active branch to issue it.</p>
              ) : gstNumbered && selectedBranch && !selectedBranch.canIssueTaxDocuments ? (
                <p className="text-xs text-subtle">
                  No GST registration here, so it can&apos;t issue a {tradeDocumentLabels[docType].toLowerCase()}. Save the draft, or
                  choose a branch with a GSTIN.
                </p>
              ) : null}
            </div>
          )}
          {isSales && bank && bank.accounts.length > 0 && (
            <BankAccountPicker bank={bank} branchId={branchId} value={bankAccountId} onChange={setBankAccountId} />
          )}

          <div className="space-y-1.5">
            <Label htmlFor="docNumber">
              {tradeDocumentLabels[docType]} # <span className="text-danger">*</span>
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="docNumber"
                value={docNumber}
                onChange={(e) => setDocNumber(e.target.value)}
                placeholder={numberMode === "MANUAL" ? "Type the number" : "Auto"}
                className="font-mono"
                required
              />
              <NumberSettingsDialog
                docType={docType}
                setting={series.setting}
                branchId={branchId || null}
                onApplied={(generated, mode) => {
                  setNumberMode(mode);
                  if (mode === "AUTO" && generated) {
                    setDocNumber(generated);
                    setGeneratedNumber(generated);
                  }
                  if (mode === "MANUAL") {
                    setDocNumber("");
                    setGeneratedNumber(null);
                  }
                  // The gear saved this branch's series: read it back, so the next visit starts from it.
                  followSeries(branchId, false);
                }}
              />
            </div>
            {numberLoading ? (
              <p className="text-xs text-subtle">Checking this branch&apos;s numbering…</p>
            ) : renumbering ? (
              <p className="text-xs text-subtle">
                Saving renumbers this draft from the series for {series.setting.ownerLabel ?? (selectedBranch ? branchLabel(selectedBranch) : "this branch")}
                {series.preview ? ` (next: ${series.preview})` : ""}; {defaults.docNumber} is left as a gap.
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="issueDate">
              Date <span className="text-danger">*</span>
            </Label>
            <Input id="issueDate" type="date" value={issueDate} onChange={(e) => changeIssueDate(e.target.value)} required />
          </div>

          {docType === "PROPOSAL" ? (
            <div className="space-y-1.5">
              <Label htmlFor="validUntil">Expiry date</Label>
              <Input id="validUntil" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="dueDate">Due date</Label>
              <Input id="dueDate" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="reference">Reference # / their PO</Label>
            <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="PO-2026-118" />
          </div>

          {isProposal && leadChoices.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="leadId">{slot(w, "For lead", "lead", "For {one:lower}")}</Label>
              <Select id="leadId" value={leadId} onChange={(e) => setLeadId(e.target.value)}>
                <option value="">{slot(w, "No lead", "lead", "No {one:lower}")}</option>
                {leadChoices.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.ref} · {l.title}
                    {l.stage ? ` — ${l.stage}` : ""}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-subtle">{slot(w, "Once issued, the lead shows it as its quotation.", "lead", "Once issued, the {one:lower} shows it as its quotation.")}</p>
            </div>
          )}

          {isSales && (
            <div className="space-y-1.5">
              <Label htmlFor="salespersonId">Salesperson</Label>
              <SearchSelect id="salespersonId" searchPlaceholder="Search people…" value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)}>
                <option value="">Account owner</option>
                {salespeople.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </SearchSelect>
              {/* Shown rather than left to be looked up: this is the contact the customer will
                  be given, and a wrong one is only discovered when they fail to get through. */}
              {chosenSalesperson && (chosenSalesperson.email || chosenSalesperson.phone) && (
                <p className="text-xs text-subtle">
                  {[chosenSalesperson.email, chosenSalesperson.phone].filter(Boolean).join(" · ")}
                </p>
              )}
              {chosenSalesperson && !chosenSalesperson.phone && (
                <p className="text-xs text-subtle">No work phone on file for them.</p>
              )}
            </div>
          )}

          {isNote && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="againstDocumentId">
                Against invoice <span className="text-danger">*</span>
              </Label>
              <Select
                id="againstDocumentId"
                value={againstDocumentId}
                onChange={(e) => {
                  setAgainstDocumentId(e.target.value);
                  // The note moves to the invoice's branch — its GSTIN, its series, its address.
                  const invoice = creditable.find((inv) => inv.id === e.target.value);
                  if (invoice) chooseBranch(invoice.branchId ?? headOfficeId);
                }}
                required
              >
                <option value="">{isCreditNote ? "Select the invoice this reduces…" : "Select the invoice this adds to…"}</option>
                {creditable.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.docNumber} — {money(inv.total)}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
          <span>Item table</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => setLines((prev) => [...prev, blankLine()])}>
            <Plus className="h-3.5 w-3.5" /> Add new row
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  {/* Wide enough for a service period's two dates side by side. */}
                  <th className="min-w-[19rem] px-3 py-2">Item details</th>
                  {pack.india && <th className="w-24 px-3 py-2">HSN/SAC</th>}
                  <th className="w-20 px-3 py-2 text-right">Quantity</th>
                  <th className="w-28 px-3 py-2 text-right">Rate</th>
                  <th className="w-36 px-3 py-2">Discount</th>
                  <th className="w-28 px-3 py-2">Tax</th>
                  <th className="w-32 px-3 py-2 text-right">Amount</th>
                  <th className="w-10 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={line.key} className="border-b border-line align-top last:border-0">
                    <td className="px-3 py-2">
                      <ItemPicker
                        value={line.name}
                        unit={line.unit}
                        description={line.description}
                        lineNumber={index + 1}
                        onNameChange={(value) => updateLine(line.key, { name: value, itemId: "" })}
                        onDescriptionChange={(value) => updateLine(line.key, { description: value })}
                        onUnitChange={(value) => updateLine(line.key, { unit: value })}
                        onPick={(item) => applyCatalogItem(line.key, item)}
                        converted={(item) =>
                          isBaseCurrency(currency)
                            ? null
                            : money(catalogLinePrice(pickOf(item), currency, exchangeRate) ?? catalogPriceInDocumentCurrency(item.sellingPrice ?? 0))
                        }
                      />
                      <LineLinks
                        line={line}
                        lineNumber={index + 1}
                        orders={isSales ? orders : EMPTY_ORDERS}
                        buying={!isSales}
                        periodShown={periodShown}
                        onOrder={(orderId) => applyOrder(line.key, orderId)}
                        warning={line.companyProductId ? orderWarnings[line.companyProductId] ?? null : null}
                        // Anything typed here is theirs: no later default replaces it, blank included.
                        onPeriod={(patch) => updateLine(line.key, { ...patch, periodSource: "typed" })}
                        onOpenPeriod={() => updateLine(line.key, { periodOpen: true })}
                      />
                    </td>
                    {pack.india && (
                      <td className="px-3 py-2">
                        {/* Named per row: the column header says "HSN", and in a grid of eleven
                            identical boxes that is not enough to say which one you are in. */}
                        <Input
                          aria-label={`HSN code, line ${index + 1}`}
                          value={line.hsnCode}
                          onChange={(e) => updateLine(line.key, { hsnCode: e.target.value })}
                          // 4, 6 or 8 digits; whether the GST directory lists it is the save's to say.
                          aria-invalid={line.hsnCode.trim() !== "" && !HSN_PATTERN.test(normaliseHsn(line.hsnCode))}
                          className="aria-[invalid=true]:border-danger"
                        />
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        step="0.001"
                        min="0"
                        aria-label={`Quantity, line ${index + 1}`}
                        value={line.quantity}
                        onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                        className="text-right"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        aria-label={`Rate, line ${index + 1}`}
                        value={line.unitPrice}
                        onChange={(e) => {
                          // Typed: a later change of currency leaves it as it is.
                          forgetPick(line.key);
                          updateLine(line.key, { unitPrice: e.target.value });
                        }}
                        className="text-right"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          aria-label={`Discount, line ${index + 1}`}
                          value={line.discountValue}
                          onChange={(e) => updateLine(line.key, { discountValue: e.target.value })}
                          className="text-right"
                        />
                        <Select
                          value={line.discountMode}
                          onChange={(e) => updateLine(line.key, { discountMode: e.target.value })}
                          className="w-16 shrink-0"
                          aria-label="Discount type"
                        >
                          <option value="PERCENT">%</option>
                          <option value="AMOUNT">{symbol}</option>
                        </Select>
                      </div>
                      {(totals.lines[index]?.discountAmount ?? 0) > 0 && (
                        <div className="mt-0.5 text-xs text-subtle">
                          − {money(totals.lines[index].discountAmount)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {pack.india ? (
                        <Select
                          value={line.taxRatePercent}
                          onChange={(e) => updateLine(line.key, { taxRatePercent: e.target.value })}
                          aria-label="Tax rate"
                        >
                          {taxRateChoices(line.taxRatePercent).map((rate) => (
                            <option key={rate} value={rate}>
                              {pack.tax.name} {rate}%
                            </option>
                          ))}
                        </Select>
                      ) : (
                        // Zero-rated, exempt and out of scope are all 0%, and the VAT return tells them apart (src/lib/vat/rules.ts).
                        <Select
                          value={lineCategory(line.taxCategory, Number(line.taxRatePercent) || 0)}
                          onChange={(e) =>
                            updateLine(line.key, {
                              taxCategory: e.target.value,
                              taxRatePercent: e.target.value === "STANDARD" ? String(Number(line.taxRatePercent) > 0 ? line.taxRatePercent : pack.tax.defaultRate) : "0",
                            })
                          }
                          aria-label={`${pack.tax.name} category`}
                        >
                          {TAX_CATEGORIES.map((category) => (
                            <option key={category} value={category}>
                              {category === "STANDARD" ? `${pack.tax.name} ${Number(line.taxRatePercent) > 0 ? line.taxRatePercent : pack.tax.defaultRate}%` : taxCategoryLabels[category]}
                            </option>
                          ))}
                        </Select>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="font-medium text-text">{money(totals.lines[index]?.lineTotal ?? 0)}</div>
                      <div className="text-xs text-subtle">
                        {money(totals.lines[index]?.taxableValue ?? 0)} + tax
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove line"
                        disabled={lines.length === 1}
                        onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="text-sm font-medium text-text">Notes &amp; terms</CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="notes">Customer notes</Label>
              <Textarea id="notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="terms">Terms &amp; conditions</Label>
              <Textarea id="terms" rows={4} value={terms} onChange={(e) => setTerms(e.target.value)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-sm font-medium text-text">Summary</CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Sub total" value={money(totals.subtotal)} />
            {totals.discountTotal > 0 && <Row label="Discount" value={`− ${money(totals.discountTotal)}`} />}

            <div className="flex items-center justify-between gap-3 text-muted">
              <span>Shipping charges</span>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={shippingCharge}
                  onChange={(e) => setShippingCharge(e.target.value)}
                  placeholder="0.00"
                  className="h-8 w-28 text-right"
                  aria-label="Shipping charges"
                />
                <Select
                  value={shippingTaxRate}
                  onChange={(e) => setShippingTaxRate(e.target.value)}
                  className="h-8 w-24"
                  aria-label="Shipping tax rate"
                >
                  {(pack.india ? ["0", "5", "12", "18", "28", "40"] : taxRateChoices(shippingTaxRate)).map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}%
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <Row label="Taxable value" value={money(totals.taxableValue)} />
            {!pack.india ? (
              // One tax, no state split: the engine puts it all in IGST, as for an export.
              <Row label={pack.tax.name} value={money(totals.cgstAmount + totals.sgstAmount + totals.igstAmount)} />
            ) : supplyType === "INTRA_STATE" ? (
              <>
                <Row label="CGST" value={money(totals.cgstAmount)} />
                <Row label="SGST" value={money(totals.sgstAmount)} />
              </>
            ) : (
              <Row label="IGST" value={money(totals.igstAmount)} />
            )}

            {/* TDS and TCS are India's; another country's pack has no withholding. */}
            {pack.india && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-muted">
                <div className="flex items-center gap-3">
                  {(["NONE", "TDS", "TCS"] as const).map((mode) => (
                    <label key={mode} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="radio"
                        checked={withholdingMode === mode}
                        onChange={() => setWithholdingMode(mode)}
                        className="h-3.5 w-3.5 accent-[var(--brand)]"
                      />
                      {mode === "NONE" ? "No TDS/TCS" : mode}
                    </label>
                  ))}
                </div>
                <span className={totals.withholdingAmount < 0 ? "text-danger" : "text-text"}>
                  {totals.withholdingAmount === 0
                    ? money(0)
                    : `${totals.withholdingAmount < 0 ? "− " : "+ "}${money(Math.abs(totals.withholdingAmount))}`}
                </span>
              </div>
            )}

            {/* A vendor bill's TDS chooses its section from the list and is told its rate (src/lib/tds);
                every other withholding is typed as before. */}
            {pack.india && docType === "BILL" && withholdingMode !== "TCS" && (
              <BillTdsHelper
                companyId={companyId}
                documentId={defaults.id ?? null}
                issueDate={issueDate}
                taxableValue={totals.taxableValue}
                mode={withholdingMode}
                section={withholdingSection ?? ""}
                rate={withholdingRate}
                onMode={(mode) => setWithholdingMode(mode)}
                onSection={(section) => setWithholdingSection(section)}
                onRate={(rate) => setWithholdingRate(rate)}
              />
            )}
            {pack.india && withholdingMode !== "NONE" && !(docType === "BILL" && withholdingMode === "TDS") && (
              <div className="flex items-center gap-2 pl-1">
                <Input
                  value={withholdingSection}
                  onChange={(e) => setWithholdingSection(e.target.value)}
                  placeholder="Section (194Q)"
                  className="h-8 w-36"
                  aria-label="TDS/TCS section"
                />
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={withholdingRate}
                  onChange={(e) => setWithholdingRate(e.target.value)}
                  placeholder="Rate"
                  className="h-8 w-20 text-right"
                  aria-label="TDS/TCS rate"
                />
                <span className="text-xs text-subtle">% of taxable value</span>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 text-muted">
              <Input
                value={adjustmentLabel}
                onChange={(e) => setAdjustmentLabel(e.target.value)}
                className="h-8 w-32"
                aria-label="Adjustment label"
              />
              <Input
                type="number"
                step="0.01"
                value={adjustment}
                onChange={(e) => setAdjustment(e.target.value)}
                placeholder="0.00"
                className="h-8 w-28 text-right"
                aria-label="Adjustment amount"
              />
            </div>

            {totals.roundOff !== 0 && <Row label="Round off" value={money(totals.roundOff)} />}

            <div className="flex items-center justify-between border-t border-line pt-2 text-base font-semibold text-text">
              <span>Total ({currency})</span>
              <span>{money(totals.total)}</span>
            </div>
            {reverseCharge && (
              <Badge tone="amber" className="mt-2">
                Tax payable under reverse charge
              </Badge>
            )}
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="rounded-base border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="flex items-center gap-3">
        {/* Held while a branch change is fetching its number, so the old branch's number isn't saved under the new one. */}
        <Button type="submit" disabled={pending || !companyId || numberLoading}>
          {pending ? "Saving…" : defaults.id ? "Save changes" : `Save ${tradeDocumentLabels[docType].toLowerCase()}`}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push(defaults.id ? `/documents/${defaults.id}` : documentListPath[docType])}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-muted">
      <span>{label}</span>
      <span className="text-text">{value}</span>
    </div>
  );
}

/**
 * Under a line: the order it bills, and the period it pays for.
 *
 * The order picker appears once the customer has orders to offer (or the line already bills one).
 * The period shows on a line whose item is a service or a subscription, or that already has one;
 * any other line gets a quiet "Add service period" link. The problem the server would refuse is
 * shown as it is typed, in the same words.
 */
function LineLinks({
  line,
  lineNumber,
  orders,
  periodShown,
  onOrder,
  onPeriod,
  onOpenPeriod,
  warning = null,
  buying = false,
}: {
  line: LineDraft;
  lineNumber: number;
  orders: PartyOrder[];
  /** A purchase order's line, raised from an order's Purchasing box: it buys for the order rather than billing it. */
  buying?: boolean;
  /** Whether this type of document carries a period at all (`showsServicePeriod`). */
  periodShown: boolean;
  onOrder: (orderId: string) => void;
  onPeriod: (patch: Pick<Partial<LineDraft>, "servicePeriodFrom" | "servicePeriodTo">) => void;
  onOpenPeriod: () => void;
  /** This line bills its order again, or for more than is left (src/lib/orders/billing-rules.ts). */
  warning?: string | null;
}) {
  const showOrders = orders.length > 0 || !!line.companyProductId;
  const showPeriod =
    periodShown && (suggestsServicePeriod(line.itemType) || !!line.servicePeriodFrom || !!line.servicePeriodTo || line.periodOpen);
  const problem = showPeriod ? servicePeriodProblem(line.servicePeriodFrom, line.servicePeriodTo) : null;
  // Linked to an order the picker can't offer — cancelled since, outside what this person may see, or
  // not loaded yet.
  const linkedElsewhere = !!line.companyProductId && !orders.some((o) => o.id === line.companyProductId);
  if (!showOrders && !periodShown && !line.billingMilestoneId) return null;

  return (
    <div className="mt-1.5 space-y-1.5">
      {showOrders && (
        <Select
          aria-label={buying ? `Order bought for, line ${lineNumber}` : `Order billed, line ${lineNumber}`}
          value={line.companyProductId}
          onChange={(e) => onOrder(e.target.value)}
          className="h-8 text-xs"
        >
          <option value="">{buying ? "Not for an order" : "Not billing an order"}</option>
          {linkedElsewhere && <option value={line.companyProductId}>{buying ? "The order this line buys for" : "The order this line bills"}</option>}
          {orders.map((o) => (
            <option key={o.id} value={o.id}>
              {orderLabel(o)}
            </option>
          ))}
        </Select>
      )}
      {warning && (
        <p role="alert" className="text-xs text-warning">
          {warning}
        </p>
      )}
      {periodShown &&
        (showPeriod ? (
          <div className="space-y-1">
            {/* The label above, the two dates side by side on one row: they share the column's width
                rather than each taking a fixed 144px, which wrapped them onto two lines (owner, 8 Oct 2026). */}
            <span className="block text-xs text-subtle">Service period</span>
            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                aria-label={`Service period from, line ${lineNumber}`}
                value={line.servicePeriodFrom}
                onChange={(e) => onPeriod({ servicePeriodFrom: e.target.value })}
                className="h-8 min-w-0 flex-1 px-2 text-xs"
              />
              <span className="shrink-0 text-xs text-subtle" aria-hidden="true">
                –
              </span>
              <Input
                type="date"
                aria-label={`Service period to, line ${lineNumber}`}
                value={line.servicePeriodTo}
                onChange={(e) => onPeriod({ servicePeriodTo: e.target.value })}
                className="h-8 min-w-0 flex-1 px-2 text-xs"
              />
            </div>
            {problem ? (
              <p className="text-xs text-danger">{problem}</p>
            ) : line.periodSource === "order" ? (
              <p className="text-xs text-subtle">The order&apos;s term.</p>
            ) : line.periodSource === "item" ? (
              <p className="text-xs text-subtle">One billing cycle from the document&apos;s date.</p>
            ) : null}
          </div>
        ) : (
          <button type="button" onClick={onOpenPeriod} className="text-xs text-brand hover:underline">
            Add service period
          </button>
        ))}
      {line.billingMilestoneId && <p className="text-xs text-subtle">Bills a project billing stage.</p>}
    </div>
  );
}

/**
 * Free text with a catalogue lookup behind it. A document line is often a one-off ("AMC — 3 site
 * visits") that isn't a SKU, so the description is always typeable and picking an item is a
 * shortcut that fills in price, tax, HSN and unit rather than a requirement. The field itself is the
 * search, as the customer field is: what's typed lists the items that match, to pick with the mouse
 * or the arrows and Enter.
 */
function ItemPicker({
  value,
  unit,
  description,
  lineNumber,
  onNameChange,
  onDescriptionChange,
  onUnitChange,
  onPick,
  converted,
}: {
  value: string;
  /** Which row this is, so its three fields can say so out loud. */
  lineNumber: number;
  unit: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onUnitChange: (value: string) => void;
  onPick: (item: CatalogItem) => void;
  /**
   * What the item's price becomes on this document, already formatted: its own price in the
   * document's currency, else its rupee price converted.
   *
   * Passed in rather than computed here because the currency and the rate belong to the form,
   * and a picker that reached for them would be a second place that has to know the conversion.
   * Absent on a rupee document, where there is nothing to convert.
   */
  converted?: (item: CatalogItem) => string | null;
}) {
  const [open, setOpen] = useState(false);
  // The rows with the text they answer, so a slow answer for "micro" never shows under "microsoft".
  const [answer, setAnswer] = useState<{ for: string; rows: CatalogItem[]; failed: boolean } | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const query = value.trim();

  // Typing searches the catalogue, as the customer field does (owner, 23 Nov 2026 — "it should work like customers
  // do"): no button to press. A moment after the last keystroke, and the newest search wins; nothing is asked while the
  // list is shut, so picking an item — its name in the field, the list closed — sends nothing.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      listDocumentItems(query || undefined).then(
        (rows) => {
          if (!cancelled) setAnswer({ for: query, rows, failed: false });
        },
        () => {
          if (!cancelled) setAnswer({ for: query, rows: [], failed: true });
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query]);

  const current = answer?.for === query ? answer : null;
  const results = current?.rows ?? [];
  const searching = open && !current;

  // The panel is portalled out of the table, so a click elsewhere no longer counts as a blur —
  // closing it has to be handled explicitly. Escape and Tab close it through the keyboard below.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (fieldRef.current?.contains(target)) return;
      if (target.closest?.("[data-item-picker-panel]") || insideAnchoredPopover(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function pick(item: CatalogItem) {
    onPick(item);
    setOpen(false);
  }

  // Arrows and Enter take a row, as on the customer field (src/components/ui/use-combobox-keyboard.ts). Nothing is
  // highlighted until somebody aims: a line is often a one-off that isn't in the catalogue, and Enter mustn't swap
  // what was typed for whichever item sorts first.
  const combobox = useComboboxKeyboard({
    label: "Items",
    optionCount: results.length,
    isOpen: open,
    setOpen,
    onChoose: (index) => {
      const item = results[index];
      if (item) pick(item);
    },
    resetKey: results.map((r) => r.id).join(","),
  });

  return (
    <div className="space-y-1.5">
      <div ref={fieldRef}>
        <Input
          aria-label={`Item, line ${lineNumber}`}
          value={value}
          onChange={(e) => {
            onNameChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Type to search items…"
          autoComplete="off"
          {...combobox.comboboxProps}
        />
      </div>
      <Textarea
        aria-label={`Description, line ${lineNumber}`}
        value={description}
        onChange={(e) => onDescriptionChange(e.target.value)}
        placeholder="Description — what's included, the period covered, serial numbers…"
        rows={2}
        className="text-xs"
      />
      <Input
        aria-label={`Unit, line ${lineNumber}`}
        value={unit}
        onChange={(e) => onUnitChange(e.target.value)}
        placeholder="Unit (NOS, PCS…)"
        className="h-8 w-32 text-xs"
      />

      <AnchoredPopover anchorRef={fieldRef} open={open} width={420} maxHeight={340}>
        <div data-item-picker-panel className="py-1" {...combobox.listboxProps}>
          {results.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => pick(item)}
              {...combobox.optionProps(index)}
              className={cn(
                "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-surface-sunken",
                // The keyboard highlight borrows the hover tint, as the customer field's does.
                combobox.activeIndex === index && "bg-surface-sunken",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-text">{item.name}</span>
                {/* Its HSN/SAC comes onto the line with it — said here, so a product without one shows before it is picked. */}
                <span className="block truncate text-xs text-subtle">
                  {item.sku} · {item.hsnCode ? `HSN/SAC ${item.hsnCode}` : "no HSN/SAC"}
                </span>
              </span>
              {/* The catalogue's own rupee price. On a foreign-currency document the line is
                  added at the converted figure, so this is shown for what it is. */}
              <span className="shrink-0 text-xs text-muted">
                {formatCurrency(item.sellingPrice)}
                {converted?.(item) && <span className="ml-1 text-subtle">→ {converted(item)}</span>}
              </span>
            </button>
          ))}
          {searching && <div className="px-3 py-2 text-sm text-subtle">Searching…</div>}
          {current?.failed && <div className="px-3 py-2 text-sm text-danger">{"Couldn't search — try again"}</div>}
          {current && !current.failed && results.length === 0 && (
            <div className="px-3 py-2 text-sm text-subtle">
              {query ? "No matching items — the line keeps what you typed." : "No items in the catalogue yet."}
            </div>
          )}
          {results.length >= ITEM_SEARCH_LIMIT && (
            <div className="border-t border-line px-3 py-1.5 text-xs text-subtle">{`Showing the first ${ITEM_SEARCH_LIMIT} — keep typing`}</div>
          )}
        </div>
      </AnchoredPopover>
    </div>
  );
}

/** The most `listDocumentItems` returns at once. A full list means there are probably more behind it. */
const ITEM_SEARCH_LIMIT = 50;

/** Which of the organisation's accounts this sale prints — by default, the branch's or the primary. */
function BankAccountPicker({
  bank,
  branchId,
  value,
  onChange,
}: {
  bank: DocumentBankChoices;
  branchId: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const id = useId();
  const branchDefault = bank.accounts.find((a) => a.id === bank.branchDefaults[branchId]);
  const fallback = branchDefault ?? bank.accounts.find((a) => a.isPrimary && a.active);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Bank account printed</Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">
          {fallback ? `${branchDefault ? "Branch default" : "Primary"} — ${fallback.label}` : "None printed"}
        </option>
        {bank.accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
            {a.active ? "" : " (retired)"}
          </option>
        ))}
      </Select>
    </div>
  );
}
