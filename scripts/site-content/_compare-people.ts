import type { SeedPage } from "./types";
import { comparePage, withLink, FAQ_TRIAL, FAQ_PRICING, FIT_BOOKS, FIT_GST, FIT_PEOPLE, FIT_COPILOT, REL_HUB, REL_IMPORT, REL_ACCOUNTING, REL_PAYROLL, tool, T_GREYTHR, T_ZOHO_BOOKS, T_ZOHO_CRM, T_ZOHO_PEOPLE, T_ZOHO_PAYROLL } from "./_compare-kit";
import type { Faq, Link, Row } from "./_compare-kit";

/**
 * The HR and payroll comparisons — Keka, greytHR, Darwinbox and Zoho People — read on 16 November 2026 from each
 * vendor's own site. The angle: HR and payroll software beside a workspace where people, payroll, expenses and
 * attendance sit with sales, invoices and the books, and payroll posts to the ledger.
 *
 * {siteName}'s payroll as the code has it on 16 Nov 2026 (src/lib/hr): PF and ESI; professional tax from dated rules
 * for 18 states (Meghalaya, Manipur and Puducherry left out, the payslip says so); TDS on salary worked out under
 * either regime (income-tax.ts, tds.ts) from the declaration payroll enters; the PF ECR, ESI return and bank file
 * (statutory-files.ts); full and final; loans; UAE payroll with the WPS file (src/lib/uae). Not there: Labour Welfare
 * Fund, Form 130 (was 16) and the salary TDS return (138, was 24Q) — reminded of, not made.
 */

const AS_OF = { date: "2026-11-16", words: "16 November 2026" };

const ATTENDANCE: Link = { label: "Attendance", href: "/product/attendance", description: "Biometric terminals, clock-in from a browser, and the month that payroll reads." };
const RECRUITMENT: Link = { label: "Recruitment", href: "/product/recruitment", description: "Candidates, offer letters and one step from accepted offer to employee." };
const EXPENSES: Link = { label: "Expenses", href: "/product/expenses", description: "Claims with receipts and GST, approved, paid back and posted to the ledger." };

// ─── {siteName}'s side of the rows, true of the code (see the header) ───────────────────────────

const US = {
  pfEsi: "{siteName} works out PF and ESI on each payslip from the month's attendance and the person's salary structure.",
  pt: "{siteName} works out professional tax from each state's own dated rules, for 18 states; for a state with no slab on file, such as Meghalaya, nothing is deducted and the payslip says so.",
  lwf: "{siteName} doesn't deduct the Labour Welfare Fund.",
  tds: "{siteName} works out each month's TDS on salary under the new or the old regime, from the declaration payroll enters on the person's record.",
  forms: "{siteName} reminds you when the quarterly salary TDS return (Form 138, was 24Q) is due; it doesn't make the return or Form 130 (was Form 16).",
  files: "From a locked month, {siteName} makes EPFO's ECR file, ESIC's monthly upload and a bulk bank transfer file; anyone missing a UAN, IP number or bank account is left out and named.",
  fnf: "{siteName}: final salary, leave encashment, gratuity and notice recovery, drafted, approved and paid.",
  loans: "{siteName}: loans and salary advances, recovered from pay; employees ask from My HR.",
  ledger: "Locking a run in {siteName} posts salaries by department, employer contributions and PF, ESI, PT and TDS payable to its own double-entry ledger; marking it paid posts the bank payment.",
  books: "{siteName} keeps CRM, GST invoices and the books in the same workspace as payroll.",
  attendance: "{siteName}: daily attendance from eSSL and ZKTeco biometric terminals and from clock-in in a browser, with an optional check that the person is at their office.",
  shifts: "{siteName}: shifts and a roster, leave with balances and approvals, and short leave by the hour.",
  expenses: "{siteName}: claims with receipts, approved by HR or the reporting manager, then booked to the ledger and paid back by Accounts.",
  hiring: "{siteName}: candidate records, numbered offer letters, a details form for the candidate and one step to employee; no job postings, interview scheduling or scorecards.",
  reviews: "{siteName}: goals, and review cycles with a self-assessment and the manager's review; no 360-degree feedback.",
  uae: "{siteName}, for a workspace in the UAE: monthly pay in AED, the WPS salary information file (SIF), gratuity and UAE leave.",
  self: "{siteName}'s My HR: each person's attendance, leave, payslips, loans and expense claims, in a browser on a phone or a computer.",
};

const PRICING_US = "Per plan; some plans per person";

// ─── Shared: switching from an HR and payroll product ───────────────────────────────────────────

