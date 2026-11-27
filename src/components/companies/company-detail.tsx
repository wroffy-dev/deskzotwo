import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { CompanyServiceCycles } from "@/components/service-cycles/service-cycle-cards";
import { InTheseLists } from "@/components/smart-lists/in-these-lists";
import { notFound } from "next/navigation";
import { ScheduleMeetingButton } from "@/components/calendar/schedule-meeting-button";
import { RecordMeetings } from "@/components/calendar/record-meetings";
import {
  getCompany,
  listAssignableUsers,
  listVendorOptions,
  listClientCompanyNameOptions,
  listEndCustomers,
  updateCompanyCustomFields,
} from "@/actions/company";
import {
  listLinkedCompanies,
  listCommissionPartyAccounts,
  listCompanyCommissionParties,
  listCompanyCommissions,
  listCommissionPartyOptions,
  listCommissionPartyEarnings,
} from "@/actions/commission-party";
import { listCompanyDocuments } from "@/actions/trade-document";
import { listCompanyVisits } from "@/actions/visit";
import { customerStatement } from "@/actions/receivable";
import { expenseSummary } from "@/actions/expense";
import { listCompanyPayments, companyPaymentSummary } from "@/actions/payment";
import { companyFieldEntity, holdsBankAccounts } from "@/lib/validation/company";
import { listCompanyBankAccounts } from "@/actions/company-bank";
import { BankAccountsManager } from "@/components/banking/bank-accounts-manager";
import { NO_DIRECT_CONTACT_NOTICE } from "@/lib/reseller";
import { getResellerOnboarding, getResellerCreditSummary, listResellerItemPrices } from "@/actions/reseller";
import { onboardingChecklist, isOnboardingComplete } from "@/lib/reseller-onboarding";
import { ResellerOnboardingPanel } from "@/components/companies/reseller-onboarding-panel";
import { ResellerPricingManager } from "@/components/companies/reseller-pricing-manager";
import { ResellerQuoteRequests } from "@/components/quote-requests/reseller-requests";
import { resellerRequests } from "@/lib/quote-requests";
import { Lock } from "lucide-react";
import { isModuleEnabled, moduleAccess } from "@/actions/module";
import { canBroadcastNotes } from "@/actions/note";
import { RecordNotes } from "@/components/notes/record-notes";
import { listItemOptions } from "@/actions/item";
import { listTickets } from "@/actions/ticket";
import { estateCount } from "@/actions/it-asset";
import { listTasks } from "@/actions/task";
import { listProjects } from "@/actions/project";
import { CompanyProjects } from "@/components/companies/company-projects";
import { getCreditProfile } from "@/actions/credit";
import { CompanyCredit } from "@/components/credit/company-credit";
import { CreditBadge } from "@/components/credit/credit-badge";
import { getSupportLoad } from "@/actions/support-load";
import { companyMailSummary, listMailLog } from "@/actions/mail-log";
import { CompanyEmails } from "@/components/mail-log/company-emails";
import { CompanyForms } from "@/components/forms/company-forms";
import { companyFormResponses } from "@/actions/forms";
import { SupportLevelBadge, SupportLoadPanel } from "@/components/support/support-load-panel";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { mayChangeAccountManager, mayChangeCaller, mayLeaveUnassigned, reassignRights } from "@/lib/authz/reassign";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TabRow } from "@/components/ui/tab-row";
import { CompanyPortalPanel } from "@/components/portal/company-portal-panel";
import { portalLogins, portalStatusFor } from "@/actions/portal";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { customerStanding } from "@/lib/customers/lapsed";
import { historyOfCompanies } from "@/lib/customers/stats";
import { HistoryCard } from "@/components/customers/customer-history";
import { workspaceClock } from "@/lib/time/workspace";
import { ContactsList, type ContactCustomFields } from "@/components/companies/contacts-list";
import { leftContactsOf } from "@/lib/contacts/left";
import { unconfirmedAmong, unconfirmedFromLabel } from "@/lib/contacts/unconfirmed";
import { designationNamesOf } from "@/lib/contacts/designations";
import { contactMovesOf } from "@/lib/contacts/moves";
import { CustomFieldsCard } from "@/components/custom-fields/custom-fields-card";
import { EditCustomFields } from "@/components/custom-fields/edit-custom-fields";
import { displayFields, formatMany, formSetup, valuesFor, valuesOf } from "@/lib/custom-fields/server";
import { companyMasker, hiddenCustomKeys, pendingCompanyReveal } from "@/lib/companies/masking";
import { CompanyReveal } from "@/components/companies/company-reveal";
import { formValues } from "@/lib/custom-fields/rules";
import { PastOrderButton } from "@/components/companies/past-order-dialog";
import { CompanyProductsList } from "@/components/companies/company-products-list";
import { orderPaperwork } from "@/lib/orders/paperwork";
import { LocationsManager } from "@/components/companies/locations-manager";
import { GstinBadge } from "@/components/companies/gstin-badge";
import { savedGstinChecks } from "@/lib/gstin/lookup";
import type { GstinCheckView } from "@/lib/gstin/notes";
import { AccountManagerButton } from "@/components/companies/account-manager-button";
import { RenewalManagerButton } from "@/components/companies/renewal-manager-button";
import { CompanyMoreMenu } from "@/components/companies/company-more-menu";
import { faviconOf } from "@/lib/domain-intel/favicon";
import { renewalManagersHere, renewalManagersOf } from "@/lib/companies/renewal-manager";
import { CallerButton } from "@/components/companies/caller-button";
import { CallButton } from "@/components/calls/call-button";
import { CustomerNoticeButton } from "@/components/marketing/customer-notice-button";
import { RenewButton } from "@/components/renewals/renew-button";
import { viewerRenewalActions } from "@/lib/renewal-actions";
import { RenewalsFilter, type RenewalStanding } from "@/components/renewals/renewals-filter";
import { formerNamesOf } from "@/lib/companies/former-names";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { CompanyLinks } from "@/components/companies/company-links";
import { CompanyStageBadge } from "@/components/companies/company-stage-badge";
import { CompanyRolesControl } from "@/components/companies/company-roles-control";
import { ActivityPanelButton } from "@/components/activity/activity-panel-button";
import { StatementCollectPanel } from "@/components/collect/statement-collect-panel";
import { formatCompanyId } from "@/lib/order-id";
import { activityGroupsFor } from "@/lib/activity/timeline";
import { rolesAddable, rolesOf } from "@/lib/companies/roles";
import { vendorStatement } from "@/actions/payable";
import { accessLevel, mayAccess } from "@/lib/authz/access";
import { CategoryChip, CategoryGuidance } from "@/components/customers/category-chip";
import { CategoryPicker } from "@/components/customers/category-picker";
import { listCustomerCategories } from "@/actions/customer-category";
import { CompanyLeads } from "@/components/leads/company-leads";
import { leadStages } from "@/lib/pipeline/server";
import { readStageNote } from "@/lib/pipeline/rules";
import { callOutcomeLabels, formatDuration } from "@/lib/calls";
import { CallList } from "@/components/calls/call-list";
import { DomainPanel } from "@/components/domains/domain-panel";
import { getDomainBriefing } from "@/actions/domain";
import { listCompanyCalls } from "@/actions/call";
import { VendorStatusControl } from "@/components/companies/vendor-status-control";
import { VendorCodeButton } from "@/components/companies/vendor-code-button";
import { PayoutDetailsButton } from "@/components/companies/payout-details-button";
import { VendorTdsCard } from "@/components/companies/vendor-tds-card";
import { vendorTdsCardData } from "@/lib/tds/vendor";
import { VendorMsmeCard } from "@/components/companies/vendor-msme-card";
import { CompanyGroupCard } from "@/components/companies/company-group-card";
import { vendorMsmeCardData } from "@/lib/payables/msme";
import { LinkedCompaniesManager } from "@/components/companies/linked-companies-manager";
import { CommissionPartyAccountsManager } from "@/components/companies/commission-party-accounts-manager";
import { CompanyDocuments } from "@/components/companies/company-documents";
import { CompanyPayments } from "@/components/companies/company-payments";
import { CompanyCommission } from "@/components/companies/company-commission";
import { CommissionPartyEarnings } from "@/components/companies/commission-party-earnings";
import { CompanyVisits } from "@/components/companies/company-visits";
import { CompanyStatement } from "@/components/companies/company-statement";
import { StatementToolbar } from "@/components/statements/statement-toolbar";
import { maySeeStatement } from "@/lib/statements/print-data";
import { CompanyEstate } from "@/components/companies/company-estate";
import { CompanyFeedback } from "@/components/companies/company-feedback";
import { CompanyMarketing } from "@/components/companies/company-marketing";
import { TicketsTable } from "@/components/tickets/tickets-table";
import { TaskList } from "@/components/tasks/task-list";
import { getRenewalStatus } from "@/lib/renewals";
import { formatOrderId } from "@/lib/order-id";
import { companyPath, leadPath } from "@/lib/record-links";
import { paymentTermsLabels } from "@/lib/gst";
import { baseCurrency, getCurrency } from "@/lib/currency";
import { relationshipTypeLabels, vendorStatusLabels, isContactDetailField } from "@/lib/validation/company";
import { headcountLabel } from "@/lib/company-size";
import { isModuleEntitled } from "@/lib/modules-access";
import { workspacePack } from "@/lib/country-pack";
import { RegistrationCard } from "@/components/companies/registration-card";
import { addressTaxNumbers, licenceStanding } from "@/lib/companies/registration-rules";
import { customerRevenue } from "@/actions/revenue";
import { CustomerRevenueCard } from "@/components/revenue/customer-revenue-card";
import { documentWriteKey } from "@/lib/documents/write-permission";
import { ManagerNoticeBanner } from "@/components/messages/manager-notice";
import { mayQuickMessage } from "@/actions/quick-messages";
import { companyHasArchive } from "@/lib/migration/archive";
import { companyHasOldProposals } from "@/lib/old-proposals/run";
import { OldProposals } from "./old-proposals";
import { ArchivedHistory } from "@/components/companies/archived-history";
import { SuperAdminDeleteButton } from "@/components/super-admin/delete-button";
import { companyTypeName, companyTypeOptions } from "@/lib/companies/company-types";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import { CompanyInstalledElsewhere, RenewingElsewhere } from "@/components/companies/company-installed-elsewhere";
import { ApolloPanel } from "@/components/companies/apollo-panel";
import { ResearchCard } from "@/components/companies/research-card";
import { researchCardData } from "@/lib/research/view";
import { ResearchPlanCard } from "@/components/research/research-plan-card";
import { RecordTeam } from "@/components/ai/record-team";
import { companyTeam } from "@/lib/ai/record-team";
import { checkInCardOf } from "@/lib/reengage/server";
import { CheckInCard } from "@/components/ai/check-in-card";
import { planCardData } from "@/lib/research/plan-view";
import { apolloSetup, latestCompanyLookup } from "@/lib/apollo/server";
import { lushaSetup } from "@/lib/lusha/server";

const CLOSED_STATUSES = ["WON", "LOST", "DISQUALIFIED"];

