/**
 * What "Keep my setup" keeps and what it removes (owner, 22 Oct 2026 — src/lib/workspace-reset.ts, the engine
 * in src/lib/data-reset.ts): every table of a workspace is one or the other, named here by its Prisma model.
 *
 * **Setup** is kept: the people and what they may do, the organisation, how documents are numbered, the
 * catalogue, how selling, the books and HR are set up, employees' profiles and salary structures, templates,
 * connections, automations. **Records** go: customers, leads, orders, documents, payments, tickets, tasks,
 * stock, the ledger's entries, HR history (attendance, leave taken, payslips, expense claims, letters), chat,
 * logs. Numbering starts again from 1 — the counters are records, the formats are setup.
 *
 * A table in neither list fails check:data-reset, so a new one can't be wiped, or kept, by accident.
 */

export const SETUP_MODELS = {
  "People and access": [
    "User", "Role", "RolePermission", "RoleAccessLevel", "UserPermission", "UserAccessLevel", "RoleFieldPolicy",
    "UserFieldPolicy", "RoleUnmaskLimit", "UserUnmaskLimit", "FieldMaskingSettings", "UnmaskSettings", "RoleAccessPolicy", "UserAccessPolicy", "IpRule",
    // Lead limits (owner, 12 Nov 2026 — Phase 4, audit H.6): what a role or a person may be given, and the backstop's
    // setting — kept, as the unmask limits are. Their counters (LeadUsage) and the backstop's warnings are records.
    "RoleLeadLimit", "UserLeadLimit", "LeadLimitSettings",
    // Whether leads "as the account" reach the ones people own and made (owner, 26 Nov 2026): kept, as the levels are.
    "RoleLeadReach", "UserLeadReach",
    "SecurityPolicy", "SecuritySettings", "SignInRule", "WorkplaceSettings", "UserDevice", "AppDevice", "UserPhoto",
    // Which Microsoft, Google or Zoho identity each account signs in with: kept with the account it belongs to.
    "UserSsoIdentity",
    "TablePreference", "PageLayout", "NotificationPreference", "DigitalCard",
    // Which menu pages a role doesn't see: part of what the role is.
    "RoleHiddenPage",
  ],
  "The organisation": [
    "OrganisationSettings", "BrandingSettings", "TerminologySettings", "SystemModule", "MaintenanceMode", "Branch",
    "Department", "Designation", "GstRegistration", "OrganisationBankAccount", "HelpDesk", "HelpLink",
  ],
  "Documents and their numbering (the formats — the counters restart)": [
    "DocumentNumberSetting", "DocumentSeries", "DocumentApprovalPolicy", "DocumentMailSettings",
    "DocumentEmailTemplate", "DocumentPrintTemplate",
  ],
  "The catalogue (owner, 22 Oct 2026: kept)": [
    "ItemCategory", "Brand", "ProductFamily", "Item", "ItemUnit", "ItemPrice", "UnitOfMeasure", "Warehouse", "Transporter",
    // The kinds of asset the register offers (Settings › Asset types; its starter rows: data-reset.ts), as the catalogue is.
    "AssetType",
  ],
  "How selling is set up": [
    "Industry", "CompanyTypeOption", "CustomerCategory", "CustomFieldDefinition", "LeadPipeline", "LeadStage", "PipelineAutomation",
    // Required, format, range and unique rules on fields (src/lib/field-rules), as the fields themselves are.
    "FieldRule",
    "OrderStep", "LeadAssignmentRule", "LeadCaptureKey", "ForecastStageWeight", "SalesCelebrationSettings",
    "ActivityAwardSettings", "Target", "IncentiveScheme", "IncentiveSlab", "ProjectType",
    "ProjectTemplateMilestone", "BookingPage", "BookingPageForm",
    // The loyalty tiers' rules (owner, 31 Oct 2026): how selling is judged, not a record of it.
    "LoyaltySettings",
    // How renewals are chased, and the list Installed elsewhere files things under (its starter rows: data-reset.ts).
    "RenewalSettings", "ElsewhereCategoryOption",
    // The template the automatic renewal reminder uses.
    "AutoNoticeTemplate",
    // The business's own telephony account and who's who on it. Its sync point stays, so old calls don't come back.
    "TelephonyConnection", "TelephonyAgent",
    // The workspace's own Apollo.io key (src/lib/apollo).
    "ApolloConnection",
    // Other data providers' keys — Lusha (src/lib/lusha).
    "EnrichmentConnection",
    // Credits per person with Apollo and Lusha (src/lib/enrich/credits.ts).
    "EnrichmentAllowance",
  ],
  "How the books are set up": [
    "ZohoConnection",
    "LedgerAccount", "AccountsSettings", "TallySettings", "TallyMaster", "TallyMapping", "BankAccount", "ExpenseSettings", "RevenueCloseSettings",
    "CloseTaskTemplate", "TdsSettings",
    // The day's exchange rates (owner, 30 Oct 2026): reference figures — some typed by accounts — not transactions.
    "ExchangeRate",
    // The business's own gateway, as a mail connection is, and how it collects. No link or reminder survives the reset:
    // they belong to invoices, which go, so nothing goes out until there are new ones.
    "PaymentGateway", "CollectionSettings",
  ],
  "HR: profiles and policies (owner, 22 Oct 2026: kept; their history goes)": [
    "EmployeeProfile", "EmploymentHistory", "EmployeeDocument", "EmployeeFileVisibility", "SalaryStructure",
    "SalaryComponent", "SalarySplitRules", "LeaveType", "LeaveBalance", "Holiday", "AttendanceSettings", "LeaveYearSettings",
    "ShortLeavePolicy", "LetterTemplate", "BiometricDevice", "FeedbackQuota",
    // UAE payroll: the WPS setup and each person's UAE pay and papers (src/lib/uae).
    "UaeWpsSettings", "UaeEmployee",
    // Shifts and who stands on which (a day's change, RosterDay, is history); courses offered, not who took them;
    // the policies the company holds and who's covered; how ID cards look.
    "Shift", "ShiftAssignment", "Course", "InsurancePolicy", "InsuranceMember", "IdCardSettings",
  ],
  "Mail, calendars, signatures and cards": [
    "MailConnection", "CalendarAccount", "CalendarFeed", "SupportMailSettings", "CustomerEmailSettings",
    "NotificationEmailType", "SignatureTemplate", "SignatureBanner", "SignatureMailbox", "SignatureRule",
    "SignatureSettings", "SignatureOutlook", "CardTemplate",
    // How notification emails read and look (owner, 18 Nov 2026), and the quick email/WhatsApp templates with their files.
    "NotificationEmailWording", "NotificationEmailLayout", "QuickTemplate", "QuickTemplateFile",
    // Who may read whose mailbox, and how far each has been read (owner, 23 Nov 2026 — src/lib/mail-reading).
    "MailReadSettings", "MailReadGrant", "MailReadCursor",
  ],
  "Marketing set-up": [
    "MessagingProvider", "MarketingTemplate", "MarketingAsset", "Audience", "Journey", "JourneyStep", "InboundForm",
    "FormAccessGrant", "MarketingSavedBlock", "FormWebsite", "MarketingPolicy",
  ],
  "Automations (the workflows, not their runs)": [
    // Service cycle plans and the items that start them; the cycles themselves are records (owner, 9 Nov 2026).
    "ServiceCycleTemplate", "ServiceCycleStep", "ItemServicePlan",
    // The internal help desk's desks and what each may be asked for; the requests are records (owner, 25 Nov 2026).
    "Desk", "DeskRequestType",
    // Whether phones send call recordings, and for how long they're kept.
    "CallRecordingSettings",
    // Whether website enquiries wait for review.
    "LeadReviewSettings",
    "AutomationWorkflow", "AutomationVersion", "AutomationTrigger", "AutomationConnection", "AutomationWebhook",
    "AutomationTemplate", "AutomationSettings",
  ],
  "Chat, AI, the portal, devices and keys": [
    "ChatSettings", "WordFilter", "CopilotSettings", "AiTeammateName", "AiHouseStyle", "ReengageSettings", "AutoPlanSettings", "NurtureSettings", "CollectionAgentSettings", "PortalSettings", "ApiKey", "VisitorKiosk", "TvScreen",
    "CredentialTag",
    // The company's own guides the AI answers from.
    "AiKnowledgeFile", "AiKnowledgeChunk", "HrDeskSettings", "HrDeskFile",
    // The customer inbox as it's set up: channels, what their AI reads, saved replies, who is available. Not conversations.
    // Whether the public document search is on.
    "VerifiableSettings",
    "InboxChannel", "InboxSettings", "InboxKnowledgePage", "InboxSavedReply", "InboxAgentStatus",
    // Reports people built, who they're shared with and who starred them, as a page layout is. When last opened goes.
    "SavedReport", "SavedReportShare", "SavedReportFavourite",
  ],
  "Backups, and the record of the reset itself": [
    "Backup", "BackupSchedule", "WorkspaceReset",
  ],
  // Owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.8: kept by every reset, Everything included (src/lib/data-reset.ts
  // `keptTables`) — archived where it is, never emptied; the usage counter (UnmaskUsage) is a record and goes.
  "The unmasking log": [
    "UnmaskEvent",
  ],
} as const;

