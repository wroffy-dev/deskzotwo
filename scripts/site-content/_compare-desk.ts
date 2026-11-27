import type { RichInline } from "../../src/components/site/blocks/types";
import type { SeedPage } from "./types";
import {
  comparePage,
  withLink,
  importSteps,
  IMPORT_AFTER,
  FAQ_TRIAL,
  FAQ_PRICING,
  faqHistory,
  FIT_BOOKS,
  FIT_GST,
  FIT_PEOPLE,
  FIT_DATABASE,
  REL_HELPDESK,
  REL_CRM,
  REL_IMPORT,
  REL_HUB,
  REL_ACCOUNTING,
  REL_INVOICES,
  REL_MARKETING,
  tool,
  T_FRESHDESK,
  T_FRESHSALES,
  T_ZOHO_DESK,
  T_ZOHO_CRM,
  T_ZOHO_BOOKS,
} from "./_compare-kit";

/** Kylas CRM, monday CRM, Freshdesk and Zoho Desk beside {siteName}: read on 16 November 2026 from each vendor's own site. */

const AS_OF_16_NOV = { date: "2026-11-16", words: "16 November 2026" };

// ─── Shared wording about {siteName}'s support side (true of the code, 16 Nov 2026) ─────────────
//
// Tickets: src/lib/tickets.ts (SLA_HOURS — a fixed window per priority, not configurable), prisma Ticket (company,
// contact, the product they have, the asset). Email: src/lib/support-mail (<slug>@tickets.deskzo.com). Website chat
// and WhatsApp: src/lib/inbox, the module "inbox" sold as the Customer inbox add-on. Portal: src/lib/portal/access.ts
// and src/components/portal. Ratings: src/lib/feedback + the inbox's close rating. Support load: src/lib/support/load.ts.
// No knowledge base or help centre for customers: the bot answers from set answers and, with AI on, website pages.

const FIT_PORTAL: RichInline = "A customer portal on the same records: each customer sees their subscriptions, invoices, payments, open tickets and machines, pays an invoice online, asks for a renewal or more seats, and reports a problem that opens a ticket.";
const FIT_LOAD: RichInline = "Support set against what each customer pays: tickets for each lakh of rupees billed, beside the typical customer's, so a heavy-support account shows up before its renewal.";
const FIT_CHANNELS: RichInline = "Email to your helpdesk address opens tickets at the right company, and the Customer inbox add-on brings website chat and WhatsApp into one queue, with a ticket from any conversation.";

// ─── Kylas CRM ───────────────────────────────────────────────────────────────────────────────────

