import type { RichInline, RichNode, SiteBlock, StackSavingsTool } from "../../src/components/site/blocks/types";
import type { SeedPage } from "./types";

/**
 * The comparison pages' shared building blocks (moved out of compare.ts on 16 Nov 2026, so each group of comparisons can
 * live in a file of its own): the page builder, the shared wording about {siteName} (true of the code), the vendors'
 * list prices for the calculator, and the rules every page keeps — see compare.ts's header. A "_" file: not a section.
 */

/** The day the competitors' websites were read. */
export const AS_OF = "2026-09-30";
export const AS_OF_WORDS = "30 September 2026";

export type Row = { feature: string; us: string; them: string; note?: string; source: string };
export type Faq = { question: string; answer: string[] };
export type Link = { label: string; href: string; description: string };

export type Compare = {
  /** The last part of the address: /compare/<slug>. */
  slug: string;
  /** The product as the table and the text name it ("Zoho One", "TallyPrime"). */
  competitor: string;
  /** Its name in the CMS and in the breadcrumb. */
  navTitle: string;
  /** Whose website the facts come from, as the disclaimer says it ("Zoho's website (zoho.com)"). */
  website: string;
  /** "vs": the H1 is "{siteName} vs X"; "alternative": "A X alternative for Indian businesses". */
  h1: "vs" | "alternative";
  /** The name the H1 uses, when searchers use another than the product's ("Tally" for TallyPrime). */
  h1Name?: string;
  keywords: [string, string, string];
  seoTitle: string;
  seoDescription: string;
  /** Under the H1. */
  subheading: string;
  /** The answer-first summary: a question heading, then who each product fits. */
  summary: { heading: string; paragraphs: RichInline[] };
  tableIntro: string;
  rows: Row[];
  fits: { intro: RichInline; items: RichInline[] };
  theirs: { intro: RichInline; items: RichInline[] };
  switching: { answer: RichInline; steps: RichInline[]; after: RichInline[] };
  faq: Faq[];
  related: Link[];
  /** The trademark line at the foot of the page. */
  trademarks: string;
  /** When this page's facts were read, if not AS_OF — "2026-11-16", with its words ("16 November 2026"). */
  asOf?: { date: string; words: string };
  /** What the separate tools cost, when this page's stack isn't in STACKS. */
  stack?: { heading: string; tools: StackSavingsTool[]; /** When its main prices were read, if not PRICES_AS_OF. */ pricesAsOf?: string };
};

export const withLink = (before: string, text: string, href: string, after = ""): RichInline => [{ text: before }, { text, href }, ...(after ? [{ text: after }] : [])];

/** The table's own disclaimer — the "Information about X … as of" line above it is the block's. */
export const tableDisclaimer = (competitor: string) =>
  `Product names and trademarks belong to their owners. Features, plans and prices change: check ${competitor}'s own website for current details. Prices are in the calculator below, each from the vendor's own pricing page with the day it was read.`;

// ─── What the separate tools cost (owner, 26 Oct 2026) ───────────────────────────────────────────
//
// Each price is the vendor's own India list price in rupees a month, read from the page linked on the day below:
// billed monthly (`price`) and billed yearly (`priceYearly`). Where a vendor lists only US dollars (HubSpot,
// Salesforce), the price is 0 and the visitor types theirs — never converted. Keka publishes none and isn't here.
// Odoo's are its list prices, not its first-year discount. Research notes: the W3-COMPARE-PRICES report.

/** The day the vendors' pricing pages were read. */
export const PRICES_AS_OF = "2026-10-26";

export type StackTool = StackSavingsTool;
export const tool = (t: StackTool): StackTool => t;

