/**
 * Smart List templates (owner, 20 Nov 2026 — "add more smart list templates use cases across industry usage as per the
 * industry template admin choose"): ready lists with rows of their own — the columns, a select's choices and the views —
 * for the work teams keep in spreadsheets today. Records only: nothing here fetches or checks anything outside Deskzo
 * (owner: "no automatic link tracker … just to keep records and data").
 *
 * Each template names the industries it suits, by the industry templates' keys (src/lib/industry-templates/catalogue.ts),
 * so the workspace's own industry — the one its admin chose — is offered first; `everyone` ones suit any company. The
 * list a person creates is theirs to change afterwards. Pure and client-safe, so the picker, the action and
 * check:smart-list-own-rows read the same catalogue.
 */

export type TemplateColumnKind = "TEXT" | "NUMBER" | "MONEY" | "DATE" | "SELECT" | "MULTI_SELECT" | "CHECKBOX" | "LINK" | "PERSON" | "RATING" | "EMAIL" | "PHONE" | "COMPANY" | "LEAD" | "CONTACT" | "FILE";

export type TemplateColumn = {
  name: string;
  kind: TemplateColumnKind;
  /** A select's choices, in order. */
  options?: string[];
};

export type TemplateView = {
  name: string;
  kind: "TABLE" | "BOARD" | "CALENDAR";
  /** The column a board groups by (a SELECT) or a calendar places rows by (a DATE). */
  by?: string;
};

/** What a template is for — the picker's sections. */
export type TemplateGroup = "marketing" | "sales" | "operations" | "people" | "projects";

export const TEMPLATE_GROUPS: { key: TemplateGroup; label: string }[] = [
  { key: "marketing", label: "Marketing and SEO" },
  { key: "sales", label: "Sales and partners" },
  { key: "operations", label: "Operations and purchase" },
  { key: "projects", label: "Sites, service and compliance" },
  { key: "people", label: "People and hiring" },
];

export type ListTemplate = {
  key: string;
  name: string;
  description: string;
  group: TemplateGroup;
  /** What the title column of a row is called — "Linking page", "Unit", "Candidate". */
  titleName: string;
  columns: TemplateColumn[];
  /** The views beside the plain table, which every list has. */
  views: TemplateView[];
  /** Industry template keys it suits. */
  industries: string[];
  /** Suits any company, whatever its industry. */
  everyone?: boolean;
};

const STATUS = (...choices: string[]): TemplateColumn => ({ name: "Status", kind: "SELECT", options: choices });
const board = (by = "Status", name = "Board"): TemplateView => ({ name, kind: "BOARD", by });
const calendar = (by: string, name = "Calendar"): TemplateView => ({ name, kind: "CALENDAR", by });

