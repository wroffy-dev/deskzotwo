import { solutionPage } from "./_build";
import type { SeedPage } from "./types";

/** Solutions by industry (owner decision W-D2): IT services and resellers, professional services, trading and distribution, SaaS. */

const itResellers = solutionPage({
  slug: "solutions/it-services-resellers",
  name: "IT services & resellers",
  seo: {
    title: "ERP for IT resellers and IT services firms",
    description: "ERP for IT resellers: licence and hardware renewals, add-on seats, AMCs, IT assets by serial, distributor statement checks, resellers and helpdesk.",
    keywords: ["ERP for IT resellers", "IT services company software", "renewal tracking"],
  },
  eyebrow: "For IT services and resellers",
  h1: "ERP for IT resellers that sell, renew and support",
  lead: "For IT resellers and IT services firms: licences and hardware, subscriptions with add-on seats, AMCs on the machines you look after, distributor bills checked against what you sold, and the tickets that follow, in one workspace built around renewals.",
  answer: {
    question: "What does an IT reseller need from an ERP?",
    answer:
      "An ERP for IT resellers is one system that knows every licence and machine a customer holds, when each one expires, and what the distributor charged for it. {siteName} keeps subscriptions, add-ons, AMCs, serial numbers and support tickets on the same customer record.",
    more: [
      "Renewal tracking is the centre of it. The renewals list shows what has expired and what is due within 30 days, 60 days or 90 days, with a stage worked out from calls and quotes. One click raises a renewal proposal with every add-on seat at the full-term price. Add-on seats bought mid-term end with their parent and are priced for the days left.",
    ],
  },
  problems: {
    heading: "Reseller problems, and how {siteName} handles them",
    intro: "Resellers lose money in the gaps between sales, purchasing and support. Each of these closes one.",
    items: [
      { icon: "calendar", title: "Renewals found after they lapse", body: "Every subscription's expiry in one list, with stages from activity and renewal tasks raised in bulk." },
      { icon: "check", title: "Distributor bills taken on trust", body: "Upload the distributor's statement, and each line is matched with what you sold: quantity, price, and subscriptions billed with no live order." },
      { icon: "server", title: "Customer machines without history", body: "IT assets by serial, owned, deployed at a client or client-owned, with custody, warranty and AMC cover." },
      { icon: "users", title: "Channel partners' customers contacted by mistake", body: "A reseller's end customers are masked and kept out of marketing, so your team never approaches them directly." },
      { icon: "headset", title: "Support that costs more than the contract", body: "The support load page shows tickets against billing, customer by customer." },
    ],
  },
  modules: {
    heading: "The modules IT resellers use",
    intro: "IT services company software here is the same workspace with renewals, assets and support at the centre.",
    groups: [
      { title: "Sell and renew", paths: ["/product/crm", "/product/subscriptions-renewals", "/product/quotes-invoices"] },
      { title: "Buy, deliver and support", paths: ["/product/purchases-payables", "/product/assets", "/product/helpdesk"] },
    ],
  },
  workflow: {
    heading: "How a licence renewal runs",
    intro: "From the 90-day window to the distributor's bill, one customer record carries it.",
    steps: [
      "The subscription appears in the 90-day window, and a renewal task is raised for the account manager.",
      "The renewal proposal is raised with every add-on seat, and the customer accepts.",
      "The renewal order is punched; accounts approves the terms and purchasing orders from the distributor.",
      "The invoice is issued, and the distributor's statement is checked against the order before the bill is paid.",
      "The new term starts, and the AMC cover on the customer's machines is extended.",
    ],
  },
  faqHeading: "Questions IT resellers ask",
  faq: [
    ["Can we track machines we maintain for clients?", "Yes. Client-owned machines are tracked with their serials, custody and AMC cover, and never reach your balance sheet."],
    ["Do subscriptions renew automatically?", "If you switch it on for an order. Recurring billing raises each instalment, and on auto-renew the next term's order and invoice, as drafts on the day they fall due; someone reviews and issues each, since an issued invoice takes its number and IRN."],
    ["Can we find out what a prospect runs before we call?", "Domain Intel reads a company's public DNS and website: who runs their email, whether the domain is protected against spoofing, and who hosts the site."],
  ],
  related: ["/product/subscriptions-renewals", "/product/assets", "/product/purchases-payables", "/solutions/saas-subscriptions", "/solutions/sales-teams", "/solutions/field-service-amc"],
  cta: { heading: "See every renewal due this quarter", body: "Import your subscriptions with their expiry dates and read the next 90 days. Every workspace starts with a {trialDays}-day free trial." },
});

