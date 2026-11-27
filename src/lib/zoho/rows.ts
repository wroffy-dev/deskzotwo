/**
 * Zoho Books' API replies as the rows of its own backup files (src/lib/zoho/pull.ts) — "Invoice.csv" with its
 * headings, "Contacts.csv" with its — so everything that reads the backup reads the pull too: the master lists
 * (src/lib/legacy-import), the switch's steps and the archive (src/lib/migration). Field names are Zoho's
 * documented ones (its OpenAPI files, 26 Oct 2026); where a reply may name a figure more than one way, each is
 * tried. A detail reply is read over its list row, so what only the list carries still lands.
 */

type J = Record<string, unknown>;
type Row = Record<string, string>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "true" : "false") : String(v));
/** The first of several fields a reply may carry a value under. */
const pick = (o: J | undefined, ...keys: string[]): string => {
  for (const k of keys) {
    const v = o?.[k];
    if (v !== null && v !== undefined && v !== "") return s(v);
  }
  return "";
};
const list = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);
const n = (v: string) => Number(v) || 0;
/**
 * An invoice's e-invoice in a Zoho reply (owner, 21 Nov 2026: invoices pulled after the backup came without their IRN).
 * The names first read here were guesses from Zoho's OpenAPI files; these are every name Zoho is known to give them —
 * nested under einvoice_details (or e_invoice_details, einvoice) or at the top — so whichever it sends lands.
 */
export type ZohoEInvoice = { irn: string; ackNo: string; ackDate: string; qr: string; status: string };

/** An invoice's e-invoice from a Zoho reply — under any name Zoho is known to give it, nested or at the top. */
export function einvoiceOf(d: J | undefined): ZohoEInvoice {
  const inner = (d?.einvoice_details ?? d?.e_invoice_details ?? d?.einvoice ?? {}) as J;
  const either = (...keys: string[]) => pick(inner, ...keys) || pick(d, ...keys);
  return {
    // The IRN: "irn" in most, "inv_ref_num" in some; "uuid" only inside the e-invoice itself (Zoho's mark-as-pushed name for it).
    irn: either("irn", "inv_ref_num", "invoice_reference_number") || pick(inner, "uuid"),
    ackNo: either("ack_no", "ack_number", "acknowledgement_number"),
    ackDate: either("ack_date", "acknowledgement_date"),
    qr: either("signed_qr_code", "signed_qr", "qr_code"),
    // The invoice's own "status" is its payment state, so only the e-invoice's is read under that name.
    status: pick(inner, "status", "formatted_status") || pick(d, "einvoice_status"),
  };
}

/** "other_current_asset" → "Other Current Asset", as the backup names an account's type. */
const words = (v: string) => v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * A document's discount on the whole of it, as an amount: Zoho's own figure when it gives one, else worked out
 * from its percentage or amount over the lines before tax.
 */
function entityDiscount(d: J): string {
  // A discount on the lines (Zoho's "item_level"): its total is theirs, already on each line — not one more on the
  // whole document (owner, 23 Nov 2026: WT/26-27/QT/724's 2% line discount came off twice).
  if (/item/i.test(pick(d, "discount_type"))) return "0";
  const given = pick(d, "discount_total", "discount_amount", "entity_discount_amount");
  if (given) return given;
  if (pick(d, "discount_type") !== "entity_level") return "0";
  const raw = pick(d, "discount");
  if (!raw) return "0";
  if (raw.endsWith("%")) {
    const gross = list(d.line_items).reduce((t, l) => t + (n(pick(l, "item_total")) || n(pick(l, "rate")) * (n(pick(l, "quantity")) || 1)), 0);
    return String(Math.round(gross * n(raw.slice(0, -1))) / 100);
  }
  return raw;
}

