import { productPage } from "./_build";
import type { SeedPage } from "./types";

/**
 * {siteName} for a company in the UAE (owner, 16 Nov 2026 — "UAE + industry pages"). Only what a UAE workspace does
 * today, each piece checked in the code: the country pack (src/lib/country-pack.ts — AED, VAT 5%, a January year,
 * delivery notes), VAT (src/lib/vat, src/actions/vat-return.ts), Corporate Tax (src/lib/corporate-tax.ts), payroll
 * (src/lib/uae — WPS SIF, gratuity, leave, document expiries). Not built, and said so: e-invoicing (the UAE's starts
 * in 2027), Arabic, bad-debt relief.
 */
const uae = productPage({
  slug: "solutions/uae",
  name: "UAE",
  seo: {
    title: "Business software for the UAE, with VAT and WPS",
    description: "Business software for the UAE: VAT invoices and the VAT return, Corporate Tax working, WPS payroll with gratuity, and CRM, in AED, in one workspace.",
    keywords: ["business software for the UAE", "VAT software UAE", "WPS payroll software"],
  },
  eyebrow: "For companies in the UAE",
  h1: "Business software for the UAE, with VAT and WPS payroll built in",
  lead: "Tax invoices with your TRN, VAT standard-rated, zero-rated or exempt on each line, the VAT return and Corporate Tax worked out from your books, and payroll with the WPS salary file and gratuity — in AED, beside your CRM, sales and support.",
  heroPreview: "invoice",
  answer: {
    question: "Does {siteName} work for a company in the UAE?",
    answer:
      "Yes: {siteName} is business software for the UAE as well as India. A UAE workspace keeps its books in AED from January to December, charges VAT instead of GST, prints tax invoices with your TRN, works out the VAT return and Corporate Tax, and runs payroll with the WPS salary file, gratuity and UAE leave.",
    more: [
      "CRM, quotes, orders, the helpdesk and the books are the same as everywhere.",
      "India's own pieces — GST, TDS, e-way bills, PAN and Aadhaar — are switched off, and nothing in the UAE workspace mentions them. The paper goods travel on is a delivery note.",
    ],
  },
  features: {
    heading: "What a UAE workspace has",
    columns: 3,
    items: [
      { icon: "receipt", title: "VAT on every line", body: "Standard-rated, zero-rated or exempt on each line, with the TRN on the tax invoice and tax credit note, and a simplified tax invoice where it's allowed." },
      { icon: "globe", title: "Reverse charge on imports", body: "A vendor bill for goods or services from abroad works out the VAT you account for yourself, in the return's own box." },
      { icon: "file-text", title: "The VAT return", body: "The VAT 201 boxes worked out from your invoices and bills for the period, by emirate, to file on EmaraTax." },
      { icon: "scroll", title: "Corporate Tax working", body: "From the books' profit to the tax: add-backs, exempt income, 0% on the first AED 375,000 and 9% above, and Small Business Relief." },
      { icon: "rupee", title: "WPS salary file", body: "Payroll makes the SIF file in the layout every bank takes, with routing codes for the ten largest UAE banks and the rest." },
      { icon: "users", title: "Gratuity and UAE leave", body: "End-of-service gratuity at 21 or 30 days of basic pay a year, and annual, sick, maternity, parental and other UAE leave types at a click." },
      { icon: "calendar", title: "Document expiries", body: "Passports, residence visas, Emirates IDs, labour cards and health insurance, with reminders 60, 30 and 7 days before each expires." },
      { icon: "book", title: "Books in AED", body: "A January-to-December year, Input and Output VAT accounts, IBANs on your documents, and the emirate on every address." },
      { icon: "layers", title: "The rest of the company", body: "CRM and the pipeline, quotes, orders and renewals, the helpdesk and customer portal, and WhatsApp and website chat with the Customer Inbox add-on, on the same records." },
    ],
  },
  how: [
    {
      heading: "How a UAE company starts",
      intro: "The country is chosen when the workspace is set up, and everything follows from it.",
      steps: [
        "Set up the workspace with the United Arab Emirates as its country.",
        "Add your TRN and your emirate in the organisation settings, and your bank's IBAN.",
        "Import customers, vendors and items from Excel or CSV, and enter opening balances as a journal.",
        "For payroll, choose your paying bank and add each person's labour card, Emirates ID and IBAN.",
      ],
    },
  ],
  faq: [
    ["Is {siteName} ready for UAE e-invoicing?", "Not yet. The UAE's e-invoicing begins in 2027, through accredited service providers, and {siteName} doesn't connect to one today. It prints tax invoices and tax credit notes with your TRN."],
    ["Can documents be in Arabic?", "Not today. Documents and screens are in English."],
    ["Does it file the VAT return for me?", "No. It works out the VAT 201 boxes from your books for the period; you or your tax agent file them on EmaraTax."],
    ["Which banks does the WPS file work with?", "All of them: the SIF layout is the same for every bank. The ten largest UAE banks' routing codes are built in, and another bank's is taken from its IBAN."],
    ["Can a group with companies in India and the UAE use {siteName}?", "Yes. Each company has a workspace of its own, in its own country, and people who work in both switch between them in one click."],
  ],
  related: ["/product/accounting-gst", "/product/payroll", "/product/crm", "/product/quotes-invoices", "/product/linked-workspaces", "/product/integrations"],
  relatedHeading: "Read more",
  cta: { heading: "Run your UAE company in one workspace", body: "Set up a workspace in the UAE and send your first tax invoice in AED. Every workspace starts with a {trialDays}-day free trial." },
});

export const REGION_PAGES: SeedPage[] = [uae];
