import type { StaffRole } from "@deskzo/control-client";
import { ALL_ROLES } from "@/lib/console-shared/roles";
import { PAGE_ROLES, type ConsolePageKey } from "@/lib/console-shared/nav";
import { consoleZone } from "@/lib/platform/console-clock";
import * as lib_platform_nav_counts from "@/lib/platform/nav-counts";
import { workspaceMigrationNames } from "@/lib/platform/schema-info";
import { sendStaffMail } from "@/lib/internal-api/staff-mail";

// The console's actions.
import * as act_console from "@/actions/platform/console";
import * as act_console_admin from "@/actions/platform/console-admin";
import * as act_console_ai from "@/actions/platform/console-ai";
import * as act_console_ai_teammates from "@/actions/platform/console-ai-teammates";
import * as act_console_ai_training from "@/actions/platform/console-ai-training";
import * as act_console_alert_recipients from "@/actions/platform/console-alert-recipients";
import * as act_console_alerts from "@/actions/platform/console-alerts";
import * as act_console_announcements from "@/actions/platform/console-announcements";
import * as act_console_automate from "@/actions/platform/console-automate";
import * as act_console_backups from "@/actions/platform/console-backups";
import * as act_console_billing from "@/actions/platform/console-billing";
import * as act_console_commissions from "@/actions/platform/console-commissions";
import * as act_console_directory from "@/actions/platform/console-directory";
import * as act_console_domains from "@/actions/platform/console-domains";
import * as act_console_help from "@/actions/platform/console-help";
import * as act_console_linked from "@/actions/platform/console-linked";
import * as act_console_mail from "@/actions/platform/console-mail";
import * as act_console_mail_queue from "@/actions/platform/console-mail-queue";
import * as act_console_mail_suppressions from "@/actions/platform/console-mail-suppressions";
import * as act_console_names from "@/actions/platform/console-names";
import * as act_console_offline from "@/actions/platform/console-offline";
import * as act_console_offsite from "@/actions/platform/console-offsite";
import * as act_console_partners from "@/actions/platform/console-partners";
import * as act_console_privacy from "@/actions/platform/console-privacy";
import * as act_console_sales_crm from "@/actions/platform/console-sales-crm";
import * as act_console_shell from "@/actions/platform/console-shell";
import * as act_console_signups from "@/actions/platform/console-signups";
import * as act_console_storage from "@/actions/platform/console-storage";
import * as act_console_support from "@/actions/platform/console-support";
import * as act_console_time_zone from "@/actions/platform/console-time-zone";
import * as act_console_website from "@/actions/platform/console-website";
import * as act_console_workspace from "@/actions/platform/console-workspace";