const switchingSteps = (competitor: string) => [
  `Gather your employee list, salary structures, bank details and this tax year's pay so far from ${competitor} as spreadsheets.`,
  "Import the people first, with their departments, managers and joining dates. {siteName} shows what each row would create or update before anything is written.",
  "Import pay in People › Payroll › Import from another system: one file sets each person's salary structure, bank account, PF and ESI numbers, and this year's gross, TDS, PT and PF paid so far. Common Indian payroll headings, such as \"Basic Salary\" and \"UAN No\", are read as they are.",
  "Enter each person's opening leave balances, and connect your biometric terminals to the workspace.",
  `Run your first month in {siteName} beside ${competitor}'s, compare the payslips, and keep ${competitor}'s exports as your record of the months before.`,
];

const SWITCH_AFTER = [
  withLink(
    "Earlier payslips don't come across as payslips: this year's totals do, so TDS for the rest of the year counts what was already deducted. See ",
    "payroll",
    "/product/payroll",
    " for how a run works.",
  ),
];

const faqHistory = (competitor: string): Faq => ({
  question: `Will my payroll history from ${competitor} come across?`,
  answer: [
    `This tax year's totals do: the payroll import takes each person's gross, TDS, professional tax and PF paid so far, so {siteName}'s TDS for the months left counts them. Earlier payslips stay in ${competitor}'s exports, which you keep as your record.`,
  ],
});

const faqTogether = (competitor: string): Faq => ({
  question: `Can I keep ${competitor} for payroll and use {siteName} for the rest?`,
  answer: [`{siteName} has no ${competitor} integration, so the two wouldn't share records, and payroll run in ${competitor} wouldn't post to {siteName}'s ledger. You can run both side by side for a month or two while you move.`],
});

const FIT_LEDGER = "Payroll and expense claims post to the same ledger as your invoices and bills, so the month's salary cost and what is payable for PF, ESI, PT and TDS are in the books the day the run is locked.";
const FIT_ATTENDANCE = withLink("Attendance from eSSL and ZKTeco biometric terminals and browser clock-in, feeding loss of pay into the run. See ", "attendance", "/product/attendance", ".");

// ─── Keka ────────────────────────────────────────────────────────────────────────────────────────

const KEKA_ROWS: Row[] = [
  { feature: "Payroll with PF and ESI", us: "yes", them: "yes", note: `Keka: PF with ECR-ready reports, and ESI computations. ${US.pfEsi}`, source: "https://www.keka.com/payroll-software" },
  { feature: "Professional tax by state", us: "partial", them: "yes", note: `Keka applies state-specific PT rules and generates the filing reports. ${US.pt}`, source: "https://www.keka.com/payroll-software" },
  { feature: "Labour Welfare Fund", us: "no", them: "yes", note: `Keka calculates LWF deductions by state rules. ${US.lwf}`, source: "https://www.keka.com/payroll-software" },
  { feature: "TDS on salary", us: "yes", them: "yes", note: `Keka calculates income tax deductions and the reports for TDS filings. ${US.tds}`, source: "https://www.keka.com/payroll-software" },
  { feature: "Form 130 (was Form 16) and the salary TDS return", us: "no", them: "yes", note: `Keka generates Form 130 from payroll data. ${US.forms}`, source: "https://www.keka.com/payroll-software" },
  { feature: "Full and final settlement", us: "yes", them: "yes", note: `Keka processes full and final settlements once payroll is approved. ${US.fnf}`, source: "https://www.keka.com/payroll-processing" },
  { feature: "Payroll posted to the books", us: "yes", them: "Payroll journals; exports to Tally and Zoho Books", note: `Keka generates payroll journals each cycle, and its marketplace lists Tally and Zoho Books exports for payroll. ${US.ledger}`, source: "https://www.keka.com/marketplace" },
  { feature: "GST invoices, CRM and accounting", us: "yes", them: "Not stated on Keka's website", note: `Keka's Project Services Suite includes project billing. ${US.books}`, source: "https://www.keka.com/hr-software" },
  { feature: "Attendance from biometric devices and phones", us: "yes", them: "yes", note: `Keka names biometric, smart card, RFID and facial recognition devices, selfie attendance and geo-fencing. ${US.attendance}`, source: "https://www.keka.com/attendance-management-system" },
  { feature: "Shifts and leave", us: "yes", them: "yes", note: `Keka: shifts, swaps, leave types, accruals and carry forward. ${US.shifts}`, source: "https://www.keka.com/workforce-management-software" },
  { feature: "Timesheets", us: "no", them: "yes", note: "Keka's employees log time against projects and tasks. {siteName}: time logged on tasks, with no timesheets to approve.", source: "https://www.keka.com/workforce-management-software" },
  { feature: "Expense claims", us: "yes", them: "yes", note: `Keka: receipts read by OCR, policy checks, advances, and approved claims paid through payroll. ${US.expenses}`, source: "https://www.keka.com/expense-management-software" },
  { feature: "Hiring", us: "partial", them: "yes", note: `Keka: job descriptions, interview scheduling across panels, and onboarding. ${US.hiring}`, source: "https://www.keka.com/hiring-software" },
  { feature: "Goals and performance reviews", us: "partial", them: "yes", note: `Keka: goals, custom review cycles and 360-degree reviews. ${US.reviews}`, source: "https://www.keka.com/performance-management-software" },
  { feature: "UAE payroll and the WPS file", us: "yes", them: "yes", note: `Keka generates WPS-ready payroll files for banks. ${US.uae}`, source: "https://www.keka.com/payroll-processing" },
  { feature: "Payroll outside India and the UAE", us: "no", them: "yes", note: "Keka runs global payroll for subsidiaries and offers an employer of record. {siteName}'s payroll is for India and the UAE.", source: "https://www.keka.com/payroll-software" },
  { feature: "Pricing model", us: PRICING_US, them: "Plans by suite; prices not published", note: "Keka's pricing page names its plans and asks you to talk to its team; it shows no prices.", source: "https://www.keka.com/pricing" },
];