const services = solutionPage({
  slug: "solutions/professional-services",
  name: "Professional services & agencies",
  seo: {
    title: "Software for professional services firms",
    description: "Software for professional services firms and agencies: proposals, projects with milestone billing, retainers, expenses and revenue recognised as work is done.",
    keywords: ["software for professional services firms", "agency management software", "retainer billing"],
  },
  eyebrow: "For professional services and agencies",
  h1: "Software for professional services firms that bill by milestone and retainer",
  lead: "Proposals, delivery projects with milestones and billing stages, retainers as subscriptions, expenses claimed against client work, and revenue recognised as the work is done.",
  answer: {
    question: "How do professional services firms bill?",
    answer:
      "Professional services firms bill in two ways: by milestone, when a piece of work is delivered, and by retainer, a fixed fee each month or year. Software for professional services firms is the system that has to handle both. In {siteName}, milestones are billing stages on a project, and retainers are subscriptions.",
    more: [
      "Agency management software also has to keep the work visible. Each project has a status from discovery to handover, a health of on track, at risk or off track, weekly updates, and a risk register. Agreements, NDAs and statements of work are stored on the project, and client credentials are encrypted, with every reveal logged. Only the project's stakeholders see it.",
    ],
  },
  problems: {
    heading: "Agency problems, and how {siteName} handles them",
    intro: "Agencies lose margin where delivery and billing are kept apart. Each of these ties them together.",
    items: [
      { icon: "rupee", title: "Milestones delivered, never invoiced", body: "Raise a billing stage's invoice from the project, and the stage follows it until it is paid." },
      { icon: "calendar", title: "Retainer billing done from memory", body: "Retainers are subscriptions with a billing cycle and an expiry, listed with the renewals coming up." },
      { icon: "lock", title: "Client passwords in chat", body: "Credentials stored on the project, encrypted, and revealed only with your own password." },
      { icon: "book", title: "Annual fees booked as this month's income", body: "With Revenue & Close, a year's fee moves into revenue month by month, and a milestone's in the month it is delivered." },
    ],
  },
  modules: {
    heading: "The modules agencies use",
    intro: "Most firms start with proposals and projects, then add revenue recognition.",
    groups: [
      { title: "Win and deliver", paths: ["/product/crm", "/product/quotes-invoices", "/product/projects"] },
      { title: "Bill and account", paths: ["/product/subscriptions-renewals", "/product/revenue-close", "/product/expenses"] },
    ],
  },
  workflow: {
    heading: "How a project goes from proposal to paid",
    intro: "The proposal, the project and the invoices stay linked.",
    steps: [
      "Send the proposal, priced from your service items.",
      "When it is accepted, set up the project with its milestones and billing stages.",
      "As each milestone is delivered, raise its stage's invoice from the project.",
      "The stage shows invoiced, then paid, as the customer pays.",
      "Monthly retainers renew from the renewals list at the end of their term.",
    ],
  },
  faqHeading: "Questions agencies ask",
  faq: [
    ["Does it track time with timesheets?", "Time can be logged on tasks, but there are no timesheets to approve and no hourly billing. Projects track milestones, billing stages, risks and weekly updates."],
    ["Can clients see their project?", "Not yet. Client people are named on the project as stakeholders, but the customer portal doesn't show projects."],
    ["Can staff claim expenses against a client?", "Yes. An expense claim can be tied to a company, and travel to the field visit it was for."],
  ],
  related: ["/product/projects", "/product/revenue-close", "/product/quotes-invoices", "/solutions/saas-subscriptions", "/solutions/small-business"],
  cta: { heading: "Invoice every milestone the day it is done", body: "Set up a workspace and add your current projects with their billing stages. Every workspace starts with a {trialDays}-day free trial." },
});