/** A sales document's lines, each with the document's own figures beside it, as the backup writes them. */
function salesLines(d: J, head: Row, lineKeys: { quantity: string }): Row[] {
  const lines = list(d.line_items);
  const one = (l: J | undefined): Row => ({
    ...head,
    // Zoho's own id for the line: a document read twice is told from one with two lines alike (src/lib/migration/zoho.ts).
    "Line Item ID": pick(l, "line_item_id"),
    "Item Name": pick(l, "name"),
    "Item Desc": pick(l, "description"),
    SKU: pick(l, "sku"),
    "Product ID": pick(l, "item_id"),
    [lineKeys.quantity]: pick(l, "quantity"),
    QuantityInvoiced: pick(l, "quantity_invoiced"),
    QuantityBilled: pick(l, "quantity_billed"),
    QuantityCancelled: pick(l, "quantity_cancelled"),
    "Item Price": pick(l, "rate"),
    Rate: pick(l, "rate"),
    "Discount Amount": pick(l, "discount_amount"),
    "Item Total": pick(l, "item_total"),
    "Usage unit": pick(l, "unit"),
    "Item Tax %": pick(l, "tax_percentage"),
    "Tax Percentage": pick(l, "tax_percentage"),
    "HSN/SAC": pick(l, "hsn_or_sac"),
    Account: pick(l, "account_name"),
    Description: pick(l, "description"),
  });
  return lines.length ? lines.map(one) : [one(undefined)];
}

const documentHead = (d: J): Row => ({
  "Place of Supply": pick(d, "place_of_supply"),
  "GST Treatment": pick(d, "gst_treatment"),
  "GST Identification Number (GSTIN)": pick(d, "gst_no"),
  "Is Inclusive Tax": pick(d, "is_inclusive_tax") || "false",
  "Currency Code": pick(d, "currency_code"),
  "Exchange Rate": pick(d, "exchange_rate") || "1",
  "Discount Type": pick(d, "discount_type"),
  "Is Discount Before Tax": pick(d, "is_discount_before_tax"),
  "Entity Discount Amount": entityDiscount(d),
  SubTotal: pick(d, "sub_total"),
  Total: pick(d, "total"),
  Balance: pick(d, "balance"),
  Adjustment: pick(d, "adjustment"),
  "Shipping Charge": pick(d, "shipping_charge"),
  "Shipping Charge Tax %": pick(d, "shipping_charge_tax_percentage"),
  "Sales person": pick(d, "salesperson_name"),
  Notes: pick(d, "notes"),
  "Terms & Conditions": pick(d, "terms"),
});

export function invoiceRows(d: J): Row[] {
  return salesLines(
    d,
    {
      ...documentHead(d),
      "Invoice ID": pick(d, "invoice_id"),
      "Invoice Number": pick(d, "invoice_number"),
      "Invoice Date": pick(d, "date"),
      "Invoice Status": pick(d, "status"),
      "Customer ID": pick(d, "customer_id"),
      "Customer Name": pick(d, "customer_name"),
      "Due Date": pick(d, "due_date"),
      PurchaseOrder: pick(d, "reference_number"),
      "TDS Amount": pick(d, "tds_amount"),
      // Under every name Zoho is known to give them (owner, 21 Nov 2026: invoices pulled after the backup came without
      // their IRN — the names first written here were guesses; src/lib/zoho/einvoices.ts).
      "e-Invoice Reference Number": einvoiceOf(d).irn,
      "e-Invoice Ack Number": einvoiceOf(d).ackNo,
      "e-Invoice Ack Date": einvoiceOf(d).ackDate,
      "e-Invoice QR Raw Data": einvoiceOf(d).qr,
      "e-Invoice Status": einvoiceOf(d).status,
      "E-WayBill Number": pick(d.ewaybill_details as J, "ewaybill_number") || pick(d, "ewaybill_number"),
    },
    { quantity: "Quantity" },
  );
}

/** A credit note's rows, and what Zoho set it against — the Creditnotes_Invoice file's rows. */
export function creditNoteRows(d: J): { rows: Row[]; applications: Row[] } {
  /**
   * A credit note raised against an invoice keeps it in `invoices_credited` (and `invoice_number`), not in `invoices`,
   * which only lists invoices it was applied to afterwards (owner, 17 Nov 2026 — "why payments not settled?": twelve
   * credit notes came across with no invoice and were refused). Each counts, with the amount it took off.
   */
  const credited = list(d.invoices_credited).map((i) => ({ ...i, amount_applied: pick(i, "credited_amount", "amount_applied", "amount") }));
  const later = list(d.invoices).filter((i) => !credited.some((c) => pick(c, "invoice_id") && pick(c, "invoice_id") === pick(i, "invoice_id")));
  const invoices = [...credited, ...later];
  const rows = salesLines(
    d,
    {
      ...documentHead(d),
      "CreditNotes ID": pick(d, "creditnote_id"),
      "Credit Note Number": pick(d, "creditnote_number"),
      "Credit Note Date": pick(d, "date"),
      "Credit Note Status": pick(d, "status"),
      "Customer ID": pick(d, "customer_id"),
      "Customer Name": pick(d, "customer_name"),
      "Associated Invoice Number": pick(invoices[0], "invoice_number") || pick(d, "invoice_number") || pick(d, "reference_number"),
      "Reference#": pick(d, "reference_number"),
    },
    { quantity: "Quantity" },
  );
  const applications = invoices
    .filter((i) => n(pick(i, "amount", "amount_applied")) > 0)
    .map((i) => ({ Date: pick(i, "date") || pick(d, "date"), "Credit Note Number": pick(d, "creditnote_number"), "Invoice Number": pick(i, "invoice_number"), "Applied Invoice Date": pick(i, "invoice_date"), Amount: pick(i, "amount", "amount_applied") }));
  return { rows, applications };
}

