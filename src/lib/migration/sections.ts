import type { StepKey } from "./steps";

/**
 * The switch a section at a time (owner, 28 Oct 2026): each step can be fetched, checked and imported by itself, in any
 * order. A row that needs what another section brings — a receipt its invoice, an invoice its customer — isn't a failure
 * but waits for it: kept with what it waits for, and tried again when that comes (`retryWaitingPart`, ./steps.ts).
 */

/** What a waiting row waits for: a section of the switch, or a master list brought in elsewhere. */
export type WaitFor = "customers" | "vendors" | "invoices" | "bills" | "chart";

export const WAIT_LABELS: Record<WaitFor, string> = {
  customers: "Customers",
  vendors: "Vendors",
  invoices: "Invoices",
  bills: "Bills",
  chart: "the chart of accounts",
};

/** Where whoever is waiting goes to bring it: a step of this page, or another page. */
export const WAIT_WHERE: Record<WaitFor, { step?: StepKey; href?: string; how: string }> = {
  customers: { href: "/settings/data", how: "Import the customers (Import & export › Customers — Zoho's Contacts.csv goes straight in), then Retry waiting" },
  vendors: { href: "/settings/data", how: "Import the vendors (Import & export › Vendors — Zoho's Vendors.csv goes straight in), then Retry waiting" },
  invoices: { step: "invoices", how: "Bring the invoices across — what waits for them is tried again by itself" },
  bills: { step: "bills", how: "Bring the bills across — what waits for them is tried again by itself" },
  chart: { how: "Add the account to Deskzo's chart, or map it in the old chart above, then Retry waiting" },
};

/**
 * What an error says a row waits for, by how each step words the missing thing (./receipts.ts, ./purchases.ts,
 * ./ledger.ts, src/lib/portability/documents.ts). Anything else — a wrong total, a vendor where a customer belongs —
 * is the row's own problem: fixed in the file, not by waiting.
 */
export function waitingFor(error: string): WaitFor | null {
  if (/^No (company|customer|contact) named "/.test(error)) return "customers";
  if (/^No vendor named "/.test(error)) return "vendors";
  if (/^Invoice .+ isn't in Deskzo\./.test(error)) return "invoices";
  if (/^Bill .+ isn't in Deskzo\./.test(error)) return "bills";
  if (/^No account ".*" in Deskzo's chart\./.test(error)) return "chart";
  return null;
}

/** The sections whose import lets rows waiting for these go on: importing invoices frees what waits for invoices. */
export const FREES: Partial<Record<StepKey, WaitFor>> = { invoices: "invoices", bills: "bills" };

/**
 * The section a migration record belongs to, by its key (./documents.ts, receipts.ts, purchases.ts, expenses.ts,
 * journals.ts): "INVOICE:…", "BILL:…", "VCREDIT:…", "PAID:…" a vendor payment and a bare number a receipt, each with
 * its entry ("…:entry", "PAYMENT:…:entry") and a receipt's TDS ("…:TDS"). Null for what no section brought — an
 * adjustment, a document opened from the archive.
 */
export function sectionOfRecord(kind: string, key: string): StepKey | null {
  const k = key.startsWith("PAYMENT:") ? key.slice("PAYMENT:".length) : key;
  if (/^ADJUSTMENT:|^OPENED:/.test(k)) return null;
  if (k.startsWith("INVOICE:")) return "invoices";
  if (k.startsWith("CREDIT_NOTE:")) return "credit-notes";
  if (k.startsWith("BILL:")) return "bills";
  if (k.startsWith("VCREDIT:")) return "vendor-credits";
  if (k.startsWith("EXPENSE:")) return "expenses";
  if (k.startsWith("JOURNAL:")) return "journals";
  if (k.startsWith("PROPOSAL:")) return "quotes";
  if (k.startsWith("PROFORMA:")) return "sales-orders";
  if (k.startsWith("PURCHASE_ORDER:")) return "purchase-orders";
  if (k.startsWith("PAID:")) return "vendor-payments";
  // A payment's own key is its number; its entry's is "PAYMENT:<number>:entry".
  if (kind === "payment" || key.startsWith("PAYMENT:")) return "receipts";
  return null;
}

/** What a section's undo takes with it: the sections whose records are set against its own. */
export const DEPENDENTS: Partial<Record<StepKey, StepKey[]>> = {
  invoices: ["credit-notes", "receipts"],
  bills: ["vendor-credits", "vendor-payments"],
};