const trading = solutionPage({
  slug: "solutions/trading-distribution",
  name: "Trading & distribution",
  seo: {
    title: "ERP for trading and distribution companies",
    description: "ERP for trading and distribution: orders with approvals, purchasing, stock counts, GST invoices with e-way bills, and credit control for customers on terms.",
    keywords: ["ERP for trading and distribution", "e-way bill for distributors", "credit control"],
  },
  eyebrow: "For trading and distribution",
  h1: "ERP for trading and distribution companies that sell on credit",
  lead: "Orders approved before they are sourced, purchase orders and vendor bills, a stock count for every item you hold, GST invoices with e-way bills for each consignment, and credit control for customers on terms.",
  heroPreview: "invoice",
  answer: {
    question: "What does a trading company need from its ERP?",
    answer:
      "An ERP for trading and distribution is the system that follows goods from the supplier to the customer and the money back again. In {siteName}, orders, purchases, stock, invoices, e-way bills and receivables are one set of records, so a salesperson can see an order's terms and the customer's credit.",
    more: [
      "Credit control matters most when you sell on terms. Each customer has a rating of reliable, fair, risky or new, worked out from two years of how they paid, with suggested terms and a credit limit. Longer terms, or an order over the limit, need an override with a written reason. Receivables are aged from each invoice's due date.",
    ],
  },
  problems: {
    heading: "Trading problems, and how {siteName} handles them",
    intro: "Traders lose margin and cash in the same places. Each of these is handled where the order or invoice is recorded.",
    items: [
      { icon: "check", title: "Orders shipped on terms nobody approved", body: "Accounts approves each order's payment terms, and a customer beyond their rating needs an override." },
      { icon: "truck", title: "E-way bills raised on a separate portal", body: "The e-way bill is raised from the invoice, credit note or delivery challan, with validity worked out from the distance." },
      { icon: "rupee", title: "Money owed, and nobody knows how late", body: "Ageing from each due date, a statement for every customer, and payments allocated against invoices." },
      { icon: "gauge", title: "Margin known only after the month", body: "Each order records its purchase price and costs, so its margin is known when it is punched." },
    ],
  },
  modules: {
    heading: "The modules traders use",
    intro: "Trading companies run on orders, invoices and receivables; stock and purchasing sit beside them.",
    groups: [
      { title: "Sell on credit", paths: ["/product/quotes-invoices", "/product/payments-receivables", "/product/subscriptions-renewals"] },
      { title: "Buy and stock", paths: ["/product/purchases-payables", "/product/inventory", "/product/multi-branch-gst"] },
    ],
  },
  workflow: {
    heading: "How an order ships with its e-way bill",
    intro: "The e-way bill for distributors is raised from the documents that already exist.",
    body: [
      "The order is approved and fulfilled, and the tax invoice is issued with CGST and SGST or IGST from the place of supply. Where the goods' value is over the threshold set for the GSTIN, the e-way bill is raised from the invoice, and Part B is updated with the vehicle. Its validity is worked out at one day for each 200 km. The invoice then waits in receivables until it is paid.",
    ],
    bullets: ["E-way bills from invoices, credit notes and delivery challans", "Cancellation within 24 hours, with the portal's reasons", "The intra-state threshold set for each GSTIN"],
    preview: "invoice",
    side: "left",
  },
  faqHeading: "Questions traders ask",
  faq: [
    ["Does selling reduce stock automatically?", "If you choose it. In Accounts settings, invoices can issue their goods from the warehouse, bills can receive them and credit notes can return them; left off, stock moves only when someone records a movement. Warehouses, batches with expiry dates and serial numbers are kept."],
    ["Can customers pay online?", "Yes, with Razorpay or Cashfree connected. Each invoice can carry a payment link, reminder emails include it, and customers can pay from the portal; a payment that comes in is applied to the invoice."],
    ["Can we check a distributor's statement?", "Yes. Upload it, and each line is matched with the period's sales orders, so mismatched quantities and prices stand out."],
  ],
  related: ["/product/quotes-invoices", "/product/payments-receivables", "/blog/e-way-bill-rules", "/solutions/multi-branch-enterprises", "/solutions/operations"],
  cta: { heading: "Ship with the e-way bill already raised", body: "Set up a workspace and issue your first invoice with its e-way bill in test mode. Every workspace starts with a {trialDays}-day free trial." },
});

