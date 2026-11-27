import type { LeadStatus, OrderStatus } from "@prisma/client";
import type { CustomFieldEntity, CustomFieldType } from "@prisma/client";
import type { Term, TermKey } from "@/lib/terms/dictionary";

/**
 * Industry templates (owner, 2 Oct 2026): a workspace's pipeline, order steps, words and fields set up
 * for how one kind of business works — picked at signup or applied later from Settings → Industry
 * templates. Plain data, versioned with the code: applying one writes ordinary rows (src/lib/
 * industry-templates/apply.ts), and nothing stays bound to the template afterwards.
 *
 * A template only adds and renames. A stage that means the same as one of the template's is renamed to
 * it; one the template has no use for is retired when nobody's lead is in it, and kept when somebody's
 * is. Steps and fields are added beside what is there; words are set; nothing is deleted.
 */

export type TemplateStage = { label: string; status: LeadStatus };
export type TemplateStep = { label: string; status: Extract<OrderStatus, "APPROVED" | "PROCESSING" | "FULFILLED"> };
export type TemplateField = {
  entity: CustomFieldEntity;
  label: string;
  type: CustomFieldType;
  options?: string[];
  helpText?: string;
  /** A column in the list from the start. */
  showInList?: boolean;
};

export type IndustryTemplate = {
  key: string;
  name: string;
  /** One line, for the card and the signup choice. */
  summary: string;
  stages: TemplateStage[];
  steps: TemplateStep[];
  terms: Partial<Record<TermKey, Term>>;
  fields: TemplateField[];
  /** Switched on when the plan includes them. */
  modules: string[];
};

const term = (one: string, many: string, a: "a" | "an" = "a"): Term => ({ one, many, a });

