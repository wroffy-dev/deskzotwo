import type { SeedPage } from "./types";
import { comparePage, withLink, importSteps, IMPORT_AFTER, FAQ_TRIAL, FAQ_PRICING, faqHistory, FIT_BOOKS, FIT_GST, FIT_PEOPLE, FIT_COPILOT, REL_CRM, REL_INVOICES, REL_ACCOUNTING, REL_IMPORT, REL_HUB, T_ZOHO_CRM, T_ZOHO_BOOKS, T_ZOHO_PAYROLL, T_ZOHO_PEOPLE, T_GREYTHR, tool } from "./_compare-kit";
import type { Faq } from "./_compare-kit";
import type { RichInline } from "../../src/components/site/blocks/types";

/**
 * The CRM comparisons — Zoho CRM, Pipedrive, LeadSquared and Bitrix24 — for a sales team that also needs GST quotes
 * and invoices, the books and payroll on the same records. Read on 16 November 2026 from each vendor's own site.
 */

const AS_OF_CRM = { date: "2026-11-16", words: "16 November 2026" };

/** A sale that runs to the end on one company record (lead quotes, quote to order, invoice from orders, payments applied). */
const FIT_SALE: RichInline =
  "A sale that runs to the end on one record: a lead becomes a proposal, a sales order and a GST invoice for the same company, with the calls and visits that led to it.";

/** src/lib/portability/importers/leads.ts: stage by name, then by meaning; closed deals dated as they closed. */
const faqDeals = (competitor: string, headings: string): Faq => ({
  question: `Can I bring my open deals from ${competitor}?`,
  answer: [
    `Yes, as a spreadsheet. {siteName}'s leads import ${headings}puts each deal on the stage with the same name — or, failing that, the stage whose meaning matches, such as won or proposal sent — and brings closed deals across dated as they closed. The other system's record ID is kept, so running the file again changes nothing.`,
  ],
});

// ─── Zoho CRM ────────────────────────────────────────────────────────────────────────────────────