export const T_ZOHO_ONE = tool({ name: "Zoho One", replaces: "Every Zoho app", price: 2500, priceYearly: 1250, per: "user", basis: "All-employee pricing: every employee on the payroll is licensed", source: "https://www.zoho.com/one/pricing/" });
export const T_ZOHO_CRM = tool({ name: "Zoho CRM", replaces: "CRM", price: 2100, priceYearly: 1400, per: "user", basis: "Professional", source: "https://www.zoho.com/crm/zohocrm-pricing.html", selected: true });
export const T_ZOHO_BOOKS = tool({ name: "Zoho Books", replaces: "Accounting & GST", price: 1799, priceYearly: 1499, per: "org", included: 5, extra: 180, extraYearly: 150, basis: "Professional", source: "https://www.zoho.com/in/books/pricing/", selected: true });
export const T_ZOHO_DESK = tool({ name: "Zoho Desk", replaces: "Helpdesk", price: 2100, priceYearly: 1400, per: "user", basis: "Professional", source: "https://www.zoho.com/desk/pricing.html", selected: true });
export const T_ZOHO_PEOPLE = tool({ name: "Zoho People", replaces: "HR & attendance", price: 120, priceYearly: 96, per: "user", basis: "Professional", source: "https://www.zoho.com/people/zohopeople-pricing.html", selected: true });
export const T_ZOHO_PAYROLL = tool({ name: "Zoho Payroll", replaces: "Payroll", price: 1250, priceYearly: 1000, per: "org", included: 25, extra: 50, extraYearly: 40, basis: "Standard", source: "https://www.zoho.com/in/payroll/pricing/", selected: true });
export const T_ZOHO_PROJECTS = tool({ name: "Zoho Projects", replaces: "Projects", price: 350, priceYearly: 280, per: "user", basis: "Premium", source: "https://www.zoho.com/projects/zohoprojects-pricing.html", selected: true });
export const T_FRESHSALES = tool({ name: "Freshsales", replaces: "CRM", price: 899, priceYearly: 749, per: "user", basis: "Growth", source: "https://www.freshworks.com/crm/pricing/", selected: true });
export const T_FRESHDESK = tool({ name: "Freshdesk", replaces: "Helpdesk", price: 1799, priceYearly: 1499, per: "user", basis: "Growth", source: "https://www.freshworks.com/freshdesk/pricing/", selected: true });
export const T_ODOO_STANDARD = tool({ name: "Odoo Standard", replaces: "Every Odoo app", price: 950, priceYearly: 725, per: "user", basis: "List price, after the first-year discount; hosting and implementation extra", source: "https://www.odoo.com/pricing", selected: true });
export const T_ODOO_CUSTOM = tool({ name: "Odoo Custom", replaces: "Every Odoo app, with Studio and multi-company", price: 1690, priceYearly: 1350, per: "user", basis: "List price, after the first-year discount", source: "https://www.odoo.com/pricing" });
export const T_TALLY = tool({ name: "TallyPrime Silver", replaces: "Accounting & GST", price: 750, priceYearly: 675, per: "org", basis: "One user, rented (₹8,100 for 12 months); ₹22,500 to buy outright", source: "https://tallysolutions.com/buy-tally/", selected: true });
export const T_GREYTHR = tool({ name: "greytHR", replaces: "HR & payroll", price: 2495, per: "org", included: 50, extra: 45, basis: "Essential", source: "https://www.greythr.com/pricing/", selected: true });
export const T_SLACK = tool({ name: "Slack", replaces: "Team chat", price: 294.75, priceYearly: 245.25, per: "user", basis: "Pro, at the offer price on their page", source: "https://slack.com/intl/en-in/pricing", selected: true });
export const T_HUBSPOT_SALES = tool({ name: "HubSpot Sales Hub", replaces: "CRM", price: 0, per: "user", basis: "Professional — in US dollars only ($100 a seat, $90 yearly, plus $1,500 onboarding): type your price", source: "https://www.hubspot.com/pricing/sales", selected: true });
export const T_HUBSPOT_SERVICE = tool({ name: "HubSpot Service Hub", replaces: "Helpdesk", price: 0, per: "user", basis: "Professional — in US dollars only ($100 a seat, $90 yearly, plus onboarding): type your price", source: "https://www.hubspot.com/pricing/service", selected: true });
export const T_HUBSPOT_MARKETING = tool({ name: "HubSpot Marketing Hub", replaces: "Email marketing", price: 0, per: "user", basis: "Starter — listed in US dollars only: type what you pay", source: "https://www.hubspot.com/pricing/marketing" });
export const T_SALESFORCE_SALES = tool({ name: "Salesforce Sales Cloud", replaces: "CRM", price: 0, per: "user", basis: "Core — listed in US dollars only ($195 a user a month, billed yearly): type what you pay", source: "https://www.salesforce.com/in/sales/pricing/", selected: true });
export const T_SALESFORCE_SERVICE = tool({ name: "Salesforce Service Cloud", replaces: "Helpdesk", price: 0, per: "user", basis: "Core — listed in US dollars only ($195 a user a month, billed yearly): type what you pay", source: "https://www.salesforce.com/in/service/pricing/", selected: true });