export const RECORD_MODELS = [
  "AccountVoucher", "AccountVoucherLine", "AccountingSchedule", "AccountingScheduleLine", "AccountsCounter",
  "Activity", "ActivityAward", "ActivityLog", "Announcement", "ApiIdempotency", "AppCallRequest", "AppPairing",
  "ApprovalRequest", "Asset", "AssetMovement", "AttendanceDay", "AttendanceException", "AttendanceLocation",
  "AttendanceRegularisation", "AuditLog", "AutomationEffect", "AutomationEvent", "AutomationEventWait",
  "AutomationRun", "AutomationRunStep", "AutomationUsage", "BankReconciliation", "BankStatementLine",
  "BiometricPunch", "Booking", "BookingDetail", "CalendarEvent", "CallLog", "Campaign", "Candidate", "CardCampaign",
  "CardCampaignMember", "CardContact", "CardEvent", "Celebration", "CelebrationSeen", "Chat", "ChatAttachment",
  "ChatMember", "ChatMessage", "ChatPin", "ChatPresence", "ChatReaction", "CloseMonth", "CloseTask",
  "CloseTaskAttachment", "CommissionPartyAccount", "CommissionPartyLink", "Company", "CompanyBankAccount", "CompanyGroup", "CompanyGroupMember", "ComplianceFiling",
  "CompanyDuplicateDismissal", "CompanyLocation", "CompanyLock", "CompanyMerge", "CompanyMergeJob", "CompanyProduct", "Consignment",
  "Contact", "ContactConsent", "ContactVerification", "CopilotConversation", "CopilotMessage", "CopilotProposal",
  "CopilotUsage", "CredentialReveal", "CreditDecision", "CustomerMailSend", "CreditNoteApplication", "DailyJobRun",
  "DepreciationCharge", "DeskzoDocumentMail", "DocumentCounter", "DocumentRenderGrant", "DomainProfile",
  "EmployeeLetter", "EwayBill", "Expense", "FeedbackRequest", "FeedbackResponse", "FinalSettlement",
  "FiscalYearClose", "FixedAsset", "FluxNote", "FxRevaluation", "ForecastCommit", "FormInvite", "FormSubmission", "GstinCheck", "Handover",
  "HandoverLine", "IncentiveEarning", "InternalFeedback", "ItemBatch", "ItemSerial", "JournalCounter",
  "JournalEntry", "JournalLine", "JourneyEnrolment", "Lead", "LeadRequirement", "LeaveRequest", "LedgerLock",
  "MarketingList", "MarketingListMember", "MarketingMessage", "MarketingTick", "MessageEvent", "Migration", "MigrationBalance",
  "ArchivedDocument", "ArchivedDocumentFile", "ZohoPull", "ZohoPullPage", "TallyExport", "TallyExportRecord", "MigrationAccount", "MigrationFile", "MigrationRecord", "NetworkAddress",
  "Notification", "NotificationEmailClaim", "OldProposal", "OldProposalFile", "OldProposalImport", "OldProposalMade", "OrderExpense", "OrderPriceChange", "OrderRebate", "OrderStepChange", "PastOrderEntry",
  "PasswordResetToken", "Payment", "PaymentAllocation", "PaymentFollowUp", "PayrollRun", "Payslip", "UaePayrollRun", "UaePayslip", "InvoiceWriteOff",
  "PermissionChange", "PortalLogin", "PortalRequest", "Prize", "PrizeAnnouncement", "PrizeWinner", "Project",
  "ProjectBillingMilestone", "ProjectCredential", "ProjectDocument", "ProjectMilestone", "ProjectRisk",
  "ProjectStakeholder", "ProjectUpdate", "Proposal", "PurchaseSaving", "RebateAllocation", "RebateProgramme",
  "RecurringBilling", "RecurringBillingPeriod", "ResellerItemPrice", "ResellerProfile", "RevenueSchedule",
  "RevenueScheduleAdjustment", "RevenueScheduleLine", "ScreenshotAllowance", "ShortLeaveRequest", "SignIn",
  "SignatureClick", "SignatureSync", "StickyNote", "StockBalance", "StockCostLayer", "StockDocument",
  "StockDocumentLine", "StockMovement", "StockReservation", "SupportEmail", "SupportEmailAttachment", "Suppression",
  "Survey", "SurveyAnswer", "SurveyParticipation", "SurveyQuestion", "SurveyResponse", "SurveyTarget", "Task",
  "TaskAttachment", "TaskChallenge", "TaskChecklistItem", "TaskComment", "TaskReminder", "TaskStar", "TaskTimeLog",
  "TaxDeclaration", "TdsCertificate", "TdsChallan", "TdsChallanLink", "TdsStatement", "LegacyImport", "LegacyImportFile", "LegacyImportChunk", "LegacyImportRecord", "LegacyImportError", "LegacyMatch", "Ticket", "TicketComment", "TradeDocument", "TradeDocumentLine", "TvPairing",
  "UnmaskUsage", "UserDailyActivity", "VaultCredential", "VaultPin", "VaultReveal", "VaultShare", "VendorCredit", "VendorTds",
  "VendorCreditApplication", "VendorStatement", "VendorStatementLine", "VendorStatementMapping", "Visit",
  "VisitorCompanion", "VisitorCompany", "VisitorEntry", "VisitorInvite", "Wish", "Workbook", "WorkbookAssignee",
  "WorkbookRecord",
  // Smart Lists' own columns, values, views, row pages and hand-added rows (owner, 20 Nov 2026): they go with the list.
  "WorkbookProperty", "WorkbookValue", "WorkbookView", "WorkbookRowPage", "WorkbookPinnedRow",
  // A list's rows of its own, their values, and its title column's name (owner, 20 Nov 2026): they go with the list.
  "WorkbookRow", "WorkbookRowValue", "WorkbookRowSettings",
  // Phase 2: a view's filters, a Date column's reminders and what they sent, a Files column's files.
  "WorkbookViewQuery", "WorkbookReminder", "WorkbookReminderSent", "WorkbookFile",
  // Phase 3: a row's history and comments, a list's forms, and the company's own list templates.
  "WorkbookRowChange", "WorkbookRowComment", "WorkbookForm", "WorkbookTemplate",
  // Phase 4: who may see and fill in a list, a view's settings, a form's public link and its answers, scheduled rows.
  "WorkbookAccess", "WorkbookMember", "WorkbookViewOptions", "WorkbookPublicForm", "WorkbookFormSubmission", "WorkbookRepeat",
  // Deskzo Connect (owner, 20 Nov 2026): the outside companies, their guests, sign-in codes and sessions, and the lists
  // shared with them — they go with the lists.
  "Connection", "Guest", "GuestCode", "GuestSession", "ListShare",
  // Phase 3: guests' suggestions, comments on list rows, and how the account owner is shown to guests.
  "ListSuggestion", "ListRowComment", "ConnectSettings",
  // Phase 4: what guests did, for the activity report.
  "GuestActivity",
  // Emails guests were sent about a list (20 Nov 2026), for the once-an-hour rule.
  "GuestNotice",
  // A list's own Connect settings (20 Nov 2026) — whether its guests are emailed; they go with the list.
  "WorkbookGuestSettings",
  // A guest's territory and a share's tick column (20 Nov 2026) — they go with the guest and the share.
  "GuestTerritory",
  "ListShareScope",
  "ListShareColumns",
  // Which team a shared comment went to (20 Nov 2026).
  "ListRowCommentAudience",
  // Emails read from people's mailboxes and every agent read of them (23 Nov 2026 — src/lib/mail-reading).
  "MailMessage",
  "MailReadLog",
  // Each customer's history with us (owner, 31 Oct 2026): worked out from the records above, so it goes with them.
  "CustomerStats",
  // Sales and collecting: what happened on leads, invoices and customers.
  "LeadAssignment", "LeadUsage", "LeadLimitWarning", "PaymentLink", "PaymentReminder", "PaymentReminderPause", "DocumentMailThread", "QuoteBillingStage",
  "VisitLocation", "TelephonyCall", "InstalledElsewhere", "ApprovalEvent", "RenderGrant", "RequestKey", "SavedReportView",
  // HR's history (owner, 22 Oct 2026: history goes): reviews and goals with their cycles, leavers, loans (their payslips
  // go too), who took a course, a day's roster.
  "Resignation", "ReviewCycle", "PerformanceReview", "Goal", "CourseAssignment", "EmployeeLoan", "LoanRepayment", "RosterDay",
  // A customer's portal sign-ins, and what's held on records that go.
  "PortalCode", "PortalDevice", "CustomFieldFile", "CustomFieldReveal",
  // Conversations and who they blocked, as Suppression is; a group's picture, with the group.
  "Conversation", "ConversationMessage", "ConversationFile", "ConversationRead", "InboxBlock", "ChatIcon",
  // What a business has issued: its customers go, so these do.
  "VerifiableDocument",
  // What campaigns sent, and what came back.
  "MarketingListReject", "CampaignOption", "AbVariant", "ConsentConfirmation", "EmailPollAnswer",
  // Customers' service cycles and their jobs; which quote line an order came from; the phone's once-keys; website visits.
  "ServiceCycle", "ServiceJob", "QuoteOrderLink", "AppOnceKey", "WebVisitor", "WebPageView",
  // Which proforma an advance was received against — with its payment.
  "ProformaAdvance",
  // Calls' recordings and who listened.
  "CallRecording", "CallRecordingPlay",
  // Website enquiries held for review.
  "WebsiteEnquiry",
  // Lookups made with Apollo.io (src/lib/apollo).
  "EnrichmentLookup",
  // Owner, 18 Nov 2026 — tables added since, each with what it belongs to: a vendor's MSME details (with VendorTds); a
  // notification email held until sending hours; the AI's research on a company; a project's questionnaire rounds, its
  // portal, stages, what it shares and the customer's reviews; a customer not yet told of a new account manager.
  "VendorMsme", "NotificationEmailHeld", "CompanyResearch",
  // A company's CIN or trade licence (20 Nov 2026), which goes with the company.
  "CompanyRegistration",
  // Deskzo AI's "Research & plan" on a lead or company, which goes with it.
  "ResearchPlan",
  // Which leads were planned by itself (with the lead); its switch is the workspace's setup, kept.
  "AutoPlanRun",
  // Leads being nurtured by Deskzo AI and their emails, with the leads.
  "NurtureEnrolment", "NurtureTouch", "NurtureReply",
  // Arjun's chase emails and the replies to them, with the customers they were about.
  "CollectionChase", "CollectionReply", "CollectionAutoRun",
  // What people asked Priya, the HR desk, and the answers.
  "HrDeskQuestion",
  // What people asked the internal help desk, with the conversation and files.
  "DeskRequest", "DeskRequestMessage", "DeskRequestFile", "DeskApproval", "DeskRequestStep",
  // What Arjun read in bank statement lines, with the lines.
  "BankLineGuess",
  // Vendors' bills Arjun read, with the bills made from them.
  "BillReading",
  "ProjectQuestionnaire", "ProjectPortal", "ProjectPortalStage", "ProjectPortalShare", "ProjectStageReview",
  "AccountManagerNotice",
  // What the AI teammates did, for the team strip and Today (src/lib/ai/teammate-work.ts) — about records that go.
  "AiTeammateWork",
  // Teammates' drafts and what became of them, and thumbs up or down (src/lib/ai/drafts.ts) — about records that go.
  "AiDraftRecord", "AiFeedback",
  // Tara's check-ins to quiet customers (src/lib/reengage) — about customers that go.
  "ReengageEmail",
] as const;

/** Every setup model, flat. */
export const SETUP_MODEL_NAMES: readonly string[] = Object.values(SETUP_MODELS).flat();
