import type { RichInline } from "../../src/components/site/blocks/types";
import type { SeedPage } from "./types";
import type { Faq } from "./_compare-kit";
import { comparePage, withLink, importSteps, FAQ_TRIAL, FAQ_PRICING, FIT_BOOKS, FIT_GST, FIT_BRANCHES, FIT_REVENUE, FIT_PEOPLE, FIT_COPILOT, REL_HUB, REL_IMPORT, REL_ACCOUNTING, REL_INVOICES, REL_INVENTORY, REL_PAYROLL, REL_CRM, REL_BRANCHES, T_ZOHO_BOOKS, T_ZOHO_CRM, T_ZOHO_DESK, T_ZOHO_PAYROLL, T_GREYTHR, T_SLACK, tool } from "./_compare-kit";

/**
 * Accounting and GST software beside {siteName}: Zoho Books, BUSY, Vyapar and Marg ERP — each read on 16 November 2026
 * from the vendor's own website (zoho.com/in/books, busy.in, vyaparapp.in, margcompusoft.com), and each row links the
 * page it came from. The angle: books-and-GST software against one workspace where invoices, the ledger, CRM, payroll
 * and the helpdesk share records.
 *
 * {siteName}'s side was checked against the code on the same day, not only against the older pages' wording: stock
 * now has warehouses, batches, serials and FIFO or average costing (src/lib/inventory — no bills of materials);
 * payroll works out TDS on salary (src/lib/hr/income-tax.ts); GSTR-2B is matched to bills (src/lib/ledger/gstr2b.ts);
 * and a company switching mid-year brings the year's documents across (src/lib/migration — Zoho Books' own exports,
 * or any system's through the templates), which is why these pages don't use the kit's IMPORT_AFTER / faqHistory.
 */

const AS_OF = { date: "2026-11-16", words: "16 November 2026" };

/** Settings › Import & export › Switch partway through the year (src/lib/migration/state.ts MIGRATION_SOURCES). */
const switchAfter = (how: string): RichInline[] => [
  withLink(
    `Switching partway through the financial year? {siteName} can bring the rest of the year across — every invoice, credit note, receipt, bill, payment, expense and journal on its own date — ${how}, checked against the old books at every month end. See `,
    "import and migration",
    "/product/import-migration",
    ".",
  ),
];

const yearSoFar = (competitor: string, how: string): Faq => ({
  question: `Will this year's invoices and payments from ${competitor} come across?`,
  answer: [
    `Yes, for the current financial year. {siteName}'s switch brings the year's invoices, credit notes, receipts, bills, payments, expenses and journals across ${how}, each on its own date, and checks them against ${competitor}'s figures at every month end. For earlier years, keep ${competitor}'s exports as your archive.`,
  ],
});

const PAYROLL_US = "{siteName} computes PF and ESI, professional tax from each state's slabs, and TDS on salary, in the same workspace as attendance and leave.";
const INVENTORY_US = "{siteName}: warehouses, batches with expiry dates, serial numbers, and FIFO or weighted-average costing; no bills of materials or production.";
const GST_RETURNS_US = "{siteName} prepares GSTR-1 and GSTR-3B for each GSTIN, with the JSON file the GST portal's upload reads; you file them on the portal.";
const TDS_US = "{siteName} works out TDS on vendor bills, records each challan, and prepares the quarterly TDS statement file; the return is filed outside it.";
const EXPORT_US = "{siteName} exports each area as CSV or Excel, and the whole workspace as one sealed backup file.";
const COPILOT_US = "{siteName}: a copilot that answers from your data with the person's own permissions, on {siteName} AI, processed in India.";
const CRM_FIT: RichInline = withLink("A CRM in the same workspace as the books: companies, contacts, leads, calls and field visits, on the same customer records your invoices use. See ", "CRM", "/product/crm", ".");
const HELPDESK_FIT: RichInline = withLink("A helpdesk on the same customer records: tickets with priority, an SLA target and assignment. See ", "helpdesk", "/product/helpdesk", ".");

// ─── Zoho Books ──────────────────────────────────────────────────────────────────────────────────

const T_ZOHO_BOOKS_PREMIUM = tool({
  name: "Zoho Books Premium",
  replaces: "Accounting, GST & payroll",
  price: 3599,
  priceYearly: 2999,
  per: "org",
  included: 10,
  extra: 180,
  extraYearly: 150,
  basis: "Premium: payroll and fixed assets included; extra employees on payroll ₹75 a month (₹60 yearly)",
  source: "https://www.zoho.com/in/books/pricing/",
});

