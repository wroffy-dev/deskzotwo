import type { TemplateField } from "@/lib/console-shared/mail-template-engine";
import type { MailTemplateDef } from "@/lib/console-shared/mail-templates";

/** Deskzo's own emails in this group, with Deskzo's wording — see src/lib/console-shared/mail-templates.ts. */

const WORKSPACE: TemplateField = { name: "workspace", about: "The workspace's name", sample: "Wroffy Technologies Pvt Ltd" };
const BILLING_URL: TemplateField = { name: "billingUrl", about: "The workspace's billing page", sample: "https://wroffy.deskzo.com/settings/billing" };
const WHEN: TemplateField = { name: "when", about: "How soon: \"tomorrow\" or \"in 3 days\"", sample: "in 3 days" };
const END_DATE: TemplateField = { name: "date", about: "The day it ends, on the workspace's clock", sample: "15 November 2026" };

/** Reminders 7, 3 and 1 days before (src/lib/billing/lifecycle.ts). */
const REMINDER_FIELDS = [WORKSPACE, WHEN, END_DATE, BILLING_URL];

/** What a proforma, tax invoice and credit note mail have in common (src/lib/billing/proforma.ts, tax-invoice.ts). */
const documentFields = (number: string, url: string): TemplateField[] => [
  { name: "number", about: "The document's number", sample: number },
  { name: "lines", about: "What it is for, a line each with its taxable value", sample: "Deskzo One — 10 people, a year: ₹1,49,900.00" },
  { name: "taxable", about: "The taxable value", sample: "₹1,49,900.00" },
  { name: "rate", about: "The GST rate, in per cent", sample: "18" },
  { name: "gst", about: "The GST: CGST + SGST within the state, IGST across", sample: "CGST ₹13,491.00 + SGST ₹13,491.00" },
  { name: "total", about: "The total, GST included", sample: "₹1,76,882.00" },
  { name: "totalInWords", about: "The total in words", sample: "Rupees One Lakh Seventy-Six Thousand Eight Hundred Eighty-Two Only" },
  { name: "url", about: "The link to view it or save it as a PDF", sample: url },
  { name: "seller", about: "Deskzo's company name, as on the document", sample: "Deskzo Technologies Pvt Ltd" },
  { name: "sellerGstin", about: "Deskzo's GSTIN", sample: "07AABCD1234E1Z5" },
];

const END_USER: TemplateField = { name: "endUser", about: "When a distributor paid: the workspace it is for, and its address", sample: "Wroffy Technologies Pvt Ltd (wroffy.deskzo.com)" };