export function customerPaymentRows(d: J): Row[] {
  const head: Row = {
    "Payment Number": pick(d, "payment_number"),
    "CustomerPayment ID": pick(d, "payment_id"),
    Mode: pick(d, "payment_mode"),
    CustomerID: pick(d, "customer_id"),
    "Customer Name": pick(d, "customer_name"),
    Description: pick(d, "description"),
    Amount: pick(d, "amount"),
    "Unused Amount": pick(d, "unused_amount", "balance"),
    "Bank Charges": pick(d, "bank_charges"),
    "Reference Number": pick(d, "reference_number"),
    Date: pick(d, "date"),
    "Deposit To": pick(d, "account_name", "deposit_to_account_name"),
    "Payment Status": pick(d, "status"),
    "Currency Code": pick(d, "currency_code"),
  };
  const invoices = list(d.invoices);
  if (!invoices.length) return [{ ...head, "Invoice Number": pick(d, "invoice_numbers", "invoice_number"), "Amount Applied to Invoice": "", "Withholding Tax Amount": "" }];
  // "Applied On": the day Zoho set it against the invoice (owner, 17 Nov 2026) — an advance from before the year used
  // this year is carried in by it (src/lib/migration/advances.ts).
  return invoices.map((i) => ({ ...head, "Invoice Number": pick(i, "invoice_number"), "Amount Applied to Invoice": pick(i, "amount_applied"), "Withholding Tax Amount": pick(i, "tax_amount_withheld"), "Applied On": pick(i, "apply_date") }));
}

export function billRows(d: J): Row[] {
  return salesLines(
    d,
    {
      ...documentHead(d),
      "Bill ID": pick(d, "bill_id"),
      "Bill Number": pick(d, "bill_number"),
      "Bill Date": pick(d, "date"),
      "Due Date": pick(d, "due_date"),
      "Bill Status": pick(d, "status"),
      "Vendor Name": pick(d, "vendor_name"),
      "Vendor ID": pick(d, "vendor_id"),
      "Source of Supply": pick(d, "source_of_supply"),
      "Destination of Supply": pick(d, "destination_of_supply", "place_of_supply"),
      PurchaseOrder: pick(d, "reference_number"),
      "Vendor Notes": pick(d, "notes"),
      "TDS Amount": pick(d, "tds_amount"),
      "TDS Percentage": pick(d, "tds_percent", "tds_percentage"),
      "TDS Section Code": pick(d, "tds_section_code", "tds_section"),
    },
    { quantity: "Quantity" },
  );
}

export function vendorCreditRows(d: J): Row[] {
  return salesLines(
    d,
    {
      ...documentHead(d),
      "Vendor Credit ID": pick(d, "vendor_credit_id"),
      "Vendor Credit Number": pick(d, "vendor_credit_number"),
      "Vendor Credit Date": pick(d, "date"),
      "Vendor Credit Status": pick(d, "status"),
      "Vendor Name": pick(d, "vendor_name"),
      "Vendor ID": pick(d, "vendor_id"),
      "Associated Bill Number": pick(list(d.bills_credited)[0], "bill_number"),
      "Source of Supply": pick(d, "source_of_supply"),
      "Reference#": pick(d, "reference_number"),
    },
    { quantity: "Quantity" },
  );
}