const KEKA = comparePage({
  slug: "keka",
  competitor: "Keka",
  navTitle: "Keka",
  website: "Keka's website (keka.com)",
  h1: "alternative",
  keywords: ["Keka alternative", "Keka alternative in India", "compare Keka payroll"],
  seoTitle: "Keka alternative: {siteName} vs Keka",
  seoDescription: "A Keka alternative for Indian companies: attendance, leave, payroll and expenses in the same workspace as CRM, GST invoicing and the books, compared row by row.",
  subheading: "{siteName} runs attendance, leave, payroll and expenses in the same workspace as sales, GST invoicing and the books. Compare Keka and {siteName} row by row, from Keka's own website.",
  summary: {
    heading: "Is {siteName} a Keka alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a Keka alternative for companies that want payroll inside the same workspace as their sales and accounts. Keka is HR and payroll software whose payroll " },
        { text: "exports to Tally and Zoho Books", href: "https://www.keka.com/marketplace" },
        { text: ". In {siteName}, a locked payroll run posts to the same ledger as your invoices, bills and expense claims." },
      ],
      "If you are looking for a Keka alternative in India because you also raise GST invoices, follow up leads and close the books each month, {siteName} does that work beside attendance, leave and payroll. If HR is most of your work and you need timesheets, 360-degree reviews, Form 130 or payroll in other countries, Keka may fit better: see below.",
    ],
  },
  tableIntro: "What each product offers an Indian company: {siteName} from its own features, Keka from its public website. Each Keka row links the page it was read from.",
  rows: KEKA_ROWS,
  fits: {
    intro: "{siteName} suits a company that wants its people, its customers and its accounts on one set of records.",
    items: [FIT_PEOPLE, FIT_LEDGER, FIT_BOOKS, FIT_ATTENDANCE, FIT_GST],
  },
  theirs: {
    intro: "Keka may suit you better if:",
    items: [
      withLink("you need the statutory forms made for you: Keka ", "generates Form 130 and calculates LWF", "https://www.keka.com/payroll-software", ";"),
      withLink("your team logs time: Keka's ", "timesheets", "https://www.keka.com/workforce-management-software", " record time against projects and tasks;"),
      withLink("you hire at volume: Keka schedules interviews ", "across panels, time zones and calendars", "https://www.keka.com/hiring-software", ";"),
      withLink("you run 360-degree reviews and OKRs, which are part of ", "Keka's performance software", "https://www.keka.com/performance-management-software", ";"),
      withLink("you pay people in other countries: Keka offers ", "global payroll and an employer of record", "https://www.keka.com/payroll-software", "."),
    ],
  },
  switching: {
    answer: "Bring your people and their pay across as spreadsheets: first the employee list, then one payroll file with salary structures, bank details and this year's pay so far. {siteName} shows every row it would create or update before anything is written.",
    steps: switchingSteps("Keka"),
    after: SWITCH_AFTER,
  },
  faq: [
    {
      question: "Does {siteName} work out TDS on salary like Keka?",
      answer: [
        "Yes. {siteName} works out each month's TDS under the new or the old regime, from the declaration payroll enters on the person's record. It reminds you when the quarterly return is due, but it doesn't make the return or Form 130 (was Form 16); Keka's website says it generates Form 130.",
      ],
    },
    faqHistory("Keka"),
    faqTogether("Keka"),
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_PAYROLL, ATTENDANCE, EXPENSES, REL_ACCOUNTING, REL_IMPORT, REL_HUB],
  trademarks: "Keka and the names of its products are trademarks of their owner.",
  asOf: AS_OF,
});

// ─── greytHR ─────────────────────────────────────────────────────────────────────────────────────