export const TEMPLATES: MailTemplateDef[] = [
  {
    key: "billing.trialEnding",
    label: "Trial ending",
    group: "Billing",
    when: "Seven, three and one days before a workspace's free trial ends.",
    type: "BILLING",
    fromWorkspace: true,
    fields: REMINDER_FIELDS,
    required: ["billingUrl"],
    subject: "Your trial of {workspace} ends {when}",
    text: "Your free trial ends on {date}.\n\nChoose a plan to keep everything as it is:\n{billingUrl}",
  },
  {
    key: "billing.renewDue",
    label: "Paid period ending",
    group: "Billing",
    when: "Seven, three and one days before a period paid offline (a bank transfer, a distributor) ends.",
    type: "BILLING",
    fromWorkspace: true,
    fields: REMINDER_FIELDS,
    required: ["billingUrl"],
    subject: "{workspace} is paid until {date}",
    text:
      "{workspace} is paid until {date}. To carry on after that, pay the next period by bank transfer as before — or write to us to pay another way.\n\n" +
      "Your plan and invoices:\n{billingUrl}",
  },
  {
    key: "billing.holdComing",
    label: "Hold coming",
    group: "Billing",
    when: "Seven, three and one days before an unpaid workspace is held.",
    type: "BILLING",
    fromWorkspace: true,
    fields: REMINDER_FIELDS,
    required: ["billingUrl"],
    subject: "{workspace} will be held {when}",
    text:
      "{workspace} will be held on {date} unless the subscription is paid — nothing is deleted, but nobody can work in it until it is.\n\n" +
      "Settle it here:\n{billingUrl}\n\n" +
      "Leaving? Download what you want to keep from Settings › Data before then. Once it's held, only the billing page opens.",
  },
  {
    key: "billing.proforma",
    label: "Proforma",
    group: "Billing",
    when: "A workspace asks for a proforma to pay by bank transfer — to its billing address and whoever asked.",
    type: "BILLING",
    fromWorkspace: true,
    fields: [
      ...documentFields("DZ/PF/2026-27/0001", "https://deskzo.com/invoice/p.example"),
      { name: "date", about: "The day it was issued", sample: "2026-11-01" },
      {
        name: "bankDetails",
        about: "Deskzo's bank account, a line each, with the UPI line when there is one",
        sample: "  Deskzo Technologies Pvt Ltd\n  HDFC Bank\n  Account 50200012345678, IFSC HDFC0001234\n  or by UPI to deskzo@hdfcbank",
      },
      { name: "validUntil", about: "The last day it holds", sample: "2026-12-01" },
    ],
    required: ["url"],
    subject: "Proforma {number} from {seller}",
    text:
      "Proforma {number}, {date}\n\n" +
      "{lines}\nTaxable value: {taxable}\nGST at {rate}%: {gst}\nTotal to pay: {total} ({totalInWords})\n\n" +
      "Pay by bank transfer (NEFT, RTGS, IMPS) to:\n{bankDetails}\n\n" +
      "Quote {number} as the payment's reference. This proforma holds until {validUntil}.\n" +
      "Once the payment reaches us, your plan is switched on and your GST tax invoice is emailed to you.\n\n" +
      "View or save it as a PDF: {url}\n\n" +
      "{seller} · GSTIN {sellerGstin}",
  },
  {
    key: "billing.taxInvoice",
    label: "Tax invoice",
    group: "Billing",
    when: "A rupee invoice is paid and its GST tax invoice issued — to whoever it is made out to.",
    type: "BILLING",
    fromWorkspace: true,
    fields: [...documentFields("DZ/2026-27/0001", "https://deskzo.com/invoice/i.example"), { name: "date", about: "The day it was issued", sample: "2026-11-01" }, END_USER],
    required: ["url"],
    subject: "Tax invoice {number} from {seller}",
    text:
      "Tax invoice {number}, {date}\n\n" +
      "{lines}\nTaxable value: {taxable}\nGST at {rate}%: {gst}\nTotal: {total} ({totalInWords})\n[[For: {endUser}]]\n\n" +
      "View or save it as a PDF: {url}\n\n" +
      "{seller} · GSTIN {sellerGstin}",
  },
  {
    key: "billing.creditNote",
    label: "Credit note",
    group: "Billing",
    when: "An amount is refunded or voided against a tax invoice — to whoever the invoice was made out to.",
    type: "BILLING",
    fromWorkspace: true,
    fields: [
      ...documentFields("DZ/CN/2026-27/0001", "https://deskzo.com/invoice/c.example"),
      { name: "date", about: "The day it was issued", sample: "2026-11-01" },
      { name: "invoiceNumber", about: "The tax invoice it is against", sample: "DZ/2026-27/0001" },
      END_USER,
    ],
    required: ["url"],
    subject: "Credit note {number} from {seller}",
    text:
      "Credit note {number}, {date}\n[[Against tax invoice {invoiceNumber}]]\n\n" +
      "{lines}\nTaxable value: {taxable}\nGST at {rate}%: {gst}\nTotal: {total} ({totalInWords})\n[[For: {endUser}]]\n\n" +
      "View or save it as a PDF: {url}\n\n" +
      "{seller} · GSTIN {sellerGstin}",
  },
];