export const LIST_TEMPLATES: ListTemplate[] = [
  // ─── Marketing and SEO ──────────────────────────────────────────────────────────────────────────────────────────
  {
    key: "backlinks",
    name: "Backlink tracker",
    description: "Every link to your site you've earned or paid for — where it is, which page it points to, and whether it's still live, as your team records it.",
    group: "marketing",
    titleName: "Linking page",
    columns: [
      { name: "Linking page URL", kind: "LINK" },
      { name: "Our page", kind: "LINK" },
      { name: "Anchor text", kind: "TEXT" },
      { name: "Domain authority", kind: "NUMBER" },
      { name: "Link type", kind: "SELECT", options: ["Do-follow", "No-follow", "Sponsored", "UGC"] },
      { name: "Source", kind: "SELECT", options: ["Guest post", "Outreach", "Directory", "PR", "Paid", "Other"] },
      STATUS("Pending", "Live", "Lost", "Rejected"),
      { name: "Cost", kind: "MONEY" },
      { name: "Date added", kind: "DATE" },
      { name: "Last checked by hand", kind: "DATE" },
      { name: "Owner", kind: "PERSON" },
    ],
    views: [board()],
    industries: ["marketing_agencies", "it_services", "software_resellers"],
    everyone: true,
  },
  {
    key: "content-calendar",
    name: "Content calendar",
    description: "Articles, posts and videos from idea to published — who writes, when it goes out, and where.",
    group: "marketing",
    titleName: "Title",
    columns: [
      STATUS("Idea", "Writing", "Review", "Scheduled", "Published"),
      { name: "Writer", kind: "PERSON" },
      { name: "Channel", kind: "MULTI_SELECT", options: ["Blog", "LinkedIn", "Instagram", "YouTube", "Newsletter", "X"] },
      { name: "Target keyword", kind: "TEXT" },
      { name: "Publish date", kind: "DATE" },
      { name: "Draft link", kind: "LINK" },
      { name: "Published link", kind: "LINK" },
    ],
    views: [board(), calendar("Publish date")],
    industries: ["marketing_agencies"],
    everyone: true,
  },
  {
    key: "keywords",
    name: "Keyword tracker",
    description: "The searches you want to be found for — volume, difficulty, the page that should rank, and its position as you note it.",
    group: "marketing",
    titleName: "Keyword",
    columns: [
      { name: "Monthly searches", kind: "NUMBER" },
      { name: "Difficulty", kind: "NUMBER" },
      { name: "Intent", kind: "SELECT", options: ["Informational", "Commercial", "Transactional", "Navigational"] },
      { name: "Target page", kind: "LINK" },
      { name: "Position", kind: "NUMBER" },
      { name: "Priority", kind: "RATING" },
      STATUS("To target", "In progress", "Ranking", "Dropped"),
      { name: "Noted on", kind: "DATE" },
    ],
    views: [board()],
    industries: ["marketing_agencies", "it_services"],
    everyone: true,
  },
  {
    key: "guest-posts",
    name: "Guest-post outreach",
    description: "Sites you're pitching for a guest post or a mention — who you wrote to, when, and what came of it.",
    group: "marketing",
    titleName: "Website",
    columns: [
      { name: "Site URL", kind: "LINK" },
      { name: "Contact name", kind: "TEXT" },
      { name: "Contact email", kind: "EMAIL" },
      { name: "Domain authority", kind: "NUMBER" },
      STATUS("To pitch", "Pitched", "Follow-up", "Accepted", "Published", "Declined"),
      { name: "Pitched on", kind: "DATE" },
      { name: "Fee", kind: "MONEY" },
      { name: "Published link", kind: "LINK" },
    ],
    views: [board()],
    industries: ["marketing_agencies"],
    everyone: true,
  },
  {
    key: "influencers",
    name: "Influencer outreach",
    description: "Creators you're working with or approaching — their platform, reach, rate and where the conversation is.",
    group: "marketing",
    titleName: "Creator",
    columns: [
      { name: "Profile link", kind: "LINK" },
      { name: "Platform", kind: "SELECT", options: ["Instagram", "YouTube", "LinkedIn", "X", "Other"] },
      { name: "Followers", kind: "NUMBER" },
      { name: "Rate per post", kind: "MONEY" },
      { name: "Email", kind: "EMAIL" },
      STATUS("Shortlisted", "Contacted", "Negotiating", "Booked", "Posted", "Declined"),
      { name: "Post date", kind: "DATE" },
      { name: "Fit", kind: "RATING" },
    ],
    views: [board(), calendar("Post date")],
    industries: ["marketing_agencies"],
  },
  {
    key: "ad-creatives",
    name: "Creatives for approval",
    description: "Creatives and copy waiting on a client or a manager — the channel, the preview, and who approved it.",
    group: "marketing",
    titleName: "Creative",
    columns: [
      { name: "Client or campaign", kind: "TEXT" },
      { name: "Channel", kind: "SELECT", options: ["Meta", "Google", "LinkedIn", "YouTube", "Print", "Outdoor"] },
      { name: "Preview link", kind: "LINK" },
      STATUS("Draft", "Sent for approval", "Changes asked", "Approved", "Live"),
      { name: "Go-live date", kind: "DATE" },
      { name: "Approved by", kind: "TEXT" },
    ],
    views: [board(), calendar("Go-live date")],
    industries: ["marketing_agencies"],
  },
  {
    key: "client-deliverables",
    name: "Client deliverables",
    description: "What's owed to each client and by when — reports, creatives, sites, filings.",
    group: "marketing",
    titleName: "Deliverable",
    columns: [
      { name: "Client", kind: "TEXT" },
      { name: "Owner", kind: "PERSON" },
      { name: "Due", kind: "DATE" },
      STATUS("Not started", "In progress", "With client", "Approved", "Delivered"),
      { name: "Link", kind: "LINK" },
    ],
    views: [board(), calendar("Due")],
    industries: ["marketing_agencies", "professional_services", "it_services"],
  },
  {
    key: "competitors",
    name: "Competitor tracker",
    description: "Who you lose to and why — their prices, strengths, and what you've heard from customers.",
    group: "marketing",
    titleName: "Competitor",
    columns: [
      { name: "Website", kind: "LINK" },
      { name: "Strengths", kind: "TEXT" },
      { name: "Weaknesses", kind: "TEXT" },
      { name: "Starting price", kind: "MONEY" },
      { name: "Threat", kind: "RATING" },
      { name: "Last reviewed", kind: "DATE" },
    ],
    views: [],
    industries: [],
    everyone: true,
  },

  // ─── Sales and partners ─────────────────────────────────────────────────────────────────────────────────────────
  {
    key: "deal-registrations",
    name: "Deal registrations",
    description: "Deals registered with each OEM or distributor — the registration number, the customer, and when it runs out.",
    group: "sales",
    titleName: "Deal",
    columns: [
      { name: "OEM", kind: "SELECT", options: ["Microsoft", "Google", "Adobe", "Autodesk", "Cisco", "Dell", "HP", "Other"] },
      { name: "Registration number", kind: "TEXT" },
      { name: "End customer", kind: "TEXT" },
      { name: "Products", kind: "TEXT" },
      { name: "Deal value", kind: "MONEY" },
      STATUS("Submitted", "Approved", "Rejected", "Won", "Expired"),
      { name: "Expires on", kind: "DATE" },
      { name: "Owner", kind: "PERSON" },
    ],
    views: [board(), calendar("Expires on", "Expiry calendar")],
    industries: ["software_resellers", "system_integrators", "distribution_trading", "it_services"],
  },
  {
    key: "demos-trials",
    name: "Demos and trials",
    description: "Demos booked and trials or demo units out — who, what, how it went, and the next step.",
    group: "sales",
    titleName: "Customer",
    columns: [
      { name: "Product", kind: "TEXT" },
      { name: "Demo date", kind: "DATE" },
      { name: "Trial ends", kind: "DATE" },
      STATUS("Booked", "Done", "Trial running", "Converted", "Dropped"),
      { name: "Interest", kind: "RATING" },
      { name: "Presenter", kind: "PERSON" },
    ],
    views: [board(), calendar("Demo date")],
    industries: ["software_resellers", "it_services", "medical_equipment"],
  },
  {
    key: "tenders",
    name: "Tender tracker",
    description: "Tenders and RFPs you're bidding for — the portal, the dates, the EMD, and the result.",
    group: "sales",
    titleName: "Tender",
    columns: [
      { name: "Buyer", kind: "TEXT" },
      { name: "Tender number", kind: "TEXT" },
      { name: "Portal link", kind: "LINK" },
      { name: "Estimated value", kind: "MONEY" },
      { name: "EMD", kind: "MONEY" },
      { name: "Pre-bid meeting", kind: "DATE" },
      { name: "Bid due", kind: "DATE" },
      STATUS("Studying", "Bidding", "Submitted", "Technically qualified", "Won", "Lost", "Dropped"),
      { name: "Owner", kind: "PERSON" },
    ],
    views: [board(), calendar("Bid due", "Due dates")],
    industries: ["system_integrators", "it_services", "medical_equipment", "solar_epc", "certification_bodies"],
  },
  {
    key: "channel-partners",
    name: "Channel partners and brokers",
    description: "Partners who bring you business — their terms, what they've brought, and how good they are.",
    group: "sales",
    titleName: "Partner",
    columns: [
      { name: "Contact person", kind: "TEXT" },
      { name: "Phone", kind: "PHONE" },
      { name: "Email", kind: "EMAIL" },
      { name: "City", kind: "TEXT" },
      { name: "Commission %", kind: "NUMBER" },
      { name: "Deals brought", kind: "NUMBER" },
      { name: "Rating", kind: "RATING" },
      STATUS("Prospect", "Active", "Inactive"),
    ],
    views: [board()],
    industries: ["real_estate", "software_resellers", "distribution_trading", "manufacturing", "solar_epc"],
  },
  {
    key: "price-list",
    name: "Supplier price list",
    description: "What each supplier charges for what — kept current, so a quote is priced right.",
    group: "sales",
    titleName: "Item",
    columns: [
      { name: "Supplier", kind: "TEXT" },
      { name: "Part number", kind: "TEXT" },
      { name: "Cost price", kind: "MONEY" },
      { name: "List price", kind: "MONEY" },
      { name: "Valid till", kind: "DATE" },
      { name: "Notes", kind: "TEXT" },
    ],
    views: [],
    industries: ["software_resellers", "distribution_trading", "manufacturing", "system_integrators", "medical_equipment", "solar_epc"],
  },

  // ─── Operations and purchase ────────────────────────────────────────────────────────────────────────────────────
  {
    key: "vendor-comparison",
    name: "Vendor comparison",
    description: "Quotes from several vendors side by side before you choose — price, delivery, terms and how you rate them.",
    group: "operations",
    titleName: "Vendor",
    columns: [
      { name: "For", kind: "TEXT" },
      { name: "Quoted price", kind: "MONEY" },
      { name: "Delivery days", kind: "NUMBER" },
      { name: "Payment terms", kind: "TEXT" },
      { name: "Rating", kind: "RATING" },
      { name: "Chosen", kind: "CHECKBOX" },
    ],
    views: [],
    industries: [],
    everyone: true,
  },
  {
    key: "contract-renewals",
    name: "AMCs and contract renewals",
    description: "Maintenance contracts, leases, licences and service agreements you pay for — what they cost and when they renew.",
    group: "operations",
    titleName: "Contract",
    columns: [
      { name: "Vendor", kind: "TEXT" },
      { name: "Covers", kind: "TEXT" },
      { name: "Annual cost", kind: "MONEY" },
      { name: "Starts", kind: "DATE" },
      { name: "Renews on", kind: "DATE" },
      STATUS("Active", "Renewal due", "Renewed", "Cancelled"),
      { name: "Owner", kind: "PERSON" },
    ],
    views: [calendar("Renews on", "Renewals"), board()],
    industries: [],
    everyone: true,
  },
  {
    key: "subscriptions",
    name: "Software subscriptions",
    description: "Every tool the company pays for — seats, cost, who owns it, and when it renews.",
    group: "operations",
    titleName: "Tool",
    columns: [
      { name: "Plan", kind: "TEXT" },
      { name: "Seats", kind: "NUMBER" },
      { name: "Monthly cost", kind: "MONEY" },
      { name: "Billing", kind: "SELECT", options: ["Monthly", "Yearly"] },
      { name: "Renews on", kind: "DATE" },
      { name: "Owner", kind: "PERSON" },
      { name: "Sign-in page", kind: "LINK" },
    ],
    views: [calendar("Renews on", "Renewals")],
    industries: [],
    everyone: true,
  },
  {
    key: "it-assets",
    name: "IT asset register",
    description: "Laptops, licences and devices — who has each, its serial number, and when its warranty ends.",
    group: "operations",
    titleName: "Asset tag",
    columns: [
      { name: "Type", kind: "SELECT", options: ["Laptop", "Desktop", "Phone", "Monitor", "Printer", "Network", "Licence", "Other"] },
      { name: "Make and model", kind: "TEXT" },
      { name: "Serial number", kind: "TEXT" },
      { name: "Assigned to", kind: "PERSON" },
      { name: "Bought on", kind: "DATE" },
      { name: "Warranty till", kind: "DATE" },
      STATUS("In use", "In stock", "Under repair", "Retired"),
      { name: "Cost", kind: "MONEY" },
    ],
    views: [board(), calendar("Warranty till", "Warranty ends")],
    industries: ["it_services", "system_integrators"],
    everyone: true,
  },
  {
    key: "event-checklist",
    name: "Event checklist",
    description: "Everything an event, launch or dealer meet needs, who's on it and by when — venue, vendors, travel, print, follow-ups.",
    group: "operations",
    titleName: "Task",
    columns: [
      { name: "Area", kind: "SELECT", options: ["Venue", "Vendors", "Travel", "Print", "Speakers", "Guests", "Follow-up"] },
      { name: "Owner", kind: "PERSON" },
      { name: "Due", kind: "DATE" },
      STATUS("To do", "In progress", "Done", "Blocked"),
      { name: "Cost", kind: "MONEY" },
    ],
    views: [board(), calendar("Due")],
    industries: ["training_education", "distribution_trading"],
    everyone: true,
  },
  {
    key: "guest-list",
    name: "Guest list",
    description: "Who's invited, who's coming, and what they need — for an event, a launch or a dealer meet.",
    group: "operations",
    titleName: "Guest",
    columns: [
      { name: "Company", kind: "TEXT" },
      { name: "Phone", kind: "PHONE" },
      { name: "Email", kind: "EMAIL" },
      { name: "RSVP", kind: "SELECT", options: ["Invited", "Coming", "Maybe", "Not coming", "Attended"] },
      { name: "Travel needed", kind: "CHECKBOX" },
      { name: "Stay needed", kind: "CHECKBOX" },
    ],
    views: [{ name: "RSVPs", kind: "BOARD", by: "RSVP" }],
    industries: ["training_education", "distribution_trading"],
  },
  {
    key: "shipments",
    name: "Shipment tracker",
    description: "Consignments in transit — the transporter, the docket number, and where each one is, as you hear.",
    group: "operations",
    titleName: "Consignment",
    columns: [
      { name: "Docket / LR number", kind: "TEXT" },
      { name: "Transporter", kind: "TEXT" },
      { name: "From", kind: "TEXT" },
      { name: "To", kind: "TEXT" },
      { name: "Dispatched on", kind: "DATE" },
      { name: "Expected on", kind: "DATE" },
      STATUS("Booked", "In transit", "Delivered", "Delayed", "Damaged"),
      { name: "Freight", kind: "MONEY" },
    ],
    views: [board(), calendar("Expected on")],
    industries: ["logistics", "distribution_trading", "manufacturing"],
  },
  {
    key: "transporter-rates",
    name: "Transporter rate card",
    description: "What each transporter charges on each route — compared before you book.",
    group: "operations",
    titleName: "Route",
    columns: [
      { name: "Transporter", kind: "TEXT" },
      { name: "Vehicle", kind: "SELECT", options: ["Tempo", "Pickup", "14 ft", "19 ft", "32 ft", "Container", "Courier"] },
      { name: "Rate", kind: "MONEY" },
      { name: "Transit days", kind: "NUMBER" },
      { name: "Valid till", kind: "DATE" },
      { name: "Phone", kind: "PHONE" },
    ],
    views: [],
    industries: ["logistics", "distribution_trading", "manufacturing"],
  },
  {
    key: "vehicle-documents",
    name: "Vehicle papers",
    description: "Each vehicle's insurance, permit, fitness and PUC — and when each runs out.",
    group: "operations",
    titleName: "Vehicle number",
    columns: [
      { name: "Type", kind: "SELECT", options: ["Truck", "Trailer", "Tempo", "Car", "Two-wheeler"] },
      { name: "Driver", kind: "TEXT" },
      { name: "Driver phone", kind: "PHONE" },
      { name: "Insurance till", kind: "DATE" },
      { name: "Permit till", kind: "DATE" },
      { name: "Fitness till", kind: "DATE" },
      { name: "PUC till", kind: "DATE" },
      STATUS("On road", "In workshop", "Idle", "Sold"),
    ],
    views: [calendar("Insurance till", "Insurance"), board()],
    industries: ["logistics"],
  },
  {
    key: "machine-maintenance",
    name: "Machine maintenance log",
    description: "Each machine's servicing — when it was done, what was found, and when it's due next.",
    group: "operations",
    titleName: "Machine",
    columns: [
      { name: "Line or location", kind: "TEXT" },
      { name: "Last service", kind: "DATE" },
      { name: "Next due", kind: "DATE" },
      { name: "Done by", kind: "TEXT" },
      { name: "Findings", kind: "TEXT" },
      STATUS("Running", "Due", "Under repair", "Down"),
      { name: "Cost", kind: "MONEY" },
    ],
    views: [calendar("Next due", "Due dates"), board()],
    industries: ["manufacturing"],
  },
  {
    key: "quality-issues",
    name: "Quality issues (NCR)",
    description: "Non-conformities found on the line, by a customer or in an audit — the cause, the fix, and when it was closed.",
    group: "operations",
    titleName: "Issue",
    columns: [
      { name: "Product, batch or client", kind: "TEXT" },
      { name: "Found by", kind: "SELECT", options: ["In-house QC", "Customer", "Supplier", "Audit"] },
      { name: "Severity", kind: "SELECT", options: ["Minor", "Major", "Critical"] },
      { name: "Root cause", kind: "TEXT" },
      { name: "Action taken", kind: "TEXT" },
      { name: "Owner", kind: "PERSON" },
      STATUS("Open", "Investigating", "Fixed", "Closed"),
      { name: "Raised on", kind: "DATE" },
    ],
    views: [board()],
    industries: ["manufacturing", "certification_bodies"],
  },
  {
    key: "supplier-audits",
    name: "Supplier audits",
    description: "Audits of your suppliers — when, the score, what needs fixing and by when.",
    group: "operations",
    titleName: "Supplier",
    columns: [
      { name: "Audit date", kind: "DATE" },
      { name: "Score", kind: "NUMBER" },
      { name: "Rating", kind: "RATING" },
      { name: "Findings", kind: "TEXT" },
      { name: "Fix by", kind: "DATE" },
      STATUS("Scheduled", "Done", "Fixes pending", "Approved", "Dropped"),
    ],
    views: [calendar("Audit date")],
    industries: ["manufacturing"],
  },
  {
    key: "samples",
    name: "Sample tracker",
    description: "Samples sent to customers or received from suppliers — what, when, and what they said.",
    group: "operations",
    titleName: "Sample",
    columns: [
      { name: "For", kind: "TEXT" },
      { name: "Direction", kind: "SELECT", options: ["Sent", "Received"] },
      { name: "Sent on", kind: "DATE" },
      { name: "Feedback", kind: "TEXT" },
      STATUS("Sent", "Received", "Approved", "Rejected", "Re-sample"),
    ],
    views: [board()],
    industries: ["manufacturing", "distribution_trading"],
  },

  // ─── Sites, service and compliance ──────────────────────────────────────────────────────────────────────────────
  {
    key: "unit-inventory",
    name: "Unit inventory",
    description: "Every unit in a project — tower, floor, size, price, and whether it's open, held or sold.",
    group: "projects",
    titleName: "Unit",
    columns: [
      { name: "Project", kind: "TEXT" },
      { name: "Tower", kind: "TEXT" },
      { name: "Floor", kind: "NUMBER" },
      { name: "Type", kind: "SELECT", options: ["1 BHK", "2 BHK", "3 BHK", "4 BHK", "Villa", "Plot", "Shop", "Office"] },
      { name: "Carpet area (sq ft)", kind: "NUMBER" },
      { name: "Price", kind: "MONEY" },
      { name: "Facing", kind: "SELECT", options: ["East", "West", "North", "South"] },
      STATUS("Available", "On hold", "Booked", "Sold"),
      { name: "Buyer", kind: "TEXT" },
    ],
    views: [board()],
    industries: ["real_estate"],
  },
  {
    key: "site-visits",
    name: "Site visits",
    description: "Buyers coming to see a project — who's coming, who shows them around, and how it went.",
    group: "projects",
    titleName: "Visitor",
    columns: [
      { name: "Phone", kind: "PHONE" },
      { name: "Project", kind: "TEXT" },
      { name: "Visit date", kind: "DATE" },
      { name: "Shown by", kind: "PERSON" },
      { name: "Source", kind: "SELECT", options: ["Walk-in", "Broker", "Website", "Ads", "Referral"] },
      STATUS("Booked", "Visited", "No-show", "Interested", "Not interested"),
      { name: "Interest", kind: "RATING" },
    ],
    views: [calendar("Visit date"), board()],
    industries: ["real_estate"],
  },
  {
    key: "site-surveys",
    name: "Site surveys",
    description: "Surveys before a quote — the site, what was found, the load or the bill of material, and who went.",
    group: "projects",
    titleName: "Site",
    columns: [
      { name: "Customer", kind: "TEXT" },
      { name: "Address", kind: "TEXT" },
      { name: "Contact phone", kind: "PHONE" },
      { name: "Survey date", kind: "DATE" },
      { name: "Surveyed by", kind: "PERSON" },
      { name: "Findings", kind: "TEXT" },
      { name: "Photos link", kind: "LINK" },
      STATUS("To schedule", "Scheduled", "Done", "Quote sent"),
    ],
    views: [calendar("Survey date"), board()],
    industries: ["solar_epc", "system_integrators"],
  },
  {
    key: "snag-list",
    name: "Snag list",
    description: "Defects found at a site or a handover — where, what, who fixes it, and when it was closed.",
    group: "projects",
    titleName: "Snag",
    columns: [
      { name: "Site", kind: "TEXT" },
      { name: "Location", kind: "TEXT" },
      { name: "Trade", kind: "SELECT", options: ["Civil", "Electrical", "Plumbing", "Carpentry", "Painting", "HVAC", "Cabling", "Other"] },
      { name: "Assigned to", kind: "TEXT" },
      { name: "Raised on", kind: "DATE" },
      { name: "Fix by", kind: "DATE" },
      STATUS("Open", "In progress", "Fixed", "Verified"),
      { name: "Photo link", kind: "LINK" },
    ],
    views: [board(), calendar("Fix by")],
    industries: ["real_estate", "solar_epc", "system_integrators"],
  },
  {
    key: "material-orders",
    name: "Material for sites",
    description: "Material each site asked for — what, how much, from whom, and whether it has arrived.",
    group: "projects",
    titleName: "Material",
    columns: [
      { name: "Site", kind: "TEXT" },
      { name: "Quantity", kind: "NUMBER" },
      { name: "Unit", kind: "SELECT", options: ["Nos", "Metres", "Kg", "Tonnes", "Sq ft", "Boxes", "Sets"] },
      { name: "Supplier", kind: "TEXT" },
      { name: "Needed by", kind: "DATE" },
      STATUS("Requested", "Ordered", "Delivered", "Short"),
      { name: "Amount", kind: "MONEY" },
    ],
    views: [board(), calendar("Needed by")],
    industries: ["solar_epc", "system_integrators", "real_estate"],
  },
  {
    key: "net-metering",
    name: "Net-metering applications",
    description: "Each rooftop's application with the electricity board — the number, the inspection, the meter and the subsidy, as they move.",
    group: "projects",
    titleName: "Customer",
    columns: [
      { name: "DISCOM", kind: "TEXT" },
      { name: "Capacity (kW)", kind: "NUMBER" },
      { name: "Application number", kind: "TEXT" },
      { name: "Applied on", kind: "DATE" },
      { name: "Inspection date", kind: "DATE" },
      STATUS("Documents pending", "Applied", "Inspection due", "Meter installed", "Subsidy claimed", "Subsidy received"),
      { name: "Subsidy amount", kind: "MONEY" },
    ],
    views: [board(), calendar("Inspection date", "Inspections")],
    industries: ["solar_epc"],
  },
  {
    key: "installed-equipment",
    name: "Installed equipment and service",
    description: "Equipment you've installed at customers' sites — serial number, warranty, and when the next preventive service is due.",
    group: "projects",
    titleName: "Equipment",
    columns: [
      { name: "Customer", kind: "TEXT" },
      { name: "Serial number", kind: "TEXT" },
      { name: "Installed on", kind: "DATE" },
      { name: "Warranty till", kind: "DATE" },
      { name: "Next service due", kind: "DATE" },
      { name: "Engineer", kind: "PERSON" },
      STATUS("Working", "Service due", "Under repair", "Out of service"),
      { name: "Under AMC", kind: "CHECKBOX" },
    ],
    views: [calendar("Next service due", "Service due"), board()],
    industries: ["medical_equipment", "system_integrators", "solar_epc", "manufacturing"],
  },
  {
    key: "audit-schedule",
    name: "Audit schedule",
    description: "Client audits to plan and run — the standard, the stage, the auditor and the day.",
    group: "projects",
    titleName: "Client",
    columns: [
      { name: "Standard", kind: "SELECT", options: ["ISO 9001", "ISO 14001", "ISO 45001", "ISO 27001", "ISO 22000", "Other"] },
      { name: "Audit type", kind: "SELECT", options: ["Stage 1", "Stage 2", "Surveillance", "Recertification", "Special"] },
      { name: "Lead auditor", kind: "PERSON" },
      { name: "Audit date", kind: "DATE" },
      { name: "Man-days", kind: "NUMBER" },
      STATUS("To plan", "Planned", "Done", "Report sent", "Closed"),
    ],
    views: [calendar("Audit date"), board()],
    industries: ["certification_bodies"],
  },
  {
    key: "certificates-issued",
    name: "Certificates issued",
    description: "Certificates you've issued — the number, the standard, and when each expires or needs its surveillance audit.",
    group: "projects",
    titleName: "Certificate number",
    columns: [
      { name: "Client", kind: "TEXT" },
      { name: "Standard", kind: "SELECT", options: ["ISO 9001", "ISO 14001", "ISO 45001", "ISO 27001", "ISO 22000", "Other"] },
      { name: "Issued on", kind: "DATE" },
      { name: "Next surveillance", kind: "DATE" },
      { name: "Expires on", kind: "DATE" },
      STATUS("Valid", "Suspended", "Withdrawn", "Expired"),
    ],
    views: [calendar("Expires on", "Expiries"), board()],
    industries: ["certification_bodies"],
  },
  {
    key: "compliance-calendar",
    name: "Client compliance calendar",
    description: "Each client's filings and due dates — GST, TDS, ROC, audits — who's on it, and whether it's filed.",
    group: "projects",
    titleName: "Filing",
    columns: [
      { name: "Client", kind: "TEXT" },
      { name: "Type", kind: "SELECT", options: ["GST return", "TDS return", "Income tax", "ROC filing", "Audit", "Payroll", "Other"] },
      { name: "Period", kind: "TEXT" },
      { name: "Due on", kind: "DATE" },
      { name: "Assigned to", kind: "PERSON" },
      STATUS("Pending documents", "In progress", "Filed", "Late"),
      { name: "Acknowledgement number", kind: "TEXT" },
    ],
    views: [calendar("Due on", "Due dates"), board()],
    industries: ["professional_services"],
  },
  {
    key: "document-checklist",
    name: "Document checklist",
    description: "Documents to collect from each client or candidate — what's asked for, what's come, and what's missing.",
    group: "projects",
    titleName: "Document",
    columns: [
      { name: "From", kind: "TEXT" },
      { name: "For", kind: "TEXT" },
      { name: "Asked on", kind: "DATE" },
      STATUS("Asked", "Received", "Incomplete", "Not needed"),
      { name: "Received on", kind: "DATE" },
    ],
    views: [board()],
    industries: ["professional_services", "staffing", "certification_bodies"],
  },

  // ─── People and hiring ──────────────────────────────────────────────────────────────────────────────────────────
  {
    key: "candidates",
    name: "Candidate pipeline",
    description: "Candidates for an opening, stage by stage — from sourced to joined.",
    group: "people",
    titleName: "Candidate",
    columns: [
      { name: "Opening", kind: "TEXT" },
      { name: "Phone", kind: "PHONE" },
      { name: "Email", kind: "EMAIL" },
      { name: "Experience (years)", kind: "NUMBER" },
      { name: "Expected CTC", kind: "MONEY" },
      STATUS("Sourced", "Screened", "Interview", "Offer", "Joined", "Rejected"),
      { name: "Interview date", kind: "DATE" },
      { name: "Resume link", kind: "LINK" },
      { name: "Recruiter", kind: "PERSON" },
    ],
    views: [board(), calendar("Interview date", "Interviews")],
    industries: ["staffing"],
    everyone: true,
  },
  {
    key: "openings",
    name: "Openings",
    description: "Roles you're hiring for, or filling for clients — how many, the budget, and how far along.",
    group: "people",
    titleName: "Role",
    columns: [
      { name: "Client or team", kind: "TEXT" },
      { name: "Positions", kind: "NUMBER" },
      { name: "Budget (CTC)", kind: "MONEY" },
      { name: "Location", kind: "TEXT" },
      STATUS("Open", "On hold", "Filled", "Closed"),
      { name: "Opened on", kind: "DATE" },
    ],
    views: [board()],
    industries: ["staffing"],
  },
  {
    key: "training-sessions",
    name: "Training sessions",
    description: "Sessions running and coming up — the client, the trainer, the dates, and seats filled.",
    group: "people",
    titleName: "Session",
    columns: [
      { name: "Client", kind: "TEXT" },
      { name: "Course", kind: "TEXT" },
      { name: "Trainer", kind: "TEXT" },
      { name: "Starts", kind: "DATE" },
      { name: "Mode", kind: "SELECT", options: ["Classroom", "Online", "Blended"] },
      { name: "Participants", kind: "NUMBER" },
      STATUS("Planned", "Confirmed", "Running", "Completed", "Cancelled"),
      { name: "Fee", kind: "MONEY" },
    ],
    views: [calendar("Starts"), board()],
    industries: ["training_education"],
  },
  {
    key: "trainer-pool",
    name: "Trainer pool",
    description: "Trainers you can call on — what they teach, their day rate, and how participants rated them.",
    group: "people",
    titleName: "Trainer",
    columns: [
      { name: "Subjects", kind: "MULTI_SELECT", options: ["Sales", "Leadership", "Communication", "Technical", "Compliance", "Soft skills"] },
      { name: "Phone", kind: "PHONE" },
      { name: "Email", kind: "EMAIL" },
      { name: "Day rate", kind: "MONEY" },
      { name: "City", kind: "TEXT" },
      { name: "Rating", kind: "RATING" },
      STATUS("Available", "Busy", "Not working with us"),
    ],
    views: [board()],
    industries: ["training_education"],
  },
  {
    key: "goals",
    name: "Goals tracker",
    description: "The quarter's goals — who owns each, how far along, and by when.",
    group: "people",
    titleName: "Goal",
    columns: [
      { name: "Owner", kind: "PERSON" },
      { name: "Target", kind: "NUMBER" },
      { name: "Achieved", kind: "NUMBER" },
      { name: "Due", kind: "DATE" },
      STATUS("Not started", "On track", "At risk", "Done"),
    ],
    views: [board()],
    industries: [],
    everyone: true,
  },
];

