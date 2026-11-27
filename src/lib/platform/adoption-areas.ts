import { MODULE_REGISTRY } from "@/lib/modules";

/**
 * The areas of a workspace the console's Adoption tab counts changes in (owner, 23 Nov 2026): each record kind the
 * audit log names (`AuditLog.entityType`) belongs to one. An area is a module where one owns the kind; sales and
 * purchase documents share one table, so they share an area; settings and setup kinds are "setup", and a kind not
 * listed here is counted there too.
 */

const KINDS: Record<string, readonly string[]> = {
  leads: ["Lead", "LeadAssignmentRule", "LeadCaptureKey", "LeadLimitSettings", "LeadPipeline", "LeadStage", "LeadReviewSettings", "WebsiteEnquiry", "AutoPlanSettings", "NurtureReply", "NurtureSettings", "NurtureTouch", "ReengageEmail", "ReengageSettings"],
  companies: ["Company", "CompanyBankAccount", "CompanyLock", "CompanyMergeJob", "CompanyProduct", "CompanyTypeOption", "Contact", "ContactConsent", "ContactVerification", "CustomerCategory"],
  items: ["Item", "ItemCategory", "StockDocument", "Warehouse", "UnitOfMeasure", "Consignment", "Transporter"],
  orders: ["Order", "OrderStep", "OrderRebate", "RebateProgramme"],
  documents: ["TradeDocument", "Proforma", "EwayBill"],
  payables: ["VendorCredit", "VendorStatement", "VendorStatementLine"],
  renewals: ["RenewalSettings"],
  payments: ["Payment", "PaymentFollowUp", "PaymentGateway", "CollectionAgentSettings", "CollectionSettings"],
  accounting: [
    "AccountVoucher", "JournalEntry", "LedgerAccount", "LedgerLock", "BankAccount", "BankReconciliation", "BankStatementLine", "FiscalYearClose", "FixedAsset", "DepreciationCharge",
    "ExchangeRate", "FxRevaluation", "GstRegistration", "ComplianceFiling", "TdsChallan", "TdsStatement", "TdsSettings", "TallyExport", "TallySettings", "AccountsSettings",
    "AccountingSchedule", "AccountingScheduleRun", "OrganisationBankAccount",
  ],
  revenue_close: ["CloseMonth", "CloseTask", "CloseTaskAttachment", "CloseTaskTemplate", "RevenueSchedule", "RevenueCloseSettings", "FluxNote"],
  workspace: ["Workbook", "WorkbookTemplate", "Guest", "ConnectSettings"],
  calls: ["CallLog", "CallRecordingSettings", "TelephonyConnection", "QuickMessage", "QuickTemplate"],
  targets: ["Target"],
  incentives: ["IncentiveEarning", "IncentiveScheme"],
  it_assets: ["Asset", "AssetType"],
  hr: [
    "EmployeeProfile", "EmployeeDocument", "EmployeeLetter", "EmploymentHistory", "AttendanceDay", "AttendanceException", "AttendanceRegularisation", "AttendanceSettings",
    "LeaveBalance", "LeaveRequest", "LeaveType", "LeaveYearSettings", "Holiday", "Shift", "RosterDay", "ShortLeavePolicy", "ShortLeaveRequest", "Resignation", "Candidate",
    "PerformanceReview", "ReviewCycle", "Course", "LetterTemplate", "IdCardSettings", "BiometricDevice", "BiometricPunch", "HrDeskQuestion", "HrDeskSettings", "Department", "Designation",
  ],
  visitors: ["VisitorCompany", "VisitorInvite", "VisitorKiosk"],
  engagement: ["Survey", "SurveyResponse"],
  payroll: ["PayrollRun", "Payslip", "SalaryComponent", "SalaryStructure", "SalarySplitRules", "EmployeeLoan", "FinalSettlement", "TaxDeclaration", "UaeEmployee", "UaePayrollRun", "UaePayslip", "UaeWpsSettings"],
  resellers: ["ResellerItemPrice", "ResellerProfile"],
  commission_parties: ["CommissionPartyAccount"],
  visits: ["Visit"],
  expenses: ["Expense", "ExpenseSettings"],
  automate: ["Automate", "AutomationConnection", "AutomationTemplate", "AutomationWorkflow"],
  tasks: ["Task", "TaskAttachment", "TaskChallenge", "ServiceCycle", "ServiceCycleTemplate", "ServiceJob"],
  calendar: ["CalendarEvent"],
  desks: ["Desk", "DeskRequest", "DeskRequestMessage"],
  notes: ["StickyNote"],
  chat: ["Chat", "ChatExport", "ChatSettings", "WordFilter"],
  marketing: ["Campaign", "MarketingList", "MarketingPolicy", "MarketingSavedBlock", "MarketingTemplate", "MarketingTick", "Audience", "Journey", "Suppression"],
  wins: ["Celebration", "SalesCelebrationSettings", "Prize", "PrizeAnnouncement", "PrizeWinner", "TvScreen"],
  forecast: ["ForecastCommit", "ForecastStageWeight"],
  booking: ["Booking", "BookingPage"],
  forms: ["InboundForm"],
  customer_portal: ["PortalLogin", "PortalSettings"],
  feedback: ["FeedbackRequest", "FeedbackResponse"],
  projects: ["Project", "ProjectBillingMilestone", "ProjectCredential", "ProjectDocument", "ProjectType"],
  vault: ["VaultCredential"],
  cards: ["DigitalCard", "CardCampaign", "CardTemplate"],
  signatures: ["SignatureBanner", "SignatureMailbox", "SignatureSettings", "SignatureTemplate"],
  helpdesk: ["Ticket", "HelpDesk", "SupportMailSettings"],
  inbox: ["InboxBlock", "InboxChannel", "InboxSavedReply", "InboxSettings"],
  reports: ["SavedReport"],
};

export const SETUP_AREA = "setup";

const AREA_OF = new Map(Object.entries(KINDS).flatMap(([area, kinds]) => kinds.map((k) => [k, area] as const)));

/** The area a record kind's changes count under. */
export function areaOf(entityType: string): string {
  return AREA_OF.get(entityType) ?? SETUP_AREA;
}

const OWN_LABELS: Record<string, string> = { documents: "Sales & purchase documents", [SETUP_AREA]: "Settings & setup" };
const MODULE_LABELS = new Map(MODULE_REGISTRY.map((m) => [m.key, m.label]));

export function areaLabel(area: string): string {
  return OWN_LABELS[area] ?? MODULE_LABELS.get(area) ?? area;
}

/** The modules an area stands for: a module switched on whose areas saw no change was not used. */
export function modulesOfArea(area: string): readonly string[] {
  if (area === "documents") return ["sales_documents", "purchase_documents"];
  return MODULE_LABELS.has(area) ? [area] : [];
}

/**
 * Modules whose everyday use the audit log doesn't see — chat and inbox messages, workflow runs, what customers and the
 * public send in — so no changes there isn't no use (their settings still count under the module).
 */
const USE_NOT_AUDITED = new Set(["chat", "inbox", "automate", "customer_portal", "forms"]);

/** A module's changes say whether it is used only where its everyday records are audited — the rest can't be called unused. */
export function moduleIsCounted(key: string): boolean {
  if (USE_NOT_AUDITED.has(key)) return false;
  return key === "sales_documents" || key === "purchase_documents" || key in KINDS;
}