export const INDUSTRY_TEMPLATES: readonly IndustryTemplate[] = [
  {
    key: "system_integrators",
    name: "System integrators",
    summary: "CCTV, networking, AV, access control and fire — from the site survey to handing the installation over.",
    stages: [
      { label: "Enquiry", status: "NEW" },
      { label: "Site survey", status: "CONTACTED" },
      { label: "Solution design", status: "QUALIFYING" },
      { label: "Quotation sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "PO received", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not a fit", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Material ordered", status: "PROCESSING" },
      { label: "Material received", status: "PROCESSING" },
      { label: "Installation", status: "PROCESSING" },
      { label: "Testing and commissioning", status: "PROCESSING" },
      { label: "Handed over", status: "FULFILLED" },
    ],
    terms: { lead: term("Enquiry", "Enquiries", "an"), order: term("Project", "Projects"), ticket: term("Service call", "Service calls") },
    fields: [
      { entity: "LEAD", label: "Solution type", type: "MULTI_SELECT", options: ["CCTV", "Networking", "AV", "Access control", "Fire"], showInList: true },
      { entity: "LEAD", label: "Site address", type: "LONG_TEXT" },
      { entity: "LEAD", label: "Survey date", type: "DATE" },
      { entity: "ORDER", label: "Site code", type: "TEXT", showInList: true },
      { entity: "ORDER", label: "Installation date", type: "DATE" },
      { entity: "ORDER", label: "Warranty till", type: "DATE" },
      { entity: "ORDER", label: "AMC included", type: "CHECKBOX" },
    ],
    modules: [],
  },
  {
    key: "real_estate",
    name: "Real estate",
    summary: "Enquiries to site visits to bookings, and each booking through agreement, home loan, registration and possession.",
    stages: [
      { label: "Enquiry", status: "NEW" },
      { label: "Contacted", status: "CONTACTED" },
      { label: "Site visit scheduled", status: "QUALIFYING" },
      { label: "Site visit done", status: "QUALIFIED" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "Booked", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not interested", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Booking amount received", status: "APPROVED" },
      { label: "Agreement signed", status: "PROCESSING" },
      { label: "Home loan sanctioned", status: "PROCESSING" },
      { label: "Registration", status: "PROCESSING" },
      { label: "Possession", status: "FULFILLED" },
    ],
    terms: { lead: term("Enquiry", "Enquiries", "an"), customer: term("Buyer", "Buyers"), order: term("Booking", "Bookings"), item: term("Unit", "Units") },
    fields: [
      { entity: "LEAD", label: "Budget range", type: "TEXT", helpText: "For example 80 lakh – 1 crore", showInList: true },
      { entity: "LEAD", label: "Configuration", type: "SELECT", options: ["1 BHK", "2 BHK", "3 BHK", "4 BHK or more", "Villa", "Plot"], showInList: true },
      { entity: "LEAD", label: "Preferred location", type: "TEXT" },
      { entity: "LEAD", label: "Home loan needed", type: "CHECKBOX" },
      { entity: "ITEM", label: "Tower", type: "TEXT", showInList: true },
      { entity: "ITEM", label: "Floor", type: "NUMBER" },
      { entity: "ITEM", label: "Carpet area", type: "NUMBER", helpText: "Square feet" },
      { entity: "ITEM", label: "Facing", type: "SELECT", options: ["North", "South", "East", "West", "North-east", "North-west", "South-east", "South-west"] },
      { entity: "ORDER", label: "Booking amount", type: "MONEY" },
      { entity: "ORDER", label: "Agreement date", type: "DATE" },
      { entity: "ORDER", label: "Possession date", type: "DATE" },
    ],
    modules: [],
  },
  {
    key: "it_services",
    name: "IT services",
    summary: "Discovery to proposal to project, and each project from kick-off to go-live and hypercare.",
    stages: [
      { label: "Lead", status: "NEW" },
      { label: "Discovery call", status: "CONTACTED" },
      { label: "Requirements", status: "QUALIFYING" },
      { label: "Proposal sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "Won", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not a fit", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Kick-off", status: "PROCESSING" },
      { label: "In development", status: "PROCESSING" },
      { label: "Testing (UAT)", status: "PROCESSING" },
      { label: "Go-live", status: "FULFILLED" },
      { label: "Hypercare", status: "FULFILLED" },
    ],
    terms: { order: term("Project", "Projects"), item: term("Service", "Services"), ticket: term("Support request", "Support requests") },
    fields: [
      { entity: "LEAD", label: "Engagement type", type: "SELECT", options: ["Fixed price", "Time and material", "Retainer", "Managed service"], showInList: true },
      { entity: "LEAD", label: "Tech stack", type: "TEXT" },
      { entity: "ORDER", label: "Project manager", type: "USER", showInList: true },
      { entity: "ORDER", label: "Go-live date", type: "DATE" },
      { entity: "ORDER", label: "SLA tier", type: "SELECT", options: ["Basic", "Standard", "Premium"] },
    ],
    modules: [],
  },
  {
    key: "manufacturing",
    name: "Manufacturing",
    summary: "RFQs through sampling and quotation to the PO, and each order from raw material to dispatch.",
    stages: [
      { label: "Enquiry", status: "NEW" },
      { label: "RFQ received", status: "QUALIFYING" },
      { label: "Sampling / technical review", status: "QUALIFIED" },
      { label: "Quotation sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "PO received", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Regret", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Raw material procured", status: "PROCESSING" },
      { label: "In production", status: "PROCESSING" },
      { label: "Quality check", status: "PROCESSING" },
      { label: "Packed", status: "PROCESSING" },
      { label: "Dispatched", status: "FULFILLED" },
    ],
    terms: { lead: term("Enquiry", "Enquiries", "an"), order: term("Sales order", "Sales orders") },
    fields: [
      { entity: "LEAD", label: "RFQ number", type: "TEXT", showInList: true },
      { entity: "LEAD", label: "Annual volume", type: "NUMBER" },
      { entity: "LEAD", label: "Drawing link", type: "URL" },
      { entity: "LEAD", label: "Sample required", type: "CHECKBOX" },
      { entity: "ITEM", label: "Material grade", type: "TEXT", showInList: true },
      { entity: "ITEM", label: "Minimum order quantity", type: "NUMBER" },
      { entity: "ITEM", label: "Lead time in days", type: "NUMBER" },
      { entity: "ORDER", label: "Customer PO date", type: "DATE" },
      { entity: "ORDER", label: "Dispatch date", type: "DATE" },
      { entity: "ORDER", label: "Inspection required", type: "CHECKBOX" },
    ],
    modules: [],
  },
  {
    key: "software_resellers",
    name: "Software resellers",
    summary: "Requirement to OEM deal registration to PO, licences issued and onboarded — with renewals and add-on seats.",
    stages: [
      { label: "Lead", status: "NEW" },
      { label: "Requirement captured", status: "QUALIFYING" },
      { label: "OEM deal registered", status: "QUALIFIED" },
      { label: "Quotation sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "PO received", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not a fit", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "PO placed with distributor", status: "PROCESSING" },
      { label: "Licences issued", status: "PROCESSING" },
      { label: "Delivered to customer", status: "FULFILLED" },
      { label: "Customer onboarded", status: "FULFILLED" },
    ],
    terms: {},
    fields: [
      { entity: "LEAD", label: "Licence type", type: "SELECT", options: ["New", "Renewal", "Upgrade", "Migration", "True-up"], showInList: true },
      { entity: "LEAD", label: "Seats needed", type: "NUMBER" },
      { entity: "LEAD", label: "Current licence expiry", type: "DATE" },
      { entity: "LEAD", label: "Competing partner", type: "TEXT" },
      { entity: "COMPANY", label: "Tenant / domain", type: "TEXT", helpText: "For example contoso.onmicrosoft.com" },
      { entity: "ORDER", label: "Agreement number", type: "TEXT" },
      { entity: "ORDER", label: "Distributor PO number", type: "TEXT" },
      { entity: "ORDER", label: "Licence admin email", type: "EMAIL" },
    ],
    // Renewals, add-on seats, OEM deal registrations and backend rebates all live in Orders and Renewals.
    modules: ["orders", "renewals"],
  },

  // Nine more (owner, 12 Nov 2026), all B2B — the businesses Deskzo is sold to next.
  {
    key: "certification_bodies",
    name: "Certification and inspection",
    summary: "ISO and product certification, audits and inspections — from the application to the certificate, then surveillance every year.",
    stages: [
      { label: "Enquiry", status: "NEW" },
      { label: "Application received", status: "CONTACTED" },
      { label: "Scope review", status: "QUALIFYING" },
      { label: "Contract review done", status: "QUALIFIED" },
      { label: "Quotation sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "Contract signed", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Out of scope", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Audit team assigned", status: "APPROVED" },
      { label: "Stage 1 audit", status: "PROCESSING" },
      { label: "Stage 2 audit", status: "PROCESSING" },
      { label: "Corrective actions closed", status: "PROCESSING" },
      { label: "Technical review", status: "PROCESSING" },
      { label: "Certificate issued", status: "FULFILLED" },
    ],
    terms: { lead: term("Enquiry", "Enquiries", "an"), customer: term("Client", "Clients"), order: term("Assignment", "Assignments", "an"), item: term("Service", "Services"), renewal: term("Recertification", "Recertifications") },
    fields: [
      { entity: "LEAD", label: "Standard", type: "MULTI_SELECT", options: ["ISO 9001", "ISO 14001", "ISO 45001", "ISO 27001", "ISO 22000", "HACCP", "CE marking", "Other"], showInList: true },
      { entity: "LEAD", label: "Number of sites", type: "NUMBER" },
      { entity: "LEAD", label: "Employees in scope", type: "NUMBER" },
      { entity: "LEAD", label: "Transfer from another body", type: "CHECKBOX" },
      { entity: "COMPANY", label: "Scope of certification", type: "LONG_TEXT" },
      { entity: "ORDER", label: "Lead auditor", type: "USER", showInList: true },
      { entity: "ORDER", label: "Audit days", type: "NUMBER" },
      { entity: "ORDER", label: "Certificate number", type: "TEXT", showInList: true },
      { entity: "ORDER", label: "Certificate valid till", type: "DATE" },
      { entity: "ORDER", label: "Accreditation", type: "SELECT", options: ["NABCB", "UKAS", "IAS", "JAS-ANZ", "Non-accredited"] },
    ],
    // Recertifications come round every three years, surveillance audits every year.
    modules: ["orders", "renewals"],
  },
  {
    key: "distribution_trading",
    name: "Distribution and trading",
    summary: "Dealers and wholesalers — from the enquiry and price quote to the order, picked, invoiced and delivered on credit terms.",
    stages: [
      { label: "Enquiry", status: "NEW" },
      { label: "Contacted", status: "CONTACTED" },
      { label: "Requirement confirmed", status: "QUALIFYING" },
      { label: "Price quoted", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "Order confirmed", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not a fit", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Stock checked", status: "APPROVED" },
      { label: "Picked and packed", status: "PROCESSING" },
      { label: "Invoiced", status: "PROCESSING" },
      { label: "Out for delivery", status: "PROCESSING" },
      { label: "Delivered", status: "FULFILLED" },
    ],
    terms: { lead: term("Enquiry", "Enquiries", "an"), customer: term("Dealer", "Dealers"), item: term("Product", "Products") },
    fields: [
      { entity: "LEAD", label: "Product category", type: "TEXT", showInList: true },
      { entity: "LEAD", label: "Monthly volume", type: "NUMBER" },
      { entity: "COMPANY", label: "Credit limit", type: "MONEY", showInList: true },
      { entity: "COMPANY", label: "Credit days", type: "NUMBER" },
      { entity: "COMPANY", label: "Dealer type", type: "SELECT", options: ["Distributor", "Wholesaler", "Retailer", "Institution", "Project buyer"] },
      { entity: "COMPANY", label: "Beat / route", type: "TEXT" },
      { entity: "ITEM", label: "Brand", type: "TEXT", showInList: true },
      { entity: "ITEM", label: "Pack size", type: "TEXT" },
      { entity: "ITEM", label: "Reorder level", type: "NUMBER" },
      { entity: "ORDER", label: "Transporter", type: "TEXT" },
      { entity: "ORDER", label: "LR / docket number", type: "TEXT" },
    ],
    modules: ["orders", "receivables"],
  },
  {
    key: "logistics",
    name: "Logistics and freight",
    summary: "Freight forwarders, transporters and courier companies — rate enquiry to booking, and each shipment from pickup to proof of delivery.",
    stages: [
      { label: "Rate enquiry", status: "NEW" },
      { label: "Contacted", status: "CONTACTED" },
      { label: "Lane details captured", status: "QUALIFYING" },
      { label: "Rates quoted", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "Contract / booking won", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not serviceable", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Booking confirmed", status: "APPROVED" },
      { label: "Picked up", status: "PROCESSING" },
      { label: "In transit", status: "PROCESSING" },
      { label: "Customs cleared", status: "PROCESSING" },
      { label: "Delivered", status: "FULFILLED" },
      { label: "POD received", status: "FULFILLED" },
    ],
    terms: { lead: term("Enquiry", "Enquiries", "an"), customer: term("Shipper", "Shippers"), order: term("Shipment", "Shipments"), item: term("Service", "Services") },
    fields: [
      { entity: "LEAD", label: "Mode", type: "MULTI_SELECT", options: ["Road (FTL)", "Road (PTL)", "Air", "Sea (FCL)", "Sea (LCL)", "Rail", "Courier"], showInList: true },
      { entity: "LEAD", label: "Origin", type: "TEXT", showInList: true },
      { entity: "LEAD", label: "Destination", type: "TEXT", showInList: true },
      { entity: "LEAD", label: "Monthly shipments", type: "NUMBER" },
      { entity: "LEAD", label: "Incoterm", type: "SELECT", options: ["EXW", "FOB", "CIF", "CFR", "DAP", "DDP"] },
      { entity: "ORDER", label: "AWB / BL / LR number", type: "TEXT", showInList: true },
      { entity: "ORDER", label: "Vehicle / container number", type: "TEXT" },
      { entity: "ORDER", label: "Pickup date", type: "DATE" },
      { entity: "ORDER", label: "Expected delivery", type: "DATE" },
      { entity: "ORDER", label: "Chargeable weight (kg)", type: "NUMBER" },
    ],
    modules: ["orders"],
  },
  {
    key: "staffing",
    name: "Staffing and recruitment",
    summary: "Hiring mandates from client companies — from the first call to the agreement, and each mandate through sourcing, interviews and joining.",
    stages: [
      { label: "Lead", status: "NEW" },
      { label: "Contacted", status: "CONTACTED" },
      { label: "Hiring need understood", status: "QUALIFYING" },
      { label: "Proposal / rate card sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "Agreement signed", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not a fit", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Sourcing", status: "PROCESSING" },
      { label: "Profiles shared", status: "PROCESSING" },
      { label: "Interviews", status: "PROCESSING" },
      { label: "Offer made", status: "PROCESSING" },
      { label: "Candidate joined", status: "FULFILLED" },
      { label: "Replacement period over", status: "FULFILLED" },
    ],
    terms: { customer: term("Client", "Clients"), order: term("Mandate", "Mandates"), item: term("Service", "Services") },
    fields: [
      { entity: "LEAD", label: "Hiring type", type: "SELECT", options: ["Permanent", "Contract staffing", "RPO", "Executive search", "Bulk / campus"], showInList: true },
      { entity: "LEAD", label: "Positions", type: "NUMBER" },
      { entity: "LEAD", label: "Functions", type: "TEXT" },
      { entity: "COMPANY", label: "Fee percentage", type: "NUMBER", helpText: "Of annual CTC" },
      { entity: "COMPANY", label: "Replacement period (days)", type: "NUMBER" },
      { entity: "ORDER", label: "Role", type: "TEXT", showInList: true },
      { entity: "ORDER", label: "Openings", type: "NUMBER" },
      { entity: "ORDER", label: "CTC budget", type: "MONEY" },
      { entity: "ORDER", label: "Recruiter", type: "USER", showInList: true },
      { entity: "ORDER", label: "Joining date", type: "DATE" },
    ],
    modules: [],
  },
  {
    key: "professional_services",
    name: "CA, legal and consulting firms",
    summary: "Chartered accountants, law firms and consultants — from the first meeting to the engagement letter, and each engagement to delivery.",
    stages: [
      { label: "Enquiry", status: "NEW" },
      { label: "First meeting", status: "CONTACTED" },
      { label: "Scope discussed", status: "QUALIFYING" },
      { label: "Fee proposal sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "Engagement letter signed", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Conflict / declined", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Documents received", status: "PROCESSING" },
      { label: "Work in progress", status: "PROCESSING" },
      { label: "Partner review", status: "PROCESSING" },
      { label: "Filed / delivered", status: "FULFILLED" },
    ],
    terms: { lead: term("Enquiry", "Enquiries", "an"), customer: term("Client", "Clients"), order: term("Engagement", "Engagements", "an"), item: term("Service", "Services") },
    fields: [
      { entity: "LEAD", label: "Service needed", type: "MULTI_SELECT", options: ["Audit", "Tax", "GST", "Company law / ROC", "Accounting", "Payroll", "Legal advice", "Litigation", "Advisory"], showInList: true },
      { entity: "LEAD", label: "Referred by", type: "TEXT" },
      { entity: "COMPANY", label: "PAN", type: "TEXT" },
      { entity: "COMPANY", label: "CIN / LLPIN", type: "TEXT" },
      { entity: "COMPANY", label: "Year end", type: "SELECT", options: ["31 March", "31 December", "Other"] },
      { entity: "ORDER", label: "Engagement partner", type: "USER", showInList: true },
      { entity: "ORDER", label: "Financial year", type: "TEXT", helpText: "For example 2026-27", showInList: true },
      { entity: "ORDER", label: "Statutory due date", type: "DATE" },
      { entity: "ORDER", label: "Fee type", type: "SELECT", options: ["Fixed", "Hourly", "Retainer", "Success fee"] },
    ],
    // Yearly engagements — audits, returns, retainers — come round again.
    modules: ["renewals"],
  },
  {
    key: "training_education",
    name: "Corporate training",
    summary: "Training companies and institutes selling to businesses — from the training need to the purchase order, and each batch through to certificates.",
    stages: [
      { label: "Enquiry", status: "NEW" },
      { label: "Contacted", status: "CONTACTED" },
      { label: "Training need analysis", status: "QUALIFYING" },
      { label: "Proposal sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "PO received", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not a fit", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Trainer confirmed", status: "APPROVED" },
      { label: "Batch scheduled", status: "PROCESSING" },
      { label: "Training delivered", status: "PROCESSING" },
      { label: "Assessment done", status: "PROCESSING" },
      { label: "Certificates issued", status: "FULFILLED" },
    ],
    terms: { lead: term("Enquiry", "Enquiries", "an"), customer: term("Client", "Clients"), order: term("Batch", "Batches"), item: term("Course", "Courses") },
    fields: [
      { entity: "LEAD", label: "Topic", type: "TEXT", showInList: true },
      { entity: "LEAD", label: "Participants", type: "NUMBER" },
      { entity: "LEAD", label: "Delivery", type: "SELECT", options: ["Classroom", "Online live", "Self-paced", "Blended"], showInList: true },
      { entity: "ITEM", label: "Duration (hours)", type: "NUMBER", showInList: true },
      { entity: "ITEM", label: "Certification body", type: "TEXT" },
      { entity: "ORDER", label: "Trainer", type: "USER", showInList: true },
      { entity: "ORDER", label: "Start date", type: "DATE" },
      { entity: "ORDER", label: "Venue", type: "TEXT" },
      { entity: "ORDER", label: "Feedback score", type: "NUMBER" },
    ],
    modules: [],
  },
  {
    key: "marketing_agencies",
    name: "Marketing and digital agencies",
    summary: "Digital, creative and media agencies — from the brief and pitch to the retainer, and each campaign from strategy to report.",
    stages: [
      { label: "Lead", status: "NEW" },
      { label: "Intro call", status: "CONTACTED" },
      { label: "Brief received", status: "QUALIFYING" },
      { label: "Pitch / proposal sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "Signed", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not a fit", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Onboarding", status: "APPROVED" },
      { label: "Strategy", status: "PROCESSING" },
      { label: "Creatives approved", status: "PROCESSING" },
      { label: "Campaign live", status: "PROCESSING" },
      { label: "Report shared", status: "FULFILLED" },
    ],
    terms: { customer: term("Client", "Clients"), order: term("Campaign", "Campaigns"), item: term("Service", "Services") },
    fields: [
      { entity: "LEAD", label: "Services wanted", type: "MULTI_SELECT", options: ["SEO", "Performance ads", "Social media", "Content", "Website", "Branding", "PR", "Influencer"], showInList: true },
      { entity: "LEAD", label: "Monthly budget", type: "MONEY", showInList: true },
      { entity: "LEAD", label: "Website", type: "URL" },
      { entity: "ORDER", label: "Account manager", type: "USER", showInList: true },
      { entity: "ORDER", label: "Engagement", type: "SELECT", options: ["Retainer", "One-time project", "Performance-based"] },
      { entity: "ORDER", label: "Ad spend (monthly)", type: "MONEY" },
      { entity: "ORDER", label: "Go-live date", type: "DATE" },
    ],
    // Retainers renew every month or year.
    modules: ["renewals"],
  },
  {
    key: "solar_epc",
    name: "Solar and EPC",
    summary: "Rooftop and ground-mount solar, and other EPC contractors — from the site survey to commissioning, net metering and the subsidy.",
    stages: [
      { label: "Enquiry", status: "NEW" },
      { label: "Contacted", status: "CONTACTED" },
      { label: "Site survey", status: "QUALIFYING" },
      { label: "Design and BOQ", status: "QUALIFIED" },
      { label: "Quotation sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "Order confirmed", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not feasible", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Advance received", status: "APPROVED" },
      { label: "Material dispatched", status: "PROCESSING" },
      { label: "Installation", status: "PROCESSING" },
      { label: "Net metering applied", status: "PROCESSING" },
      { label: "Commissioned", status: "FULFILLED" },
      { label: "Subsidy received", status: "FULFILLED" },
    ],
    terms: { lead: term("Enquiry", "Enquiries", "an"), order: term("Project", "Projects"), ticket: term("Service call", "Service calls") },
    fields: [
      { entity: "LEAD", label: "Capacity (kW)", type: "NUMBER", showInList: true },
      { entity: "LEAD", label: "Segment", type: "SELECT", options: ["Residential", "Commercial", "Industrial", "Utility"], showInList: true },
      { entity: "LEAD", label: "Monthly electricity bill", type: "MONEY" },
      { entity: "LEAD", label: "Roof type", type: "SELECT", options: ["RCC", "Metal sheet", "Ground mount", "Carport"] },
      { entity: "LEAD", label: "DISCOM", type: "TEXT" },
      { entity: "ORDER", label: "Site address", type: "LONG_TEXT" },
      { entity: "ORDER", label: "Panel make", type: "TEXT" },
      { entity: "ORDER", label: "Inverter make", type: "TEXT" },
      { entity: "ORDER", label: "Commissioning date", type: "DATE" },
      { entity: "ORDER", label: "Subsidy applicable", type: "CHECKBOX" },
    ],
    modules: [],
  },
  {
    key: "medical_equipment",
    name: "Medical equipment",
    summary: "Dealers and makers selling to hospitals, labs and clinics — from the requirement and demo to the tender or PO, then installation and AMC.",
    stages: [
      { label: "Requirement", status: "NEW" },
      { label: "Contacted", status: "CONTACTED" },
      { label: "Demo / evaluation", status: "QUALIFYING" },
      { label: "Specifications agreed", status: "QUALIFIED" },
      { label: "Quotation / tender submitted", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "PO received", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not a fit", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Ordered from principal", status: "PROCESSING" },
      { label: "Delivered", status: "PROCESSING" },
      { label: "Installed", status: "PROCESSING" },
      { label: "Application training", status: "FULFILLED" },
    ],
    terms: { customer: term("Hospital", "Hospitals"), ticket: term("Service call", "Service calls"), renewal: term("AMC / CMC", "AMCs / CMCs", "an") },
    fields: [
      { entity: "LEAD", label: "Department", type: "SELECT", options: ["Radiology", "ICU", "OT", "Cardiology", "Laboratory", "Dental", "Physiotherapy", "Other"], showInList: true },
      { entity: "LEAD", label: "Buying route", type: "SELECT", options: ["Direct PO", "Tender", "GeM"] },
      { entity: "LEAD", label: "Tender closing date", type: "DATE" },
      { entity: "COMPANY", label: "Beds", type: "NUMBER" },
      { entity: "COMPANY", label: "Ownership", type: "SELECT", options: ["Private", "Government", "Trust / charitable", "Corporate chain"] },
      { entity: "ITEM", label: "Principal / make", type: "TEXT", showInList: true },
      { entity: "ITEM", label: "Device class", type: "SELECT", options: ["A", "B", "C", "D"] },
      { entity: "ORDER", label: "Serial number", type: "TEXT", showInList: true },
      { entity: "ORDER", label: "Installation date", type: "DATE" },
      { entity: "ORDER", label: "Warranty till", type: "DATE" },
    ],
    // After warranty comes the AMC or CMC, every year.
    modules: ["orders", "renewals"],
  },
];

export const TEMPLATE_KEYS = INDUSTRY_TEMPLATES.map((t) => t.key);

export function templateOf(key: unknown): IndustryTemplate | null {
  return INDUSTRY_TEMPLATES.find((t) => t.key === key) ?? null;
}