/** Each comparison page's stack: what a company like the one reading it pays for separately. */
export const STACKS: Record<string, { heading: string; tools: StackTool[] }> = {
  "zoho-one": { heading: "Zoho's apps one by one, Zoho One, or {siteName} One", tools: [T_ZOHO_CRM, T_ZOHO_BOOKS, T_ZOHO_DESK, T_ZOHO_PEOPLE, T_ZOHO_PAYROLL, T_ZOHO_PROJECTS, T_ZOHO_ONE] },
  tally: { heading: "Tally and the tools beside it, or {siteName} One", tools: [T_TALLY, T_ZOHO_CRM, T_GREYTHR, T_SLACK, { ...T_ZOHO_DESK, selected: undefined }] },
  odoo: { heading: "What Odoo costs, and what {siteName} One costs", tools: [T_ODOO_STANDARD, T_ODOO_CUSTOM] },
  salesforce: { heading: "Salesforce and the tools beside it, or {siteName} One", tools: [T_SALESFORCE_SALES, T_SALESFORCE_SERVICE, T_ZOHO_BOOKS, T_GREYTHR, T_SLACK] },
  hubspot: { heading: "HubSpot and the tools beside it, or {siteName} One", tools: [T_HUBSPOT_SALES, T_HUBSPOT_SERVICE, T_HUBSPOT_MARKETING, T_ZOHO_BOOKS, T_GREYTHR, T_SLACK] },
  freshworks: { heading: "Freshworks and the tools beside it, or {siteName} One", tools: [T_FRESHSALES, T_FRESHDESK, T_ZOHO_BOOKS, T_GREYTHR, T_SLACK] },
};