// What the console's pages read.
import * as lib_ai_training_models from "@/lib/ai-training/models";
import * as lib_platform_document_mail_limits from "@/lib/platform/document-mail-limits";
import * as lib_platform_helpdesk_from from "@/lib/platform/helpdesk-from";
import * as lib_platform_mail_templates from "@/lib/platform/mail/templates";
import * as lib_platform_tick_summary from "@/lib/platform/tick-summary";
import * as lib_storage_box from "@/lib/storage/box";
import * as app_platform_console__console__help_content_load from "@/app/platform-console/(console)/help-content/load";
import * as lib_ai_training_store from "@/lib/ai-training/store";
import * as lib_ai_accounts from "@/lib/ai/accounts";
import * as lib_ai_credits from "@/lib/ai/credits";
import * as lib_ai_teammate_looks from "@/lib/ai/teammate-looks";
import * as lib_automate_switches from "@/lib/automate/switches";
import * as lib_billing_tax_invoice from "@/lib/billing/tax-invoice";
import * as lib_bundle_console_data from "@/lib/bundle/console-data";
import * as lib_bundle_jobs from "@/lib/bundle/jobs";
import * as lib_bundle_restore from "@/lib/bundle/restore";
import * as lib_bundle_upload from "@/lib/bundle/upload";
import * as lib_cms_users from "@/lib/cms/users";
import * as lib_offsite_status from "@/lib/offsite/status";
import * as lib_partners_commission_data from "@/lib/partners/commission-data";
import * as lib_partners_console_data from "@/lib/partners/console-data";
import * as lib_platform_adoption_view from "@/lib/platform/adoption-view";
import * as lib_platform_alerts from "@/lib/platform/alerts";
import * as lib_platform_announcements from "@/lib/platform/announcements";
import * as lib_platform_audit_query from "@/lib/platform/audit-query";
import * as lib_platform_billing_events from "@/lib/platform/billing-events";
import * as lib_platform_console_data from "@/lib/platform/console-data";
import * as lib_platform_console_guard from "@/lib/platform/console-guard";
import * as lib_platform_console_page_reads from "@/lib/platform/console-page-reads";
import * as lib_platform_errors from "@/lib/platform/errors";
import * as lib_platform_health from "@/lib/platform/health";
import * as lib_platform_hsn_directory from "@/lib/platform/hsn-directory";
import * as lib_platform_linked_groups from "@/lib/platform/linked/groups";
import * as lib_platform_mail_log from "@/lib/platform/mail/log";
import * as lib_platform_mail_queue from "@/lib/platform/mail/queue";
import * as lib_platform_mail_store from "@/lib/platform/mail/store";
import * as lib_platform_mail_suppressions from "@/lib/platform/mail/suppressions";
import * as lib_platform_names_console from "@/lib/platform/names-console";
import * as lib_platform_onboarding from "@/lib/platform/onboarding";
import * as lib_platform_privacy_requests from "@/lib/platform/privacy-requests";
import * as lib_platform_reference_sync from "@/lib/platform/reference-sync";
import * as lib_platform_revenue from "@/lib/platform/revenue";
import * as lib_platform_settings from "@/lib/platform/settings";
import * as lib_platform_signups from "@/lib/platform/signups";
import * as lib_platform_storage_summary from "@/lib/platform/storage-summary";
import * as lib_platform_trials from "@/lib/platform/trials";
import * as lib_platform_workspace_data from "@/lib/platform/workspace-data";
import * as lib_platform_workspace_directory from "@/lib/platform/workspace-directory";
import * as lib_support_console from "@/lib/support/console";
import * as lib_support_settings from "@/lib/support/settings";

/**
 * What the admin app (wroffy-dev/deskzotwo-admin) may ask the CRM to do, by name. Nothing outside this
 * table can be called.
 *
 * ## Actions: `<module>.<function>`
 * The console's own server actions, called as they are: each one starts with `requireStaff(roles)`, which
 * inside an internal call answers with the admin app's staff member (src/lib/internal-api/actor.ts), so
 * the roles, refusals and audit entries are the ones the console always had. Never here: staff accounts,
 * staff sign-in, sessions and authenticators, which the admin app keeps in its own database.
 *
 * ## Loaders: `load.<function>`
 * What a console page reads. The page checked the role itself (`consoleStaff(PAGE_ROLES.x)`), so each
 * loader carries the role set of the pages that read it, checked again before it runs. Named one by one:
 * these modules also hold writers (chargeTurn, attachment access, getSecret), never reachable this way.
 * A page that read the control plane inline reads through src/lib/platform/console-page-reads.ts.
 *
 * The admin app's crm-sync.json lists the same names; its sync refuses a name the CRM doesn't have.
 */

type AnyFn = (...args: never[]) => Promise<unknown>;
export type Op = { kind: "action"; fn: AnyFn } | { kind: "loader"; fn: AnyFn; roles: readonly StaffRole[] };

/** Staff-account actions the admin app does itself; never callable here. */
const STAFF_ACCOUNT_ACTIONS = new Set([
  "consoleAddStaff",
  "consoleSetStaffRole",
  "consoleDeactivateStaff",
  "consoleEndStaffSessions",
  "consoleResetStaffTwoFactor",
  "consoleNewSetupLink",
  "consoleSetStaffTwoFactor",
  "consoleEndStaffSession",
  "consoleEndMySession",
  "consoleEndMyOtherSessions",
  "consoleReactivateStaff",
  "consoleMyPasswordLink",
  "consoleTouch",
]);