const KYLAS = comparePage({
  slug: "kylas",
  competitor: "Kylas CRM",
  navTitle: "Kylas CRM",
  website: "Kylas's website (kylas.io)",
  h1: "alternative",
  h1Name: "Kylas",
  keywords: ["Kylas CRM alternative", "Kylas CRM alternative in India", "compare Kylas CRM"],
  seoTitle: "Kylas CRM alternative: {siteName} vs Kylas",
  seoDescription: "A Kylas CRM alternative for Indian companies: leads, calls and field visits beside GST invoicing, the books, support and payroll in one workspace.",
  subheading: "{siteName} keeps leads, calls and field visits beside GST invoicing, the books, support and payroll. Compare Kylas CRM and {siteName} row by row, from Kylas's own website.",
  summary: {
    heading: "Is {siteName} a Kylas CRM alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a Kylas alternative for companies whose sales team hands over to invoicing, support and accounts in the same place. Kylas is a sales CRM: leads, deals, calling, WhatsApp and field sales. On its quotation page, " },
        { text: "invoices are listed as coming soon", href: "https://kylas.io/features/quotation-management" },
        { text: ". {siteName} raises GST invoices from the same records and keeps the ledger itself." },
      ],
      "If you are looking for a Kylas CRM alternative in India because the sale is only the start — the order, the GST invoice, the payment and the support tickets that follow — {siteName} keeps them on one set of records. If you only need a sales CRM with unlimited users on a flat plan, or live tracking of field reps, Kylas may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, Kylas CRM from its public website. Each Kylas row links the page it was read from.",
  rows: [
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "yes",
      note: "Kylas: custom pipelines for leads and deals. {siteName}: companies, contacts and a lead pipeline from new to won, with team pipelines and stage rules.",
      source: "https://kylas.io/features/pipeline-management",
    },
    {
      feature: "Leads from website forms and lead portals",
      us: "partial",
      them: "yes",
      note: "Kylas captures leads from web forms, Facebook and Google ads, and from IndiaMART, TradeIndia and Justdial. {siteName} takes leads from your website's forms through its lead capture API and from the website chat; it has no IndiaMART or Justdial connection.",
      source: "https://kylas.io/features/lead-management",
    },
    {
      feature: "Lead assignment rules",
      us: "yes",
      them: "yes",
      note: "Kylas routes leads by round robin, and by product, location and campaign source. {siteName}'s rules match on product, source, designation and the customer's country, state, city or PIN code, then choose by round robin, the least loaded, or a share weighted by how each person works their leads.",
      source: "https://kylas.io/features/lead-management",
    },
    {
      feature: "Duplicate leads",
      us: "yes",
      them: "yes",
      note: "Both find duplicate leads. {siteName} also matches a new enquiry against existing contacts, so a repeat enquiry doesn't create a second person.",
      source: "https://kylas.io/features/lead-management",
    },
    {
      feature: "Calling and call logs",
      us: "yes",
      them: "yes",
      note: "Kylas: click-to-call from a lead or deal, call logs and recordings. {siteName}: a phone icon on every company, lead, ticket and renewal that dials the contact, times the call and records how it went, with CallerDesk cloud calling as an option.",
      source: "https://kylas.io/features/sales-calling",
    },
    {
      feature: "WhatsApp",
      us: "yes",
      them: "yes",
      note: "Kylas: inbuilt WhatsApp, as an add-on. {siteName}: WhatsApp on a shared business number and on reps' own numbers, in the Customer inbox add-on.",
      source: "https://kylas.io/whatsapp-feature",
    },
    {
      feature: "Field sales visits",
      us: "partial",
      them: "yes",
      note: "Kylas: geo check-ins and check-outs, live location and route replay. {siteName}: visits planned with a purpose, checked in and out with the phone's location at each, the outcome written up and travel claimed; there is no live location tracking.",
      source: "https://kylas.io/features/field-sales-management",
    },
    {
      feature: "Quotes",
      us: "yes",
      them: "yes",
      note: "Kylas builds quotations from CRM data and product images. {siteName}: proposals and proforma invoices.",
      source: "https://kylas.io/features/quotation-management",
    },
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "Not stated on Kylas's website",
      note: "Kylas's quotation page lists invoices as coming soon and doesn't mention GST. {siteName} works out CGST, SGST or IGST from the place of supply, with e-invoices and e-way bills.",
      source: "https://kylas.io/features/quotation-management",
    },
    {
      feature: "Accounting: ledger, bank reconciliation, statements",
      us: "yes",
      them: "Not stated on Kylas's website",
      note: "Kylas's integrations name Razorpay and Stripe under payment and invoicing, and no accounting software. {siteName} posts invoices, bills, payments and payroll to its own double-entry ledger.",
      source: "https://kylas.io/features/integrations",
    },
    {
      feature: "Help desk tickets",
      us: "yes",
      them: "Through Zendesk",
      note: "Kylas's Zendesk integration tracks support tickets from within Kylas. {siteName}: tickets with priority, an SLA target and assignment, on the same company record as the sale.",
      source: "https://kylas.io/features/integrations",
    },
    {
      feature: "Workflows",
      us: "yes",
      them: "yes",
      note: "Kylas: triggers, conditions and actions, such as emails at each pipeline stage. {siteName}: workflows that run on a schedule, when something happens, or at the press of a button, with every run recorded.",
      source: "https://kylas.io/features/sales-automation",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "Kylas sets permissions by profile, with teams and sharing rules. Both set what each person can see and change.",
      source: "https://kylas.io/features/user-management",
    },
    {
      feature: "Import and export",
      us: "yes",
      them: "yes",
      note: "Kylas imports up to 10,000 records a batch on its paid plans, and 250 on its free plan. {siteName} imports CSV and Excel files with a dry run of every change first, and exports each area as CSV or Excel.",
      source: "https://kylas.io/pricing",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "Kylas: call sentiment analysis, email drafting and lead scoring. {siteName}: a copilot that answers from your data with the person's own permissions, on {siteName} AI, processed in India.",
      source: "https://kylas.io/features/artificial-intelligence",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Flat plans with unlimited users; a free plan",
      note: "Kylas's pricing page shows no amount for its Elevate plan, and Exceed is a custom plan, so this page has no price calculator. Check Kylas's own pricing page.",
      source: "https://kylas.io/pricing",
    },
    {
      feature: "Where it runs",
      us: "Cloud, a database per company",
      them: "Cloud, with Android and iOS apps",
      note: "Kylas's mobile app makes calls with real-time logging.",
      source: "https://kylas.io/features/mobile-app",
    },
  ],
  fits: {
    intro: "{siteName} suits a company whose sales team hands over to invoicing, support and accounts.",
    items: [FIT_BOOKS, FIT_GST, "Support on the same company record as the sale: tickets with priority, an SLA target and assignment, and calls logged against them.", FIT_PEOPLE, FIT_DATABASE],
  },
  theirs: {
    intro: "Kylas CRM may suit you better if:",
    items: [
      withLink("you want unlimited users on a flat plan, or to start free: Kylas's ", "pricing page", "https://kylas.io/pricing", " lists a lifetime free plan, and no plan is charged per user;"),
      withLink("your leads come from IndiaMART, TradeIndia or Justdial, which ", "Kylas captures", "https://kylas.io/features/lead-management", " automatically;"),
      withLink("you want to see where field reps are during the day: Kylas offers ", "live location and route replay", "https://kylas.io/features/field-sales-management", ";"),
      withLink("you use a particular telephony provider: Kylas's marketplace names ", "Aircall, MyOperator, Airtel and others", "https://kylas.io/features/integrations", " among 350+ apps;"),
      withLink("you want call recordings analysed: Kylas lists ", "AI call sentiment analysis", "https://kylas.io/features/artificial-intelligence", "."),
    ],
  },
  switching: {
    answer:
      "Export your Kylas leads, contacts and companies as spreadsheets and import them into {siteName} one area at a time. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(withLink("Export from Kylas: data export is included on ", "every Kylas plan", "https://kylas.io/pricing", "."), "Kylas"),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Can I move my Kylas leads and contacts to {siteName}?",
      answer: [
        "Yes. Export them from Kylas, then import them into {siteName}'s Leads, Companies and Contacts as CSV or Excel files. A dry run shows every row before anything is written, and running the file again updates rather than duplicates.",
      ],
    },
    {
      question: "Does {siteName} assign new leads automatically, like Kylas?",
      answer: [
        "Yes. Assignment rules match on product, source, designation and where the customer is — country, state, city or PIN code — and choose by round robin, the least loaded, the account's own manager, or a share weighted by how each person works their leads.",
      ],
    },
    faqHistory("Kylas"),
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_CRM, REL_INVOICES, REL_HELPDESK, REL_IMPORT, REL_HUB],
  trademarks: "Kylas and the names of its products are trademarks of their owner.",
  asOf: AS_OF_16_NOV,
});