const ZOHO_CRM = comparePage({
  slug: "zoho-crm",
  competitor: "Zoho CRM",
  navTitle: "Zoho CRM",
  website: "Zoho's website (zoho.com and help.zoho.com)",
  h1: "alternative",
  keywords: ["Zoho CRM alternative", "Zoho CRM alternative in India", "compare Zoho CRM"],
  seoTitle: "Zoho CRM alternative: {siteName} vs Zoho CRM",
  seoDescription: "A Zoho CRM alternative for Indian sales teams: leads, calls and quotes beside GST invoicing, the books and payroll in one workspace, compared row by row.",
  subheading: "{siteName} keeps leads, calls and quotes in the same workspace as GST invoicing, the ledger and payroll. Compare Zoho CRM and {siteName} row by row, from Zoho's own website.",
  summary: {
    heading: "Is {siteName} a Zoho CRM alternative for an Indian sales team?",
    paragraphs: [
      [
        { text: "{siteName} is a Zoho CRM alternative for sales teams whose quotes turn into GST invoices, payments and payroll on the same records. Zoho CRM is a sales CRM; for GST invoices, Zoho points to " },
        { text: "Zoho Books, which syncs quotes and invoices with Zoho CRM", href: "https://www.zoho.com/in/books/integrations/zoho-crm/" },
        { text: ", and payroll is a third app. {siteName} does all of it in one workspace." },
      ],
      "If you are looking for a Zoho CRM alternative in India because your sales team raises GST quotes and invoices and your accounts team closes the books from the same customers, {siteName} keeps both on one set of records. If you want a free CRM for a small team, territories or deep CRM customisation, Zoho CRM may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian sales team: {siteName} from its own features, Zoho CRM — and the Zoho apps it works with — from Zoho's public website. Each Zoho row links the page it was read from.",
  rows: [
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "yes",
      note: "Zoho CRM: pipelines, forecasting and sales force automation. {siteName}: companies, contacts and a lead pipeline from new to won, with calls and field visits.",
      source: "https://www.zoho.com/crm/features.html",
    },
    {
      feature: "Web forms for enquiries",
      us: "yes",
      them: "yes",
      note: "Zoho CRM: web forms shared by link or QR code, and leads from email and business cards. {siteName}: enquiry forms that create leads, and a lead capture API with a key per website.",
      source: "https://www.zoho.com/crm/lead-management/lead-generation.html",
    },
    {
      feature: "Sharing leads out among the team",
      us: "yes",
      them: "yes",
      note: "Zoho CRM: territory management, which assigns accounts by region. {siteName}: assignment rules — round robin, fewest open leads, a named person or the account manager — matched on brand, product, designation, source or state.",
      source: "https://www.zoho.com/crm/sales-force-automation/territory-management.html",
    },
    {
      feature: "Calls from the CRM",
      us: "yes",
      them: "yes",
      note: "Zoho CRM: click-to-call through telephony providers, logged against the record. {siteName}: a phone icon on every company and lead dials the contact, times the call and records how it went, with a worklist of callbacks still owed.",
      source: "https://www.zoho.com/crm/telephony.html",
    },
    {
      feature: "Quotes",
      us: "yes",
      them: "yes",
      note: "Zoho CRM: CPQ, with pricing rules and bundles. {siteName}: proposals and proforma invoices, raised from the lead.",
      source: "https://www.zoho.com/crm/sales-force-automation/cpq.html",
    },
    {
      feature: "Sales orders and invoices",
      us: "yes",
      them: "yes",
      note: "Zoho CRM's Professional edition lists inventory management for invoices and sales and purchase orders. {siteName}: a quote becomes a sales order, and the GST invoice is raised from the order.",
      source: "https://www.zoho.com/crm/zohocrm-pricing.html",
    },
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "In Zoho Books, a separate app",
      note: "Zoho Books and Zoho CRM share customers, quotes and invoices through an integration. {siteName} works out CGST, SGST or IGST from the place of supply.",
      source: "https://www.zoho.com/in/books/integrations/zoho-crm/",
    },
    {
      feature: "GST e-invoices (IRN) and e-way bills",
      us: "yes",
      them: "In Zoho Books",
      note: "Zoho Books uploads invoices to the IRP and generates e-way bills. {siteName} generates the IRN and the e-way bill through the government's portals, from the invoice the sale produced.",
      source: "https://www.zoho.com/in/books/e-invoicing/",
    },
    {
      feature: "Accounting: ledger, bank reconciliation, statements",
      us: "yes",
      them: "In Zoho Books",
      note: "Zoho: Zoho Books, connected to Zoho CRM. {siteName} posts invoices, bills, payments and payroll to its own double-entry ledger.",
      source: "https://www.zoho.com/in/books/integrations/zoho-crm/",
    },
    {
      feature: "Payroll with PF, ESI and professional tax",
      us: "yes",
      them: "In Zoho Payroll, a separate app",
      note: "Zoho Payroll computes EPF, ESI, PT and LWF. {siteName}: salary structures and a monthly run with PF, ESI, professional tax by state and TDS on salary, for the same people who sell.",
      source: "https://www.zoho.com/in/payroll/features/",
    },
    {
      feature: "Customer portal",
      us: "yes",
      them: "yes",
      note: "Zoho CRM's portals let customers, partners and vendors see their records and place orders. {siteName}'s portal shows each customer what they have, what they owe and their open tickets.",
      source: "https://www.zoho.com/crm/customization/portals.html",
    },
    {
      feature: "Workflow automation",
      us: "yes",
      them: "yes",
      note: "Zoho CRM: workflows, Blueprint and cadences. {siteName}: workflows that run on a schedule, when something happens, or at the press of a button, with every run recorded.",
      source: "https://www.zoho.com/crm/features.html",
    },
    {
      feature: "Import from spreadsheets",
      us: "yes",
      them: "yes",
      note: "Zoho CRM imports XLS, XLSX, CSV and vCard files, with a migration wizard for other CRMs. {siteName} imports CSV and Excel files and shows a dry run of every change first.",
      source: "https://help.zoho.com/portal/en/kb/crm/data-administration/import-data/articles/import-data",
    },
    {
      feature: "Data export",
      us: "yes",
      them: "yes",
      note: "Zoho CRM exports each module as CSV or XLSX, for people allowed to export. {siteName} exports each area as CSV or Excel, and the whole workspace as one sealed backup file.",
      source: "https://help.zoho.com/portal/en/kb/crm/data-administration/export-data/articles/export-crm-data",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "Zoho CRM: Zia. {siteName}: a copilot that answers from your data with the person's own permissions, on {siteName} AI, processed in India.",
      source: "https://www.zoho.com/crm/zia/",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per user, by edition; free for 3 users",
      note: "Zoho says local taxes such as GST are charged on top of its prices. Prices: in the calculator below, each from the vendor's own pricing page with the day it was read.",
      source: "https://www.zoho.com/crm/zohocrm-pricing.html",
    },
  ],
  fits: {
    intro: "{siteName} suits a sales team whose work carries on into invoices, the books and payroll.",
    items: [FIT_SALE, FIT_BOOKS, FIT_GST, FIT_PEOPLE, FIT_COPILOT],
  },
  theirs: {
    intro: "Zoho CRM may suit you better if:",
    items: [
      withLink("you want to start free with a small team: Zoho CRM is ", "free for up to 3 users", "https://www.zoho.com/crm/zohocrm-pricing.html", ";"),
      withLink("you sell by region and want ", "territory management", "https://www.zoho.com/crm/sales-force-automation/territory-management.html", " with goals and reports per territory;"),
      withLink("you need complex quoting with ", "price rules and product bundles", "https://www.zoho.com/crm/sales-force-automation/cpq.html", ";"),
      withLink("you want to shape the CRM deeply, with ", "Blueprint, Canvas and client scripts", "https://www.zoho.com/crm/features.html", ";"),
      withLink("you already use Zoho Books, which ", "shares customers, quotes and invoices with Zoho CRM", "https://www.zoho.com/in/books/integrations/zoho-crm/", "."),
    ],
  },
  switching: {
    answer:
      "Export your Zoho CRM modules as spreadsheets and import them into {siteName} one area at a time — accounts as companies, contacts, leads and deals. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      withLink("Export from Zoho CRM: ", "each module downloads", "https://help.zoho.com/portal/en/kb/crm/data-administration/export-data/articles/export-crm-data", " as a CSV or XLSX file, for anyone with export permission."),
      "Zoho",
    ),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Can I move my Zoho CRM accounts and contacts to {siteName}?",
      answer: [
        "Yes. Export them from Zoho CRM, then import accounts into {siteName}'s Companies and contacts into Contacts, as CSV or Excel files. A dry run shows every row before anything is written, and running the file again updates rather than duplicates.",
      ],
    },
    faqDeals("Zoho CRM", "reads the usual headings of Zoho CRM's Leads and Deals exports, "),
    faqHistory("Zoho Books"),
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_CRM, REL_INVOICES, REL_ACCOUNTING, REL_IMPORT, REL_HUB],
  trademarks: "Zoho, Zoho CRM, Zoho Books, Zoho Payroll and Zia are trademarks of their owner.",
  asOf: AS_OF_CRM,
  stack: {
    heading: "Zoho CRM and the apps beside it, or {siteName} One",
    tools: [T_ZOHO_CRM, T_ZOHO_BOOKS, T_ZOHO_PAYROLL, T_ZOHO_PEOPLE],
  },
});