const saas = solutionPage({
  slug: "solutions/saas-subscriptions",
  name: "SaaS & subscriptions",
  seo: {
    title: "ERP for SaaS and subscription businesses",
    description: "ERP for SaaS companies: subscriptions and renewals, add-on seats, invoices in fourteen currencies, and deferred revenue recognised month by month.",
    keywords: ["ERP for SaaS", "subscription renewals", "deferred revenue"],
  },
  eyebrow: "For SaaS and subscription businesses",
  h1: "ERP for SaaS companies that bill ahead and earn over time",
  lead: "Subscriptions with their start and expiry, add-on seats priced to end with their parent, invoices in the customer's currency, and revenue that moves from deferred revenue into sales month by month.",
  answer: {
    question: "Why does a SaaS company need deferred revenue?",
    answer:
      "A SaaS company is paid ahead for service it delivers over time. An annual invoice is not a year's revenue in the month it is raised: under Ind AS 115 rules, revenue follows the service. Deferred revenue holds the unearned part until each month is delivered.",
    more: [
      "An ERP for SaaS is the system that does that without a spreadsheet. With Revenue & Close in {siteName}, an invoice line whose service runs past the month of issue waits in deferred revenue, and a nightly run moves each month's share into sales, spread by day or evenly by month. The revenue waterfall shows what is still to be recognised, by customer or item, over the next 12 months or 24 months.",
    ],
  },
  problems: {
    heading: "Subscription problems, and how {siteName} handles them",
    intro: "Subscription businesses feel these every month. Each is handled on the subscription or the invoice.",
    items: [
      { icon: "calendar", title: "Subscription renewals chased at the last minute", body: "What has expired and what is due within 30 days, 60 days or 90 days, with a stage for each renewal." },
      { icon: "layers", title: "Seats added mid-term, priced by hand", body: "Add-on seats end with their parent subscription, priced for the days left, and renew at the full-term price." },
      { icon: "globe", title: "Customers billed in other currencies", body: "Invoices in fourteen currencies with the rate kept on the document, and exchange differences booked when they are paid." },
      { icon: "book", title: "Revenue that jumps when invoices are raised", body: "Deferred revenue recognised month by month, with a waterfall and a check of the schedules against the ledger." },
    ],
  },
  modules: {
    heading: "The modules subscription businesses use",
    intro: "Revenue & Close is an add-on to Accounting, offered to companies in India.",
    groups: [
      { title: "Sell and renew", paths: ["/product/subscriptions-renewals", "/product/quotes-invoices", "/product/payments-receivables"] },
      { title: "Account for it", paths: ["/product/accounting-gst", "/product/revenue-close", "/product/reports"] },
    ],
  },
  workflow: {
    heading: "How an annual subscription is recognised",
    intro: "The invoice is issued once; the revenue follows the months.",
    steps: [
      "Issue the annual invoice; the subscription's line waits in deferred revenue.",
      "Each month, the recognition run moves that month's share into sales.",
      "A mid-term credit note reduces what is left to recognise, in proportion.",
      "At month end, the close checklist confirms revenue was recognised and nothing waits for approval.",
      "The waterfall shows what the next twelve months will recognise.",
    ],
  },
  faqHeading: "Questions SaaS companies ask",
  faq: [
    ["Does it bill subscriptions automatically?", "If you switch it on for an order. Recurring billing raises each instalment, and on auto-renew the next term's order and invoice, as drafts on the day they fall due; someone reviews and issues each, since an issued invoice takes its number and IRN."],
    ["Is revenue recognition contract-based?", "It follows each issued invoice line: a line whose service runs past the month of issue is deferred and spread. Standalone selling price allocation and usage-based revenue aren't modelled."],
    ["What about invoices raised before we switch it on?", "An opening wizard creates schedules for service and subscription lines from the last 24 months, with one adjusting entry, for a second person to approve."],
  ],
  related: ["/product/revenue-close", "/product/subscriptions-renewals", "/blog/revenue-recognition-ind-as-115", "/solutions/finance-teams", "/solutions/it-services-resellers"],
  cta: { heading: "Recognise this year's subscriptions month by month", body: "Revenue & Close is offered to companies in India. Book a demo and we will set up your opening deferred revenue with you." },
});

/**
 * Field service and AMC companies (owner, 16 Nov 2026 — "UAE + industry pages"). Checked in the code: service cycles
 * (src/lib/service-cycles — a plan of steps per customer, optionally for a contract, each job its owner's task before
 * it's due, skips kept with a reason), IT assets with warranty and AMC cover (src/lib/assets), renewals' reminder
 * ladder, tickets with SLA targets, visits with check-in and check-out, the portal's equipment and requests.
 */