// ─── monday CRM ──────────────────────────────────────────────────────────────────────────────────

const T_MONDAY_CRM = tool({
  name: "monday CRM",
  replaces: "CRM",
  price: 0,
  per: "user",
  basis: "Standard — listed in US dollars only ($25 a seat a month, $17 billed yearly; from 3 seats): type your price",
  source: "https://monday.com/crm/pricing",
  selected: true,
});

const MONDAY = comparePage({
  slug: "monday-crm",
  competitor: "monday CRM",
  navTitle: "monday CRM",
  website: "monday.com's website (monday.com)",
  h1: "alternative",
  keywords: ["monday CRM alternative", "monday CRM alternative in India", "compare monday CRM"],
  seoTitle: "monday CRM alternative: {siteName} vs monday CRM",
  seoDescription: "A monday CRM alternative for Indian companies: leads, quotes and support beside GST invoicing, accounting and payroll in one workspace, compared row by row.",
  subheading: "{siteName} keeps leads, quotes and support beside GST invoicing, the books and payroll. Compare monday CRM and {siteName} row by row, from monday.com's own website.",
  summary: {
    heading: "Is {siteName} a monday CRM alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a monday CRM alternative for companies that want their CRM and their books in one place. monday CRM is a sales CRM built on boards, and for accounting it " },
        { text: "syncs invoices and payment status with QuickBooks", href: "https://monday.com/crm/overview/integrations" },
        { text: ". {siteName} raises GST invoices and keeps the ledger itself." },
      ],
      "If you are looking for a monday CRM alternative in India because your team also raises GST invoices, answers support tickets and closes the books each month, {siteName} does that work beside the CRM. If you want boards you shape yourself, or your company already works in monday.com, monday CRM may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, monday CRM from monday.com's public website. Each monday CRM row links the page it was read from.",
  rows: [
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "yes",
      note: "monday CRM: leads, accounts, communication, tasks and reporting on boards. {siteName}: companies, contacts and a lead pipeline from new to won, with calls and field visits.",
      source: "https://monday.com/crm",
    },
    {
      feature: "Leads from website forms",
      us: "yes",
      them: "yes",
      note: "monday CRM captures leads from web forms, events and imports. {siteName} takes leads from your website's forms through its lead capture API and from the website chat.",
      source: "https://monday.com/crm/features",
    },
    {
      feature: "Email campaigns and sequences",
      us: "yes",
      them: "yes",
      note: "monday CRM: mass emails and sequences on its Pro plan, and monday campaigns. {siteName}: campaigns and triggered journeys, each send checked against consent and the suppression list first.",
      source: "https://monday.com/crm/pricing",
    },
    {
      feature: "Quotes and invoices",
      us: "yes",
      them: "yes",
      note: "monday CRM generates quotes and invoices from the deal, with a monthly number by plan (20, 50 or 250; unlimited on Ultimate). {siteName}: proposals, proforma invoices and GST tax invoices, with no monthly cap.",
      source: "https://monday.com/crm/pricing",
    },
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "Not stated on monday.com's website",
      note: "monday CRM's features page doesn't mention tax on quotes or invoices. {siteName} works out CGST, SGST or IGST from the place of supply, with e-invoices and e-way bills.",
      source: "https://monday.com/crm/features",
    },
    {
      feature: "Accounting: ledger, bank reconciliation, statements",
      us: "yes",
      them: "Through integrations",
      note: "monday CRM syncs invoices and payment status with QuickBooks. {siteName} posts invoices, bills, payments and payroll to its own double-entry ledger.",
      source: "https://monday.com/crm/overview/integrations",
    },
    {
      feature: "Help desk tickets",
      us: "yes",
      them: "In monday service, a separate product",
      note: "monday service shows tickets beside account history and deals from the CRM. {siteName}: tickets with priority, an SLA target and assignment, in the same workspace.",
      source: "https://monday.com/service",
    },
    {
      feature: "Calling",
      us: "yes",
      them: "yes",
      note: "monday CRM: calls from its phone app, and an AI calling agent for new leads. {siteName}: a phone icon on every company, lead, ticket and renewal that dials the contact, times the call and records how it went.",
      source: "https://monday.com/crm/features",
    },
    {
      feature: "Workflows and automations",
      us: "yes",
      them: "yes",
      note: "monday CRM counts automations a month by plan. {siteName}: workflows that run on a schedule, when something happens, or at the press of a button, with every run recorded.",
      source: "https://monday.com/crm/pricing",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "monday CRM lists advanced permissions on its Ultimate plan. {siteName} sets what each person can see and change, and who may export, on every plan.",
      source: "https://monday.com/crm/pricing",
    },
    {
      feature: "Import from spreadsheets",
      us: "yes",
      them: "yes",
      note: "monday CRM imports CSV files. {siteName} imports CSV and Excel files and shows a dry run of every change first.",
      source: "https://monday.com/crm/features",
    },
    {
      feature: "Data export",
      us: "yes",
      them: "yes",
      note: "monday.com exports a board to Excel, up to 100,000 items at a time. {siteName} exports each area as CSV or Excel, and the whole workspace as one sealed backup file.",
      source: "https://support.monday.com/hc/en-us/articles/26989749858578-Export-from-monday-to-Excel",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "monday CRM: an AI notetaker, deal summaries, email drafting and AI sales agents. {siteName}: a copilot that answers from your data with the person's own permissions, on {siteName} AI, processed in India.",
      source: "https://monday.com/crm",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per seat, from 3 seats",
      note: "monday CRM's plans start from three users and are billed monthly or yearly. Prices: in the calculator below, each from the vendor's own pricing page.",
      source: "https://monday.com/crm/pricing",
    },
    {
      feature: "Where it runs",
      us: "Cloud, a database per company",
      them: "Cloud, with iOS and Android apps",
      note: "monday CRM links its iOS and Android apps from its site.",
      source: "https://monday.com/crm",
    },
  ],
  fits: {
    intro: "{siteName} suits a company that wants its customer work and its accounts on one set of records.",
    items: [FIT_BOOKS, FIT_GST, "Support in the same workspace as the sale: tickets with priority, an SLA target and assignment, and a customer portal showing what each customer has and owes.", FIT_PEOPLE, FIT_DATABASE],
  },
  theirs: {
    intro: "monday CRM may suit you better if:",
    items: [
      withLink("you want to shape the CRM yourself: monday CRM speaks of ", "flexible boards, fields, views, automations and dashboards", "https://monday.com/crm", ";"),
      withLink("your company already plans its work in monday.com, and wants ", "monday service", "https://monday.com/service", " beside the CRM;"),
      withLink("you want AI agents that source and qualify leads, which ", "monday CRM", "https://monday.com/crm", " describes;"),
      withLink("your accounts already live in QuickBooks, which ", "monday CRM syncs with", "https://monday.com/crm/overview/integrations", "."),
    ],
  },
  switching: {
    answer:
      "Export your monday CRM boards to Excel and import them into {siteName} one area at a time — accounts as companies, contacts, leads. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      withLink("Export from monday CRM: ", "each board exports to Excel", "https://support.monday.com/hc/en-us/articles/26989749858578-Export-from-monday-to-Excel", ", up to 100,000 items at a time."),
      "monday CRM",
    ),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Can I move my monday CRM contacts and deals to {siteName}?",
      answer: [
        "Yes. Export the boards to Excel, then import accounts into {siteName}'s Companies, contacts into Contacts and open deals into Leads. A dry run shows every row before anything is written, and running the file again updates rather than duplicates.",
      ],
    },
    faqHistory("monday CRM"),
    {
      question: "Can I use {siteName} and monday.com together?",
      answer: ["{siteName} has no monday.com integration, so the two wouldn't share records. You can run both side by side while you move, keeping the customer list in step with exports and imports."],
    },
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_CRM, REL_INVOICES, REL_MARKETING, REL_ACCOUNTING, REL_IMPORT, REL_HUB],
  trademarks: "monday.com, monday CRM and monday service are trademarks of their owner.",
  asOf: AS_OF_16_NOV,
  stack: { pricesAsOf: "2026-11-16", heading: "monday CRM and the tools beside it, or {siteName} One", tools: [T_MONDAY_CRM, T_ZOHO_BOOKS, { ...T_FRESHDESK, selected: undefined }] },
});