// ─── Pipedrive ───────────────────────────────────────────────────────────────────────────────────

const T_PIPEDRIVE = tool({
  name: "Pipedrive",
  replaces: "CRM",
  price: 0,
  per: "user",
  basis: "Growth — listed in US dollars only ($34 a seat billed monthly, $24 billed yearly, before tax): type your price",
  source: "https://www.pipedrive.com/en/pricing",
  selected: true,
});

const PIPEDRIVE = comparePage({
  slug: "pipedrive",
  competitor: "Pipedrive",
  navTitle: "Pipedrive",
  website: "Pipedrive's website (pipedrive.com and support.pipedrive.com)",
  h1: "alternative",
  keywords: ["Pipedrive alternative", "Pipedrive alternative in India", "compare Pipedrive"],
  seoTitle: "Pipedrive alternative: {siteName} vs Pipedrive",
  seoDescription: "A Pipedrive alternative for Indian sales teams: the pipeline beside GST quotes and invoices, the books and payroll in one workspace, compared row by row.",
  subheading: "{siteName} keeps the sales pipeline in the same workspace as GST quotes and invoices, the ledger and payroll. Compare Pipedrive and {siteName} row by row, from Pipedrive's own website.",
  summary: {
    heading: "Is {siteName} a Pipedrive alternative for an Indian sales team?",
    paragraphs: [
      [
        { text: "{siteName} is a Pipedrive alternative for sales teams that raise GST invoices from the deals they win. Pipedrive is a sales CRM built around the pipeline; for invoicing it points to " },
        { text: "accounting and invoicing apps in its Marketplace", href: "https://www.pipedrive.com/en/features" },
        { text: ". {siteName} raises the GST invoice, posts it to the ledger and runs payroll in the same workspace." },
      ],
      "If you are looking for a Pipedrive alternative in India because won deals still have to be re-keyed into an accounting package, {siteName} carries them through to the invoice and the books. If a simple visual pipeline is all you need, or you rely on many connected apps, Pipedrive may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian sales team: {siteName} from its own features, Pipedrive from its public website. Each Pipedrive row links the page it was read from.",
  rows: [
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "yes",
      note: "Pipedrive: customisable pipelines and lead management. {siteName}: companies, contacts and a lead pipeline from new to won, with calls and field visits.",
      source: "https://www.pipedrive.com/en/features/pipeline-management",
    },
    {
      feature: "Web forms and website chat",
      us: "yes",
      them: "yes",
      note: "Pipedrive: web forms, chatbot and live chat in the LeadBooster add-on. {siteName}: enquiry forms that create leads, and website chat with a bot in the Customer inbox add-on.",
      source: "https://www.pipedrive.com/en/features/lead-generation-software",
    },
    {
      feature: "WhatsApp conversations in the CRM",
      us: "yes",
      them: "yes",
      note: "Pipedrive connects a WhatsApp Business account. {siteName}'s Customer inbox add-on takes WhatsApp on a shared number, and makes leads from new customers.",
      source: "https://www.pipedrive.com/en/features/crm-for-whatsapp",
    },
    {
      feature: "Calls logged against deals",
      us: "yes",
      them: "yes",
      note: "Pipedrive's mobile app tracks calls against deals. {siteName}: a phone icon on every company and lead dials the contact, times the call and records how it went, with a worklist of callbacks.",
      source: "https://www.pipedrive.com/en/features/mobile-crm",
    },
    {
      feature: "Quotes and proposals",
      us: "yes",
      them: "yes",
      note: "Pipedrive: Smart Docs sends trackable quotes and proposals with eSignatures. {siteName}: proposals and proforma invoices, raised from the lead.",
      source: "https://www.pipedrive.com/en/features/smart-docs",
    },
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "Not stated on Pipedrive's website",
      note: "Pipedrive lists accounting and invoicing apps in its Marketplace. {siteName} works out CGST, SGST or IGST from the place of supply, with e-invoices and e-way bills.",
      source: "https://www.pipedrive.com/en/features",
    },
    {
      feature: "Accounting: ledger, bank reconciliation, statements",
      us: "yes",
      them: "Through Marketplace apps",
      note: "Pipedrive names QuickBooks among the 500+ tools it syncs with. {siteName} posts invoices, bills, payments and payroll to its own double-entry ledger.",
      source: "https://www.pipedrive.com/en/features",
    },
    {
      feature: "Payroll with PF, ESI and professional tax",
      us: "yes",
      them: "Not stated on Pipedrive's website",
      note: "{siteName}: salary structures and a monthly run with PF, ESI, professional tax by state and TDS on salary, for the same people who sell.",
      source: "https://www.pipedrive.com/en/features",
    },
    {
      feature: "Email campaigns",
      us: "yes",
      them: "yes",
      note: "Pipedrive: the Campaigns add-on. {siteName}: campaigns and triggered journeys, each send checked against consent first.",
      source: "https://www.pipedrive.com/en/features",
    },
    {
      feature: "Workflow automation",
      us: "yes",
      them: "yes",
      note: "Pipedrive: automations and nurturing sequences, from its Growth plan. {siteName}: workflows that run on a schedule, when something happens, or at the press of a button, with every run recorded.",
      source: "https://www.pipedrive.com/en/pricing",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "Pipedrive: permission sets and visibility groups. {siteName}: permissions per role, and which accounts each person sees.",
      source: "https://www.pipedrive.com/en/features/permissions-visibility",
    },
    {
      feature: "Import from spreadsheets",
      us: "yes",
      them: "yes",
      note: "Pipedrive imports XLS, XLSX and CSV files. {siteName} imports CSV and Excel files and shows a dry run of every change first.",
      source: "https://support.pipedrive.com/en/article/importing-data-into-pipedrive-with-spreadsheets",
    },
    {
      feature: "Data export",
      us: "yes",
      them: "yes",
      note: "Pipedrive exports as Excel or CSV. {siteName} exports each area as CSV or Excel, and the whole workspace as one sealed backup file.",
      source: "https://support.pipedrive.com/en/article/exporting-data-from-pipedrive",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "Pipedrive: an AI sales assistant and Nova, which records and transcribes calls. {siteName}: a copilot that answers from your data with the person's own permissions, on {siteName} AI, processed in India.",
      source: "https://www.pipedrive.com/en/features/ai-sales-assistant",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per seat, by plan; add-ons extra",
      note: "Pipedrive lists its prices in US dollars, before VAT. Prices: in the calculator below, each from the vendor's own pricing page with the day it was read.",
      source: "https://www.pipedrive.com/en/pricing",
    },
    {
      feature: "Where it runs",
      us: "Cloud, a database per company",
      them: "Cloud, with Android and iOS apps",
      note: "Pipedrive says its accounts are hosted in AWS data centres in Europe and the US.",
      source: "https://www.pipedrive.com/en/features/privacy-security",
    },
  ],
  fits: {
    intro: "{siteName} suits a sales team whose deals carry on into GST invoices, the books and payroll.",
    items: [FIT_SALE, FIT_BOOKS, FIT_GST, FIT_PEOPLE, FIT_COPILOT],
  },
  theirs: {
    intro: "Pipedrive may suit you better if:",
    items: [
      withLink("a visual sales pipeline is most of what you need: Pipedrive is built around ", "pipeline management", "https://www.pipedrive.com/en/features/pipeline-management", ";"),
      withLink("you rely on many other apps: Pipedrive speaks of ", "over 500 tools", "https://www.pipedrive.com/en/features", " in its Marketplace;"),
      withLink("you want calls recorded and transcribed for you, which ", "Pipedrive's Nova", "https://www.pipedrive.com/en/features", " does;"),
      withLink("you send quotes for e-signature from the CRM, with ", "Smart Docs", "https://www.pipedrive.com/en/features/smart-docs", ";"),
      withLink("your accounts already live in an accounting app that connects to Pipedrive, such as QuickBooks, among its ", "Marketplace integrations", "https://www.pipedrive.com/en/features", "."),
    ],
  },
  switching: {
    answer:
      "Export your Pipedrive organisations, people and deals as spreadsheets and import them into {siteName} one area at a time. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      withLink("Export from Pipedrive: ", "organisations, people, deals and more", "https://support.pipedrive.com/en/article/exporting-data-from-pipedrive", " download as Excel or CSV files."),
      "Pipedrive",
    ),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Can I move my Pipedrive organisations and people to {siteName}?",
      answer: [
        "Yes. Export them from Pipedrive, then import organisations into {siteName}'s Companies and people into Contacts, as CSV or Excel files. A dry run shows every row before anything is written, and running the file again updates rather than duplicates.",
      ],
    },
    faqDeals("Pipedrive", "reads the usual headings of Pipedrive's deals export, "),
    faqHistory("your accounting app"),
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_CRM, REL_INVOICES, REL_ACCOUNTING, REL_IMPORT, REL_HUB],
  trademarks: "Pipedrive and the names of its products are trademarks of their owner.",
  asOf: AS_OF_CRM,
  stack: {
    pricesAsOf: "2026-11-16",
    heading: "Pipedrive and the tools beside it, or {siteName} One",
    tools: [T_PIPEDRIVE, T_ZOHO_BOOKS, T_GREYTHR],
  },
});