/** A vendor payment's rows; a bill named only by its id is given its number when the pull stores them. */
export function vendorPaymentRows(d: J): Row[] {
  const head: Row = {
    "Payment Number": pick(d, "payment_number"),
    "VendorPayment ID": pick(d, "payment_id", "vendorpayment_id"),
    Mode: pick(d, "payment_mode"),
    Description: pick(d, "description"),
    Amount: pick(d, "amount"),
    "Unused Amount": pick(d, "balance", "unused_amount"),
    TDSAmount: pick(d, "tax_amount_withheld"),
    "Reference Number": pick(d, "reference_number"),
    Date: pick(d, "date"),
    "Vendor Name": pick(d, "vendor_name"),
    "Paid Through": pick(d, "paid_through_account_name"),
    "Payment Status": pick(d, "status") || "Paid",
    "Currency Code": pick(d, "currency_code"),
  };
  const bills = list(d.bills);
  if (!bills.length) return [{ ...head, "Bill ID": "", "Bill Number": pick(d, "bill_numbers"), "Bill Amount": "" }];
  return bills.map((b) => ({ ...head, "Bill ID": pick(b, "bill_id"), "Bill Number": pick(b, "bill_number"), "Bill Amount": pick(b, "amount_applied", "amount") }));
}

export function expenseRows(d: J): Row[] {
  return [
    {
      "Expense Date": pick(d, "date"),
      "Expense Description": pick(d, "description"),
      "Expense Account": pick(d, "account_name"),
      "Expense Account Code": "",
      "Paid Through": pick(d, "paid_through_account_name"),
      "Paid Through Account Code": "",
      Vendor: pick(d, "vendor_name"),
      "Source of Supply": pick(d, "source_of_supply"),
      "Is Inclusive Tax": pick(d, "is_inclusive_tax") || "false",
      "Tax Percentage": pick(d, "tax_percentage"),
      "Tax Amount": pick(d, "tax_amount"),
      "Expense Amount": pick(d, "sub_total", "amount"),
      Total: pick(d, "total"),
      "Reference#": pick(d, "reference_number"),
      "Expense Reference ID": pick(d, "expense_id"),
      "Currency Code": pick(d, "currency_code"),
    },
  ];
}

export function journalRows(d: J): Row[] {
  return list(d.line_items).map((l) => {
    const debit = pick(l, "debit_or_credit").toLowerCase() === "debit";
    return {
      "Journal ID": pick(d, "journal_id"),
      "Journal Number": pick(d, "entry_number"),
      "Journal Date": pick(d, "journal_date", "date"),
      "Reference Number": pick(d, "reference_number"),
      Notes: pick(d, "notes"),
      Status: pick(d, "status") || "published",
      Account: pick(l, "account_name"),
      "Account Code": "",
      Description: pick(l, "description"),
      "Contact Name": pick(l, "customer_name"),
      Debit: debit ? pick(l, "amount") : "",
      Credit: debit ? "" : pick(l, "amount"),
    };
  });
}

export function quoteRows(d: J): Row[] {
  return salesLines(
    d,
    {
      ...documentHead(d),
      "Quote ID": pick(d, "estimate_id"),
      "Quote Number": pick(d, "estimate_number"),
      "Quote Date": pick(d, "date"),
      "Quote Status": pick(d, "status"),
      "Customer ID": pick(d, "customer_id"),
      "Customer Name": pick(d, "customer_name"),
      "Expiry Date": pick(d, "expiry_date"),
      "Reference ID": pick(d, "reference_number"),
    },
    { quantity: "Quantity" },
  );
}

export function salesOrderRows(d: J): Row[] {
  return salesLines(
    d,
    {
      ...documentHead(d),
      "SalesOrder ID": pick(d, "salesorder_id"),
      "SalesOrder Number": pick(d, "salesorder_number"),
      "Order Date": pick(d, "date"),
      Status: pick(d, "status", "order_status"),
      "Customer ID": pick(d, "customer_id"),
      "Customer Name": pick(d, "customer_name"),
      "Expected Shipment Date": pick(d, "shipment_date"),
      "Reference#": pick(d, "reference_number"),
    },
    { quantity: "QuantityOrdered" },
  );
}

/** A delivery challan (owner, 16 Nov 2026), a row a line — read into the archive (src/lib/migration/archive.ts). */
export function challanRows(d: J): Row[] {
  return salesLines(
    d,
    {
      ...documentHead(d),
      "Delivery Challan ID": pick(d, "deliverychallan_id"),
      "Delivery Challan Number": pick(d, "deliverychallan_number"),
      "Challan Date": pick(d, "date"),
      Status: pick(d, "status"),
      "Challan Type": pick(d, "challan_type"),
      "Customer ID": pick(d, "customer_id"),
      "Customer Name": pick(d, "customer_name"),
      "Reference#": pick(d, "reference_number"),
    },
    { quantity: "Quantity" },
  );
}