// ─── Freshdesk ───────────────────────────────────────────────────────────────────────────────────

const FRESHDESK = comparePage({
  slug: "freshdesk",
  competitor: "Freshdesk",
  navTitle: "Freshdesk",
  website: "Freshworks' websites (freshworks.com and its help centre)",
  h1: "alternative",
  keywords: ["Freshdesk alternative", "Freshdesk alternative in India", "compare Freshdesk"],
  seoTitle: "Freshdesk alternative: {siteName} vs Freshdesk",
  seoDescription: "A Freshdesk alternative for Indian companies: a helpdesk on the same records as orders, subscriptions, GST invoices and the customer portal.",
  subheading: "{siteName}'s helpdesk sits on the same records as orders, subscriptions, GST invoices and the customer portal. Compare Freshdesk and {siteName} row by row, from Freshworks' own website.",
  summary: {
    heading: "Is {siteName} a Freshdesk alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a Freshdesk alternative for companies whose support team needs to see what a customer bought, what they owe and when they renew. Freshdesk is a helpdesk that " },
        { text: "connects to tools such as Shopify, Stripe and Salesforce", href: "https://www.freshworks.com/freshdesk/" },
        { text: ". In {siteName}, a ticket belongs to the same company record as its orders, subscriptions, invoices and payments." },
      ],
      "If you are looking for a Freshdesk alternative in India because support, billing and renewals sit in separate tools, {siteName} puts them on one set of records, with a portal where customers see all of it. If support is your main work across many channels, with a knowledge base and SLA policies of your own, Freshdesk may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, Freshdesk from Freshworks' public websites. Each Freshdesk row links the page it was read from.",
  rows: [
    {
      feature: "Help desk tickets",
      us: "yes",
      them: "yes",
      note: "Freshdesk: ticketing on every plan. {siteName}: tickets with priority, an SLA target and assignment.",
      source: "https://www.freshworks.com/freshdesk/pricing/",
    },
    {
      feature: "Email into tickets",
      us: "yes",
      them: "yes",
      note: "Freshdesk's shared inbox turns incoming emails into tickets. {siteName}'s helpdesk answers at its own address: an email from a customer's contact opens a ticket at their company, and replies go back by email.",
      source: "https://www.freshworks.com/helpdesk/shared-inbox/",
    },
    {
      feature: "Website chat and WhatsApp",
      us: "yes",
      them: "yes",
      note: "Freshdesk Omni brings email, chat, phone and messaging together. {siteName}'s Customer inbox add-on puts website chat and WhatsApp in one queue, with a bot and a ticket from any conversation.",
      source: "https://www.freshworks.com/freshdesk/omni/",
    },
    {
      feature: "SLA targets",
      us: "partial",
      them: "yes",
      note: "Freshdesk's Pro plan has multiple SLA policies. {siteName} sets one fixed target per priority, from 4 hours for urgent to a week for low; you can't change them yet.",
      source: "https://www.freshworks.com/freshdesk/pricing/",
    },
    {
      feature: "Knowledge base",
      us: "no",
      them: "yes",
      note: "Freshdesk includes a knowledge base. {siteName} has none for customers; its website chat bot answers from your own set answers and, with AI answers on, from pages of your website.",
      source: "https://www.freshworks.com/freshdesk/features/",
    },
    {
      feature: "Customer portal",
      us: "yes",
      them: "yes",
      note: "Freshdesk includes a customer portal. {siteName}'s portal shows each customer what they have, what they owe and their open tickets, and lets them pay an invoice online.",
      source: "https://www.freshworks.com/freshdesk/pricing/",
    },
    {
      feature: "Tickets beside orders, subscriptions and invoices",
      us: "yes",
      them: "Through integrations",
      note: "Freshdesk names integrations such as Shopify, Stripe and Salesforce. In {siteName}, a ticket belongs to the company and contact, can name the product they have and the machine it is about, and sits beside their orders, invoices and payments.",
      source: "https://www.freshworks.com/freshdesk/",
    },
    {
      feature: "Automations",
      us: "yes",
      them: "yes",
      note: "Freshdesk automates follow-ups and escalations. {siteName}'s workflows can start when a ticket opens or its status changes.",
      source: "https://www.freshworks.com/freshdesk/features/",
    },
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "In Freshsales, a separate product",
      note: "{siteName}: companies, contacts and a lead pipeline, with calls and field visits, in the same workspace as support.",
      source: "https://www.freshworks.com/crm/sales/",
    },
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "Not stated on Freshworks' website",
      note: "Freshdesk's plans don't mention invoicing. {siteName} works out CGST, SGST or IGST from the place of supply, with e-invoices and e-way bills, and posts each invoice to its ledger.",
      source: "https://www.freshworks.com/freshdesk/pricing/",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "Both set what each person can see and change.",
      source: "https://www.freshworks.com/freshdesk/pricing/",
    },
    {
      feature: "Data export",
      us: "yes",
      them: "yes",
      note: "Freshdesk exports tickets as CSV or Excel. {siteName} exports each area as CSV or Excel, and the whole workspace as one sealed backup file.",
      source: "https://support.freshdesk.com/support/solutions/articles/225158-how-do-i-export-my-tickets-from-freshdesk-",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "Freshdesk: Freddy AI Agent on every plan, and Copilot as an add-on. {siteName}: a copilot that answers from your data with the person's own permissions, on {siteName} AI, processed in India.",
      source: "https://www.freshworks.com/freshdesk/pricing/",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per agent, by plan",
      note: "Prices: in the calculator below, each from the vendor's own pricing page.",
      source: "https://www.freshworks.com/freshdesk/pricing/",
    },
    {
      feature: "Where it runs",
      us: "Cloud, a database per company",
      them: "Cloud, in five data centre regions",
      note: "Freshdesk lists data centres in the US, the EEA, the UAE, India and Australia.",
      source: "https://support.freshdesk.com/support/solutions/articles/235810-where-is-your-data-servers-located-",
    },
  ],
  fits: {
    intro: "{siteName} suits a company whose support team needs the whole customer in front of it.",
    items: [FIT_PORTAL, FIT_CHANNELS, FIT_LOAD, FIT_BOOKS, FIT_GST],
  },
  theirs: {
    intro: "Freshdesk may suit you better if:",
    items: [
      withLink("your customers help themselves from a ", "knowledge base", "https://www.freshworks.com/freshdesk/features/", ", which {siteName} doesn't have;"),
      withLink("you need SLA policies of your own for different customers: Freshdesk's Pro plan has ", "multiple SLA policies", "https://www.freshworks.com/freshdesk/pricing/", ";"),
      withLink("your support team works across email, chat, phone and messaging, which ", "Freshdesk Omni", "https://www.freshworks.com/freshdesk/omni/", " unifies;"),
      withLink("you want to choose where your data lives: Freshdesk lists ", "five data centre regions, India among them", "https://support.freshdesk.com/support/solutions/articles/235810-where-is-your-data-servers-located-", ";"),
      withLink("your billing already lives in Stripe or Shopify, which ", "Freshdesk connects to", "https://www.freshworks.com/freshdesk/", "."),
    ],
  },
  switching: {
    answer:
      "Export your Freshdesk tickets and contacts as spreadsheets and import them into {siteName} — companies first, then contacts, then open tickets. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      withLink("Export from Freshdesk: ", "tickets export", "https://support.freshdesk.com/support/solutions/articles/225158-how-do-i-export-my-tickets-from-freshdesk-", " as CSV or Excel, with the fields you choose."),
      "Freshdesk",
    ),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Can I bring my Freshdesk tickets?",
      answer: ["Yes. Export tickets from Freshdesk as CSV or Excel and import them into {siteName}'s Tickets, each linked to its company. The dry run shows any row it can't place, and why."],
    },
    {
      question: "Can customers email {siteName}'s helpdesk, as they do Freshdesk?",
      answer: [
        "Yes. Each workspace's helpdesk has its own address: forward your support mail there, and an email from a known contact opens a ticket at their company. Replies go back by email, and only people already on a ticket can add to it.",
      ],
    },
    {
      question: "Does {siteName} have a knowledge base?",
      answer: ["Not for customers. The website chat's bot answers from your own set answers and, with AI answers switched on, from pages of your website; everything else goes to a person."],
    },
    faqHistory("Freshdesk"),
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_HELPDESK, REL_CRM, REL_INVOICES, REL_ACCOUNTING, REL_IMPORT, REL_HUB],
  trademarks: "Freshworks, Freshdesk, Freshsales and Freddy are trademarks of their owner.",
  asOf: AS_OF_16_NOV,
  stack: { heading: "Freshdesk and the tools beside it, or {siteName} One", tools: [T_FRESHDESK, T_ZOHO_BOOKS, { ...T_FRESHSALES, selected: undefined }] },
});