/** One thing logged on the company — on one of its leads, or a call — for the Last activity card. */
type TimelineEntry = {
  id: string;
  type: string;
  notes: string;
  occurredAt: Date | string;
  user: { id: string; name: string };
  /** Where it belongs: its lead, or the company's Calls tab for a call on none. */
  link: { href: string; label: string };
  /** A lead's call entry, keyed as its call is — so that call isn't counted a second time. */
  callOf?: string | null;
};

/**
 * A company's 360 view. Rendered on its own page and again inside the split view on any of the
 * lists that are really companies — Companies, Customers, Vendors, Resellers, Commission parties —
 * so the five of them can't drift apart.
 *
 * `basePath` and `linkParams` are what let the tabs stay put when embedded: a tab link has to go
 * back to the list with the record still open, not navigate off to /companies/<id>.
 */
/** Where this browser keeps the tabs it pinned to a company's row (src/components/ui/tab-row.tsx). */
const TAB_PINS_COOKIE = "deskzo.tabs.company";

export async function CompanyDetail({
  id,
  tab,
  basePath,
  linkParams = {},
}: {
  id: string;
  tab?: string;
  /** Where the tab links point. Defaults to this company's own page. */
  basePath?: string;
  /** Query params a tab link must preserve — the list's filters and which record is open. */
  linkParams?: Record<string, string | undefined>;
}) {
  const sessionUser = await currentUser();
  const userId = sessionUser!.id;
  const calendarEnabled = await isModuleEnabled("calendar");
  // Booking one is "Schedule meetings" (owner, 8 Oct 2026); the Meetings tab still lists what was booked.
  const canScheduleMeetings = calendarEnabled && (await hasEffectivePermission(userId, "meetings.schedule"));
  const [
    itemsEnabled,
    renewalsEnabled,
    helpdeskEnabled,
    tasksEnabled,
    canEditProducts,
    canRecordPayments,
    canDeletePayments,
    canCreateTickets,
    canDeleteAnyTask,
    salesDocsEnabled,
    purchaseDocsEnabled,
    paymentsEnabled,
    visitsEnabled,
    receivablesEnabled,
    callsEnabled,
    domainsEnabled,
    itAssetsEnabled,
    canManageAssets,
    canViewAssets,
    feedbackEnabled,
    marketingEnabled,
    canViewMarketing,
    notesEnabled,
    canBroadcastNote,
    canManagePortal,
    canSeeContacts,
    canSeeLeads,
    canSeeOrders,
    projectsEnabled,
    canManageProjects,
    canMerge,
    canCreateLeads,
  ] = await Promise.all([
    // In the plan and switched on is enough (owner, 2 Nov 2026 — "why can't Sumit see products and renewals"): a role
    // without the Items & Inventory section loses the catalogue's pages, not what a customer has bought.
    moduleAccess("items").then((access) => access === "available" || access === "no-permission"),
    isModuleEnabled("renewals"),
    isModuleEnabled("helpdesk"),
    isModuleEnabled("tasks"),
    hasEffectivePermission(userId, "products.edit"),
    hasEffectivePermission(userId, "payments.record"),
    accessLevel(userId, "payments", "delete").then((level) => level !== "NONE"),
    hasEffectivePermission(userId, "tickets.create"),
    accessLevel(userId, "tasks", "delete").then((level) => level === "ALL"),
    isModuleEnabled("sales_documents"),
    isModuleEnabled("purchase_documents"),
    isModuleEnabled("payments"),
    isModuleEnabled("visits"),
    isModuleEnabled("receivables"),
    isModuleEnabled("calls"),
    isModuleEnabled("domains"),
    isModuleEnabled("it_assets"),
    hasEffectivePermission(userId, "assets.manage"),
    hasEffectivePermission(userId, "assets.viewAll"),
    isModuleEnabled("feedback"),
    isModuleEnabled("marketing"),
    hasEffectivePermission(userId, "marketing.viewAll"),
    isModuleEnabled("notes"),
    canBroadcastNotes(),
    hasEffectivePermission(userId, "portal.manage"),
    // The `*.view` permissions. The module-shaped ones (documents, payments, visits, calls,
    // tickets, renewals, projects) are already inside `isModuleEnabled` above; contacts and orders
    // have no module of their own to ride on, so they are asked for directly. Leads have had one since
    // 14 Oct 2026, so the plan decides too. Contacts ask their record level as well (owner, 3 Nov 2026 — Phase 2
    // permission fixes, audit H-4): at None there is no Contacts tab or count, as `getCompany` sends nobody — the page
    // has already checked the company, which is all "as far as the account" asks.
    Promise.all([hasEffectivePermission(userId, "contacts.view"), accessLevel(userId, "contacts", "view")]).then(([held, level]) => held && level !== "NONE"),
    isModuleEnabled("leads"),
    // The Products & Subscriptions tab is its own permission since 26 Nov 2026 (owner); Renewals asks its module.
    hasEffectivePermission(userId, "subscriptions.view"),
    isModuleEnabled("projects"),
    hasEffectivePermission(userId, "projects.manage"),
    hasEffectivePermission(userId, "companies.merge"),
    hasEffectivePermission(userId, "leads.create"),
  ]);
  const [company, itemOptions, companyTickets, companyTasks, assignableUsers, vendorOptions, companyCalls, domainBriefing, companyProjects, customerCategories] = await Promise.all([
    getCompany(id),
    itemsEnabled ? listItemOptions() : Promise.resolve([]),
    helpdeskEnabled ? listTickets({ companyId: id }) : Promise.resolve([]),
    tasksEnabled ? listTasks({ companyId: id }) : Promise.resolve([]),
    listAssignableUsers(),
    itemsEnabled ? listVendorOptions() : Promise.resolve([]),
    callsEnabled ? listCompanyCalls(id) : Promise.resolve([]),
    domainsEnabled ? getDomainBriefing(id) : Promise.resolve(null),
    projectsEnabled ? listProjects({ companyId: id }) : Promise.resolve([]),
    listCustomerCategories(),
  ]);
  if (!company) notFound();

  // A vendor is who we buy from, not who we sell to — the sales-pipeline-shaped tabs (Products &
  // Subscriptions, Leads, Renewals) track what a company has bought from us, which doesn't
  // apply. Resellers are on the buying side, so they keep those tabs: their orders are real orders.
  // A company with a second role (owner, 19 Oct 2026 — src/lib/companies/roles.ts) has both sides' tabs:
  // `isVendor` is "not a customer at all", and the vendor side's details show wherever it's a vendor.
  const roles = await rolesOf(company);
  const isVendor = !roles.customer;
  const bothSides = roles.customer && roles.vendor;
  // Changing its role is its own permission (companies.changeRole), on top of being able to edit the company.
  const canEditRoles = (await mayAccess(userId, "companies", "edit", company.id)) && (await hasEffectivePermission(userId, "companies.changeRole"));
  // Who may move this account, decided by the same rules the actions enforce — see
  // src/lib/authz/reassign.ts — so the buttons below are shown only to people they will work for.
  const reassign = await reassignRights(userId);
  const holders = { ownerUserId: company.owner?.id ?? null, assignedToUserId: company.assignedTo?.id ?? null };
  const canChangeManager = mayChangeAccountManager(reassign, userId, holders);
  // Who looks after its renewals (owner, 30 Oct 2026): its own renewal manager, else the account manager — a customer's,
  // where Renewals is on and the workspace has the column.
  let renewalManager: { manager: { id: string; name: string } | null } | null = null;
  if (!isVendor && itemsEnabled && renewalsEnabled && (await renewalManagersHere())) {
    const got = (await renewalManagersOf([{ id: company.id, owner: company.owner }])).get(company.id);
    renewalManager = { manager: got?.own ? { id: got.id, name: got.name } : null };
  }
  // Their photos, for the account manager, renewal manager and caller chips (owner, 15 Nov 2026: photo, name on hover).
  const chipIds = [company.owner?.id, company.assignedTo?.id, renewalManager?.manager?.id].filter((x): x is string => !!x);
  const photos = new Map(
    (chipIds.length ? await db.user.findMany({ where: { id: { in: chipIds } }, select: { id: true, photoUpdatedAt: true } }) : []).map((u) => [u.id, u.photoUpdatedAt]),
  );
  const withPhoto = <P extends { id: string; name: string }>(p: P | null | undefined) => (p ? { ...p, photoUpdatedAt: photos.get(p.id) ?? null } : null);
  const canChangeCaller = mayChangeCaller(reassign, userId, holders);
  const canUnassign = mayLeaveUnassigned(reassign);
  const isCommissionParty = company.relationshipType === "COMMISSION_PARTY";
  const isReseller = company.relationshipType === "RESELLER";
  const managedByReseller = company.managedByReseller;
  // Modules this page borrows from without a switch of their own here: each only where the plan has it.
  // Resellers' tools and the Commission tab are those modules' own screens on this page, so they follow
  // the company's switch and the role's section too (isModuleEnabled), as the modules' pages do.
  const [commissionsOn, expensesInPlan, resellersOn, portalInPlan] = await Promise.all([
    isModuleEnabled("commission_parties"),
    isModuleEntitled("expenses"),
    isModuleEnabled("resellers"),
    isModuleEntitled("customer_portal"),
  ]);
  const resellerTools = isReseller && resellersOn;
  // GSTINs, PAN and TDS are India's; another country's pack shows none of them (src/lib/country-pack.ts, owner 30 Oct 2026).
  const pack = workspacePack();
  // What the GST system said about each address's GSTIN when it was last checked (src/lib/gstin). Not where field access
  // masks the GSTIN for this person, and without the registered address where it masks the address (owner, 5 Nov 2026 —
  // Phase 3 masking fixes, audit H.4.2): the check carries both, and the locations' forms are handed it.
  const gstinChecks = pack.india && !company.masked.gstin ? withoutAddress(await savedGstinChecks(company.locations.map((l) => l.gstNumber)), company.masked.address) : {};
  // Several accounts, one primary (owner, 8 Oct 2026); changed with payments.manage — src/actions/company-bank.ts.
  const bankAccounts = holdsBankAccounts(company.relationshipType) || roles.vendor ? await listCompanyBankAccounts(company.id) : null;
  const payouts = bankAccounts?.ok ? bankAccounts.data : null;
  // A vendor's TDS (src/lib/tds): its usual section, certificates and tax year so far, beside its PAN — finance's view.
  const vendorTds = pack.india && roles.vendor && purchaseDocsEnabled && payouts ? await vendorTdsCardData(company.id) : null;
  // Its MSME (Udyam) registration, and its bills against the 45-day limit (owner, 17 Nov 2026; src/lib/payables/msme.ts).
  const vendorMsme = pack.india && roles.vendor ? await vendorMsmeCardData(company.id, userId) : null;
  // Its registration numbers in one card (owner, 20 Nov 2026 — src/lib/companies/registration-rules.ts): PAN and CIN in
  // India, the trade licence in the UAE, beside the GSTINs or TRNs on its addresses. Before the table reaches this
  // workspace, an empty card.
  const registration = await db.companyRegistration.findUnique({ where: { companyId: company.id } }).catch((err) => {
    if (notMigratedYet(err)) return null;
    throw err;
  });
  const [canEditCompany, financeHere, registrationToday] = await Promise.all([
    mayAccess(userId, "companies", "edit", company.id),
    hasEffectivePermission(userId, "payments.manage"),
    workspaceClock().then((c) => c.today()),
  ]);
  const licenceExpiresOn = registration?.tradeLicenceExpiresOn?.toISOString().slice(0, 10) ?? null;

  // The estate tab earns its place when there is an estate to show, or when this is somebody we
  // actually serve and whoever manages assets needs a way in to record their first machine. A
  // prospect nobody has shipped a laptop to shouldn't carry an empty tab around.
  const assetsVisible = itAssetsEnabled && (canViewAssets || canManageAssets);
  const showEstateTab =
    assetsVisible &&
    ((canManageAssets && !isVendor && company.stage === "CUSTOMER") || (await estateCount(company.id)) > 0);

  const [linkedCompanies, commissionPartyAccounts, clientCompanyOptions, commissionEarnings] = isCommissionParty && commissionsOn
    ? await Promise.all([
        listLinkedCompanies(company.id),
        listCommissionPartyAccounts(company.id),
        listClientCompanyNameOptions(),
        listCommissionPartyEarnings(company.id),
      ])
    : [[], [], [], []];

  // The 360 view: everything raised for, received from, or paid out on this account. Loaded here
  // rather than per-tab because the header counts need them regardless of which tab is open.
  const documentsEnabled = isVendor ? purchaseDocsEnabled : bothSides ? salesDocsEnabled || purchaseDocsEnabled : salesDocsEnabled;
  const isSuperAdmin = await actingAsSuperAdmin(userId);
  // A vendor's delete is also "Delete vendors" — admins, and anyone given it (owner, 28 Oct 2026).
  const mayDelete = isSuperAdmin || (isVendor && (await hasEffectivePermission(userId, "vendors.delete")));
  // The old system's earlier years (src/lib/migration/archive.ts): a tab only where there are any.
  const [archived, oldProposals] = documentsEnabled ? await Promise.all([companyHasArchive(company.id), companyHasOldProposals(company.id)]) : [false, false];
  const hasArchive = archived || oldProposals;
  // What only one tab shows is read when that tab is open: the visits, the statement and the payments list.
  // A large customer's statement is every invoice and payment they ever had, and it was worked out on
  // every tab (the large-workspace load test, 23 Oct 2026).
  const [visits, visitExpenses] =
    visitsEnabled && tab === "visits"
      ? await Promise.all([listCompanyVisits(company.id), expensesInPlan ? expenseSummary({ companyId: company.id }) : null])
      : [[], null];

  // The statement is a customer-side view; a vendor has no receivable against us.
  const showStatement = receivablesEnabled && !isVendor && (await hasEffectivePermission(userId, "statements.view"));
  const statement = showStatement && tab === "statement" ? await customerStatement(company.id) : null;
  // Both sides: what we owe them as a vendor, beside what they owe us, and the net.
  // Payables' own statement, only where its module is on (src/lib/module-actions.ts).
  const asVendor = showStatement && tab === "statement" && bothSides && (await isModuleEnabled("payables")) ? await vendorStatement(company.id) : null;
  // A vendor's own statement of accounts, to print and send them (owner, 31 Oct 2026): where payables is on and theirs to see.
  const showVendorStatement = isVendor && (await maySeeStatement(userId, "AP", company.id));

  // Credit is money about the account, so it rides on the payments view like the billed figures do.
  const [documents, companyPayments, paymentSummary, creditProfile, supportLoad, mailSummary, companyForms] = await Promise.all([
    documentsEnabled ? listCompanyDocuments(company.id) : Promise.resolve([]),
    paymentsEnabled && tab === "payments" ? listCompanyPayments(company.id) : Promise.resolve([]),
    paymentsEnabled ? companyPaymentSummary(company.id) : Promise.resolve(null),
    // The credit engine is Receivables': a plan with payments and without it has no profile to show.
    paymentsEnabled && !isVendor && (await isModuleEntitled("receivables")) ? getCreditProfile(company.id) : Promise.resolve(null),
    // How much support they take against what they pay — beside their tickets, where it is judged.
    helpdeskEnabled && !isVendor ? getSupportLoad(company.id) : Promise.resolve(null),
    // Null without `emails.view` or outside the account scope — and then there is no Emails tab.
    !isVendor ? companyMailSummary(company.id) : Promise.resolve(null),
    // Only the forms whose answers are shared with this viewer — and no tab when there are none.
    !isVendor && (await isModuleEntitled("forms")) ? companyFormResponses(company.id) : Promise.resolve(null),
  ]);
  const showFormsTab = Boolean(companyForms && (companyForms.responses.length > 0 || companyForms.waiting.length > 0));

  // A customer's revenue (Revenue & Close): only where the add-on is available and the viewer may read
  // revenue. The action also answers null for an account outside their scope.
  const revenueVisible =
    !isVendor &&
    (await isModuleEnabled("revenue_close")) &&
    ((await hasEffectivePermission(userId, "revenue.viewReports")) || (await hasEffectivePermission(userId, "revenue.manage")));
  const revenueFigures = revenueVisible ? await customerRevenue(company.id) : null;

  // Commission is paid on a customer's business, so it's a customer-side view; a commission party
  // sees the mirror of it (what they earned) on their own Details tab instead.
  // Its own right since 2 Nov 2026 (owner): "View commission on a customer".
  const showCommissionTab = !isVendor && commissionsOn && (await hasEffectivePermission(userId, "commissions.view"));
  const [commissionParties, commissions, commissionPartyOptions] = showCommissionTab
    ? await Promise.all([
        listCompanyCommissionParties(company.id),
        listCompanyCommissions(company.id),
        listCommissionPartyOptions(),
      ])
    : [[], [], []];
  const endCustomers = isReseller ? await listEndCustomers(company.id) : [];
  const [resellerOnboarding, resellerCredit, resellerPrices] = resellerTools
    ? await Promise.all([
        getResellerOnboarding(company.id),
        getResellerCreditSummary(company.id),
        listResellerItemPrices(company.id),
      ])
    : [null, null, []];
  const resellerChecklist = resellerOnboarding ? onboardingChecklist(resellerOnboarding.inputs) : [];
  // What the reseller asked to be quoted for through their own link, and their links (owner, 26 Nov 2026 — src/lib/quote-requests.ts).
  const quoteRequests = resellerTools && (!tab || tab === "details") ? await resellerRequests(userId, company.id) : null;
  // The order is billed to the reseller, but the product/subscription belongs to the end customer —
  // their seats, their expiry, their support — so it shows in *their* Products & Subscriptions.
  // A normal client has no `ordersAsEndCustomer`, so this is just `products` for everyone else.
  const productRows = [...company.products, ...company.ordersAsEndCustomer];
  // A won deal only counts as a real Customer once it has at least one order on file (even an
  // expired one) — otherwise it's shown as "Awaiting Order" rather than a misleading "CUSTOMER".
  // Only said to someone who can see the orders — without `orders.view` the list is empty because it
  // was left out, not because there are none.
  const isAwaitingOrder = canSeeOrders && company.stage === "CUSTOMER" && productRows.length === 0;
  // The workspace's own words (Settings → Wording) for the tabs, headings and buttons below.
  const w = await getWording();

  const tabs = [
    { key: "details", label: "Details" },
    ...(!isVendor && itemsEnabled && canSeeOrders ? [{ key: "products", label: "Products & Subscriptions" }] : []),
    ...(documentsEnabled ? [{ key: "documents", label: "Documents" }] : []),
    ...(hasArchive ? [{ key: "archive", label: "Earlier years" }] : []),
    ...(paymentsEnabled && !isVendor ? [{ key: "payments", label: "Payments" }] : []),
    ...(creditProfile ? [{ key: "credit", label: "Credit" }] : []),
    ...(showStatement || showVendorStatement ? [{ key: "statement", label: "Statement" }] : []),
    ...(showCommissionTab ? [{ key: "commission", label: "Commission" }] : []),
    ...(visitsEnabled ? [{ key: "visits", label: slot(w, "Visits", "visit") }] : []),
    ...(calendarEnabled && !isVendor ? [{ key: "meetings", label: "Meetings" }] : []),
    ...(callsEnabled ? [{ key: "calls", label: "Calls" }] : []),
    ...(!isVendor && canSeeLeads ? [{ key: "leads", label: slot(w, "Leads", "lead") }] : []),
    ...(!isVendor && projectsEnabled ? [{ key: "projects", label: "Projects" }] : []),
    ...(!isVendor && itemsEnabled && renewalsEnabled ? [{ key: "renewals", label: slot(w, "Renewals", "renewal") }] : []),
    // What they use that they didn't buy from us (owner, 2 Nov 2026 — src/lib/customers/elsewhere.ts).
    ...(!isVendor ? [{ key: "elsewhere", label: "Installed elsewhere" }] : []),
    { key: "locations", label: "Locations", count: company.locations.length },
    ...(canSeeContacts ? [{ key: "contacts", label: slot(w, "Contacts", "contact"), count: company.contacts.length }] : []),
    ...(showEstateTab ? [{ key: "assets", label: "IT Assets" }] : []),
    ...(feedbackEnabled && !isVendor ? [{ key: "feedback", label: "Feedback" }] : []),
    ...(marketingEnabled && canViewMarketing && !isVendor ? [{ key: "marketing", label: "Marketing" }] : []),
    ...(helpdeskEnabled ? [{ key: "tickets", label: slot(w, "Tickets", "ticket") }] : []),
    ...(mailSummary ? [{ key: "emails", label: "Emails" }] : []),
    ...(showFormsTab ? [{ key: "forms", label: "Forms" }] : []),
    ...(tasksEnabled ? [{ key: "tasks", label: "Tasks" }] : []),
    ...(canManagePortal && portalInPlan && !isVendor ? [{ key: "portal", label: "Portal" }] : []),
  ];
  /** A link to one of the tabs below, keeping the list filters when embedded — as `TabNav` builds them. */
  const tabHref = (key: string) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(linkParams)) if (v) query.set(k, v);
    query.set("tab", key);
    return `${basePath ?? companyPath(company.companySeq)}?${query}`;
  };
  const primaryLocation = company.locations.find((l) => l.isPrimary) ?? company.locations[0];
  // The names it went by before (owner, 14 Nov 2026 — src/lib/companies/former-names.ts).
  const formerNames = await formerNamesOf(company.id);
  // "Show" beside its masked fields (owner, 5 Nov 2026 — Phase 3 masking fixes, wave B; src/actions/company-unmask.ts):
  // where field access masks some that this person may unmask, and today's reveal hasn't covered them yet.
  const revealPending = await pendingCompanyReveal(userId, company.id);
  const activeTab = tabs.some((t) => t.key === tab) ? tab! : "details";
  // Every tab in the row, none under More (owner, 13 Nov 2026: "keep old one as it is show all tabs") — they wrap to a
  // second line where they don't fit.
  const rowTabs = tabs.map((t) => t.key);
  // The rows only when the tab is open; the counts above are cheap and always there.
  const recentMail = activeTab === "emails" && mailSummary ? await listMailLog({ companyId: company.id, page: 1, pageSize: 50 }) : null;
  // Each order's invoices and its proposal, on Products & Subscriptions (owner, 21 Nov 2026 — src/lib/orders/paperwork.ts).
  // On the Renewals tab, only what this person may do to a renewal is offered (owner, 26 Nov 2026 — src/lib/renewal-actions.ts).
  const renewalActions = activeTab === "renewals" ? await viewerRenewalActions() : null;
  const paperwork = activeTab === "products" && itemsEnabled && canSeeOrders ? await orderPaperwork(productRows.map((p) => p.id)) : {};
  // Past orders (temporary — src/actions/past-order.ts): the button for whoever holds "Add past orders", and their mark.
  const canAddPastOrders = activeTab === "products" && itemsEnabled && canSeeOrders && !isVendor && (await hasEffectivePermission(userId, "orders.recordPast"));
  const pastOrderIds =
    activeTab === "products" && productRows.length
      ? (await db.pastOrderEntry.findMany({ where: { orderId: { in: productRows.map((p) => p.id) } }, select: { orderId: true } }).catch(() => [])).map((e) => e.orderId)
      : [];
  // The Activity panel's kinds: those this person may see elsewhere (the page has checked they may open the company).
  const activityGroups = await activityGroupsFor(userId, "record");
  // The workspace's own fields (src/lib/custom-fields), on the tabs that show them. Whoever may open
  // the company may edit its fields, as with the company itself.
  const companyFields = activeTab === "details" ? await companyCustomFields(company.id, userId, companyFieldEntity(company.relationshipType)) : null;
  const contactFields = activeTab === "contacts" && canSeeContacts ? await contactCustomFields(company.contacts, userId) : undefined;
  // Who has left the company, and when — in the workspace's own calendar (src/lib/contacts/left.ts).
  const contactsLeft =
    activeTab === "contacts" && canSeeContacts
      ? await Promise.all([leftContactsOf(company.id), workspaceClock()]).then(([left, clock]) =>
          Object.fromEntries([...left].map(([id, at]) => [id, clock.date(at)])),
        )
      : {};
  // Each contact's designation from the list, and where those who moved came from or went.
  const contactIds = activeTab === "contacts" && canSeeContacts ? company.contacts.map((c) => c.id) : [];
  const [contactRoles, contactMoves, contactsUnconfirmed] = await Promise.all([designationNamesOf(contactIds), contactMovesOf(contactIds), unconfirmedAmong(contactIds)]);
  // Security audit round two, 13 Nov 2026 (R2-14): those a visitor added from the website, badged with a Confirm button.
  const unconfirmedBadges = Object.fromEntries([...contactsUnconfirmed].map(([id, from]) => [id, unconfirmedFromLabel(from) ?? ""]));

  // Renewals follow the subscription, so an end customer sees the expiries bought for them too.
  //
  // Parents only, exactly as the renewals page does it: an addon co-terminates with the
  // subscription it was added to and comes back with it, so listing it separately would turn one
  // renewal conversation into four — and offer a Renew button that renews part of a term.
  const subscriptionProducts = productRows
    .filter((p) => p.item.type === "SUBSCRIPTION" && p.parentId === null)
    .sort((a, b) => {
      if (!a.endDate && !b.endDate) return 0;
      if (!a.endDate) return 1;
      if (!b.endDate) return -1;
      return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    });

  /**
   * Where each subscription stands on the Renewals tab (owner, 14 Nov 2026): renewed when a later order took it on — the
   * renewal's own link, or, for history brought across from an old system without one, a later order for the same item
   * starting within a month of its end — else by its end date, as the badge says.
   */
  const RENEWAL_GAP_MS = 31 * 86_400_000;
  const renewalStanding = (p: (typeof subscriptionProducts)[number]): RenewalStanding => {
    const end = p.endDate ? new Date(p.endDate).getTime() : null;
    const takenOn =
      !!p.renewedBy ||
      (end !== null &&
        subscriptionProducts.some(
          (q) => q.id !== p.id && q.itemId === p.itemId && q.startDate && new Date(q.startDate).getTime() >= end - RENEWAL_GAP_MS && (!p.startDate || new Date(q.startDate).getTime() > new Date(p.startDate).getTime()),
        ));
    if (takenOn) return "renewed";
    const key = getRenewalStatus(p.endDate).key;
    return key === "expired" ? "expired" : key === "expiring" ? "expiring" : "active";
  };

  /** Seats added part-way through a term, which come back with the parent at renewal. */
  const addedSeats = (p: { addons?: { quantity: number }[] }) =>
    (p.addons ?? []).reduce((total, a) => total + a.quantity, 0);
  /** Whoever the call button should open on, rather than making somebody pick. */
  const callableContact = company.contacts.find((c) => c.phone) ?? undefined;
  // Apollo (owner, 14 Nov 2026 — src/lib/apollo): on Details, for whoever may spend its credits, once the workspace connected it.
  // And Lusha (owner, 14 Nov 2026 — src/lib/lusha): the panel offers whichever the workspace connected.
  const enrichProviders =
    (activeTab === "details" || activeTab === "contacts") && (await hasEffectivePermission(userId, "companies.enrich"))
      ? ([(await apolloSetup()).connected ? "apollo" : null, (await lushaSetup()).connected ? "lusha" : null].filter(Boolean) as ("apollo" | "lusha")[])
      : [];
  const apollo = enrichProviders.length && activeTab === "details" ? { last: await latestCompanyLookup(company.id) } : null;
  // Research from free public sources (owner, 18 Nov 2026 — src/lib/research), on Details: null where the website is masked.
  const research = activeTab === "details" ? await researchCardData(company.id, userId) : null;
  // Deskzo AI's "Research & plan" (owner, 18 Nov 2026): shown to whoever may make one, or once one has been made.
  const planCard = activeTab === "details" ? await planCardData({ kind: "company", id: company.id }, userId).catch(() => null) : null;
  // Tara's check-in with a quiet customer (owner, 20 Nov 2026 — step 4, src/lib/reengage): its card on Details, her slot above.
  const checkIn = isVendor ? null : await checkInCardOf(company.id, userId, await mayAccess(userId, "companies", "edit", company.id)).catch((err) => (console.error("[reengage] the card failed", err instanceof Error ? err.message : err), null));
  // The AI team at the top, on every tab: Ved's plan as it stands, Tara on a quiet customer, Arjun where money is overdue (step 3).
  const teamSlots = isVendor ? [] : await companyTeam(userId, company.id, planCard ?? (await planCardData({ kind: "company", id: company.id }, userId).catch(() => null)), checkIn).catch(() => []);

  const wonLeads = company.leads.filter((l) => l.status === "WON");
  // Its icon, unless the website is masked for this person (src/lib/companies/masking.ts) — the icon would say whose site.
  const favicon = company.masked.website ? null : await faviconOf(company.id);
  // One address that's both: one block on the profile, not the same address twice.
  const billingIds = company.locations.filter((l) => l.isBilling).map((l) => l.id).sort().join();
  const sameBillingAndShipping = !!billingIds && billingIds === company.locations.filter((l) => l.isShipping).map((l) => l.id).sort().join();
  const openLeads = company.leads.filter((l) => !CLOSED_STATUSES.includes(l.status));
  const openValue = openLeads.reduce((sum, l) => sum + Number(l.estimatedValue ?? 0), 0);

  // The workspace's own stages (Settings → Pipeline, src/lib/pipeline): a lead's moves in their names.
  const { stages: pipelineStages } = await leadStages();
  const leadTimeline: TimelineEntry[] = canSeeLeads
    ? company.leads.flatMap((l) =>
        l.activities.map((a) => ({
          id: a.id,
          type: a.type,
          notes: a.type === "STAGE_CHANGE" ? readStageNote(a.notes, pipelineStages) : a.notes,
          occurredAt: a.occurredAt,
          user: a.user,
          link: { href: leadPath(l.leadSeq), label: l.title },
          callOf: a.type === "CALL" ? `${l.id}|${a.user.id}|${new Date(a.occurredAt).getTime()}` : null,
        })),
      )
    : [];
  // The company's calls too (owner, 18 Oct 2026): one on none of its leads — most calls from the phone app, and
  // one typed in without a lead — was only under Calls. One already on a lead's timeline (logged with the
  // call's own start, by its caller) isn't listed twice.
  const onLeads = new Set(leadTimeline.map((a) => a.callOf).filter(Boolean));
  const callTimeline: TimelineEntry[] = companyCalls
    .filter((c) => !c.lead || !onLeads.has(`${c.lead.id}|${c.user.id}|${new Date(c.startedAt).getTime()}`))
    .map((c) => ({
      id: `call-${c.id}`,
      type: "CALL",
      notes: [
        `${c.direction === "INBOUND" ? "From" : "To"} ${c.contact?.name ?? c.phoneNumber} — ${callOutcomeLabels[c.outcome].toLowerCase()}`,
        c.durationSeconds ? `, ${formatDuration(c.durationSeconds)}` : "",
        c.source === "PHONE" ? ", from the phone" : c.source === "CLOUD" ? ", through the business line" : "",
        c.notes ? `. ${c.notes}` : "",
      ].join(""),
      occurredAt: c.startedAt,
      user: c.user,
      link: c.lead ? { href: leadPath(c.lead.leadSeq), label: c.lead.title } : { href: tabHref("calls"), label: "Calls" },
      callOf: null,
    }));
  const timeline = [...leadTimeline, ...callTimeline].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
  const showActivity = !isVendor && (canSeeLeads || callsEnabled);
  const clock = await workspaceClock();
  // Every subscription ended and none renewed (owner, 26 Oct 2026) — a customer to win back. A failure is no flag.
  const standing = !isVendor ? await customerStanding(company.id, clock.calendarDate(new Date())).catch(() => null) : null;
  // Its history with us and loyalty tier (owner, 31 Oct 2026): the stored row, for someone who can see orders; none, no card.
  const history = !isVendor && canSeeOrders ? ((await historyOfCompanies([company.id]).catch(() => null))?.get(company.id) ?? null) : null;

  return (
    <div className="@container space-y-6">
      {/* Their account manager changed and they haven't been told: told by hand, from here (src/lib/quick-messages). */}
      {!isVendor && !managedByReseller && <ManagerNoticeBanner companyId={company.id} companyName={company.name} />}
      {managedByReseller && (
        <div className="rounded-md border border-warning bg-warning-bg px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-warning">
            <Lock className="h-4 w-4" />
            {slot(w, "Reseller-managed customer — do not contact directly", "customer", "Reseller-managed {one:lower} — do not contact directly")}
          </div>
          <p className="mt-1 text-sm text-warning">
            {company.name} is a customer of{" "}
            <CompanyLink href={companyPath(managedByReseller.companySeq)} className="font-medium underline">
              {managedByReseller.name}
            </CompanyLink>
            . {NO_DIRECT_CONTACT_NOTICE} They&apos;re excluded from the Companies and Customer lists and from
            marketing sends, and their contact details are hidden unless you have the &ldquo;View reseller-managed
            contact details&rdquo; permission.
          </p>
        </div>
      )}

      {/*
        The header (owner, 15 Nov 2026 — "improve ui", mockup approved): the account and its everyday actions on one line,
        what isn't needed every visit behind "⋯", and who looks after it on a row of its own, named.
      */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
          {/* The site's own icon from the domain lookup (owner, 15 Nov 2026 — src/lib/domain-intel/favicon.ts), else initials. */}
          {favicon ? (
            // A data URL from our own lookup, so next/image's loader has nothing to add.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={favicon} alt="" aria-hidden className="mt-0.5 h-11 w-11 shrink-0 rounded-xl border border-line bg-white object-contain p-1.5" />
          ) : (
            <div aria-hidden className="mt-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-subtle text-sm font-semibold text-brand">
              {initialsOf(company.name)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-text">{company.name}</h1>
              {formerNames.length > 0 && (
                <span className="basis-full text-xs text-muted" title={formerNames.join("\n")}>
                  Formerly {formerNames.slice(-3).reverse().join(" · ")}
                  {formerNames.length > 3 ? ` and ${formerNames.length - 3} more` : ""}
                </span>
              )}
              {/* Who this customer is, before anything else on the page. Whoever can open the account can
                  edit it, so whoever can see this can change it. A customer's only: a vendor is no customer. */}
              {!isVendor && <CategoryPicker companyId={company.id} current={company.customerCategory} categories={customerCategories} canEdit />}
              {managedByReseller && <Badge tone="amber">Reseller-managed</Badge>}
              {isReseller && <Badge tone="blue">Reseller</Badge>}
              {!isVendor && <CompanyStageBadge stage={company.stage} awaitingOrder={isAwaitingOrder} />}
              {standing?.lapsed && (
                <span title={`All ${standing.subscriptions} of their subscriptions have ended and none was renewed — the last on ${formatCalendarDay(standing.since)}.`}>
                  <Badge tone="red">Lapsed customer</Badge>
                </span>
              )}
              {isVendor && (
                <Badge tone="amber">{relationshipTypeLabels[company.relationshipType]}</Badge>
              )}
              {roles.added && <Badge tone="blue">{roles.added === "vendor" ? "Also a vendor" : "Also a customer"}</Badge>}
            </div>
            {/* Where they are, their links and tags on one line under the name (owner, 29 Oct 2026). */}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              <span>
                {distinct([company.industry?.name, primaryLocation?.city, primaryLocation?.state, primaryLocation?.country]).join(" · ") || "No details yet"}
              </span>
              {/* A masked website isn't a link (src/lib/companies/masking.ts). */}
              <CompanyLinks website={company.masked.website ? null : company.website} linkedinUrl={company.linkedinUrl} className="-my-1 flex items-center gap-0.5" />
              {revealPending.length > 0 && <CompanyReveal companyId={company.id} name={company.name} />}
              {company.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
            {/* The AI team on this customer, one click each (owner, 20 Nov 2026 — src/lib/ai/record-team.ts). */}
            {!isVendor && <RecordTeam record={{ kind: "company", id: company.id }} slots={teamSlots} />}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Not for a reseller's end customer: the same rule that stops us emailing them stops us
              ringing them (src/lib/reseller.ts). The banner above says who to go through. */}
          {callsEnabled && !managedByReseller && (
            <CallButton companyId={company.id} companyName={company.name} />
          )}
          {/* A reseller's customer can still be met about — with colleagues only (src/lib/calendar/records.ts). Icons, named on hover. */}
          {canScheduleMeetings && !isVendor && <ScheduleMeetingButton record={{ kind: "company", id: company.id }} size="icon" />}
          {/* Everything that happened to the customer or vendor, and who did it, in a side panel (owner, 19 Oct 2026 — src/lib/activity). */}
          <ActivityPanelButton source={{ kind: "company", id: company.id }} groups={activityGroups} people={assignableUsers.map((u) => ({ id: u.id, name: u.name }))} zone={clock.zone} iconOnly />
          {isVendor && company.vendorStatus && (
            <VendorStatusControl companyId={company.id} status={company.vendorStatus} />
          )}
          {isVendor && <VendorCodeButton companyId={company.id} vendorCode={company.vendorCode} />}
          {/* Resellers need this for the PAN their onboarding KYC step checks. */}
          {/* Not while field access masks the PAN for them: `setPayoutDetails` refuses it. */}
          {pack.india && payouts?.canManage && !company.masked.pan && <PayoutDetailsButton companyId={company.id} panNumber={company.panNumber} />}
          {/* Edit, and merging a duplicate in (companies.merge), behind "⋯". */}
          <CompanyMoreMenu
            editHref={`/companies/${company.id}/edit`}
            mergeHref={canMerge ? `/companies/merge?keep=${company.id}` : null}
            mergeLabel={slot(w, "Merge a duplicate into this company", "company", "Merge a duplicate into this {one:lower}")}
          />
          {/* Deleting a company — the super admin's, a vendor's also "Delete vendors"; only one with no history (src/actions/company-delete.ts). */}
          {mayDelete && <SuperAdminDeleteButton kind="company" id={company.id} name={company.name} noun={isVendor ? "vendor" : "customer"} backTo={isVendor ? "/vendors" : "/customers"} />}
          {!isVendor && canSeeLeads && canCreateLeads && (
            <Link href={`/leads/new?companyId=${company.id}`}>
              <Button>{slot(w, "New lead", "lead", "New {one:lower}")}</Button>
            </Link>
          )}
        </div>
      </div>

      <div className="-mt-2 flex flex-wrap items-center gap-2">
        <AccountManagerButton
          companyId={company.id}
          owner={withPhoto(company.owner)}
          users={assignableUsers}
          canChange={canChangeManager}
          canUnassign={canUnassign}
        />
        {renewalManager && (
          <RenewalManagerButton
            companyId={company.id}
            manager={withPhoto(renewalManager.manager)}
            accountManager={withPhoto(company.owner)}
            users={assignableUsers}
            canChange={canChangeManager}
          />
        )}
        {!isVendor && (
          <CallerButton
            companyId={company.id}
            caller={withPhoto(company.assignedTo)}
            users={assignableUsers}
            canChange={canChangeCaller}
            canUnassign={canUnassign}
          />
        )}
        {showActivity && timeline[0] && (
          <span className="ml-auto text-xs text-subtle">
            Last activity {clock.date(timeline[0].occurredAt)} · {timeline.length} logged
          </span>
        )}
      </div>

      {/* How to treat them, across the page under the header — not a tall box beside nothing. */}
      {!isVendor && <CategoryGuidance category={company.customerCategory} bar className="-mt-2" />}

      {/*
        The account's figures in one panel, a cell each (owner, 29 Oct 2026): cells fill their row whatever the width, so
        no row is left half empty, and each is only for someone who may see what it counts — a figure with its source
        withheld is still the thing withheld.
      */}
      {isVendor ? (
        <StatStrip>
          <Stat label="Status" value={company.vendorStatus ? vendorStatusLabels[company.vendorStatus] : "—"} note={relationshipTypeLabels[company.relationshipType]} />
          <Stat label="Locations" value={company.locations.length} />
          {canSeeContacts && <Stat label={slot(w, "Contacts", "contact")} value={company.contacts.length} />}
          <Stat label="Added on" value={clock.date(company.createdAt)} />
        </StatStrip>
      ) : (
        // Pipeline first, real money in the middle, recency last — the whole account in one row, which is the point of a 360 view.
        <StatStrip>
          {paymentSummary && (
            <>
              <Stat label="Billed" value={formatCurrency(paymentSummary.billed)} note={`${formatCurrency(paymentSummary.received)} received`} />
              <Stat
                label="Outstanding"
                value={formatCurrency(paymentSummary.outstanding)}
                tone={paymentSummary.outstanding > 0 ? "danger" : undefined}
                note={
                  paymentSummary.credit > 0
                    ? `${formatCurrency(paymentSummary.credit)} in credit`
                    : paymentSummary.unallocated > 0
                      ? `${formatCurrency(paymentSummary.unallocated)} unallocated`
                      : "Fully allocated"
                }
              />
            </>
          )}
          {creditProfile && (
            <Stat
              label="Credit"
              href={tabHref("credit")}
              value={<CreditBadge rating={creditProfile.rating} score={creditProfile.score} />}
              note={<span className={creditProfile.termsBeyond ? "text-warning" : undefined}>Up to {paymentTermsLabels[creditProfile.recommendedTerms]} · limit {formatCurrency(creditProfile.limit)}</span>}
            />
          )}
          {canSeeLeads && (
            <Stat
              label="Open pipeline"
              href={tabHref("leads")}
              value={formatCurrency(openValue)}
              note={`${company.leads.length} ${company.leads.length === 1 ? "lead" : "leads"} · ${openLeads.length} open · ${wonLeads.length} won`}
            />
          )}
          {documentsEnabled && <Stat label="Documents" href={tabHref("documents")} value={documents.length} note={`${documents.filter((d) => d.docType === "INVOICE").length} invoice(s)`} />}
          {supportLoad && (
            <Stat label="Support" href={tabHref("tickets")} value={`${supportLoad.tickets} ticket(s)`} note={<SupportLevelBadge level={supportLoad.level} multiple={supportLoad.multiple} />} />
          )}
        </StatStrip>
      )}

      <TabRow
        tabs={tabs}
        activeKey={activeTab}
        pinned={rowTabs}
        cookieName={TAB_PINS_COOKIE}
        basePath={basePath ?? companyPath(company.companySeq)}
        otherParams={linkParams}
      />

      <div className="space-y-6">
        {activeTab === "details" && (
          // Two columns (owner, 15 Nov 2026 — mockup approved): the work on the account on the left, what it is on the right.
          <div className="grid grid-cols-1 items-start gap-6 @3xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-6">
            {/* First, not last: a note on an account ("they always order in March", "never ring
                before 11") is a heads-up, and a heads-up below eight cards of profile data is a
                note nobody reads. */}
            {notesEnabled && <RecordNotes companyId={company.id} canBroadcast={canBroadcastNote} />}
            {apollo && (
              <ApolloPanel
                companyId={company.id}
                contacts={canSeeContacts ? company.contacts.filter((c) => !("leftAt" in c && c.leftAt)).map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone })) : []}
                last={apollo.last ? { at: apollo.last.at, found: apollo.last.found, provider: apollo.last.provider } : null}
                providers={enrichProviders}
              />
            )}
            {research && <ResearchCard companyId={company.id} data={research} />}
            {planCard && (planCard.mayPlan || planCard.plan) && (
              <div id="research-plan" className="scroll-mt-20">
                <ResearchPlanCard data={planCard} />
              </div>
            )}
            {activeTab === "details" && checkIn && <CheckInCard data={checkIn} />}

            {history && <HistoryCard history={history} />}

            {revenueFigures && <CustomerRevenueCard revenue={revenueFigures} />}
            {!isVendor && <CompanyServiceCycles companyId={company.id} />}
            {/* Smart Lists whose rows link to this company (owner, 20 Nov 2026 — Smart Lists phase 2). */}
            <InTheseLists kind="COMPANY" recordId={company.id} />
            {isReseller && resellerOnboarding && resellerCredit && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">Reseller onboarding</CardHeader>
                <CardContent>
                  <ResellerOnboardingPanel
                    companyId={company.id}
                    profile={resellerOnboarding.profile}
                    checklist={resellerChecklist}
                    credit={resellerCredit}
                    users={assignableUsers}
                    complete={isOnboardingComplete(resellerOnboarding.inputs)}
                  />
                </CardContent>
              </Card>
            )}

            {resellerTools && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">Special reseller pricing</CardHeader>
                <CardContent>
                  <ResellerPricingManager
                    resellerId={company.id}
                    prices={resellerPrices}
                    items={itemOptions}
                    discountPercent={
                      resellerOnboarding?.profile.discountPercent != null
                        ? Number(resellerOnboarding.profile.discountPercent)
                        : null
                    }
                  />
                </CardContent>
              </Card>
            )}

            {quoteRequests && (
              <ResellerQuoteRequests
                resellerId={company.id}
                requests={quoteRequests.requests}
                links={quoteRequests.links}
                contacts={quoteRequests.contacts}
                maySend={quoteRequests.maySend}
                people={assignableUsers.map((u) => ({ id: u.id, name: u.name }))}
              />
            )}

            {isReseller && (
              <Card>
                <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
                  <span>{slot(w, "End customers", "customer", "End {many:lower}")}</span>
                  <Link href={`/resellers/${company.id}/end-customers/new`}>
                    <Button variant="secondary" size="sm">
                      {slot(w, "+ Add end customer", "customer", "+ Add end {one:lower}")}
                    </Button>
                  </Link>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p className="text-xs text-muted">
                    Customers {company.name} buys for. We never contact them directly — they&apos;re kept out of the
                    Companies and Customer lists and excluded from marketing.
                  </p>
                  {endCustomers.length === 0 && (
                    <p className="text-subtle">{slot(w, "No end customers recorded yet.", "customer", "No end {many:lower} recorded yet.")}</p>
                  )}
                  {endCustomers.map((ec) => (
                    <div key={ec.id} className="flex items-center justify-between border-t border-line pt-2">
                      <CompanyLink href={companyPath(ec.companySeq)} className="font-medium text-text hover:underline">
                        {ec.name}
                      </CompanyLink>
                      <span className="text-muted">
                        {ec._count.ordersAsEndCustomer} order(s)
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {payouts && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">
                  {isReseller ? (pack.india ? "PAN & bank accounts" : "Bank accounts") : "Payout details"}
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  {pack.india && (
                    <div className="flex max-w-xs flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-muted">PAN</span>
                      <span className="text-text">{company.panNumber ?? "—"}</span>
                    </div>
                  )}
                  <BankAccountsManager
                    scope={{ kind: "company", companyId: company.id }}
                    accounts={payouts.accounts}
                    canManage={payouts.canManage}
                    emptyText={
                      payouts.canManage
                        ? slot(w, "No bank account yet — add the one this company is paid into.", "company", "No bank account yet — add the one this {one:lower} is paid into.")
                        : "No bank account yet. Whoever manages finance records can add one."
                    }
                  />
                </CardContent>
              </Card>
            )}

            {/* Its PAN as field access shows it here — the card reads the stored one for the rate. */}
            {vendorMsme && <VendorMsmeCard companyId={company.id} canManage={payouts?.canManage ?? false} msme={vendorMsme.msme} bills={vendorMsme.bills} />}

            {vendorTds && payouts && <VendorTdsCard companyId={company.id} canManage={payouts.canManage} {...vendorTds} pan={company.masked.pan && vendorTds.pan ? company.panNumber : vendorTds.pan} />}

            {isCommissionParty && commissionsOn && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">{slot(w, "Linked companies", "company", "Linked {many:lower}")}</CardHeader>
                <CardContent>
                  <p className="mb-3 text-xs text-muted">
                    The customer companies this commission party refers business from — commission on their orders gets
                    paid out to this party.
                  </p>
                  <LinkedCompaniesManager
                    ownerId={company.id}
                    side="commissionParty"
                    links={linkedCompanies}
                    companyOptions={clientCompanyOptions}
                  />
                </CardContent>
              </Card>
            )}

            {isCommissionParty && commissionsOn && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">Commission earned</CardHeader>
                <CardContent>
                  <CommissionPartyEarnings earnings={commissionEarnings} />
                </CardContent>
              </Card>
            )}

            {isCommissionParty && commissionsOn && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">Related parties (payee accounts)</CardHeader>
                <CardContent>
                  <p className="mb-3 text-xs text-muted">
                    This commission party may want to be paid into different accounts — their own, a firm, or a family
                    member&apos;s — for different deals. Add one entry per account.
                  </p>
                  <CommissionPartyAccountsManager commissionPartyId={company.id} accounts={commissionPartyAccounts} />
                </CardContent>
              </Card>
            )}

            {domainsEnabled && domainBriefing && (
              <DomainPanel companyId={company.id} briefing={domainBriefing} />
            )}

            </div>
            <div className="min-w-0 space-y-6">
            {/* Other legal entities that are the same customer — any may pay the others' invoices (src/lib/companies/groups.ts). */}
            {!isVendor && <CompanyGroupCard companyId={company.id} userId={userId} />}
            <Card>
              <CardHeader className="text-sm font-medium text-text">{slot(w, "Company profile", "company", "{one} profile")}</CardHeader>
              <CardContent className="text-sm">
                <ProfileRows
                  rows={[
                    { label: "Relationship", value: relationshipTypeLabels[company.relationshipType] },
                    { label: "Industry", value: company.industry?.name ?? null },
                    { label: slot(w, "Company type", "company", "{one} type"), value: companyTypeName(company.companyType, await companyTypeOptions()) ?? null },
                    ...(!isVendor ? [{ label: "Category", value: company.customerCategory ? <CategoryChip category={company.customerCategory} /> : null }] : []),
                    { label: "Employees", value: headcountLabel(company.employeeCount) ?? null },
                    { label: "Website", value: company.website ?? null },
                    { label: "LinkedIn", value: company.linkedinUrl ?? null },
                    ...(!isVendor ? [{ label: "Payment terms", value: paymentTermsLabels[company.paymentTerms] }] : []),
                    { label: "D-U-N-S number", value: company.dunsNumber ?? null },
                    // What new documents for them start in (owner, 30 Oct 2026); none set is the workspace's own.
                    { label: "Currency", value: company.defaultCurrency ? `${company.defaultCurrency} — ${getCurrency(company.defaultCurrency).label}` : `Base (${baseCurrency()})` },
                  ]}
                />
              </CardContent>
            </Card>
            <RegistrationCard
              companyId={company.id}
              india={pack.india}
              canEdit={canEditCompany}
              panEditable={financeHere && !company.masked.pan}
              pan={company.panNumber}
              cin={registration?.cin ?? null}
              licence={{ number: registration?.tradeLicenceNumber ?? null, authority: registration?.tradeLicenceAuthority ?? null, expiresOn: licenceExpiresOn }}
              standing={licenceStanding(licenceExpiresOn, registrationToday)}
              taxNumbers={addressTaxNumbers(company.locations)}
              taxMasked={company.masked.gstin}
            />
            {/* Billing and shipping, on the profile rather than only under Locations.

                These are the two addresses anybody raising a document needs, and having to open
                another tab to read them is how they end up being typed from memory. Shown even
                when neither is marked, because an account with no billing address on file is
                something to fix rather than something to hide. */}
            <Card>
              <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
                Addresses
                <Link href={`?tab=locations`} className="text-xs font-medium text-muted hover:text-text hover:underline">
                  All {company.locations.length}
                </Link>
              </CardHeader>
              <CardContent className="space-y-4">
                {sameBillingAndShipping ? (
                  <AddressBlock
                    gstinChecks={gstinChecks}
                    gstinMasked={company.masked.gstin}
                    title="Billing and shipping"
                    locations={company.locations.filter((l) => l.isBilling)}
                    empty=""
                  />
                ) : (
                  <>
                <AddressBlock
                  gstinChecks={gstinChecks}
                  gstinMasked={company.masked.gstin}
                  title="Billing"
                  locations={company.locations.filter((l) => l.isBilling)}
                  empty="No billing address marked. Tick one under Locations and documents will default to it."
                />
                <AddressBlock
                  gstinChecks={gstinChecks}
                  gstinMasked={company.masked.gstin}
                  title="Shipping"
                  locations={company.locations.filter((l) => l.isShipping)}
                  empty="No shipping address marked."
                />
                  </>
                )}
              </CardContent>
            </Card>
            {!managedByReseller && (
              <CompanyRolesControl
                companyId={company.id}
                mainLabel={relationshipTypeLabels[company.relationshipType]}
                added={roles.added}
                addable={rolesAddable(company.relationshipType)}
                sideOwnerId={roles.sideOwnerUserId}
                people={assignableUsers.map((u) => ({ id: u.id, name: u.name }))}
                canEdit={canEditRoles}
                mainKind={company.relationshipType}
                resellersOn={await isModuleEnabled("resellers")}
              />
            )}
            {(roles.vendor || isCommissionParty) && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">
                  {isCommissionParty ? "Commission party details" : slot(w, "Vendor details", "vendor", "{one} details")}
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Type</span>
                    <span className="text-text">{relationshipTypeLabels[company.relationshipType]}</span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Onboarding status</span>
                    <span className="text-text">
                      {company.vendorStatus ? vendorStatusLabels[company.vendorStatus] : "—"}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">{isCommissionParty ? "Reference code" : slot(w, "Vendor code", "vendor", "{one} code")}</span>
                    <span className="text-text">{company.vendorCode ?? "—"}</span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Payment terms (from us to them)</span>
                    <span className="text-text">{paymentTermsLabels[company.paymentTerms]}</span>
                  </div>
                </CardContent>
              </Card>
            )}

            {companyFields && (
              <CustomFieldsCard
                groups={companyFields.shown}
                action={
                  <EditCustomFields
                    title={`More details — ${company.name}`}
                    fields={companyFields.form.fields}
                    initial={companyFields.form.values}
                    people={companyFields.form.people}
                    save={updateCompanyCustomFields.bind(null, company.id)}
                  />
                }
              />
            )}

            <Card>
              <CardHeader className="text-sm font-medium text-text">Record info</CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Source</span>
                  <span className="text-text">{company.source}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Account manager</span>
                  <span className="text-text">{company.owner?.name ?? "—"}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Caller</span>
                  <span className="text-text">{company.assignedTo?.name ?? "Unassigned"}</span>
                </div>
                {company.assignedBy && (
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Caller assigned by</span>
                    <span className="text-text">
                      {company.assignedBy.name} · {clock.date(company.assignedAt)}
                    </span>
                  </div>
                )}
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Added by</span>
                  <span className="text-text">{company.createdBy.name}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Added on</span>
                  <span className="text-text">{clock.date(company.createdAt)}</span>
                </div>
              </CardContent>
            </Card>
            </div>
          </div>
        )}

          {activeTab === "products" && itemsEnabled && canSeeOrders && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">
                {isReseller ? slot(w, "Orders placed (billed to this reseller)", "order", "{many} placed (billed to this reseller)") : "Products & Subscriptions"}
              </CardHeader>
              <CardContent>
                {managedByReseller && (
                  <p className="mb-3 text-xs text-muted">
                    Bought for them by {managedByReseller.name}. The subscription and support are this customer&apos;s;
                    the invoice sits with the reseller.
                  </p>
                )}
                {isReseller && (
                  <p className="mb-3 text-xs text-muted">
                    What this reseller has ordered and owes us. Anything bought for an end customer also appears in
                    that customer&apos;s own Products &amp; Subscriptions.
                  </p>
                )}
                {/* Orders the customer already had, entered after the fact (owner, 23 Nov 2026 — temporary, src/actions/past-order.ts). */}
                {canAddPastOrders && (
                  <div className="mb-3 flex justify-end">
                    <PastOrderButton companyId={company.id} items={itemOptions} locations={company.locations} vendors={vendorOptions} />
                  </div>
                )}
                <CompanyProductsList
                  companyId={company.id}
                  companyName={company.name}
                  products={productRows}
                  pastOrderIds={pastOrderIds}
                  paperwork={paperwork}
                  items={itemOptions}
                  locations={company.locations}
                  vendors={vendorOptions}
                  canEdit={canEditProducts}
                  canChangeTerms={isSuperAdmin}
                  // Deleting an order: the super admin's alone (src/actions/company.ts removeCompanyProduct).
                  canDelete={isSuperAdmin}
                  // Payments against an order are the Payments module's; seats added mid-term, Renewals'.
                  canRecordPayments={canRecordPayments && paymentsEnabled}
                  canDeletePayments={canDeletePayments && paymentsEnabled}
                  // As `createAddon` decides it: Renewals in the plan, and `orders.process`.
                  canAddSeats={(await isModuleEntitled("renewals")) && (await hasEffectivePermission(userId, "orders.process"))}
                />
              </CardContent>
            </Card>
          )}

          {activeTab === "archive" && hasArchive && (
            <div className="space-y-4">
              {archived && <ArchivedHistory companyId={company.id} />}
              {oldProposals && <OldProposals companyId={company.id} companyName={company.name} canMove={isSuperAdmin} />}
            </div>
          )}

          {activeTab === "documents" && documentsEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">
                {isVendor ? "Purchase documents" : "Sales documents"}
              </CardHeader>
              <CardContent>
                <CompanyDocuments
                  companyId={company.id}
                  documents={documents}
                  isVendor={isVendor}
                  managedByResellerName={managedByReseller?.name}
                  // The button raises a PO for a vendor and a proposal for anybody else.
                  canRaise={await hasEffectivePermission(userId, documentWriteKey(isVendor ? "PURCHASE_ORDER" : "PROPOSAL", "create"))}
                />
              </CardContent>
            </Card>
          )}

          {activeTab === "payments" && paymentsEnabled && paymentSummary && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Payments</CardHeader>
              <CardContent>
                <CompanyPayments
                  companyId={company.id}
                  companyName={company.name}
                  payments={companyPayments}
                  summary={paymentSummary}
                  canRecord={canRecordPayments}
                  canDelete={canDeletePayments}
                />
              </CardContent>
            </Card>
          )}

          {activeTab === "calls" && callsEnabled && (
            <Card>
              <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
                <span>Call history</span>
                <CallButton companyId={company.id} companyName={company.name} size="sm" />
              </CardHeader>
              <CardContent>
                <CallList
                  calls={companyCalls}
                  showCompany={false}
                  canDelete={isSuperAdmin}
                  canMessage={await mayQuickMessage()}
                  emptyMessage={slot(w, "Nobody has logged a call to this company yet.", "company", "Nobody has logged a call to this {one:lower} yet.")}
                />
              </CardContent>
            </Card>
          )}

          {activeTab === "visits" && visitsEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">{slot(w, "Field visits", "visit")}</CardHeader>
              <CardContent>
                <CompanyVisits companyId={company.id} visits={visits} expenseTotal={visitExpenses?.total ?? 0} />
              </CardContent>
            </Card>
          )}

          {activeTab === "meetings" && calendarEnabled && !isVendor && (
            <RecordMeetings record={{ kind: "company", id: company.id }} viewerId={userId} emptyText="No meetings scheduled with this customer yet — from here, a lead, a contact or a ticket." />
          )}

          {/* Payment reminders for this customer, and MSME interest on its late payments (src/lib/collect). */}
          {/* The statement of accounts the customer (or vendor) gets: a period, Print, PDF and Send email (owner, 31 Oct 2026). */}
          {activeTab === "statement" && statement && <StatementToolbar side="AR" companyId={company.id} />}
          {activeTab === "statement" && showVendorStatement && <StatementToolbar side="AP" companyId={company.id} />}
          {activeTab === "statement" && statement && <StatementCollectPanel companyId={company.id} companyRef={formatCompanyId(company.companySeq)} />}
          {activeTab === "statement" && statement && <CompanyStatement statement={statement} />}
          {activeTab === "statement" && statement && asVendor && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">As a vendor — what we owe them</CardHeader>
              <CardContent className="grid grid-cols-2 gap-3 text-sm @2xl:grid-cols-4">
                <div>
                  <div className="text-xs text-muted">Billed to us</div>
                  <div className="font-medium text-text">{formatCurrency(asVendor.billed)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">We&apos;ve paid</div>
                  <div className="font-medium text-text">{formatCurrency(asVendor.paid)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">We owe them</div>
                  <div className="font-medium text-text">{formatCurrency(asVendor.outstanding)}</div>
                </div>
                <div>
                  {/* Net against net, both in rupees: what they owe us after their payments on account, less what we owe them after ours. */}
                  <div className="text-xs text-muted">Net</div>
                  <div className={statement.netPosition - asVendor.outstanding >= 0 ? "font-medium text-text" : "font-medium text-danger"}>
                    {statement.netPosition - asVendor.outstanding >= 0
                      ? `They owe us ${formatCurrency(statement.netPosition - asVendor.outstanding)}`
                      : `We owe them ${formatCurrency(asVendor.outstanding - statement.netPosition)}`}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "credit" && creditProfile && <CompanyCredit companyId={company.id} profile={creditProfile} />}

          {activeTab === "commission" && showCommissionTab && (
            <CompanyCommission
              companyId={company.id}
              commissionParties={commissionParties}
              commissions={commissions}
              partyOptions={commissionPartyOptions}
            />
          )}

          {activeTab === "leads" && canSeeLeads && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">{slot(w, "Leads", "lead")}</CardHeader>
              <CardContent>
                {/* As the Leads list shows them (src/components/leads/company-leads.tsx). */}
                <CompanyLeads companyId={company.id} companyName={company.name} emptyMessage={slot(w, "No leads yet for this company.", "lead", "No {many:lower} yet for this company.")} />
              </CardContent>
            </Card>
          )}

          {activeTab === "projects" && projectsEnabled && (
            <CompanyProjects
              companyId={company.id}
              projects={companyProjects}
              canCreate={canManageProjects}
              asOf={new Date()}
            />
          )}

          {activeTab === "renewals" && itemsEnabled && renewalsEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">{slot(w, "Renewals", "renewal")}</CardHeader>
              <CardContent className="p-0">
                <RenewalsFilter
                  columns={8}
                  head={
                  <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-4 py-2.5">{slot(w, "Order ID", "order", "{one} ID")}</th>
                      <th className="px-4 py-2.5">Subscription</th>
                      <th className="px-4 py-2.5">Qty</th>
                      <th className="px-4 py-2.5">PO / Invoice #</th>
                      <th className="px-4 py-2.5">Start date</th>
                      <th className="px-4 py-2.5">Expiry date</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  }
                  rows={subscriptionProducts.map((p) => {
                      const status = getRenewalStatus(p.endDate);
                      const standing = renewalStanding(p);
                      return {
                        key: p.id,
                        standing,
                        node: (
                        <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                          <td className="px-4 py-2.5 font-mono text-xs text-muted">{formatOrderId(p.orderSeq)}</td>
                          <td className="px-4 py-2.5 font-medium text-text">{p.item.name}</td>
                          <td className="px-4 py-2.5 text-muted">
                            {p.quantity + addedSeats(p)}
                            {addedSeats(p) > 0 && (
                              <span className="block text-[11px] text-subtle">
                                {p.quantity} + {addedSeats(p)} added
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-muted">{p.poNumber ?? "—"}</td>
                          {/* Typed days, held as midnight UTC: the day itself, whatever the zone. */}
                          <td className="px-4 py-2.5 text-muted">{formatCalendarDay(p.startDate)}</td>
                          <td className="px-4 py-2.5 text-muted">{formatCalendarDay(p.endDate)}</td>
                          <td className="px-4 py-2.5">
                            {standing === "renewed" ? <Badge tone="blue">Renewed</Badge> : <Badge tone={status.tone}>{status.label}</Badge>}
                            {p.renewedBy && (
                              <span className="mt-0.5 block text-[11px] text-success">
                                Renewed — {formatOrderId(p.renewedBy.orderSeq)}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center justify-end gap-1">
                              {callsEnabled && !managedByReseller && (
                                <CallButton
                                  companyId={company.id}
                                  companyName={company.name}
                                  companyProductId={p.id}
                                  preferContact={callableContact}
                                  size="icon"
                                  variant="ghost"
                                />
                              )}
                              {renewalActions?.email && <CustomerNoticeButton companyProductId={p.id} companyName={company.name} />}
                              {renewalActions?.renew && <RenewButton companyProductId={p.id} />}
                            </div>
                          </td>
                        </tr>
                        ),
                      };
                    })}
                  empty={
                      <tr>
                        <td colSpan={8} className="px-4 py-6 text-center text-subtle">
                          No subscription products added directly to this company yet. Add one from the Products &
                          Subscriptions tab.
                        </td>
                      </tr>
                  }
                />
              </CardContent>
            </Card>
          )}
          {activeTab === "renewals" && itemsEnabled && renewalsEnabled && !isVendor && <RenewingElsewhere companyId={company.id} tabHref={tabHref("elsewhere")} />}

          {activeTab === "elsewhere" && !isVendor && <CompanyInstalledElsewhere companyId={company.id} canMakeLead={canSeeLeads && canCreateLeads} />}

          {activeTab === "locations" && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Locations</CardHeader>
              <CardContent>
                <p className="mb-3 text-sm text-muted">
                  {pack.india
                    ? "Each location has its own address and GST registration — useful when this company has offices in more than one state."
                    : "Each location has its own address — useful when this company has more than one office."}{" "}
                  New orders default to the primary location but can be assigned to any of them.
                </p>
                <LocationsManager
                  companyId={company.id}
                  locations={company.locations}
                  companyPan={company.masked.pan ? null : company.panNumber}
                  gstinChecks={gstinChecks}
                  hidden={{ address: company.masked.address, gstin: company.masked.gstin }}
                />
              </CardContent>
            </Card>
          )}

          {activeTab === "contacts" && canSeeContacts && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">{slot(w, "Contacts", "contact")}</CardHeader>
              <CardContent>
                <ContactsList
                  companyId={company.id}
                  companyName={company.name}
                  contacts={company.contacts.map((c) => ({ ...c, designationName: contactRoles[c.id] ?? null }))}
                  customFields={contactFields}
                  canMeet={canScheduleMeetings}
                  left={contactsLeft}
                  moves={contactMoves}
                  unconfirmed={unconfirmedBadges}
                  enrich={enrichProviders}
                />
              </CardContent>
            </Card>
          )}

          {activeTab === "assets" && showEstateTab && (
            <CompanyEstate companyId={company.id} companyName={company.name} />
          )}

          {activeTab === "feedback" && feedbackEnabled && (
            <CompanyFeedback companyId={company.id} companyName={company.name} />
          )}

          {activeTab === "portal" && canManagePortal && portalInPlan && !isVendor && (
            <CompanyPortalTab companyId={company.id} contacts={company.contacts} />
          )}

          {activeTab === "marketing" && marketingEnabled && canViewMarketing && (
            <CompanyMarketing companyId={company.id} companyName={company.name} />
          )}

          {activeTab === "tickets" && helpdeskEnabled && supportLoad && <SupportLoadPanel load={supportLoad} />}

          {activeTab === "tickets" && helpdeskEnabled && (
            <Card className="overflow-x-auto p-0">
              <div className="flex items-center justify-between border-b border-line px-5 py-4">
                <span className="text-sm font-medium text-text">{slot(w, "Tickets", "ticket")}</span>
                {canCreateTickets && (
                  <Link href={`/tickets/new?companyId=${company.id}`}>
                    <Button size="sm">{slot(w, "+ New ticket", "ticket", "+ New {one:lower}")}</Button>
                  </Link>
                )}
              </div>
              <TicketsTable tickets={companyTickets} showCompany={false} />
            </Card>
          )}

          {activeTab === "emails" && mailSummary && recentMail && (
            <CompanyEmails companyId={company.id} summary={mailSummary} recent={recentMail} />
          )}

          {activeTab === "forms" && showFormsTab && companyForms && <CompanyForms data={companyForms} />}

          {activeTab === "tasks" && tasksEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Tasks</CardHeader>
              <CardContent>
                <TaskList
                  tasks={companyTasks}
                  users={assignableUsers}
                  currentUserId={userId}
                  canDeleteAny={canDeleteAnyTask}
                  context={{ companyId: company.id }}
                />
              </CardContent>
            </Card>
          )}
      </div>
    </div>
  );
}