export function comparePage(c: Compare): SeedPage {
  const h1 = c.h1 === "vs" ? `{siteName} vs ${c.h1Name ?? c.competitor}` : `A ${c.h1Name ?? c.competitor} alternative for Indian businesses`;
  const blocks: SiteBlock[] = [
    {
      id: "compare-hero",
      type: "hero",
      props: {
        eyebrow: "Compare",
        heading: h1,
        subheading: c.subheading,
        primary: { kind: "signup" },
        secondary: { kind: "link", label: "See the comparison", href: "#compare" },
        note: "Free for {trialDays} days. No card needed to start.",
        noteInviteOnly: "Setting up a workspace is by invitation for now.",
      },
    },
    {
      id: "compare-summary",
      type: "richText",
      props: {
        anchor: "summary",
        content: [{ type: "heading", level: 2, text: c.summary.heading }, ...c.summary.paragraphs.map((text): RichNode => ({ type: "paragraph", text }))],
      },
    },
    {
      id: "compare-table",
      type: "comparisonTable",
      props: {
        anchor: "compare",
        eyebrow: "Comparison",
        heading: `${c.competitor} vs {siteName}, feature by feature`,
        intro: c.tableIntro,
        competitor: c.competitor,
        asOf: c.asOf?.date ?? AS_OF,
        rows: c.rows,
        disclaimer: tableDisclaimer(c.competitor),
      },
    },
    // What the separate tools cost beside {siteName} One (owner, 26 Oct 2026) — where the page has a stack.
    ...((c.stack ?? STACKS[c.slug])
      ? [
          {
            id: "compare-cost",
            type: "stackSavings" as const,
            props: {
              anchor: "cost",
              eyebrow: "What it costs",
              heading: (c.stack ?? STACKS[c.slug])!.heading,
              intro: "Tick the tools your company pays for and how many people use them. Every price is the vendor's own list price — change any of them to what you really pay.",
              people: 10,
              asOf: c.stack?.pricesAsOf ?? PRICES_AS_OF,
              tools: (c.stack ?? STACKS[c.slug])!.tools,
              disclaimer: "Prices change and differ by plan, region, offer and billing; check each vendor's own website. Some vendors don't say whether their prices include GST. Product names and trademarks belong to their owners.",
            },
          },
        ]
      : []),
    {
      id: "compare-fit",
      type: "richText",
      props: {
        anchor: "fit",
        content: [
          { type: "heading", level: 2, text: "Where {siteName} fits" },
          { type: "paragraph", text: c.fits.intro },
          { type: "list", items: c.fits.items },
          { type: "heading", level: 2, text: `Where ${c.competitor} may fit better` },
          { type: "paragraph", text: c.theirs.intro },
          { type: "list", items: c.theirs.items },
        ],
      },
    },
    {
      id: "compare-switch",
      type: "richText",
      props: {
        anchor: "switching",
        content: [
          { type: "heading", level: 2, text: `How do you switch from ${c.competitor} to {siteName}?` },
          { type: "paragraph", text: c.switching.answer },
          { type: "list", ordered: true, items: c.switching.steps },
          ...c.switching.after.map((text): RichNode => ({ type: "paragraph", text })),
        ],
      },
    },
    { id: "compare-faq", type: "faq", props: { anchor: "faq", heading: `Questions about switching from ${c.competitor}`, items: c.faq } },
    { id: "compare-related", type: "relatedLinks", props: { heading: "Related pages", links: c.related } },
    {
      id: "compare-cta",
      type: "cta",
      props: {
        heading: `Try {siteName} beside ${c.competitor}`,
        body: "Set up a workspace, bring in a sample of your customers and items, and see how your own month would run. Free for {trialDays} days.",
        primary: { kind: "signup" },
        secondary: { kind: "link", label: "Book a demo", href: "/contact?topic=demo" },
        variant: "panel",
      },
    },
    {
      id: "compare-disclaimer",
      type: "richText",
      props: {
        content: [
          {
            type: "note",
            tone: "info",
            text: `Information about ${c.competitor} on this page is from ${c.website} as of ${c.asOf?.words ?? AS_OF_WORDS}, and each row of the table links the page it was read from. ${c.trademarks} Check their website for current details.`,
          },
        ],
      },
    },
  ];
  return {
    slug: `compare/${c.slug}`,
    // The title names {siteName} already, so it stands without the site's " · {siteName}" template.
    document: { title: c.navTitle, seo: { title: c.seoTitle, absoluteTitle: true, description: c.seoDescription, keywords: c.keywords }, blocks },
  };
}

// ─── Shared: what {siteName} does (true of the code), switching, the common questions ──────────

/** src/lib/portability: CSV or Excel per area, a dry run before anything is written, natural-key matching. */
export const importSteps = (first: RichInline, competitor: string): RichInline[] => [
  first,
  "Download {siteName}'s template for each area — companies, contacts, items, the chart of accounts, employees and more — and match your columns to it.",
  "Import companies before their contacts, then items, open tickets and the rest.",
  "Read the dry run: what each row would create or update, and why any row is refused. Then apply it. Running the same file again updates rather than duplicates.",
  `Enter your opening balances as a journal entry on the day you start, and keep ${competitor}'s exports as your archive.`,
];

/** The current year's documents come across through the mid-year switch (src/lib/migration); earlier years don't. */
export const IMPORT_AFTER: RichInline[] = [
  withLink(
    "Switching partway through the financial year? {siteName} can bring the rest of the year across — every invoice, credit note, receipt, bill, payment, expense and journal on its own date — from your old system's files laid out in {siteName}'s templates, checked against the old books at every month end. Earlier years stay in your old system's exports. See ",
    "import and migration",
    "/product/import-migration",
    " for every area and format.",
  ),
];