/** A template by its key. */
export const templateByKey = (key: unknown): ListTemplate | null => LIST_TEMPLATES.find((t) => t.key === key) ?? null;

/**
 * The templates as the picker offers them: those suiting the workspace's industry first — or, with no industry chosen,
 * the ones for everyone — then every other one in its group. `industry` is an industry template key, or null.
 */
export function templatesFor(industry: string | null): { suggested: ListTemplate[]; groups: { key: TemplateGroup; label: string; templates: ListTemplate[] }[] } {
  const own = industry ? LIST_TEMPLATES.filter((t) => t.industries.includes(industry)) : [];
  const suggested = own.length ? own : LIST_TEMPLATES.filter((t) => t.everyone);
  const shown = new Set(suggested.map((t) => t.key));
  return {
    suggested,
    groups: TEMPLATE_GROUPS.map((g) => ({ ...g, templates: LIST_TEMPLATES.filter((t) => t.group === g.key && !shown.has(t.key)) })).filter((g) => g.templates.length > 0),
  };
}

const GREEN = /^(live|won|done|approved|delivered|published|posted|joined|sold|available|active|valid|working|running|filed|verified|fixed|closed|completed|converted|ranking|received|accepted|attended|coming|chosen|in use|renewed|on road|meter installed|subsidy received|report sent|filled|on track|quote sent|ordered|confirmed)$/i;
const RED = /^(lost|rejected|dropped|declined|expired|cancelled|down|damaged|late|withdrawn|no-show|not interested|out of service|critical|blocked|not coming|retired|sold out|inactive|not working with us|short)$/i;
const AMBER = /^(pending|waiting|on hold|due|delayed|follow-up|changes asked|at risk|under repair|suspended|major|maybe|service due|renewal due|fixes pending|in workshop|documents pending|pending documents|incomplete|inspection due|busy|re-sample|idle|asked|trial running|subsidy claimed)$/i;
const BLUE = /^(in progress|writing|review|scheduled|submitted|in transit|interview|pitched|contacted|negotiating|booked|planned|bidding|sent for approval|screened|investigating|applied|offer|shortlisted|with client|technically qualified|studying|to schedule|requested|sent|invited|counselled|open|to plan)$/i;

/** A select's choices as a template makes them: coloured by what they mean — done green, lost red, waiting amber. */
export function templateOptions(choices: string[]): { name: string; color: "gray" | "blue" | "green" | "amber" | "red" | "purple" | "pink" }[] {
  const cycle = ["blue", "purple", "pink", "gray"] as const;
  let n = 0;
  return choices.map((name) => ({
    name,
    color: GREEN.test(name) ? "green" : RED.test(name) ? "red" : AMBER.test(name) ? "amber" : BLUE.test(name) ? "blue" : cycle[n++ % cycle.length]!,
  }));
}