const ZOHO_BOOKS = comparePage({
  slug: "zoho-books",
  competitor: "Zoho Books",
  navTitle: "Zoho Books",
  website: "Zoho's website (zoho.com/in/books)",
  h1: "alternative",
  keywords: ["Zoho Books alternative", "Zoho Books alternative in India", "compare Zoho Books"],
  seoTitle: "Zoho Books alternative: {siteName} vs Zoho Books",
  seoDescription: "A Zoho Books alternative for Indian companies: GST invoicing and the books beside CRM, payroll and a helpdesk on one set of records. Compared row by row.",
  subheading: "{siteName} keeps GST invoicing and the books on the same records as CRM, payroll and the helpdesk. Compare Zoho Books and {siteName} row by row, from Zoho's own website.",
  summary: {
    heading: "Is {siteName} a Zoho Books alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a Zoho Books alternative for companies that want accounts and the rest of their work in one product. Zoho Books is online accounting with GST and e-invoicing, and it " },
        { text: "connects to Zoho CRM, Zoho Desk and Zoho Payroll", href: "https://www.zoho.com/in/books/addons/" },
        { text: " as separate apps. In {siteName}, invoices, the ledger, CRM, payroll and the helpdesk are modules of one workspace." },
      ],
      "If you are looking for a Zoho Books alternative in India because your sales team, your support desk and your accountant each work in a different app, {siteName} puts them on the same customer records. If accounting is the whole job, or you want to file GST returns from your accounting software or track time on projects, Zoho Books may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, Zoho Books from Zoho's public website. Each Zoho row links the page it was read from.",
  rows: [
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "yes",
      note: "Zoho describes Zoho Books as GST-compliant accounting software. {siteName} works out CGST, SGST or IGST from the place of supply.",
      source: "https://www.zoho.com/in/books/",
    },
    {
      feature: "GST e-invoices (IRN and QR code)",
      us: "yes",
      them: "yes",
      note: "Zoho Books uploads invoices to the IRP as a GST Suvidha Provider, on paid plans from Standard. {siteName} generates the IRN through the NIC e-invoice API, with your own API credentials.",
      source: "https://www.zoho.com/in/books/e-invoicing/",
    },
    {
      feature: "E-way bills",
      us: "yes",
      them: "yes",
      note: "Zoho Books handles delivery challans and e-way bills. {siteName} raises them from invoices, credit notes and delivery challans.",
      source: "https://www.zoho.com/in/books/accounting-software-features/",
    },
    {
      feature: "Several GSTINs and branches",
      us: "yes",
      them: "yes",
      note: "Zoho Books links a GSTIN to each branch. {siteName} keeps each GSTIN on a branch, with GST returns prepared for each.",
      source: "https://www.zoho.com/in/books/help/branches/basic-functions.html",
    },
    {
      feature: "GST returns (GSTR-1 and GSTR-3B)",
      us: "partial",
      them: "yes",
      note: `Zoho Books can file GSTR-1 from inside it once API access is enabled on the GST portal. ${GST_RETURNS_US}`,
      source: "https://www.zoho.com/in/books/help/gst/gstr1-filing.html",
    },
    {
      feature: "TDS on bills and invoices",
      us: "yes",
      them: "yes",
      note: `Zoho Books tracks TDS liabilities and challans. ${TDS_US}`,
      source: "https://www.zoho.com/in/books/help/tds/tds-liabilities.html",
    },
    {
      feature: "Payroll with PF, ESI and professional tax",
      us: "yes",
      them: "On Premium and above",
      note: `Zoho Books' Premium plan and those above it include payroll. ${PAYROLL_US}`,
      source: "https://www.zoho.com/in/books/pricing/",
    },
    {
      feature: "Inventory: warehouses, batches and serial numbers",
      us: "yes",
      them: "On Elite and above",
      note: `Every Zoho Books plan tracks inventory; warehouses, batches, serial numbers and bin locations are on Elite and Ultimate. ${INVENTORY_US}`,
      source: "https://www.zoho.com/in/books/pricing/",
    },
    {
      feature: "Accounting: ledger, bank reconciliation, statements",
      us: "yes",
      them: "yes",
      note: "Zoho Books fetches bank feeds and reconciles them. {siteName} reconciles from imported bank statements, matching a row only where exactly one entry fits, and leaves the rest to you.",
      source: "https://www.zoho.com/in/books/",
    },
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "Through Zoho CRM",
      note: "Zoho lists a Zoho CRM integration that syncs contacts, accounts, products and transactions. {siteName} has its own CRM: companies, contacts, leads, calls and field visits.",
      source: "https://www.zoho.com/in/books/addons/",
    },
    {
      feature: "Helpdesk tickets",
      us: "yes",
      them: "Through Zoho Desk",
      note: "Zoho lists a Zoho Desk integration that turns tickets into accounting entries. {siteName}: tickets with priority, an SLA target and assignment, on the same customer records.",
      source: "https://www.zoho.com/in/books/addons/",
    },
    {
      feature: "Recurring invoices",
      us: "yes",
      them: "yes",
      note: "Zoho Books creates recurring invoices automatically. {siteName} raises each period's invoice from the subscription order as a draft, for your team to check and issue.",
      source: "https://www.zoho.com/in/books/accounting-software-features/",
    },
    {
      feature: "Payment reminders",
      us: "yes",
      them: "yes",
      note: "Zoho Books automates invoices and reminders. {siteName} emails reminders on a schedule you set, with a pay link through your own Razorpay or Cashfree account.",
      source: "https://www.zoho.com/in/books/",
    },
    {
      feature: "Data export",
      us: "yes",
      them: "yes",
      note: `Zoho Books exports each module as CSV, XLS or XLSX. ${EXPORT_US}`,
      source: "https://www.zoho.com/in/books/help/import-export/export.html",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: `Zoho Books: ask Zia in plain English. ${COPILOT_US}`,
      source: "https://www.zoho.com/in/books/accounting-software-features/",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per organisation, by plan, with users included; a free plan",
      note: "Zoho Books' free plan is for one user and an accountant, for businesses with yearly revenue under 25 lakh rupees. Prices: in the calculator below, each from the vendor's own pricing page with the day it was read.",
      source: "https://www.zoho.com/in/books/pricing/",
    },
    {
      feature: "Where it runs",
      us: "Cloud, in a web browser",
      them: "Cloud, with mobile and desktop apps",
      note: "Zoho Books has iOS and Android apps, and a desktop app from the Microsoft Store.",
      source: "https://www.zoho.com/in/books/accounting-software-features/",
    },
  ],
  fits: {
    intro: "{siteName} suits a company whose accounts are one part of a day that also runs sales, support and people.",
    items: [FIT_BOOKS, CRM_FIT, HELPDESK_FIT, FIT_PEOPLE, FIT_REVENUE],
  },
  theirs: {
    intro: "Zoho Books may suit you better if:",
    items: [
      withLink("you want to start free: Zoho Books has ", "a free plan", "https://www.zoho.com/in/books/pricing/", " for one user and an accountant, while yearly revenue is under 25 lakh rupees;"),
      withLink("you want to file GST returns from your accounting software: ", "Zoho Books files GSTR-1", "https://www.zoho.com/in/books/help/gst/gstr1-filing.html", " once API access is enabled on the GST portal;"),
      withLink("you bill for time: ", "Zoho Books", "https://www.zoho.com/in/books/accounting-software-features/", " logs time against projects, with timesheet approval and project profitability;"),
      withLink("you want bank feeds rather than statement files: Zoho Books ", "fetches bank feeds", "https://www.zoho.com/in/books/", " and categorises entries;"),
      withLink("you already run other Zoho apps: Zoho Books ", "connects to Zoho CRM, Zoho Desk, Zoho Payroll and Zoho People", "https://www.zoho.com/in/books/addons/", "."),
    ],
  },
  switching: {
    answer:
      "Export your Zoho Books modules as spreadsheets and import them into {siteName} one area at a time — customers and vendors, contacts, items, the chart of accounts. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      withLink("Export from Zoho Books: ", "each module exports", "https://www.zoho.com/in/books/help/import-export/export.html", " as CSV, XLS or XLSX, up to 25,000 rows at a time."),
      "Zoho Books",
    ),
    after: switchAfter("from Zoho Books' own export files"),
  },
  faq: [
    {
      question: "Can I move from Zoho Books to {siteName}?",
      answer: [
        "Yes, as spreadsheets. Export customers, vendors, items and the chart of accounts from Zoho Books, then import each into {siteName}. A dry run shows every row before anything is written, and running the same file again updates rather than duplicates.",
      ],
    },
    yearSoFar("Zoho Books", "from Zoho Books' own export files"),
    {
      question: "Can I keep Zoho Books and use {siteName} for CRM and support?",
      answer: ["{siteName} has no Zoho Books integration, so records wouldn't sync between them. You can run both side by side while you move, keeping lists in step with exports and imports."],
    },
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_ACCOUNTING, REL_INVOICES, REL_CRM, REL_PAYROLL, REL_BRANCHES, REL_IMPORT, REL_HUB],
  trademarks: "Zoho, Zoho Books and the names of Zoho's apps are trademarks of their owner.",
  asOf: AS_OF,
  stack: {
    heading: "Zoho Books and the apps beside it, or {siteName} One",
    tools: [T_ZOHO_BOOKS, T_ZOHO_BOOKS_PREMIUM, T_ZOHO_CRM, T_ZOHO_PAYROLL, { ...T_ZOHO_DESK, selected: undefined }],
  },
});