export const FAQ_TRIAL: Faq = {
  question: "Can I try {siteName} before I switch?",
  answer: ["Yes. Every workspace starts with a free trial of {trialDays} days, and no card is needed to start. Bring in a sample of your customers and items, and run a month's invoices through it."],
};
export const FAQ_PRICING: Faq = {
  question: "Is {siteName} priced per user?",
  answer: ["Each plan says how many people it includes, and some plans are priced per person. Add-ons add modules, people or copilot use. The pricing page shows the plans for your country."],
};
export const faqHistory = (competitor: string): Faq => ({
  question: `Will this year's invoices and payments from ${competitor} come across?`,
  answer: [
    `Yes, for the current financial year. {siteName}'s switch brings the year's invoices, credit notes, receipts, bills, payments, expenses and journals across, each on its own date, and checks them against ${competitor}'s figures at every month end. For earlier years, keep ${competitor}'s exports as your archive.`,
  ],
});

export const FIT_BOOKS: RichInline = "Sales, support and the books on one set of records: a GST invoice posts itself to the ledger, and each payment is applied against the invoices it settles.";
export const FIT_GST: RichInline = withLink(
  "GST built in: CGST, SGST or IGST from the place of supply, e-invoices (IRN) and e-way bills through the government's portals, and GSTR-1 and GSTR-3B prepared for each GSTIN. See ",
  "quotes and invoices",
  "/product/quotes-invoices",
  ".",
);
export const FIT_PEOPLE: RichInline = withLink("People in the same workspace: attendance, leave and payroll with PF, ESI and professional tax. See ", "payroll", "/product/payroll", ".");
export const FIT_REVENUE: RichInline = withLink("Revenue recognised as it is earned (Ind AS 115), and a month-end close that checks itself, with the ", "Revenue & Close add-on", "/product/revenue-close", ".");
export const FIT_BRANCHES: RichInline = withLink("Several GSTINs as branches of one company, with GST returns prepared for each. See ", "multi-branch GST", "/product/multi-branch-gst", ".");
export const FIT_DATABASE: RichInline = withLink("Each company in a workspace and a database of its own. See ", "security", "/security", ".");
export const FIT_COPILOT: RichInline = withLink("A copilot that answers from your data with the asking person's own permissions, on {siteName} AI, processed in India. See ", "the copilot", "/product/ai-copilot", ".");

export const REL_HUB: Link = { label: "Every comparison", href: "/compare", description: "{siteName} beside 22 suites, CRMs, helpdesks, accounting and payroll products." };
export const REL_IMPORT: Link = { label: "Import and migration", href: "/product/import-migration", description: "Bring your records in from spreadsheets, with a dry run before anything is written." };
export const REL_ACCOUNTING: Link = { label: "Accounting and GST", href: "/product/accounting-gst", description: "The ledger, GST returns, TDS, banking and closing the books." };
export const REL_INVOICES: Link = { label: "Quotes and invoices", href: "/product/quotes-invoices", description: "Proposals, GST tax invoices, e-invoices and e-way bills." };
export const REL_CRM: Link = { label: "CRM", href: "/product/crm", description: "Companies, contacts, leads, calls and field visits." };
export const REL_HELPDESK: Link = { label: "Helpdesk", href: "/product/helpdesk", description: "Tickets with priority, an SLA target and assignment." };
export const REL_MARKETING: Link = { label: "Marketing", href: "/product/marketing", description: "Campaigns and journeys, every send checked against consent." };
export const REL_PAYROLL: Link = { label: "Payroll", href: "/product/payroll", description: "Salary structures, the monthly run and payslips, with PF, ESI and professional tax." };
export const REL_INVENTORY: Link = { label: "Inventory", href: "/product/inventory", description: "Goods, services and subscriptions, with stock tracked for goods." };
export const REL_REVENUE: Link = { label: "Revenue and close", href: "/product/revenue-close", description: "Revenue recognised as it is earned, and a month-end close that checks itself." };
export const REL_BRANCHES: Link = { label: "Multi-branch GST", href: "/product/multi-branch-gst", description: "Several GSTINs as branches of one company." };