const T_GREYTHR_GROWTH = tool({ name: "greytHR Growth", replaces: "HR, payroll & attendance", price: 4495, per: "org", included: 50, extra: 85, basis: "Growth: adds attendance, shifts and geo-fencing", source: "https://www.greythr.com/pricing/" });

const GREYTHR_ROWS: Row[] = [
  { feature: "Payroll with PF and ESI", us: "yes", them: "yes", note: `greytHR: PF calculations and ESI computations and challans. ${US.pfEsi}`, source: "https://www.greythr.com/payroll-software/" },
  { feature: "Professional tax by state", us: "partial", them: "yes", note: `greytHR says it has every state's PT rules built in. ${US.pt}`, source: "https://www.greythr.com/payroll-software/" },
  { feature: "Labour Welfare Fund", us: "no", them: "yes", note: `greytHR calculates and deducts LWF. ${US.lwf}`, source: "https://www.greythr.com/payroll-software/" },
  { feature: "TDS on salary", us: "yes", them: "yes", note: `greytHR calculates TDS and prepares eTDS returns. ${US.tds}`, source: "https://www.greythr.com/payroll-software/" },
  { feature: "Form 16 and the salary TDS return", us: "no", them: "yes", note: `greytHR generates digitally signed Form 16 and Form 24Q. ${US.forms}`, source: "https://www.greythr.com/payroll-software/" },
  { feature: "PF ECR and bank transfer files", us: "yes", them: "yes", note: `greytHR generates the ECR and bank-transfer formats for major banks. ${US.files}`, source: "https://www.greythr.com/payroll-software/" },
  { feature: "Full and final settlement and loans", us: "yes", them: "yes", note: `greytHR lists both among its payroll features. ${US.fnf} Loans and advances are recovered from pay.`, source: "https://www.greythr.com/payroll-software/" },
  { feature: "Payroll posted to the books", us: "yes", them: "An accounts JV", note: `greytHR lists "Accounts JV" among its payroll features. ${US.ledger}`, source: "https://www.greythr.com/payroll-software/" },
  { feature: "GST invoices, CRM and accounting", us: "yes", them: "Not stated on greytHR's website", note: US.books, source: "https://www.greythr.com/" },
  { feature: "Attendance from biometric devices and phones", us: "yes", them: "yes", note: `greytHR: third-party attendance hardware, geo-fencing and selfie attendance. ${US.attendance}`, source: "https://www.greythr.com/attendance-management-software/" },
  { feature: "Shifts and overtime", us: "partial", them: "yes", note: "greytHR: rotating shifts, automatic shift detection and overtime policies. {siteName}: shifts and a roster, with late, early and overtime days marked; overtime isn't paid by policy.", source: "https://www.greythr.com/attendance-management-software/" },
  { feature: "Expense claims", us: "yes", them: "yes", note: `greytHR: receipts read by OCR, approvals on mobile or web, and a bank file for payouts. ${US.expenses}`, source: "https://www.greythr.com/expense-management-software/" },
  { feature: "Hiring", us: "partial", them: "yes", note: `greytHR Recruit: job postings, interview scheduling, scorecards and offer letters. ${US.hiring}`, source: "https://www.greythr.com/recruitment/" },
  { feature: "Goals and performance reviews", us: "partial", them: "yes", note: `greytHR: goals with milestones and weightages, review cycles and a 360-degree feedback module. ${US.reviews}`, source: "https://www.greythr.com/performance-management-system/" },
  { feature: "Employee self-service", us: "yes", them: "yes", note: `greytHR: payslips, leave, attendance and tax declarations on the web and in its mobile app. ${US.self}`, source: "https://www.greythr.com/employee-self-service-portal/" },
  { feature: "UAE payroll and WPS", us: "yes", them: "yes", note: `greytHR offers HRMS and payroll for the UAE with WPS compliance. ${US.uae}`, source: "https://www.greythr.com/middle-east/" },
  { feature: "Pricing model", us: PRICING_US, them: "Per company, 50 employees included, then per employee", note: "Prices: in the calculator below, each from the vendor's own pricing page with the day it was read.", source: "https://www.greythr.com/pricing/" },
];