/**
 * The parts that hold something, a repeat of the one before left out — so a masked address's parts, each "********"
 * (src/lib/companies/masking.ts), read once rather than four times.
 */
function distinct(parts: (string | null | undefined)[]): string[] {
  return parts.filter((p): p is string => Boolean(p)).filter((p, i, all) => i === 0 || p !== all[i - 1]);
}

/** Saved GSTIN checks without the registered address and PIN they carry, where field access masks the address. */
function withoutAddress(checks: Record<string, GstinCheckView>, masked: boolean): Record<string, GstinCheckView> {
  if (!masked) return checks;
  return Object.fromEntries(Object.entries(checks).map(([gstin, check]) => [gstin, { ...check, address: null, pincode: null }]));
}

/**
 * One role's addresses.
 *
 * A list rather than a single address: a customer with three warehouses has three shipping
 * addresses, and picking one to show would make the other two invisible on the screen somebody
 * checks before raising a delivery note.
 */
function AddressBlock({
  title,
  locations,
  empty,
  gstinChecks,
  gstinMasked = false,
}: {
  title: string;
  locations: { id: string; label: string; address: string | null; city: string | null; state: string | null; pincode: string | null; gstNumber: string | null }[];
  empty: string;
  gstinChecks: Record<string, GstinCheckView>;
  /** Field access masks the GSTIN for this person here. */
  gstinMasked?: boolean;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-subtle">{title}</p>
      {locations.length === 0 ? (
        <p className="mt-1 text-sm text-subtle">{empty}</p>
      ) : (
        <ul className="mt-1 space-y-2.5">
          {locations.map((l) => (
            <li key={l.id} className="text-sm">
              <p className="font-medium text-text">{l.label}</p>
              <p className="whitespace-pre-line text-muted">
                {distinct([l.address, distinct([l.city, l.state]).join(", "), l.pincode]).join("\n") ||
                  "No address recorded"}
              </p>
              {/* The GSTIN belongs with the address it is registered at — it is the one thing on
                  an invoice that has to match the place of supply. A masked one has no check to show. */}
              {l.gstNumber && (
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-xs text-subtle">
                  {/* Kept in the same column everywhere: India's GSTIN, the UAE's TRN (src/components/companies/locations-manager.tsx). */}
                  <span className="font-sans">{workspacePack().india ? "GSTIN" : "TRN"}</span>
                  {l.gstNumber}
                  {!gstinMasked && <GstinBadge check={gstinChecks[l.gstNumber.trim().toUpperCase()] ?? null} />}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Loads the portal panel's starting state.
 *
 * Its own component so the fetch happens only when the tab is open — this is two queries plus a
 * settings read, and running them on every company page view to fill a tab nobody clicked would be
 * three round trips for nothing.
 */
async function CompanyPortalTab({
  companyId,
  contacts,
}: {
  companyId: string;
  contacts: { id: string; name: string; email: string | null }[];
}) {
  const [status, logins] = await Promise.all([portalStatusFor(companyId), portalLogins(companyId)]);
  if (!status.ok) return <p className="text-sm text-muted">{status.error}</p>;

  return (
    <CompanyPortalPanel
      companyId={companyId}
      initialOverride={status.data.override}
      initialStatus={{ allowed: status.data.allowed, because: status.data.because }}
      initialLogins={logins.ok ? logins.data : []}
      contacts={contacts.map((c) => ({ id: c.id, name: c.name, email: c.email ?? null }))}
    />
  );
}

/**
 * The company's own fields (src/lib/custom-fields) for its Details tab: in words for the card, and as
 * the Edit dialog starts with them.
 */
/** A vendor's own fields are the Vendors set; every other company's, the Companies set (owner, 8 Oct 2026). */
async function companyCustomFields(companyId: string, userId: string, entity: "COMPANY" | "VENDOR") {
  const values = await valuesFor(entity, companyId);
  // Field access on the company's page (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2): a masked field is shown
  // masked and left out of the Edit dialog, whose save keeps what it holds (`updateCompanyCustomFields`). The Companies
  // set only; a vendor's own fields aren't covered yet.
  // The card shows what "Show" revealed today in the clear; the Edit dialog still leaves out what the policy masks, as its
  // save does (owner, 5 Nov 2026 — wave B).
  const masker = entity === "COMPANY" ? await companyMasker(userId, "detail", [companyId]) : null;
  const [shown, form] = await Promise.all([
    displayFields(entity, userId, values, masker ? { present: masker.forCompany(companyId).customText } : {}),
    formSetup(entity, userId, values, { exclude: masker ? hiddenCustomKeys(masker) : [] }),
  ]);
  return { shown, form };
}

/**
 * The workspace's own contact fields for the Contacts tab: the inputs, and each contact's values — as
 * its edit form starts with them, and in words for its row (only those with a value). Nothing when
 * there are no fields this person sees.
 *
 * On a reseller's end customer the contact-detail ones (`isContactDetailField`) stay hidden like the
 * email and phone do — left out here, so they never reach the browser — unless this person may see
 * those (`getCompany` already decided it: `detailsRedacted`).
 */
async function contactCustomFields(
  contacts: { id: string; detailsRedacted: boolean }[],
  userId: string,
): Promise<ContactCustomFields | undefined> {
  const { fields, people } = await formSetup("CONTACT", userId);
  if (fields.length === 0) return undefined;
  const stored = await valuesOf("CONTACT", contacts.map((c) => c.id));
  const texts = await formatMany(fields, stored);
  const out: ContactCustomFields = { fields, people, values: {}, shown: {} };
  for (const c of contacts) {
    const own = c.detailsRedacted ? fields.filter((f) => !isContactDetailField(f.type)) : fields;
    out.values[c.id] = formValues(own, stored.get(c.id) ?? {});
    out.shown[c.id] = own.flatMap((f) => {
      const text = texts.get(c.id)?.[f.key];
      return text ? [{ key: f.key, label: f.label, text }] : [];
    });
  }
  return out;
}

/** The account's figures, one panel: cells side by side, wrapping onto full rows, lines between them. */
/**
 * A profile's fields, the filled ones first and the empty ones folded under them (owner, 15 Nov 2026 — a card of
 * dashes reads as nothing there; one click shows which are missing).
 */
function ProfileRows({ rows }: { rows: { label: string; value: React.ReactNode | null }[] }) {
  const filled = rows.filter((r) => r.value !== null && r.value !== "");
  const empty = rows.filter((r) => r.value === null || r.value === "");
  const line = (r: { label: string; value: React.ReactNode | null }) => (
    <div key={r.label} className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-muted">{r.label}</span>
      <span className="min-w-0 truncate text-right text-text">{r.value ?? "—"}</span>
    </div>
  );
  return (
    <div>
      {filled.map(line)}
      {empty.length > 0 && (
        <details className="group mt-1">
          <summary className="cursor-pointer list-none text-xs text-subtle hover:text-text">
            {empty.length} empty {empty.length === 1 ? "field" : "fields"} · <span className="group-open:hidden">Show</span>
            <span className="hidden group-open:inline">Hide</span>
          </summary>
          <div className="mt-1">{empty.map(line)}</div>
        </details>
      )}
    </div>
  );
}

/** Two letters for the header's tile: the first of the first two words that aren't "the" or a company suffix. */
function initialsOf(name: string): string {
  const words = name
    .replace(/^\s*m\/s\.?\s*/i, "")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(the|pvt|private|ltd|limited|llp|llc|inc|co)$/i.test(w));
  // One word: its first two letters ("Acme" → AC), as a tile with one letter looks unfinished.
  const two = words.length === 1 ? [...words[0]!].slice(0, 2).join("") : (words[0]?.[0] ?? "") + (words[1]?.[0] ?? "");
  return two.toUpperCase() || "?";
}

function StatStrip({ children }: { children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="-mb-px -mr-px flex flex-wrap">{children}</div>
    </Card>
  );
}

/** One figure: what it is, the number, and a line under it. A link where it opens a tab of its own. */
function Stat({ label, value, note, href, tone }: { label: string; value: React.ReactNode; note?: React.ReactNode; href?: string; tone?: "danger" }) {
  const body = (
    <>
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-0.5 text-base font-semibold tabular-nums ${tone === "danger" ? "text-danger" : "text-text"}`}>{value}</div>
      {note !== undefined && <div className="mt-0.5 text-xs text-subtle">{note}</div>}
    </>
  );
  const cell = "min-w-[9.5rem] flex-1 basis-[9.5rem] border-b border-r border-line px-4 py-3";
  return href ? (
    <Link href={href} className={`${cell} block transition-colors hover:bg-surface-sunken`}>
      {body}
    </Link>
  ) : (
    <div className={cell}>{body}</div>
  );
}