function actionsOf(prefix: string, mod: Record<string, unknown>): [string, Op][] {
  return Object.entries(mod)
    .filter(([name, fn]) => typeof fn === "function" && !STAFF_ACCOUNT_ACTIONS.has(name))
    .map(([name, fn]) => [`${prefix}.${name}`, { kind: "action", fn: fn as AnyFn }]);
}

const every = ALL_ROLES as readonly StaffRole[];
/** Everybody who may open any of these pages. */
function pages(...keys: ConsolePageKey[]): readonly StaffRole[] {
  const roles = new Set<StaffRole>();
  for (const key of keys) for (const role of (PAGE_ROLES[key] as readonly StaffRole[] | undefined) ?? every) roles.add(role);
  return [...roles];
}

function loader(fn: AnyFn, roles: readonly StaffRole[]): Op {
  return { kind: "loader", fn, roles };
}

/** The named read functions of a module, under `load.<function>`, for the roles given. */
function loadersOf(mod: Record<string, unknown>, names: readonly string[], roles: readonly StaffRole[]): [string, Op][] {
  return names.map((name) => {
    const fn = mod[name];
    if (typeof fn !== "function") throw new Error(`internal API: ${name} is not a function`);
    return [`load.${name}`, loader(fn as AnyFn, roles)];
  });
}

const sync = (fn: (...a: never[]) => unknown): AnyFn => (async (...a: never[]) => fn(...a)) as AnyFn;