const GREYTHR = comparePage({
  slug: "greythr",
  competitor: "greytHR",
  navTitle: "greytHR",
  website: "greytHR's website (greythr.com)",
  h1: "alternative",
  keywords: ["greytHR alternative", "greytHR alternative in India", "compare greytHR payroll"],
  seoTitle: "greytHR alternative: {siteName} vs greytHR",
  seoDescription: "A greytHR alternative for Indian companies: payroll, attendance and expenses in the same workspace as CRM, GST invoicing and the books, compared row by row.",
  subheading: "{siteName} keeps payroll, attendance and expenses in the same workspace as sales, GST invoicing and the books. Compare greytHR and {siteName} row by row, from greytHR's own website.",
  summary: {
    heading: "Is {siteName} a greytHR alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a greytHR alternative for companies that want payroll and the books on one set of records. greytHR is HR and payroll software with " },
        { text: "statutory payroll for India", href: "https://www.greythr.com/payroll-software/" },
        { text: " — PF, ESI, PT, LWF, TDS and Form 16. {siteName} runs payroll beside CRM, GST invoicing and accounting, and a locked run posts to its own ledger." },
      ],
      "If you are looking for a greytHR alternative in India because your HR, sales and accounts teams work from different systems, {siteName} brings them into one workspace. If you want Form 16, the 24Q return and LWF made for you, or a full recruiting suite, greytHR may fit better: see below.",
    ],
  },
  tableIntro: "What each product offers an Indian company: {siteName} from its own features, greytHR from its public website. Each greytHR row links the page it was read from.",
  rows: GREYTHR_ROWS,
  fits: {
    intro: "{siteName} suits a company that wants its people, its customers and its accounts on one set of records.",
    items: [FIT_PEOPLE, FIT_LEDGER, FIT_BOOKS, FIT_ATTENDANCE, FIT_COPILOT],
  },
  theirs: {
    intro: "greytHR may suit you better if:",
    items: [
      withLink("you want the year-end forms made in the product: greytHR ", "generates Form 16 and Form 24Q", "https://www.greythr.com/payroll-software/", ", and calculates LWF;"),
      withLink("you pay overtime by policy and rotate shifts, both covered by ", "greytHR's attendance", "https://www.greythr.com/attendance-management-software/", ";"),
      withLink("you hire through job boards, with interview scheduling and scorecards in ", "greytHR Recruit", "https://www.greythr.com/recruitment/", ";"),
      withLink("your people want a mobile app for payslips, leave and tax declarations, as ", "greytHR's self-service", "https://www.greythr.com/employee-self-service-portal/", " offers;"),
      withLink("HR and payroll is all you need from the software, on a plan priced ", "per company with 50 employees included", "https://www.greythr.com/pricing/", "."),
    ],
  },
  switching: {
    answer: "Bring your people and their pay across as spreadsheets: first the employee list, then one payroll file with salary structures, bank details and this year's pay so far. {siteName} shows every row it would create or update before anything is written.",
    steps: switchingSteps("greytHR"),
    after: SWITCH_AFTER,
  },
  faq: [
    {
      question: "Does {siteName} make the PF ECR file like greytHR?",
      answer: [
        "Yes. From a locked month, {siteName} makes EPFO's ECR file, ESIC's monthly upload and a bulk bank transfer file. It doesn't make Form 16 or the 24Q return, which greytHR's website says it generates.",
      ],
    },
    faqHistory("greytHR"),
    faqTogether("greytHR"),
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_PAYROLL, ATTENDANCE, EXPENSES, REL_ACCOUNTING, REL_IMPORT, REL_HUB],
  trademarks: "greytHR and the names of its products are trademarks of their owner.",
  asOf: AS_OF,
  stack: { heading: "greytHR and the tools beside it, or {siteName} One", tools: [T_GREYTHR, { ...T_GREYTHR_GROWTH, selected: undefined }, T_ZOHO_BOOKS, T_ZOHO_CRM] },
});

// ─── Darwinbox ───────────────────────────────────────────────────────────────────────────────────

const DARWINBOX_INDIA = "https://darwinbox.com/products/payroll/payroll-for-india";