// ─── LeadSquared ─────────────────────────────────────────────────────────────────────────────────

const T_LEADSQUARED = tool({
  name: "LeadSquared Sales CRM",
  replaces: "CRM",
  price: 2500,
  priceYearly: 2500,
  per: "user",
  basis: "Sales Pro — listed billed yearly only",
  source: "https://www.leadsquared.com/sales-crm-pricing/",
  selected: true,
});

const LEADSQUARED = comparePage({
  slug: "leadsquared",
  competitor: "LeadSquared",
  navTitle: "LeadSquared",
  website: "LeadSquared's website (leadsquared.com and help.leadsquared.com)",
  h1: "alternative",
  keywords: ["LeadSquared alternative", "LeadSquared alternative in India", "compare LeadSquared"],
  seoTitle: "LeadSquared alternative: {siteName} vs LeadSquared",
  seoDescription: "A LeadSquared alternative for Indian sales teams: lead distribution, calls and field visits beside GST invoicing, the books and payroll, compared row by row.",
  subheading: "{siteName} keeps lead assignment, calls and field visits in the same workspace as GST invoicing, the ledger and payroll. Compare LeadSquared and {siteName} row by row, from LeadSquared's own website.",
  summary: {
    heading: "Is {siteName} a LeadSquared alternative for an Indian sales team?",
    paragraphs: [
      [
        { text: "{siteName} is a LeadSquared alternative for sales teams whose leads end in GST invoices that the same company has to account for. LeadSquared is a sales CRM with " },
        { text: "lead distribution, field sales and cloud calling", href: "https://www.leadsquared.com/sales-crm-pricing/" },
        { text: ". {siteName} adds GST invoicing, the ledger and payroll to the same records." },
      ],
      "If you are looking for a LeadSquared alternative in India because your sales team also quotes, invoices and gets paid — and accounts and payroll sit in other tools — {siteName} keeps all of it in one workspace. If you run high-volume lead routing, large field teams or an industry where LeadSquared has a ready-made solution, LeadSquared may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian sales team: {siteName} from its own features, LeadSquared from its public website. Each LeadSquared row links the page it was read from.",
  rows: [
    {
      feature: "CRM: leads, accounts and opportunities",
      us: "yes",
      them: "yes",
      note: "LeadSquared: lead, account and opportunity management, with scoring and duplicate blocking. {siteName}: companies, contacts and a lead pipeline from new to won, with scores that explain themselves and duplicate checks.",
      source: "https://www.leadsquared.com/sales-crm-pricing/",
    },
    {
      feature: "Sharing leads out among the team",
      us: "yes",
      them: "yes",
      note: "LeadSquared's distribution engine routes by round robin, weighting, performance and more. {siteName}: assignment rules — round robin, fewest open leads, a named person or the account manager — matched on brand, product, designation, source or state.",
      source: "https://www.leadsquared.com/distribution-engine/",
    },
    {
      feature: "Field visits with check-in",
      us: "yes",
      them: "yes",
      note: "LeadSquared's mobile CRM: check-in and check-out, GPS tracking and geo-fenced tasks. {siteName}: plan a visit with its purpose, check in on the day, write up the outcome and distance, and claim the travel against it.",
      source: "https://www.leadsquared.com/mobile-crm/",
    },
    {
      feature: "Calls from the CRM",
      us: "yes",
      them: "yes",
      note: "LeadSquared connects telephony providers such as Exotel, Ozonetel and Knowlarity. {siteName}: a phone icon on every company and lead dials the contact, times the call and records how it went, with a worklist of callbacks.",
      source: "https://www.leadsquared.com/sales/",
    },
    {
      feature: "WhatsApp and website chat",
      us: "yes",
      them: "yes",
      note: "LeadSquared: WhatsApp Business API integrations, and Converse with a chatbot. {siteName}'s Customer inbox add-on: website chat with a bot and WhatsApp on a shared number, making leads from new customers.",
      source: "https://www.leadsquared.com/sales-crm-pricing/",
    },
    {
      feature: "Quotes",
      us: "yes",
      them: "yes",
      note: "LeadSquared: quote creation and management. {siteName}: proposals and proforma invoices, raised from the lead.",
      source: "https://www.leadsquared.com/sales-crm-pricing/",
    },
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "Not stated on LeadSquared's website",
      note: "{siteName} works out CGST, SGST or IGST from the place of supply, with e-invoices and e-way bills.",
      source: "https://www.leadsquared.com/sales-crm-pricing/",
    },
    {
      feature: "Payment links",
      us: "yes",
      them: "Through integrations",
      note: "LeadSquared lists Razorpay, PayU, CCAvenue and Cashfree integrations. {siteName} sends pay links for invoices through your own Razorpay or Cashfree account.",
      source: "https://www.leadsquared.com/sales/",
    },
    {
      feature: "Accounting: ledger, bank reconciliation, statements",
      us: "yes",
      them: "Not stated on LeadSquared's website",
      note: "{siteName} posts invoices, bills, payments and payroll to its own double-entry ledger.",
      source: "https://www.leadsquared.com/sales-crm-pricing/",
    },
    {
      feature: "Payroll with PF, ESI and professional tax",
      us: "yes",
      them: "Not stated on LeadSquared's website",
      note: "{siteName}: salary structures and a monthly run with PF, ESI, professional tax by state and TDS on salary, for the same people who sell.",
      source: "https://www.leadsquared.com/sales-crm-pricing/",
    },
    {
      feature: "Workflow automation",
      us: "yes",
      them: "yes",
      note: "LeadSquared: a process designer and workflow automation. {siteName}: workflows that run on a schedule, when something happens, or at the press of a button, with every run recorded.",
      source: "https://www.leadsquared.com/sales-crm-pricing/",
    },
    {
      feature: "Customer portal",
      us: "yes",
      them: "yes",
      note: "LeadSquared: Portals, an add-on. {siteName}'s portal shows each customer what they have, what they owe and their open tickets.",
      source: "https://www.leadsquared.com/sales-crm-pricing/",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "LeadSquared: permission templates. {siteName}: permissions per role, and which accounts each person sees.",
      source: "https://www.leadsquared.com/sales-crm-pricing/",
    },
    {
      feature: "Import from spreadsheets",
      us: "yes",
      them: "yes",
      note: "LeadSquared imports leads from a CSV file, 25,000 at a time unless the limit is raised. {siteName} imports CSV and Excel files and shows a dry run of every change first.",
      source: "https://help.leadsquared.com/how-to-import-leads/",
    },
    {
      feature: "Data export",
      us: "yes",
      them: "yes",
      note: "LeadSquared exports leads, activities, opportunities and tasks, up to 100,000 leads at once. {siteName} exports each area as CSV or Excel, and the whole workspace as one sealed backup file.",
      source: "https://help.leadsquared.com/export-your-data-from-leadsquared/",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "LeadSquared describes itself as an AI CRM, with AI-prioritised leads and guided selling. {siteName}: a copilot that answers from your data with the person's own permissions, on {siteName} AI, processed in India.",
      source: "https://www.leadsquared.com/sales/",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per user, billed yearly; add-ons extra",
      note: "Prices: in the calculator below, each from the vendor's own pricing page with the day it was read.",
      source: "https://www.leadsquared.com/sales-crm-pricing/",
    },
  ],
  fits: {
    intro: "{siteName} suits a sales team whose leads carry on into GST invoices, the books and payroll.",
    items: [FIT_SALE, FIT_BOOKS, FIT_GST, FIT_PEOPLE, FIT_COPILOT],
  },
  theirs: {
    intro: "LeadSquared may suit you better if:",
    items: [
      withLink("you route a high volume of leads and want ", "distribution by territory, skill, capacity and performance", "https://www.leadsquared.com/distribution-engine/", ";"),
      withLink("you run large field teams who need ", "GPS tracking, geo-fencing and offline mode", "https://www.leadsquared.com/mobile-crm/", " in the mobile app;"),
      withLink("you want cloud calling from a provider such as Exotel, Ozonetel or Knowlarity, which ", "LeadSquared connects", "https://www.leadsquared.com/sales/", ";"),
      withLink("you are in a sector LeadSquared builds for — financial services, healthcare and education among them — with ", "solutions by industry", "https://www.leadsquared.com/sales/", "."),
    ],
  },
  switching: {
    answer:
      "Export your LeadSquared leads, accounts and opportunities as spreadsheets and import them into {siteName} one area at a time. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      withLink("Export from LeadSquared: ", "leads, activities, opportunities and tasks", "https://help.leadsquared.com/export-your-data-from-leadsquared/", " can each be exported, up to 100,000 leads at once."),
      "LeadSquared",
    ),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Can I move my LeadSquared accounts and leads to {siteName}?",
      answer: [
        "Yes. Export them from LeadSquared, then import accounts into {siteName}'s Companies and their people into Contacts, as CSV or Excel files. A dry run shows every row before anything is written, and running the file again updates rather than duplicates.",
      ],
    },
    faqDeals("LeadSquared", ""),
    faqHistory("your accounting software"),
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_CRM, REL_INVOICES, REL_ACCOUNTING, REL_IMPORT, REL_HUB],
  trademarks: "LeadSquared and the names of its products are trademarks of their owner.",
  asOf: AS_OF_CRM,
  stack: {
    pricesAsOf: "2026-11-16",
    heading: "LeadSquared and the tools beside it, or {siteName} One",
    tools: [T_LEADSQUARED, T_ZOHO_BOOKS, T_GREYTHR],
  },
});