export function purchaseOrderRows(d: J): Row[] {
  return salesLines(
    d,
    {
      ...documentHead(d),
      "Purchase Order ID": pick(d, "purchaseorder_id"),
      "Purchase Order Number": pick(d, "purchaseorder_number"),
      "Purchase Order Date": pick(d, "date"),
      "Purchase Order Status": pick(d, "status", "order_status"),
      "Vendor Name": pick(d, "vendor_name"),
      "Destination of Supply": pick(d, "destination_of_supply", "place_of_supply"),
      "Expected Arrival Date": pick(d, "expected_delivery_date", "delivery_date"),
      "Reference#": pick(d, "reference_number"),
    },
    { quantity: "QuantityOrdered" },
  );
}

/**
 * Money Zoho moved between accounts without a document — fund transfers, deposits, drawings — from its banking
 * list, as the Transfer_Fund file's rows. Each movement is listed once a side; it is kept once, by its id. Money
 * into an account (a debit to it) came from the other side.
 */
export const MOVEMENT_TYPES = new Set(["transfer_fund", "deposit", "owner_drawings", "owner_contribution", "other_income", "interest_income", "expense_refund"]);
export function movementRow(t: J): Row | null {
  if (!MOVEMENT_TYPES.has(pick(t, "transaction_type"))) return null;
  const into = pick(t, "debit_or_credit").toLowerCase() === "debit";
  return {
    "Transaction ID": pick(t, "transaction_id"),
    "Transaction Date": pick(t, "date"),
    "Transaction Type": words(pick(t, "transaction_type")),
    "From Account": into ? pick(t, "offset_account_name") : pick(t, "account_name"),
    "To Account": into ? pick(t, "account_name") : pick(t, "offset_account_name"),
    Reference: pick(t, "reference_number"),
    Description: pick(t, "description"),
    "Currency Code": pick(t, "currency_code"),
    "Exchange Rate": "1",
    Total: pick(t, "amount"),
  };
}

export function refundRow(r: J): Row {
  return {
    Date: pick(r, "date"),
    "Credit Note Number": pick(r, "creditnote_number"),
    "Customer Name": pick(r, "customer_name"),
    "Mode of Refund": pick(r, "refund_mode"),
    "Exchange Rate": pick(r, "exchange_rate") || "1",
    "Refund From Account": pick(r, "from_account_name", "account_name"),
    "Refund From Account Code": "",
    Amount: pick(r, "amount_bcy", "amount"),
    Description: pick(r, "description"),
    "Reference Number": pick(r, "reference_number"),
  };
}

/** A customer or vendor, and the people at it: the Contacts (or Vendors) file's row and its contact persons'. */
export function contactRows(d: J, vendor: boolean): { contact: Row; people: Row[] } {
  const people = list(d.contact_persons);
  const primary = people.find((p) => pick(p, "is_primary_contact") === "true") ?? people[0];
  const address = (d.billing_address ?? {}) as J;
  const contact: Row = {
    "Contact ID": pick(d, "contact_id"),
    "Display Name": pick(d, "contact_name"),
    "Company Name": pick(d, "company_name"),
    "Legal Name": pick(d, "legal_name"),
    "First Name": pick(primary, "first_name") || pick(d, "first_name"),
    "Last Name": pick(primary, "last_name") || pick(d, "last_name"),
    EmailID: pick(primary, "email") || pick(d, "email"),
    MobilePhone: pick(primary, "mobile") || pick(d, "mobile"),
    Phone: pick(primary, "phone") || pick(d, "phone"),
    Website: pick(d, "website"),
    Status: pick(d, "status"),
    "Currency Code": pick(d, "currency_code"),
    "Payment Terms Label": pick(d, "payment_terms_label"),
    "GST Treatment": pick(d, "gst_treatment"),
    "GST Identification Number (GSTIN)": pick(d, "gst_no"),
    "Place Of Contact": pick(d, "place_of_contact"),
    "Billing Address": pick(address, "address"),
    "Billing Street2": pick(address, "street2"),
    "Billing City": pick(address, "city"),
    "Billing State": pick(address, "state_code", "state"),
    "Billing Country": pick(address, "country"),
    "Billing Code": pick(address, "zip", "zipcode"),
    "Created Time": pick(d, "created_time"),
    "Customer Sub Type": pick(d, "customer_sub_type"),
    // Who looks after it in Zoho, by name — Contacts.csv's own column (owner, 30 Oct 2026); the account manager in Deskzo.
    "Owner Name": pick(d, "owner_name"),
    ...(vendor ? { "MSME/Udyam No": pick(d, "msme_number", "udyam_reg_no") } : {}),
  };
  const rows = people.map((p) => ({
    ...(vendor ? { "Vendor ID": pick(d, "contact_id"), "Display Name": pick(d, "contact_name") } : { "Customer ID": pick(d, "contact_id"), "Customer Name": pick(d, "contact_name") }),
    "Contact Person ID": pick(p, "contact_person_id"),
    Salutation: pick(p, "salutation"),
    "First Name": pick(p, "first_name"),
    "Last Name": pick(p, "last_name"),
    EmailID: pick(p, "email"),
    Phone: pick(p, "phone"),
    MobilePhone: pick(p, "mobile"),
    "Is Primary": pick(p, "is_primary_contact"),
    Department: pick(p, "department"),
    Designation: pick(p, "designation"),
  }));
  return { contact, people: rows };
}