// ─── BUSY ────────────────────────────────────────────────────────────────────────────────────────

const T_BUSY = tool({
  name: "BUSY SMART",
  replaces: "Accounting & GST",
  price: 666.67,
  priceYearly: 666.67,
  per: "org",
  basis: "SMART: ₹8,000 for 360 days before GST, no monthly plan; POWER, with several GSTINs, is ₹12,000",
  source: "https://busy.in/pricing/",
  selected: true,
});

const BUSY = comparePage({
  slug: "busy",
  competitor: "BUSY",
  navTitle: "BUSY",
  website: "BUSY's website (busy.in)",
  h1: "alternative",
  keywords: ["BUSY alternative", "BUSY alternative in India", "compare BUSY accounting software"],
  seoTitle: "BUSY alternative: {siteName} vs BUSY",
  seoDescription: "A BUSY alternative for Indian companies that want GST billing and the books in a browser, beside CRM, payroll and a helpdesk. Compared row by row.",
  subheading: "{siteName} keeps GST billing and the books in a browser, on the same records as CRM, payroll and the helpdesk. Compare BUSY and {siteName} row by row, from BUSY's own website.",
  summary: {
    heading: "Is {siteName} a BUSY alternative for your business?",
    paragraphs: [
      [
        { text: "{siteName} is a BUSY alternative for companies that want their accounts beside the rest of their work. BUSY is accounting and GST billing software for small and medium businesses, offered as " },
        { text: "desktop software, BUSY Online and a mobile app", href: "https://busy.in/" },
        { text: ". {siteName} runs in the cloud, and its invoices, ledger, CRM, payroll and helpdesk share one set of records." },
      ],
      "If you are looking for a BUSY alternative in India because your customers, your team and your books live in separate places, {siteName} keeps them in one workspace — and it takes BUSY's own shortcut keys. If you make what you sell, or need offline billing at a counter, BUSY may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, BUSY from its public website. Each BUSY row links the page it was read from.",
  rows: [
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "yes",
      note: "BUSY covers GST accounting, ledgers and input tax credit records. {siteName} works out CGST, SGST or IGST from the place of supply.",
      source: "https://busy.in/",
    },
    {
      feature: "GST e-invoices (IRN and QR code)",
      us: "yes",
      them: "yes",
      note: "BUSY prints the IRN and QR code on bills, up to 10,000 documents on SMART. {siteName} generates the IRN through the NIC e-invoice API, with your own API credentials.",
      source: "https://busy.in/pricing/",
    },
    {
      feature: "E-way bills",
      us: "yes",
      them: "yes",
      note: "{siteName} raises them from invoices, credit notes and delivery challans.",
      source: "https://busy.in/accounting-software/",
    },
    {
      feature: "Several GSTINs in one company",
      us: "yes",
      them: "On POWER and above",
      note: "{siteName} keeps each GSTIN on a branch, with GST returns prepared for each.",
      source: "https://busy.in/pricing/",
    },
    {
      feature: "GST returns (GSTR-1 and GSTR-3B)",
      us: "partial",
      them: "yes",
      note: `BUSY lists GSTR filing directly, by JSON or by template. ${GST_RETURNS_US}`,
      source: "https://busy.in/accounting-software/",
    },
    {
      feature: "GSTR-2B reconciliation",
      us: "yes",
      them: "yes",
      note: "BUSY reconciles GSTR-1, 2A, 2B and 3B with input credit mismatches. {siteName} matches the portal's GSTR-2B download to your bills by GSTIN and invoice number, before GSTR-3B is filed.",
      source: "https://busy.in/",
    },
    {
      feature: "TDS and TCS",
      us: "yes",
      them: "yes",
      note: `BUSY lists TDS/TCS management. ${TDS_US}`,
      source: "https://busy.in/accounting-software/",
    },
    {
      feature: "Payroll with PF, ESI and professional tax",
      us: "yes",
      them: "In the Enterprise edition",
      note: `BUSY lists payroll in its Enterprise edition. ${PAYROLL_US}`,
      source: "https://busy.in/pricing/",
    },
    {
      feature: "Inventory",
      us: "partial",
      them: "yes",
      note: `BUSY: several godowns, batches with expiry dates, serial and IMEI numbers, multi-level bills of materials and production, FIFO or LIFO valuation. ${INVENTORY_US}`,
      source: "https://busy.in/accounting-software/inventory-management/",
    },
    {
      feature: "Bank reconciliation",
      us: "yes",
      them: "yes",
      note: "{siteName} reconciles from imported bank statements, matching a row only where exactly one entry fits, and leaves the rest to you.",
      source: "https://busy.in/accounting-software/",
    },
    {
      feature: "BUSY's shortcut keys",
      us: "yes",
      them: "yes",
      note: "{siteName} takes BUSY's shortcut keys in the browser — F2 saves a voucher, Alt+T opens the trial balance. Where a browser keeps a key for itself, such as Ctrl+T or Ctrl+N, it moves to Alt.",
      source: "https://busy.in/shortcut-keys-busy-software/",
    },
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "Not stated on BUSY's website",
      note: "{siteName} has its own CRM: companies, contacts, leads, calls and field visits, on the same records as the invoices.",
      source: "https://busy.in/accounting-software/",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "BUSY lists user access control and permissions. {siteName} sets permissions per role, and which accounts each person sees.",
      source: "https://busy.in/accounting-software/",
    },
    {
      feature: "Backup and data export",
      us: "yes",
      them: "yes",
      note: `BUSY backs data up to Google Drive and exports reports to Google Sheets. ${EXPORT_US}`,
      source: "https://busy.in/accounting-software/",
    },
    {
      feature: "AI",
      us: "yes",
      them: "yes",
      note: `BUSY: AI voucher scan, which reads bills into vouchers. ${COPILOT_US}`,
      source: "https://busy.in/accounting-software/",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per edition: a 360-day subscription or a perpetual licence",
      note: "BUSY's START, SMART, POWER and POWER+ are subscriptions; Basic, Standard and Enterprise are perpetual licences; Express is free. Prices: in the calculator below, each from the vendor's own pricing page with the day it was read.",
      source: "https://busy.in/pricing/",
    },
    {
      feature: "Where it runs",
      us: "Cloud, in a web browser",
      them: "Desktop software, with BUSY Online and a mobile app",
      note: "BUSY Online gives secure remote access to the desktop software from anywhere.",
      source: "https://busy.in/",
    },
  ],
  fits: {
    intro: "{siteName} suits a company that wants its books in a browser, beside the rest of its work.",
    items: [
      CRM_FIT,
      "Work from any browser: each company has its own web address and a database of its own, and BUSY's shortcut keys still work.",
      FIT_PEOPLE,
      FIT_BRANCHES,
      FIT_REVENUE,
    ],
  },
  theirs: {
    intro: "BUSY may suit you better if:",
    items: [
      withLink("you make what you sell: BUSY lists ", "multi-level bills of materials and production", "https://busy.in/accounting-software/inventory-management/", ", which {siteName} doesn't have;"),
      withLink("you bill at a counter: BUSY's ", "Standard edition", "https://busy.in/pricing/", " includes POS billing;"),
      withLink("you want software on your own computers, with ", "BUSY Online", "https://busy.in/cloud-accounting-software/", " for access from elsewhere;"),
      withLink("you want to file GST returns from inside your accounting software: BUSY lists ", "GSTR filing directly, by JSON or by template", "https://busy.in/accounting-software/", ";"),
      withLink("you want to start free: ", "BUSY Express", "https://busy.in/pricing/", " is free billing and accounting software."),
    ],
  },
  switching: {
    answer:
      "Export your masters from BUSY to Excel and import them into {siteName} one area at a time — accounts into the chart of accounts, items into items, parties into customers and vendors. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      withLink("Export from BUSY: its ", "help pages", "https://busy.in/faqs/data-conversion/", " cover exporting masters and vouchers to Excel."),
      "BUSY",
    ),
    after: switchAfter("from your old system's files laid out in {siteName}'s templates"),
  },
  faq: [
    {
      question: "Do BUSY's shortcut keys work in {siteName}?",
      answer: [
        "Yes. {siteName} takes BUSY's keys in the browser: open a page, save or copy a voucher, pick an account. A few keys a browser keeps for itself, such as Ctrl+T and Ctrl+N, move to Alt. Press ? in {siteName} for the full list, or to switch them off.",
      ],
    },
    {
      question: "Does {siteName} work offline like BUSY's desktop software?",
      answer: ["No. {siteName} runs in a web browser and needs an internet connection to record work. If offline billing matters most to you, BUSY may be the better fit."],
    },
    {
      question: "Can I bring my BUSY accounts and items into {siteName}?",
      answer: [
        "Yes, as spreadsheets. Export the masters from BUSY to Excel, then import accounts into {siteName}'s chart of accounts, items into items, and parties into customers and vendors. A dry run shows every row before anything is written.",
      ],
    },
    yearSoFar("BUSY", "from files laid out in {siteName}'s templates"),
    FAQ_TRIAL,
  ],
  related: [REL_ACCOUNTING, REL_INVOICES, REL_INVENTORY, REL_PAYROLL, REL_CRM, REL_IMPORT, REL_HUB],
  trademarks: "BUSY and related names are trademarks of their owner.",
  asOf: AS_OF,
  stack: {
    pricesAsOf: "2026-11-16",
    heading: "BUSY and the tools beside it, or {siteName} One",
    tools: [T_BUSY, T_ZOHO_CRM, T_GREYTHR, T_SLACK, { ...T_ZOHO_DESK, selected: undefined }],
  },
});