// ─── Bitrix24 ────────────────────────────────────────────────────────────────────────────────────

const T_BITRIX24 = tool({
  name: "Bitrix24 Standard",
  replaces: "CRM, tasks & chat",
  price: 6890,
  priceYearly: 4790,
  per: "org",
  included: 50,
  basis: "Standard: one flat price for up to 50 users",
  source: "https://www.bitrix24.in/prices/",
  selected: true,
});

const BITRIX24 = comparePage({
  slug: "bitrix24",
  competitor: "Bitrix24",
  navTitle: "Bitrix24",
  website: "Bitrix24's website (bitrix24.in and helpdesk.bitrix24.com)",
  h1: "alternative",
  keywords: ["Bitrix24 alternative", "Bitrix24 alternative in India", "compare Bitrix24"],
  seoTitle: "Bitrix24 alternative: {siteName} vs Bitrix24",
  seoDescription: "A Bitrix24 alternative for Indian companies: CRM, team chat and workflows beside GST invoicing, the books and payroll in one workspace, compared row by row.",
  subheading: "{siteName} keeps CRM, team chat and workflows in the same workspace as GST invoicing, the ledger and payroll. Compare Bitrix24 and {siteName} row by row, from Bitrix24's own website.",
  summary: {
    heading: "Is {siteName} a Bitrix24 alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a Bitrix24 alternative for companies that want their CRM and their GST books on one set of records. Bitrix24 brings " },
        { text: "CRM, tasks, chat, sites and HR tools", href: "https://www.bitrix24.in/tools/crm/" },
        { text: " together, and raises invoices from deals. {siteName} raises GST invoices, keeps the ledger and runs payroll beside the CRM." },
      ],
      "If you are looking for a Bitrix24 alternative in India because invoices still have to be taxed, filed and accounted for somewhere else, {siteName} does that work where the sale was made. If you want websites and an online store in the same product, or to run it on your own server, Bitrix24 may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, Bitrix24 from its public website. Each Bitrix24 row links the page it was read from.",
  rows: [
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "yes",
      note: "Bitrix24: leads, deals, contacts and pipelines. {siteName}: companies, contacts and a lead pipeline from new to won, with calls and field visits.",
      source: "https://www.bitrix24.in/tools/crm/",
    },
    {
      feature: "Web forms for enquiries",
      us: "yes",
      them: "yes",
      note: "Bitrix24: CRM forms and a website widget. {siteName}: enquiry forms that create leads, and a lead capture API with a key per website.",
      source: "https://www.bitrix24.in/tools/crm/",
    },
    {
      feature: "WhatsApp and website chat",
      us: "yes",
      them: "yes",
      note: "Bitrix24's contact centre brings in live chat, WhatsApp, Instagram, telephony and email. {siteName}'s Customer inbox add-on: website chat with a bot and WhatsApp on a shared number, making leads from new customers.",
      source: "https://www.bitrix24.in/tools/crm/",
    },
    {
      feature: "Calls from the CRM",
      us: "yes",
      them: "yes",
      note: "Bitrix24: telephony, on its paid plans. {siteName}: a phone icon on every company and lead dials the contact, times the call and records how it went, with a worklist of callbacks.",
      source: "https://www.bitrix24.in/prices/",
    },
    {
      feature: "Quotes and invoices from a deal",
      us: "yes",
      them: "yes",
      note: "Bitrix24 creates an estimate or an invoice from a deal, with the customer and products carried across. {siteName}: proposals from the lead, then the sales order and the GST invoice.",
      source: "https://helpdesk.bitrix24.com/open/15494182/",
    },
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "Not stated on Bitrix24's website",
      note: "Bitrix24's help on invoices doesn't mention GST. {siteName} works out CGST, SGST or IGST from the place of supply, with e-invoices and e-way bills.",
      source: "https://helpdesk.bitrix24.com/open/15494182/",
    },
    {
      feature: "Accounting: ledger, bank reconciliation, statements",
      us: "yes",
      them: "Not stated on Bitrix24's website",
      note: "{siteName} posts invoices, bills, payments and payroll to its own double-entry ledger.",
      source: "https://www.bitrix24.in/tools/crm/",
    },
    {
      feature: "Payroll with PF, ESI and professional tax",
      us: "yes",
      them: "Not stated on Bitrix24's website",
      note: "Bitrix24's Professional plan lists HR tools and employee hours tracking. {siteName}: salary structures and a monthly run with PF, ESI, professional tax by state and TDS on salary.",
      source: "https://www.bitrix24.in/prices/",
    },
    {
      feature: "Team chat",
      us: "yes",
      them: "yes",
      note: "Bitrix24: a team messenger and video calls. {siteName}: chat between colleagues, one to one and in groups, with files and replies.",
      source: "https://www.bitrix24.in/tools/crm/",
    },
    {
      feature: "Email campaigns",
      us: "yes",
      them: "yes",
      note: "Bitrix24: email marketing, with a monthly email allowance by plan. {siteName}: campaigns and triggered journeys, each send checked against consent first.",
      source: "https://www.bitrix24.in/prices/",
    },
    {
      feature: "Workflow automation",
      us: "yes",
      them: "yes",
      note: "Bitrix24: CRM rules and triggers, and workflow automation. {siteName}: workflows that run on a schedule, when something happens, or at the press of a button, with every run recorded.",
      source: "https://www.bitrix24.in/tools/crm/",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "Bitrix24: role-based access permissions in the CRM. {siteName}: permissions per role, and which accounts each person sees.",
      source: "https://www.bitrix24.in/tools/crm/",
    },
    {
      feature: "Import from a file",
      us: "yes",
      them: "yes",
      note: "Bitrix24 adds customers by import from a file or transfer from another CRM. {siteName} imports CSV and Excel files and shows a dry run of every change first.",
      source: "https://helpdesk.bitrix24.com/section/47482/",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "Bitrix24: CoPilot, with call transcription and summaries in the CRM. {siteName}: a copilot that answers from your data with the person's own permissions, on {siteName} AI, processed in India.",
      source: "https://www.bitrix24.in/tools/crm/",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "A flat price per company, for a set number of users",
      note: "Bitrix24 is free for 1–2 users; each paid plan includes a number of users. Prices: in the calculator below, each from the vendor's own pricing page with the day it was read.",
      source: "https://www.bitrix24.in/prices/",
    },
    {
      feature: "Where it runs",
      us: "Cloud, a database per company",
      them: "Cloud, or on your own server",
      note: "Bitrix24 On-Premise is a self-hosted version.",
      source: "https://www.bitrix24.in/self-hosted/",
    },
  ],
  fits: {
    intro: "{siteName} suits a company whose sales carry on into GST invoices, the books and payroll.",
    items: [FIT_SALE, FIT_BOOKS, FIT_GST, FIT_PEOPLE, FIT_COPILOT],
  },
  theirs: {
    intro: "Bitrix24 may suit you better if:",
    items: [
      withLink("you want to start free: Bitrix24 is ", "free for 1–2 users", "https://www.bitrix24.in/prices/", ", and its paid plans are one flat price for a set number of users;"),
      withLink("you want websites, landing pages and an online store in the same product, which ", "Bitrix24's Sites & Stores", "https://www.bitrix24.in/tools/crm/", " provide;"),
      withLink("you sell from a product catalogue with inventory in the CRM, part of ", "Bitrix24's sales tools", "https://www.bitrix24.in/tools/crm/", ";"),
      withLink("you want to run it on your own server: ", "Bitrix24 On-Premise", "https://www.bitrix24.in/self-hosted/", " is self-hosted;"),
      withLink("your team works in video calls, a company feed and a knowledge base, all part of ", "Bitrix24", "https://www.bitrix24.in/tools/crm/", "."),
    ],
  },
  switching: {
    answer:
      "Take your Bitrix24 contacts, companies and deals out as spreadsheets and import them into {siteName} one area at a time. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps("Put your Bitrix24 contacts, companies, deals and products into CSV or Excel files, one file for each.", "Bitrix24"),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Can I move my Bitrix24 companies and contacts to {siteName}?",
      answer: [
        "Yes, as spreadsheets. Import companies into {siteName}'s Companies and contacts into Contacts, as CSV or Excel files. A dry run shows every row before anything is written, and running the file again updates rather than duplicates.",
      ],
    },
    faqDeals("Bitrix24", ""),
    faqHistory("Bitrix24"),
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_CRM, REL_INVOICES, REL_ACCOUNTING, REL_IMPORT, REL_HUB],
  trademarks: "Bitrix24 and the names of its products are trademarks of their owner.",
  asOf: AS_OF_CRM,
  stack: {
    pricesAsOf: "2026-11-16",
    heading: "Bitrix24 and the tools beside it, or {siteName} One",
    tools: [T_BITRIX24, T_ZOHO_BOOKS, T_GREYTHR],
  },
});

export const pages: SeedPage[] = [ZOHO_CRM, PIPEDRIVE, LEADSQUARED, BITRIX24];