const DARWINBOX_ROWS: Row[] = [
  { feature: "Payroll with PF and ESI", us: "yes", them: "yes", note: `Darwinbox's India payroll takes PF, ESIC and the other statutory deductions into gross to net. ${US.pfEsi}`, source: DARWINBOX_INDIA },
  { feature: "Professional tax", us: "partial", them: "yes", note: `Darwinbox names PT among the taxes its India payroll calculates. ${US.pt}`, source: DARWINBOX_INDIA },
  { feature: "Labour Welfare Fund", us: "no", them: "yes", note: `Darwinbox names LWF among them too. ${US.lwf}`, source: DARWINBOX_INDIA },
  { feature: "TDS on salary and tax declarations", us: "yes", them: "yes", note: `Darwinbox: exemptions such as 80C, 80D and HRA, with employees declaring investments and submitting proof online. ${US.tds}`, source: DARWINBOX_INDIA },
  { feature: "Form 16 and the salary TDS return", us: "no", them: "Reports, with a filing partner", note: `Darwinbox lists reports for Form 16 and Form 24Q, and a partner for government filings. ${US.forms}`, source: DARWINBOX_INDIA },
  { feature: "Loans and advances", us: "yes", them: "yes", note: `Darwinbox's employees request and track loan advances. ${US.loans}`, source: DARWINBOX_INDIA },
  { feature: "Payroll posted to the books", us: "yes", them: "Journal entries to your ERP", note: `Darwinbox generates GL codes and journal vouchers for integration with an ERP. ${US.ledger}`, source: DARWINBOX_INDIA },
  { feature: "GST invoices, CRM and accounting", us: "yes", them: "Not stated on Darwinbox's website", note: US.books, source: "https://darwinbox.com/products/payroll" },
  { feature: "Attendance feeding payroll", us: "yes", them: "yes", note: `Darwinbox syncs attendance, leave and holidays into payroll. ${US.attendance}`, source: DARWINBOX_INDIA },
  { feature: "Facial recognition attendance", us: "no", them: "yes", note: "Darwinbox offers facial recognition for check-in. {siteName} reads biometric terminals and browser clock-in; it has no facial recognition of its own.", source: "https://darwinbox.com/innovations/facial-recognition" },
  { feature: "Expense claims", us: "yes", them: "yes", note: `Darwinbox: a travel and expense platform on its mobile app. ${US.expenses}`, source: "https://darwinbox.com/products/travel-and-expense" },
  { feature: "Hiring", us: "partial", them: "yes", note: `Darwinbox has a recruitment product. ${US.hiring}`, source: "https://darwinbox.com/products/recruitment" },
  { feature: "Payroll in the Gulf, with WPS", us: "partial", them: "yes", note: `Darwinbox runs payroll for the UAE, Saudi Arabia, Oman, Qatar, Bahrain and Kuwait, with WPS reports. ${US.uae} {siteName}'s Gulf payroll is the UAE's only.`, source: "https://darwinbox.com/products/payroll/payroll-for-gcc" },
  { feature: "Pay frequencies", us: "partial", them: "yes", note: "Darwinbox runs payroll monthly, bi-monthly or weekly, with off-cycle arrears and reimbursements. {siteName} runs payroll monthly.", source: DARWINBOX_INDIA },
  { feature: "Employee self-service", us: "yes", them: "yes", note: `Darwinbox: CTC, payslips, investment declarations and loans, with Android and iOS apps listed for its payroll. ${US.self}`, source: "https://darwinbox.com/products/payroll" },
  { feature: "Pricing model", us: PRICING_US, them: "Not published: request a quote", note: "Darwinbox's product pages offer a quote and a demo; they show no prices.", source: "https://darwinbox.com/products/payroll" },
];

const DARWINBOX = comparePage({
  slug: "darwinbox",
  competitor: "Darwinbox",
  navTitle: "Darwinbox",
  website: "Darwinbox's website (darwinbox.com)",
  h1: "alternative",
  keywords: ["Darwinbox alternative", "Darwinbox alternative in India", "compare Darwinbox payroll"],
  seoTitle: "Darwinbox alternative: {siteName} vs Darwinbox",
  seoDescription: "A Darwinbox alternative for Indian companies: payroll, attendance and expenses in the same workspace as CRM, GST invoicing and the books, compared row by row.",
  subheading: "{siteName} keeps payroll, attendance and expenses in the same workspace as sales, GST invoicing and the books. Compare Darwinbox and {siteName} row by row, from Darwinbox's own website.",
  summary: {
    heading: "Is {siteName} a Darwinbox alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a Darwinbox alternative for growing companies that want payroll and the books on one set of records. Darwinbox is an HR platform for enterprises whose India payroll " },
        { text: "passes journal vouchers to an ERP", href: DARWINBOX_INDIA },
        { text: ". In {siteName}, a locked payroll run posts to the same ledger as your invoices, bills and expense claims." },
      ],
      "If you are looking for a Darwinbox alternative in India because you also sell, raise GST invoices and close the books in-house, {siteName} does that work beside payroll. If you employ thousands across several countries, or need weekly pay runs and facial recognition, Darwinbox may fit better: see below.",
    ],
  },
  tableIntro: "What each product offers an Indian company: {siteName} from its own features, Darwinbox from its public website. Each Darwinbox row links the page it was read from.",
  rows: DARWINBOX_ROWS,
  fits: {
    intro: "{siteName} suits a company that wants its people, its customers and its accounts on one set of records.",
    items: [FIT_PEOPLE, FIT_LEDGER, FIT_BOOKS, FIT_ATTENDANCE, FIT_GST],
  },
  theirs: {
    intro: "Darwinbox may suit you better if:",
    items: [
      withLink("you pay people in several countries: Darwinbox runs payroll for ", "six Gulf countries", "https://darwinbox.com/products/payroll/payroll-for-gcc", " among others;"),
      withLink("you pay weekly or twice a month: Darwinbox's ", "India payroll", DARWINBOX_INDIA, " runs on several frequencies, with off-cycle arrears;"),
      withLink("you want Form 16 and 24Q reports and a partner for government filings, as ", "Darwinbox lists", DARWINBOX_INDIA, ";"),
      withLink("your sites check people in by face: Darwinbox offers ", "facial recognition", "https://darwinbox.com/innovations/facial-recognition", " for attendance;"),
      withLink("your accounts live in an ERP that payroll should feed, through Darwinbox's ", "GL codes and journal vouchers", DARWINBOX_INDIA, "."),
    ],
  },
  switching: {
    answer: "Bring your people and their pay across as spreadsheets: first the employee list, then one payroll file with salary structures, bank details and this year's pay so far. {siteName} shows every row it would create or update before anything is written.",
    steps: switchingSteps("Darwinbox"),
    after: SWITCH_AFTER,
  },
  faq: [
    {
      question: "Is {siteName} built for a company of Darwinbox's customers' size?",
      answer: [
        "{siteName} is built for companies that want HR, payroll, sales and the books in one workspace, each company with a database of its own. If you pay many thousands of people across several countries, on several pay frequencies, Darwinbox's enterprise payroll may be the better fit.",
      ],
    },
    faqHistory("Darwinbox"),
    faqTogether("Darwinbox"),
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_PAYROLL, ATTENDANCE, RECRUITMENT, REL_ACCOUNTING, REL_IMPORT, REL_HUB],
  trademarks: "Darwinbox and the names of its products are trademarks of their owner.",
  asOf: AS_OF,
});