/** Zoho's taxes by id, as percentages (GET /settings/taxes) — for a preference that names its tax by id alone. */
export type ZohoTaxRates = Map<string, number>;

/**
 * An item's GST rate and HSN/SAC in a Zoho reply (owner, 21 Nov 2026: "gst rate not set on items"). An India organisation
 * keeps the rate in item_tax_preferences — intra-state (CGST + SGST, the same total as IGST) and inter-state — often as a
 * tax id alone; elsewhere it's the item's own tax_percentage. A name like "GST18" or "IGST 5%" is read as its number
 * when nothing else says it.
 */
export function gstOfZohoItem(i: J | undefined, rates: ZohoTaxRates = new Map()): { rate: number | null; hsn: string } {
  const pct = (o: J | undefined): number | null => {
    if (!o) return null;
    const direct = Number(o.tax_percentage);
    if (o.tax_percentage !== undefined && o.tax_percentage !== null && o.tax_percentage !== "" && Number.isFinite(direct)) return direct;
    const byId = rates.get(s(o.tax_id));
    if (byId !== undefined) return byId;
    const named = /(\d+(?:\.\d+)?)\s*%?\s*$/.exec(s(o.tax_name));
    return named ? Number(named[1]) : null;
  };
  const prefs = (Array.isArray(i?.item_tax_preferences) ? i!.item_tax_preferences : []) as J[];
  const intra = prefs.find((p) => /intra/i.test(s(p.tax_specification)));
  const inter = prefs.find((p) => /inter/i.test(s(p.tax_specification)));
  const rate = pct(intra) ?? pct(inter) ?? pct(i);
  return { rate: rate !== null && rate >= 0 && rate <= 100 ? rate : null, hsn: pick(i, "hsn_or_sac", "hsn_code", "sac_code") };
}

export function itemRow(i: J): Row {
  return {
    "Item ID": pick(i, "item_id"),
    "Item Name": pick(i, "name", "item_name"),
    SKU: pick(i, "sku"),
    "HSN/SAC": pick(i, "hsn_or_sac"),
    Description: pick(i, "description"),
    Rate: pick(i, "rate"),
    "Purchase Rate": pick(i, "purchase_rate"),
    "Product Type": pick(i, "product_type"),
    "Item Type": pick(i, "item_type"),
    Status: pick(i, "status"),
    "Usage unit": pick(i, "unit"),
    // Its intra-state rate, read the India way first (gstOfZohoItem) — the list's tax_percentage alone missed it.
    "Intra State Tax Rate": ((r) => (r === null ? "" : String(r)))(gstOfZohoItem(i).rate),
  };
}

export function accountRow(a: J): Row {
  return {
    "Account ID": pick(a, "account_id"),
    "Account Name": pick(a, "account_name"),
    "Account Code": pick(a, "account_code"),
    Description: pick(a, "description"),
    "Account Type": words(pick(a, "account_type")),
    "Account Status": pick(a, "is_active") === "false" ? "Inactive" : "Active",
    Currency: pick(a, "currency_code"),
    "Parent Account": pick(a, "parent_account_name"),
  };
}