const fieldService = solutionPage({
  slug: "solutions/field-service-amc",
  name: "Field service & AMC",
  seo: {
    title: "AMC software for field service companies",
    description: "AMC software for field service: preventive maintenance on a schedule, equipment with warranty and AMC cover, tickets with SLAs, visits and renewals.",
    keywords: ["AMC software", "field service management software", "preventive maintenance schedule"],
  },
  eyebrow: "For field service and AMC companies",
  h1: "AMC software for field service, from the contract to the visit",
  lead: "Preventive maintenance that schedules itself from each contract, every machine at every site with its warranty and AMC cover, tickets with SLA targets, engineers' visits, and the AMC renewed and invoiced before it lapses.",
  heroPreview: "tickets",
  answer: {
    question: "What does an AMC company need from its software?",
    answer:
      "AMC software is the system that keeps three promises in one place: the visits a contract owes, the breakdowns a customer reports, and the renewal before the cover ends. In {siteName}, the contract, the equipment, each service job, the tickets and the invoices sit on the same customer record.",
    more: [
      "A service cycle is a plan of steps — a quarterly service, a yearly calibration — run for each customer between two dates, on its own or for their contract. Each job becomes its engineer's task a few days before it's due, with its checklist, and is done when the task is. A job skipped stays on the timeline with the reason, so a missed visit can't go quiet.",
    ],
  },
  problems: {
    heading: "Service problems, and how {siteName} handles them",
    intro: "Field service management software has to catch what slips, and service companies lose customers in the same places. Each of these is handled where the work is recorded.",
    items: [
      { icon: "calendar", title: "Preventive visits forgotten", body: "Service cycles lay out every visit a contract owes, and each becomes an engineer's task before it's due." },
      { icon: "package", title: "Nobody knows what's under cover", body: "Each machine by serial, at its site, with its warranty and AMC cover and the days left on each." },
      { icon: "headset", title: "Breakdowns logged on WhatsApp and paper", body: "Tickets from your support email and the customer portal, with priority, an SLA target and an engineer assigned." },
      { icon: "history", title: "AMCs that lapse unnoticed", body: "Reminders to the renewal's owner 60, 30, 15, 7 and 1 day before the cover ends, a task for them, and the renewal order and invoice from the same record." },
    ],
  },
  modules: {
    heading: "The modules service companies use",
    intro: "A service company runs on contracts, equipment and tickets; the invoices and the money sit beside them.",
    groups: [
      { title: "Serve", paths: ["/product/helpdesk", "/product/assets", "/product/crm"] },
      { title: "Renew and bill", paths: ["/product/subscriptions-renewals", "/product/quotes-invoices", "/product/payments-receivables"] },
    ],
  },
  workflow: {
    heading: "How a contract turns into visits",
    intro: "The preventive maintenance schedule comes from the contract, not from someone's diary.",
    body: [
      "When an AMC is sold, its order carries the term. Start a service cycle on it — a plan such as four quarterly services — and its timeline of jobs runs from the start date to the end. Each job reaches its engineer as a task before it's due; the engineer checks in at the customer, writes up what was done and checks out. When the term nears its end, the renewal reminders start, and the renewal is ordered and invoiced from the same contract.",
    ],
    bullets: ["Plans of steps, each at its own interval", "Jobs moved together when the dates change", "Skipped jobs kept, with the reason"],
    preview: "tickets",
    side: "left",
  },
  faqHeading: "Questions service companies ask",
  faq: [
    ["Can customers see their equipment and raise a request?", "Yes. The customer portal shows each customer their equipment with its warranty and AMC cover, and they can raise a request on a machine, which reaches your team."],
    ["Do engineers need an app?", "No. Tasks, visits and tickets work in a browser on a phone, and the day's tasks and visits stay readable when the signal drops."],
    ["Can we change the SLA targets?", "Not today. The targets are fixed for each priority: 4 hours, 24 hours, 72 hours and 168 hours from creation."],
    ["Can the AMC bill itself each quarter?", "If you switch recurring billing on for the order: each instalment, and the renewal on auto-renew, is raised as a draft invoice on the day it falls due, for someone to review and issue."],
  ],
  related: ["/product/helpdesk", "/product/assets", "/product/subscriptions-renewals", "/solutions/it-services-resellers", "/solutions/operations"],
  cta: { heading: "Put every contract's visits on the calendar", body: "Set up a workspace, add a customer's equipment and start a service cycle on their AMC. Every workspace starts with a {trialDays}-day free trial." },
});

export const INDUSTRY_PAGES: SeedPage[] = [itResellers, services, trading, saas, fieldService];