// ─── Zoho People ─────────────────────────────────────────────────────────────────────────────────

const ZOHO_PAYROLL_FEATURES = "https://www.zoho.com/in/payroll/features/";

const ZOHO_PEOPLE_ROWS: Row[] = [
  { feature: "Payroll with PF and ESI", us: "yes", them: "In Zoho Payroll", note: `Zoho Payroll computes EPF and ESI. ${US.pfEsi}`, source: ZOHO_PAYROLL_FEATURES },
  { feature: "Professional tax", us: "partial", them: "In Zoho Payroll", note: `Zoho Payroll computes PT. ${US.pt}`, source: ZOHO_PAYROLL_FEATURES },
  { feature: "Labour Welfare Fund", us: "no", them: "In Zoho Payroll", note: `Zoho Payroll computes LWF. ${US.lwf}`, source: ZOHO_PAYROLL_FEATURES },
  { feature: "Tax declarations and tax forms", us: "partial", them: "In Zoho Payroll", note: "Zoho Payroll collects IT declarations online, and lists 12BB, Form 138 and Form 130 among its tax forms. {siteName} works out monthly TDS on salary under either regime from the person's declaration, and reminds you of the quarterly return; it doesn't make Form 138 or Form 130.", source: "https://www.zoho.com/in/payroll/" },
  { feature: "Salary paid through the bank", us: "yes", them: "yes", note: `Zoho Payroll pays by direct deposit through HSBC and ICICI. ${US.files}`, source: ZOHO_PAYROLL_FEATURES },
  { feature: "Full and final settlement and loans", us: "yes", them: "yes", note: `Zoho Payroll automates final settlements and deducts loan EMIs. ${US.fnf}`, source: ZOHO_PAYROLL_FEATURES },
  { feature: "Payroll posted to the books", us: "yes", them: "Synced to accounting", note: `Zoho Payroll syncs with accounting to record expenses and journal entries. ${US.ledger}`, source: ZOHO_PAYROLL_FEATURES },
  { feature: "Attendance from biometric devices and phones", us: "yes", them: "yes", note: `Zoho People: biometric systems, IP and geo-fencing, facial recognition, and check-in from the web and mobile app. ${US.attendance}`, source: "https://www.zoho.com/people/attendance-management-system.html" },
  { feature: "Shifts and timesheets", us: "partial", them: "yes", note: "Zoho People: shift management and timesheets. {siteName}: shifts and a roster, and time logged on tasks with no timesheets to approve.", source: "https://www.zoho.com/people/features.html" },
  { feature: "Expense claims", us: "yes", them: "Through Zoho Expense", note: `Zoho People integrates with Zoho Expense for travel and expenses. ${US.expenses}`, source: "https://www.zoho.com/people/features.html" },
  { feature: "Goals and performance reviews", us: "partial", them: "On some plans", note: `Zoho People lists performance on its Premium plan and above. ${US.reviews}`, source: "https://www.zoho.com/people/zohopeople-pricing.html" },
  { feature: "Learning", us: "yes", them: "On some plans", note: "Zoho People lists its LMS on the Enterprise plan. {siteName} has Learning in its People module.", source: "https://www.zoho.com/people/zohopeople-pricing.html" },
  { feature: "Mobile apps", us: "Browser on a phone", them: "iOS and Android apps", note: US.self, source: "https://www.zoho.com/people/features.html" },
  { feature: "UAE payroll and the WPS file", us: "yes", them: "Not stated on Zoho's website", note: `Zoho Payroll's features page read here is India's. ${US.uae}`, source: ZOHO_PAYROLL_FEATURES },
  { feature: "Pricing model", us: PRICING_US, them: "Zoho People per user; Zoho Payroll per organisation", note: "Prices: in the calculator below, each from the vendor's own pricing page with the day it was read.", source: "https://www.zoho.com/people/zohopeople-pricing.html" },
];