export const OPS: ReadonlyMap<string, Op> = new Map<string, Op>([
  ...actionsOf("console", act_console),
  ...actionsOf("console-admin", act_console_admin),
  ...actionsOf("console-ai", act_console_ai),
  ...actionsOf("console-ai-teammates", act_console_ai_teammates),
  ...actionsOf("console-ai-training", act_console_ai_training),
  ...actionsOf("console-alert-recipients", act_console_alert_recipients),
  ...actionsOf("console-alerts", act_console_alerts),
  ...actionsOf("console-announcements", act_console_announcements),
  ...actionsOf("console-automate", act_console_automate),
  ...actionsOf("console-backups", act_console_backups),
  ...actionsOf("console-billing", act_console_billing),
  ...actionsOf("console-commissions", act_console_commissions),
  ...actionsOf("console-directory", act_console_directory),
  ...actionsOf("console-domains", act_console_domains),
  ...actionsOf("console-help", act_console_help),
  ...actionsOf("console-linked", act_console_linked),
  ...actionsOf("console-mail", act_console_mail),
  ...actionsOf("console-mail-queue", act_console_mail_queue),
  ...actionsOf("console-mail-suppressions", act_console_mail_suppressions),
  ...actionsOf("console-names", act_console_names),
  ...actionsOf("console-offline", act_console_offline),
  ...actionsOf("console-offsite", act_console_offsite),
  ...actionsOf("console-partners", act_console_partners),
  ...actionsOf("console-privacy", act_console_privacy),
  ...actionsOf("console-sales-crm", act_console_sales_crm),
  ...actionsOf("console-shell", act_console_shell),
  ...actionsOf("console-signups", act_console_signups),
  ...actionsOf("console-storage", act_console_storage),
  ...actionsOf("console-support", act_console_support),
  ...actionsOf("console-time-zone", act_console_time_zone),
  ...actionsOf("console-website", act_console_website),
  ...actionsOf("console-workspace", act_console_workspace),

  // The admin app's own staff mail, sent through the CRM's mail.
  ["admin.sendStaffMail", { kind: "action", fn: sendStaffMail as AnyFn }],

  // Every page's frame.
  ...loadersOf(lib_platform_nav_counts, ["navCounts"], every),
  ["load.consoleZone", loader(consoleZone as AnyFn, every)],
  ["load.workspaceMigrationNames", loader(sync(workspaceMigrationNames), every)],
  // Asked by components rather than pages.
  ...loadersOf(lib_platform_workspace_directory, ["workspacesCsv"], pages("workspaces")),
  ...loadersOf(lib_partners_console_data, ["partnerPicker"], pages("partners", "workspaces")),
  ...loadersOf(lib_platform_alerts, ["alertCounts"], every),
  ...loadersOf(lib_platform_tick_summary, ["lastTick"], pages("overview", "settings", "health", "billing")),
  ...loadersOf(lib_platform_document_mail_limits, ["documentMailLimits"], pages("settings")),
  ...loadersOf(lib_platform_helpdesk_from, ["helpdeskFromOwnAddress"], pages("settings")),
  ...loadersOf(lib_platform_mail_templates, ["savedWordings"], pages("settings")),
  ...loadersOf(lib_ai_training_models, ["teammateModels"], pages("settings")),
  ...loadersOf(lib_storage_box, ["storageBoxState"], pages("settings")),

  ...loadersOf(app_platform_console__console__help_content_load, ["helpContentList", "helpEditorChoices", "helpItemById"], pages("help")),
  ...loadersOf(lib_ai_training_store, ["listTrainingFiles", "trainingWorkspaces"], pages("settings")),
  ...loadersOf(lib_ai_accounts, ["aiSetup", "platformAiUsage"], pages("settings")),
  ...loadersOf(lib_ai_credits, ["consoleCreditView"], pages("workspaces")),
  ...loadersOf(lib_ai_teammate_looks, ["allLookRows"], pages("settings")),
  ...loadersOf(lib_automate_switches, ["platformPause"], pages("settings")),
  ...loadersOf(lib_billing_tax_invoice, ["readBank", "readSeller"], pages("settings")),
  ...loadersOf(lib_bundle_console_data, ["backupsBoard"], pages("backups")),
  ...loadersOf(lib_bundle_console_data, ["backupCountFor"], pages("workspaces")),
  ...loadersOf(lib_bundle_jobs, ["settleBackups"], pages("backups")),
  ...loadersOf(lib_bundle_restore, ["settleRestores"], pages("backups")),
  ...loadersOf(lib_bundle_upload, ["cleanStaleUploads"], pages("backups")),
  ...loadersOf(lib_cms_users, ["cmsAdminCount", "listCmsUsers"], pages("website")),
  ...loadersOf(lib_offsite_status, ["offsiteStatus"], pages("settings")),
  ...loadersOf(lib_partners_commission_data, ["commissionReview", "partnerReport", "statementDetail", "statementsBoard"], pages("commissions")),
  ...loadersOf(lib_partners_commission_data, ["partnerCommissionsTab", "partnerStatementsTab"], pages("partners")),
  ...loadersOf(lib_partners_console_data, ["workspaceAttribution"], pages("workspaces")),
  ...loadersOf(lib_partners_console_data, ["partnerActivity", "partnerCustomers", "partnerDirectory", "partnerHeader", "partnerOverview", "partnerPipeline", "partnerTermsView", "partnerUsersView", "programmeSettingsView", "requestsBoard"], pages("partners")),
  ...loadersOf(lib_platform_adoption_view, ["workspaceAdoption"], pages("workspaces")),
  ...loadersOf(lib_platform_alerts, ["alertsForTenant"], pages("workspaces")),
  ...loadersOf(lib_platform_alerts, ["alerts"], pages("alerts", "billing", "overview")),
  ...loadersOf(lib_platform_announcements, ["announcementById", "announcementTargets", "announcementsList"], pages("announcements")),
  ...loadersOf(lib_platform_audit_query, ["auditFacets", "auditQuery"], pages("audit")),
  ...loadersOf(lib_platform_billing_events, ["billingEvents"], pages("billing")),
  ...loadersOf(lib_platform_console_data, ["planDetail"], pages("plans")),
  ...loadersOf(lib_platform_console_data, ["plansList"], pages("partners", "plans")),
  ...loadersOf(lib_platform_console_data, ["consoleOverview"], pages("overview")),
  ...loadersOf(lib_platform_console_data, ["migrationsBoard"], pages("migrations")),
  ...loadersOf(lib_platform_console_data, ["billingOverview"], pages("billing")),
  ...loadersOf(lib_platform_console_data, ["invitesBoard"], pages("invites")),
  ...loadersOf(lib_platform_console_data, ["provisioningBoard"], pages("provisioning")),
  ...loadersOf(lib_platform_console_data, ["terminals"], pages("devices")),
  ...loadersOf(lib_platform_console_guard, ["staffNameMap"], pages("billing", "health")),
  ...loadersOf(lib_platform_console_page_reads, ["ownerEmails", "secretIsSet", "staffNameById", "staffNamesByIds", "waitingTaxInvoices", "workspaceCountries"], pages("settings")),
  ...loadersOf(lib_platform_console_page_reads, ["websiteCounts"], pages("website")),
  ...loadersOf(lib_platform_errors, ["errorStats", "listErrors"], pages("errors")),
  ...loadersOf(lib_platform_health, ["configurationPresence", "securityFacts"], pages("settings")),
  ...loadersOf(lib_platform_health, ["failingJobsSummary", "platformLeases", "systemHealth"], pages("health")),
  ...loadersOf(lib_platform_hsn_directory, ["readHsnDirectory"], pages("reference")),
  ...loadersOf(lib_platform_linked_groups, ["linkedSignInSetting"], pages("settings")),
  ...loadersOf(lib_platform_mail_log, ["listDeliveries"], pages("mail")),
  ...loadersOf(lib_platform_mail_queue, ["listMailJobs", "mailQueueStats"], pages("mail")),
  ...loadersOf(lib_platform_mail_store, ["mailSetup"], pages("settings")),
  ...loadersOf(lib_platform_mail_suppressions, ["platformSuppressionOverview"], pages("mail")),
  ...loadersOf(lib_platform_names_console, ["namesBoard"], pages("names")),
  ...loadersOf(lib_platform_onboarding, ["onboardingBoard"], pages("onboarding")),
  ...loadersOf(lib_platform_privacy_requests, ["listPrivacyRequests"], pages("privacy")),
  ...loadersOf(lib_platform_reference_sync, ["readPinDirectory", "readWorldPlaces"], pages("reference")),
  ...loadersOf(lib_platform_revenue, ["collectedByMonth", "mrrByCurrency"], pages("billing", "overview")),
  ...loadersOf(lib_platform_revenue, ["invoicesList", "mrrByPlan", "subscriptionStatusCounts", "subscriptionsList"], pages("billing")),
  ...loadersOf(lib_platform_revenue, ["trialCohorts"], pages("trials")),
  ...loadersOf(lib_platform_settings, ["signupOpen"], pages("settings", "signups")),
  ...loadersOf(lib_platform_settings, ["autoDeprovision", "customDomainsOffered", "gatewayModes", "getSetting", "settingsOverview", "staffTwoFactorPolicy", "trialDays", "trialSeats"], pages("settings")),
  ...loadersOf(lib_platform_signups, ["signupFunnel", "stuckSignups"], pages("signups")),
  ...loadersOf(lib_platform_storage_summary, ["storageSummary"], pages("settings")),
  ...loadersOf(lib_platform_trials, ["trialsBoard"], pages("trials")),
  ...loadersOf(lib_platform_workspace_data, ["workspaceBilling", "workspaceHeader", "workspaceNotes", "workspaceOps", "workspacePlan", "workspaceSupport", "workspaceTimeline", "workspaceUsage"], pages("workspaces")),
  ...loadersOf(lib_platform_workspace_directory, ["closedWorkspaces", "directoryFacets", "workspaceDirectory"], pages("workspaces")),
  ...loadersOf(lib_support_console, ["supportRequestsForTenant"], pages("workspaces")),
  ...loadersOf(lib_support_console, ["supportOverviewCounts"], pages("overview")),
  ...loadersOf(lib_support_console, ["supportInbox", "supportRequestDetail"], pages("support")),
  ...loadersOf(lib_support_settings, ["getSupportSettings"], pages("settings")),
]);