// ─── Zoho Desk ───────────────────────────────────────────────────────────────────────────────────

const ZOHO_DESK = comparePage({
  slug: "zoho-desk",
  competitor: "Zoho Desk",
  navTitle: "Zoho Desk",
  website: "Zoho's website (zoho.com and its help centre)",
  h1: "alternative",
  keywords: ["Zoho Desk alternative", "Zoho Desk alternative in India", "compare Zoho Desk"],
  seoTitle: "Zoho Desk alternative: {siteName} vs Zoho Desk",
  seoDescription: "A Zoho Desk alternative for Indian companies: a helpdesk on the same records as orders, subscriptions, GST invoices and the customer portal.",
  subheading: "{siteName}'s helpdesk sits on the same records as orders, subscriptions, GST invoices and the customer portal. Compare Zoho Desk and {siteName} row by row, from Zoho's own website.",
  summary: {
    heading: "Is {siteName} a Zoho Desk alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a Zoho Desk alternative for companies that want support and billing in one product rather than connected apps. Zoho Desk " },
        { text: "connects to Zoho Books, Zoho Invoice and Zoho Inventory", href: "https://www.zoho.com/desk/integrations.html" },
        { text: " for payments, invoices and sales orders. In {siteName}, a ticket belongs to the same company record as its orders, subscriptions, invoices and payments." },
      ],
      "If you are looking for a Zoho Desk alternative in India because support, invoicing and renewals sit in separate apps, {siteName} keeps them in one workspace, with a portal where customers see all of it. If you need a help centre, a knowledge base, telephony or many support channels, Zoho Desk may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, Zoho Desk from Zoho's public website. Each Zoho Desk row links the page it was read from.",
  rows: [
    {
      feature: "Help desk tickets",
      us: "yes",
      them: "yes",
      note: "Zoho Desk routes tickets by skills, workload and availability. {siteName}: tickets with priority, an SLA target and assignment.",
      source: "https://www.zoho.com/desk/",
    },
    {
      feature: "Email into tickets",
      us: "yes",
      them: "yes",
      note: "Email ticketing is on every Zoho Desk plan. {siteName}'s helpdesk answers at its own address: an email from a customer's contact opens a ticket at their company, and replies go back by email.",
      source: "https://www.zoho.com/desk/pricing.html",
    },
    {
      feature: "Website chat and WhatsApp",
      us: "yes",
      them: "yes",
      note: "Zoho Desk's Standard plan adds a live chat widget and WhatsApp, Instagram, Messenger and more. {siteName}'s Customer inbox add-on puts website chat and WhatsApp in one queue, with a bot and a ticket from any conversation.",
      source: "https://www.zoho.com/desk/pricing.html",
    },
    {
      feature: "Phone calls on a ticket",
      us: "yes",
      them: "yes",
      note: "Zoho Desk adds telephony on its Professional plan. {siteName}: a phone icon on every ticket that dials the contact, times the call and records how it went, with CallerDesk cloud calling as an option.",
      source: "https://www.zoho.com/desk/pricing.html",
    },
    {
      feature: "SLA targets",
      us: "partial",
      them: "yes",
      note: "Zoho Desk sets due times by channel, customer and status, and escalates overdue tickets. {siteName} sets one fixed target per priority, from 4 hours for urgent to a week for low; you can't change them yet.",
      source: "https://www.zoho.com/desk/escalations.html",
    },
    {
      feature: "Help centre and knowledge base",
      us: "no",
      them: "yes",
      note: "Zoho Desk has a help centre and a knowledge base. {siteName} has none for customers; its website chat bot answers from your own set answers and, with AI answers on, from pages of your website.",
      source: "https://www.zoho.com/desk/features.html",
    },
    {
      feature: "Customer portal",
      us: "yes",
      them: "yes",
      note: "Zoho Desk's self-service site lets customers track tickets and find answers. {siteName}'s portal shows each customer what they have, what they owe and their open tickets, and lets them pay an invoice online.",
      source: "https://www.zoho.com/desk/",
    },
    {
      feature: "Customer satisfaction ratings",
      us: "yes",
      them: "yes",
      note: "Zoho Desk asks a simple question with two answers, per reply or after a ticket closes. {siteName}: a thumbs up or down after a chat a person answered, and a rating from 1 to 5 by a one-time link for a finished ticket, visit or order.",
      source: "https://www.zoho.com/desk/happiness-ratings/",
    },
    {
      feature: "Tickets beside orders, invoices and payments",
      us: "yes",
      them: "Through Zoho apps",
      note: "Zoho Desk connects to Zoho Books for payments, Zoho Invoice for estimates and invoices, and Zoho Inventory for sales orders. In {siteName}, a ticket belongs to the company and contact, can name the product they have and the machine it is about, and sits beside their orders, invoices and payments.",
      source: "https://www.zoho.com/desk/integrations.html",
    },
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "In Zoho Books, a separate app",
      note: "{siteName} works out CGST, SGST or IGST from the place of supply, with e-invoices and e-way bills, and posts each invoice to its ledger.",
      source: "https://www.zoho.com/in/books/help/settings/taxes.html",
    },
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "In Zoho CRM, connected",
      note: "Zoho Desk integrates with Zoho CRM. {siteName}: companies, contacts and a lead pipeline, with calls and field visits, in the same workspace as support.",
      source: "https://www.zoho.com/desk/integrations.html",
    },
    {
      feature: "Workflows",
      us: "yes",
      them: "yes",
      note: "Zoho Desk: workflows on every paid plan, and Blueprints on Professional. {siteName}'s workflows can start when a ticket opens or its status changes.",
      source: "https://www.zoho.com/desk/pricing.html",
    },
    {
      feature: "Data export",
      us: "yes",
      them: "yes",
      note: "Zoho Desk exports a module at a time as CSV, up to 50,000 records. {siteName} exports each area as CSV or Excel, and the whole workspace as one sealed backup file.",
      source: "https://help.zoho.com/portal/en/kb/desk/data-administration/import-export/articles/exporting-data-from-zoho-desk-modules",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "Zoho Desk: AI agents from Express, and Zia on Professional. {siteName}: a copilot that answers from your data with the person's own permissions, on {siteName} AI, processed in India.",
      source: "https://www.zoho.com/desk/pricing.html",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per user, by plan; a free plan",
      note: "Zoho Desk's free plan includes three users. Prices: in the calculator below, each from the vendor's own pricing page.",
      source: "https://www.zoho.com/desk/pricing.html",
    },
    {
      feature: "Where it runs",
      us: "Cloud, a database per company",
      them: "Cloud, with iOS and Android apps",
      note: "Zoho Desk's mobile apps answer requests and track support on the move.",
      source: "https://www.zoho.com/desk/features.html",
    },
  ],
  fits: {
    intro: "{siteName} suits a company that wants support and billing in one product.",
    items: [FIT_PORTAL, FIT_CHANNELS, FIT_LOAD, FIT_BOOKS, FIT_GST],
  },
  theirs: {
    intro: "Zoho Desk may suit you better if:",
    items: [
      withLink("your customers help themselves from a ", "help centre and knowledge base", "https://www.zoho.com/desk/features.html", ", which {siteName} doesn't have;"),
      withLink("you need SLAs of your own by channel or customer, with ", "escalations to a manager", "https://www.zoho.com/desk/escalations.html", ";"),
      withLink("you support customers on many channels: Zoho Desk speaks of ", "10+ channels from one interface", "https://www.zoho.com/desk/features.html", ", telephony among them;"),
      withLink("you run several departments or brands from one helpdesk, which ", "Zoho Desk", "https://www.zoho.com/desk/features.html", " supports;"),
      withLink("your company already uses Zoho Books, Zoho CRM or Zoho Inventory, which ", "Zoho Desk connects to", "https://www.zoho.com/desk/integrations.html", "."),
    ],
  },
  switching: {
    answer:
      "Export your Zoho Desk accounts, contacts and tickets as spreadsheets and import them into {siteName} — companies first, then contacts, then open tickets. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      withLink("Export from Zoho Desk: ", "each module exports as CSV", "https://help.zoho.com/portal/en/kb/desk/data-administration/import-export/articles/exporting-data-from-zoho-desk-modules", ", one at a time, up to 50,000 records."),
      "Zoho Desk",
    ),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Can I bring my Zoho Desk tickets?",
      answer: ["Yes. Export accounts, contacts and tickets from Zoho Desk as CSV, then import them into {siteName}'s Companies, Contacts and Tickets, each ticket linked to its company. The dry run shows any row it can't place, and why."],
    },
    {
      question: "Can customers email {siteName}'s helpdesk, as they do Zoho Desk?",
      answer: [
        "Yes. Each workspace's helpdesk has its own address: forward your support mail there, and an email from a known contact opens a ticket at their company. Replies go back by email, and only people already on a ticket can add to it.",
      ],
    },
    {
      question: "Does {siteName} have a help centre or knowledge base?",
      answer: ["Not for customers. The website chat's bot answers from your own set answers and, with AI answers switched on, from pages of your website; everything else goes to a person."],
    },
    faqHistory("Zoho"),
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_HELPDESK, REL_CRM, REL_INVOICES, REL_ACCOUNTING, REL_IMPORT, REL_HUB],
  trademarks: "Zoho, Zoho Desk and the names of Zoho's apps are trademarks of their owner.",
  asOf: AS_OF_16_NOV,
  stack: { heading: "Zoho Desk and the apps beside it, or {siteName} One", tools: [T_ZOHO_DESK, T_ZOHO_BOOKS, { ...T_ZOHO_CRM, selected: undefined }] },
});

export const pages: SeedPage[] = [KYLAS, MONDAY, FRESHDESK, ZOHO_DESK];