const ZOHO_PEOPLE = comparePage({
  slug: "zoho-people",
  competitor: "Zoho People",
  navTitle: "Zoho People",
  website: "Zoho's website (zoho.com)",
  h1: "alternative",
  keywords: ["Zoho People alternative", "Zoho People alternative in India", "Zoho Payroll alternative"],
  seoTitle: "Zoho People alternative: {siteName} vs Zoho People",
  seoDescription: "A Zoho People and Zoho Payroll alternative for Indian companies: HR, attendance, payroll and expenses as modules of one workspace with CRM and the books.",
  subheading: "{siteName} runs HR, attendance, payroll and expenses as modules of one workspace, with CRM, GST invoicing and the books. Compare Zoho People and Zoho Payroll with {siteName} row by row, from Zoho's own website.",
  summary: {
    heading: "Is {siteName} a Zoho People alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a Zoho People alternative for companies that want HR and payroll in one product rather than two apps. Zoho People keeps HR and attendance, and " },
        { text: "Zoho Payroll", href: ZOHO_PAYROLL_FEATURES },
        { text: " runs the pay from it. In {siteName}, both are modules of one workspace, beside CRM, GST invoicing and the books." },
      ],
      "If you are looking for a Zoho People alternative in India because you want attendance, payroll, expenses and the ledger on one set of records, {siteName} covers that ground. If you need timesheets, LWF, the tax forms made for you, or native mobile apps, Zoho People with Zoho Payroll may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, Zoho from Zoho People and Zoho Payroll as Zoho's public website describes them. Each Zoho row links the page it was read from.",
  rows: ZOHO_PEOPLE_ROWS,
  fits: {
    intro: "{siteName} suits a company that wants HR, payroll and its accounts in one product.",
    items: [
      "One product rather than separate apps: people, attendance, payroll and expenses are modules of one workspace, sharing one set of records.",
      FIT_LEDGER,
      FIT_BOOKS,
      FIT_ATTENDANCE,
      FIT_COPILOT,
    ],
  },
  theirs: {
    intro: "Zoho People may suit you better if:",
    items: [
      withLink("you want a free plan to start: Zoho People ", "has a free plan", "https://www.zoho.com/people/zohopeople-pricing.html", ";"),
      withLink("your team logs time: Zoho People has ", "timesheets and shift management", "https://www.zoho.com/people/features.html", ";"),
      withLink("you need LWF and the tax forms in the product: ", "Zoho Payroll", "https://www.zoho.com/in/payroll/", " computes LWF and lists Form 130 and Form 138 among its forms;"),
      withLink("your people check in by face or from a native app: Zoho People offers ", "facial recognition and mobile check-in", "https://www.zoho.com/people/attendance-management-system.html", ";"),
      withLink("you already run other Zoho apps: Zoho People connects with ", "Zoho Payroll and Zoho Expense", "https://www.zoho.com/people/features.html", "."),
    ],
  },
  switching: {
    answer: "Bring your people and their pay across as spreadsheets: first the employee list, then one payroll file with salary structures, bank details and this year's pay so far. {siteName} shows every row it would create or update before anything is written.",
    steps: switchingSteps("Zoho People and Zoho Payroll"),
    after: SWITCH_AFTER,
  },
  faq: [
    {
      question: "Do I need a separate payroll app with {siteName}, as Zoho People has Zoho Payroll?",
      answer: [
        "No. Payroll is a module of the same workspace, which reads attendance and leave for loss of pay and posts each locked run to the ledger. It is kept behind its own permission, so who earns what stays with the people who run payroll.",
      ],
    },
    faqHistory("Zoho Payroll"),
    faqTogether("Zoho People"),
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_PAYROLL, ATTENDANCE, EXPENSES, REL_ACCOUNTING, REL_IMPORT, REL_HUB],
  trademarks: "Zoho, Zoho People, Zoho Payroll and related names are trademarks of their owner.",
  asOf: AS_OF,
  stack: { heading: "Zoho People, Zoho Payroll and the apps beside them, or {siteName} One", tools: [T_ZOHO_PEOPLE, T_ZOHO_PAYROLL, T_ZOHO_BOOKS, T_ZOHO_CRM] },
});

export const pages: SeedPage[] = [KEKA, GREYTHR, DARWINBOX, ZOHO_PEOPLE];