// ─── Vyapar ──────────────────────────────────────────────────────────────────────────────────────

const T_VYAPAR = tool({
  name: "Vyapar Gold",
  replaces: "Billing & GST",
  price: 399.92,
  priceYearly: 399.92,
  per: "org",
  basis: "Gold, desktop and mobile: ₹4,799 for a year at the offer price on their page (₹9,099 struck through); no monthly plan",
  source: "https://vyaparapp.in/pricing",
  selected: true,
});

const VYAPAR = comparePage({
  slug: "vyapar",
  competitor: "Vyapar",
  navTitle: "Vyapar",
  website: "Vyapar's website (vyaparapp.in)",
  h1: "alternative",
  keywords: ["Vyapar alternative", "Vyapar alternative in India", "compare Vyapar billing software"],
  seoTitle: "Vyapar alternative: {siteName} vs Vyapar",
  seoDescription: "A Vyapar alternative for Indian companies that have outgrown billing alone: GST invoicing and the books beside CRM, payroll and a helpdesk. Compared row by row.",
  subheading: "{siteName} keeps GST invoicing and the books on the same records as CRM, payroll and the helpdesk. Compare Vyapar and {siteName} row by row, from Vyapar's own website.",
  summary: {
    heading: "Is {siteName} a Vyapar alternative for your business?",
    paragraphs: [
      [
        { text: "{siteName} is a Vyapar alternative for companies whose billing has grown into sales teams, staff and support. Vyapar is billing, accounting and inventory software for small businesses that " },
        { text: "runs on phones and computers and bills without internet", href: "https://vyaparapp.in/" },
        { text: ". {siteName} runs in the cloud, with CRM, payroll and a helpdesk on the same records as the invoices." },
      ],
      "If you are looking for a Vyapar alternative in India because you now run payroll, follow up leads and answer customer tickets beside your billing, {siteName} does that in one workspace. If quick billing from a phone or a shop counter is most of your work, Vyapar may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, Vyapar from its public website. Each Vyapar row links the page it was read from.",
  rows: [
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "yes",
      note: "Vyapar calculates tax on each bill, with several rates on one bill. {siteName} works out CGST, SGST or IGST from the place of supply.",
      source: "https://vyaparapp.in/",
    },
    {
      feature: "GST e-invoices (IRN and QR code)",
      us: "yes",
      them: "yes",
      note: "Vyapar adds the IRN and signed QR code through a GSP, without limit on Gold. {siteName} generates the IRN through the NIC e-invoice API, with your own API credentials.",
      source: "https://vyaparapp.in/free/invoicing-software/e-invoicing",
    },
    {
      feature: "E-way bills",
      us: "yes",
      them: "yes",
      note: "Vyapar's Silver plan includes 10 e-way bills a month, and Gold has no limit. {siteName} raises them from invoices, credit notes and delivery challans.",
      source: "https://vyaparapp.in/pricing",
    },
    {
      feature: "GST returns (GSTR-1 and GSTR-3B)",
      us: "partial",
      them: "GSTR reports",
      note: `Vyapar's plans list GSTR reports to check before filing. ${GST_RETURNS_US}`,
      source: "https://vyaparapp.in/free/small-business-accounting-software",
    },
    {
      feature: "Several GSTINs and branches",
      us: "yes",
      them: "Several companies, by plan",
      note: "Vyapar's Silver plan creates up to 3 companies and Gold up to 5. {siteName} keeps several GSTINs as branches of one company, with GST returns prepared for each.",
      source: "https://vyaparapp.in/pricing",
    },
    {
      feature: "TDS and TCS",
      us: "yes",
      them: "yes",
      note: `Vyapar manages TDS and TCS transactions. ${TDS_US}`,
      source: "https://vyaparapp.in/free/small-business-accounting-software",
    },
    {
      feature: "Accounting: ledger, profit and loss, balance sheet",
      us: "yes",
      them: "yes",
      note: "Vyapar records journal entries and gives profit and loss and balance sheet reports. {siteName} posts invoices, bills, payments and payroll to its own double-entry ledger, and reconciles bank statements.",
      source: "https://vyaparapp.in/free/small-business-accounting-software",
    },
    {
      feature: "Inventory: godowns, batches and expiry",
      us: "yes",
      them: "yes",
      note: `Vyapar: godowns and stock transfers, batches with expiry dates, FIFO valuation and low-stock alerts. ${INVENTORY_US}`,
      source: "https://vyaparapp.in/free/inventory-management-software",
    },
    {
      feature: "Payment reminders",
      us: "yes",
      them: "yes",
      note: "Vyapar sends bills and reminders on WhatsApp. {siteName} emails reminders on a schedule you set, with a pay link through your own Razorpay or Cashfree account.",
      source: "https://vyaparapp.in/",
    },
    {
      feature: "Payroll with PF, ESI and professional tax",
      us: "yes",
      them: "Not stated on Vyapar's website",
      note: PAYROLL_US,
      source: "https://vyaparapp.in/free/small-business-accounting-software",
    },
    {
      feature: "Staff logins and roles",
      us: "yes",
      them: "yes",
      note: "Vyapar lets you add staff and your CA and choose what each sees or edits. {siteName} sets permissions per role, and which accounts each person sees.",
      source: "https://vyaparapp.in/free/small-business-accounting-software",
    },
    {
      feature: "Export to Tally",
      us: "no",
      them: "yes",
      note: "Vyapar's Silver and Gold plans export data to Tally. {siteName} exports each area as CSV or Excel, but not in Tally's format.",
      source: "https://vyaparapp.in/pricing",
    },
    {
      feature: "Import from spreadsheets",
      us: "yes",
      them: "yes",
      note: "Vyapar imports parties and items from Excel. {siteName} imports CSV and Excel files and shows a dry run of every change first.",
      source: "https://vyaparapp.in/free/small-business-accounting-software",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per plan, yearly; a free mobile plan",
      note: "Vyapar's mobile app has a free plan with basic features. Prices: in the calculator below, each from the vendor's own pricing page with the day it was read.",
      source: "https://vyaparapp.in/",
    },
    {
      feature: "Where it runs",
      us: "Cloud, in a web browser",
      them: "Phone and computer apps; bills offline and syncs later",
      note: "Vyapar is on Android and iOS, with a desktop app, and saves bills locally until a connection returns.",
      source: "https://vyaparapp.in/",
    },
  ],
  fits: {
    intro: "{siteName} suits a business whose billing now sits beside a sales team, staff and customer support.",
    items: [FIT_BOOKS, CRM_FIT, FIT_PEOPLE, HELPDESK_FIT, FIT_GST],
  },
  theirs: {
    intro: "Vyapar may suit you better if:",
    items: [
      withLink("you bill from a phone: Vyapar runs on ", "Android and iOS", "https://vyaparapp.in/", ", and bills without an internet connection;"),
      withLink("you bill at a shop counter: Vyapar's ", "POS billing", "https://vyaparapp.in/", " works with weighing scales, card machines and thermal printers;"),
      withLink("your accountant keeps the books in Tally: Vyapar ", "exports data to Tally", "https://vyaparapp.in/pricing", ";"),
      withLink("you want an online store: Vyapar lets you ", "create one and share its link", "https://vyaparapp.in/", ";"),
      withLink("you want to start free: Vyapar's mobile app has ", "a free plan", "https://vyaparapp.in/", " with basic features."),
    ],
  },
  switching: {
    answer:
      "Bring your parties and items across as spreadsheets and import them into {siteName} one area at a time — customers and vendors, contacts, items. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps("Export your parties and items from Vyapar as spreadsheets, or keep the Excel files you first imported them from.", "Vyapar"),
    after: switchAfter("from your old system's files laid out in {siteName}'s templates"),
  },
  faq: [
    {
      question: "Does {siteName} work offline like Vyapar?",
      answer: ["No. {siteName} runs in a web browser and needs an internet connection to record work. If billing without internet matters most to you, Vyapar may be the better fit."],
    },
    {
      question: "Can I move my Vyapar parties and items to {siteName}?",
      answer: [
        "Yes, as spreadsheets. Import parties into {siteName}'s customers and vendors, and items into items, from CSV or Excel files. A dry run shows every row before anything is written, and running the same file again updates rather than duplicates.",
      ],
    },
    yearSoFar("Vyapar", "from files laid out in {siteName}'s templates"),
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_INVOICES, REL_ACCOUNTING, REL_INVENTORY, REL_PAYROLL, REL_CRM, REL_IMPORT, REL_HUB],
  trademarks: "Vyapar and related names are trademarks of their owner.",
  asOf: AS_OF,
  stack: {
    pricesAsOf: "2026-11-16",
    heading: "Vyapar and the tools beside it, or {siteName} One",
    tools: [T_VYAPAR, T_ZOHO_CRM, T_GREYTHR, T_SLACK, { ...T_ZOHO_DESK, selected: undefined }],
  },
});

// ─── Marg ERP ────────────────────────────────────────────────────────────────────────────────────

const T_MARG_SILVER = tool({
  name: "Marg ERP 9+ Silver",
  replaces: "Billing, accounting & GST",
  price: 1158.33,
  priceYearly: 1158.33,
  per: "org",
  basis: "Silver: ₹13,900 before GST for the licence and first year, then ₹4,780 a year; one full user, ₹3,000 per extra",
  source: "https://margcompusoft.com/marg-price-list.html",
  selected: true,
});
const T_MARG_GOLD = tool({
  name: "Marg ERP 9+ Gold",
  replaces: "Billing, accounting & GST, unlimited users",
  price: 2166.67,
  priceYearly: 2166.67,
  per: "org",
  basis: "Gold Edition: ₹26,000 before GST for the licence and its first year, unlimited users; then ₹19,100 a year",
  source: "https://margcompusoft.com/marg-price-list.html",
});

const MARG = comparePage({
  slug: "marg-erp",
  competitor: "Marg ERP",
  navTitle: "Marg ERP",
  website: "Marg ERP's website (margcompusoft.com)",
  h1: "alternative",
  h1Name: "Marg",
  keywords: ["Marg ERP alternative", "Marg ERP alternative in India", "compare Marg ERP"],
  seoTitle: "Marg ERP alternative: {siteName} vs Marg ERP",
  seoDescription: "A Marg ERP alternative for Indian companies that want GST billing and the books in a browser, beside CRM, payroll and a helpdesk. Compared row by row.",
  subheading: "{siteName} keeps GST billing and the books in a browser, on the same records as CRM, payroll and the helpdesk. Compare Marg ERP and {siteName} row by row, from Marg's own website.",
  summary: {
    heading: "Is {siteName} a Marg ERP alternative for your business?",
    paragraphs: [
      [
        { text: "{siteName} is a Marg ERP alternative for companies that want their accounts in a browser. Marg ERP is GST billing, inventory and accounting software built for retailers, distributors, pharma and FMCG businesses, and it " },
        { text: "works offline as desktop-first software", href: "https://margcompusoft.com/accounting-software.html" },
        { text: ". {siteName} runs in the cloud, with CRM, payroll and a helpdesk on the same records as the invoices." },
      ],
      "If you are looking for a Marg ERP alternative in India because your sales, your people and your support live outside your billing software, {siteName} keeps them in one workspace. If you run a pharmacy, distribute through salesmen's order apps or bill at a counter, Marg ERP may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, Marg ERP from Marg's public website. Each Marg row links the page it was read from.",
  rows: [
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "yes",
      note: "Marg adds CGST, SGST or IGST on each bill. {siteName} works out CGST, SGST or IGST from the place of supply.",
      source: "https://margcompusoft.com/gst-billing-software.html",
    },
    {
      feature: "GST e-invoices (IRN and QR code)",
      us: "yes",
      them: "yes",
      note: "Marg creates the IRN and QR code from the bill. {siteName} generates the IRN through the NIC e-invoice API, with your own API credentials.",
      source: "https://margcompusoft.com/gst-billing-software.html",
    },
    {
      feature: "E-way bills",
      us: "yes",
      them: "yes",
      note: "Both raise them from the invoice.",
      source: "https://margcompusoft.com/gst-billing-software.html",
    },
    {
      feature: "GST returns (GSTR-1 and GSTR-3B)",
      us: "partial",
      them: "yes",
      note: `Marg pushes data to the GST portal as Excel, JSON or CSV, and files GSTR-1, 3B, 4 and 9 from the software. ${GST_RETURNS_US}`,
      source: "https://margcompusoft.com/gst-billing-software.html",
    },
    {
      feature: "GSTR-2B reconciliation",
      us: "yes",
      them: "yes",
      note: "Marg reconciles GSTR-2A and 2B. {siteName} matches the portal's GSTR-2B download to your bills by GSTIN and invoice number, before GSTR-3B is filed.",
      source: "https://margcompusoft.com/",
    },
    {
      feature: "TDS and TCS",
      us: "yes",
      them: "yes",
      note: `Marg files TDS and TCS returns online. ${TDS_US}`,
      source: "https://margcompusoft.com/accounting-software.html",
    },
    {
      feature: "Several branches and locations",
      us: "yes",
      them: "yes",
      note: "Marg manages multi-location and multi-branch businesses. {siteName} keeps each GSTIN on a branch, with GST returns prepared for each.",
      source: "https://margcompusoft.com/",
    },
    {
      feature: "Payroll with PF, ESI and professional tax",
      us: "yes",
      them: "In Marg HRMS",
      note: `Marg HRMS, Marg's payroll software, handles PF, ESI and TDS. ${PAYROLL_US}`,
      source: "https://margcompusoft.com/payroll-software.html",
    },
    {
      feature: "Inventory",
      us: "partial",
      them: "yes",
      note: `Marg: batches with expiry dates, near-expiry stock, several godowns, reorder levels, and bills of materials for manufacturers. ${INVENTORY_US}`,
      source: "https://margcompusoft.com/inventory-management-software.html",
    },
    {
      feature: "Bank reconciliation",
      us: "yes",
      them: "yes",
      note: "Marg connects to 140+ banks and auto-reconciles imported statements. {siteName} reconciles from imported bank statements, matching a row only where exactly one entry fits, and leaves the rest to you.",
      source: "https://margcompusoft.com/accounting-software.html",
    },
    {
      feature: "Payment reminders",
      us: "yes",
      them: "yes",
      note: "Marg sends payment reminders on WhatsApp. {siteName} emails reminders on a schedule you set, with a pay link through your own Razorpay or Cashfree account.",
      source: "https://margcompusoft.com/",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "Marg controls user access. {siteName} sets permissions per role, and which accounts each person sees.",
      source: "https://margcompusoft.com/accounting-software.html",
    },
    {
      feature: "Data export",
      us: "yes",
      them: "yes",
      note: `Marg exports reports to Excel, Word, HTML, CSV and PDF. ${EXPORT_US}`,
      source: "https://margcompusoft.com/faq.html",
    },
    {
      feature: "Import from other software",
      us: "yes",
      them: "yes",
      note: "Marg can bring in a financial year's data from Tally. {siteName} imports CSV and Excel files and shows a dry run of every change first.",
      source: "https://margcompusoft.com/faq.html",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per edition: a licence with its first year, then a yearly renewal",
      note: "Marg ERP 9+ editions differ by users and companies; the yearly renewal (ARC) covers the licence and upgrades. Prices: in the calculator below, each from the vendor's own pricing page with the day it was read.",
      source: "https://margcompusoft.com/marg-price-list.html",
    },
    {
      feature: "Where it runs",
      us: "Cloud, in a web browser",
      them: "Desktop first, offline; with online features",
      note: "Marg also offers Marg Cloud, and MargBooks as cloud software.",
      source: "https://margcompusoft.com/accounting-software.html",
    },
  ],
  fits: {
    intro: "{siteName} suits a company that wants its books in a browser, beside the rest of its work.",
    items: [FIT_BOOKS, CRM_FIT, FIT_PEOPLE, HELPDESK_FIT, FIT_COPILOT],
  },
  theirs: {
    intro: "Marg ERP may suit you better if:",
    items: [
      withLink("you run a pharmacy or distribute medicines: Marg's ", "pharmacy software", "https://margcompusoft.com/", " has medicine search, salt and substitute information, and batch-wise stock;"),
      withLink("your salesmen and retailers order from apps: Marg lists ", "eOrder, eRetail, eOwner and eDelivery", "https://margcompusoft.com/", ";"),
      withLink("you make what you sell: Marg keeps ", "bills of materials", "https://margcompusoft.com/inventory-management-software.html", " for production runs;"),
      withLink("billing must carry on without internet: Marg ", "works offline as desktop-first software", "https://margcompusoft.com/accounting-software.html", ";"),
      withLink("you want help nearby: Marg lists ", "850+ sales and support centres", "https://margcompusoft.com/", "."),
    ],
  },
  switching: {
    answer:
      "Export your masters from Marg to Excel and import them into {siteName} one area at a time — ledgers into the chart of accounts, items into items, parties into customers and vendors. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      withLink("Export from Marg: ", "Marg exports", "https://margcompusoft.com/faq.html", " to Excel, CSV and other formats."),
      "Marg ERP",
    ),
    after: switchAfter("from your old system's files laid out in {siteName}'s templates"),
  },
  faq: [
    {
      question: "Does {siteName} work offline like Marg ERP?",
      answer: ["No. {siteName} runs in a web browser and needs an internet connection to record work. If offline billing matters most to you, Marg ERP may be the better fit."],
    },
    {
      question: "Can I bring my Marg ledgers and items into {siteName}?",
      answer: [
        "Yes, as spreadsheets. Export the masters from Marg to Excel, then import ledgers into {siteName}'s chart of accounts, items into items, and parties into customers and vendors. A dry run shows every row before anything is written.",
      ],
    },
    yearSoFar("Marg ERP", "from files laid out in {siteName}'s templates"),
    {
      question: "Does {siteName} track batches and expiry dates?",
      answer: [
        "Yes. An item can keep batches with manufacturing and expiry dates, and a sale takes the earliest expiry first unless you name a batch. Stock is kept by warehouse, with serial numbers where an item needs them. There are no bills of materials or production.",
      ],
    },
    FAQ_TRIAL,
  ],
  related: [REL_ACCOUNTING, REL_INVOICES, REL_INVENTORY, REL_PAYROLL, REL_CRM, REL_IMPORT, REL_HUB],
  trademarks: "Marg, Marg ERP and related names are trademarks of their owner.",
  asOf: AS_OF,
  stack: {
    pricesAsOf: "2026-11-16",
    heading: "Marg ERP and the tools beside it, or {siteName} One",
    tools: [T_MARG_SILVER, T_MARG_GOLD, T_ZOHO_CRM, T_GREYTHR, T_SLACK, { ...T_ZOHO_DESK, selected: undefined }],
  },
});

export const pages: SeedPage[] = [ZOHO_BOOKS, BUSY, VYAPAR, MARG];
