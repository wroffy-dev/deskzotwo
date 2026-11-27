import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import { poolSettings } from "@/lib/tenancy/direct-client";
import { tenancyState, type PoolEntry, type Tenant } from "@/lib/tenancy/state";

/**
 * Every workspace's queries, through one Prisma client.
 *
 * Each workspace has a database of its own. One Prisma client serves them all: it is given a routing
 * adapter (Prisma's driver-adapter interface) which, for each query, takes the workspace the work
 * runs as — `db` (src/lib/db.ts) runs every call as its workspace — and sends it to that workspace's
 * own small pool of connections. A transaction stays on the connection it began on.
 *
 * Why one: a Prisma client builds a query compiler from the whole schema, which takes tens of
 * milliseconds of the process's only thread. With a client per workspace, a server with more busy
 * workspaces than it kept clients for spent nearly all its time opening them (docs/reports/
 * load-test.md). A pool costs a few milliseconds, most of them waiting for the server.
 *
 * What makes sharing safe:
 *   · a query outside any workspace is refused, never sent to a default;
 *   · Prisma merges findUnique calls of the same shape made in the same tick into one query, run in
 *     the first caller's context — two workspaces' lookups would be answered from one database. Here
 *     that merging is confined to one transaction's queries (one caller's, by construction), and if
 *     Prisma's internals ever move, the client refuses to start rather than share unsafely.
 * check:hardening proves both, against two real databases.
 *
 * Pools: a bounded number kept (TENANCY_MAX_CLIENTS), the least recently used idle one ended first —
 * never one with work on it; one retired while work runs on it is ended the moment the work does.
 * A connection unused for TENANCY_IDLE_CONNECTION_S closes by itself, so a quiet workspace holds none.
 *
 * The only file (with direct-client.ts, the control plane's and the reference database's) allowed
 * `new PrismaClient` — check:tenancy.
 */

const MAX_POOLS = Math.max(2, Number(process.env.TENANCY_MAX_CLIENTS?.trim() || 35));
const IDLE_MS = 10 * 60_000;
/** Ended after this whatever it runs — a transaction that never ended must not hold a pool forever. */
const BACKSTOP_MS = 2 * 60_000;

/**
 * The address a workspace's pool connects to: the workspace's own, unless TENANCY_POOLER_URL sends
 * the app's queries through PgBouncer — then its host and port, with the workspace's own role,
 * password and database, so PgBouncer keeps a pool per workspace and the role's limits still apply.
 * node-postgres sends unnamed statements, which PgBouncer's transaction mode takes as they are.
 * Migrations, backups and provisioning keep the direct address (tenant.dbUrl): they need a session.
 *
 * The pool: TENANCY_CONNECTION_LIMIT connections (2), each closed after TENANCY_IDLE_CONNECTION_S
 * unused (30) — unless the address already says (connection_limit, max_idle_connection_lifetime).
 * The defaults, 35 pools of 2, keep the worst case, 70, within a stock Postgres's 100 with room for
 * everything else.
 */
export function appUrl(url: string): string {
  const limit = process.env.TENANCY_CONNECTION_LIMIT?.trim() || "2";
  const idle = process.env.TENANCY_IDLE_CONNECTION_S?.trim() || "30";
  try {
    const u = new URL(url);
    const pooler = process.env.TENANCY_POOLER_URL?.trim();
    if (pooler) {
      const p = new URL(pooler);
      u.hostname = p.hostname;
      u.port = p.port;
    }
    if (!u.searchParams.has("connection_limit")) u.searchParams.set("connection_limit", limit);
    if (!u.searchParams.has("pool_timeout")) u.searchParams.set("pool_timeout", "10");
    if (!u.searchParams.has("max_idle_connection_lifetime")) u.searchParams.set("max_idle_connection_lifetime", idle);
    return u.toString();
  } catch {
    return url;
  }
}

// ─── Pools ─────────────────────────────────────────────────────────────────────────────────────

function close(entry: PoolEntry) {
  if (entry.closed) return;
  entry.closed = true;
  if (entry.backstop) clearTimeout(entry.backstop);
  entry.backstop = undefined;
  tenancyState().poolCounts.closed += 1;
  // Ending a pool lets what is running on it finish; nothing new is sent to a retired one.
  entry.adapter.then((adapter) => adapter.dispose()).catch(() => {});
}

function retire(entry: PoolEntry) {
  entry.retired = true;
  if (entry.inFlight <= 0) return close(entry);
  entry.backstop = setTimeout(() => close(entry), BACKSTOP_MS);
  entry.backstop.unref?.();
}

function release(entry: PoolEntry) {
  entry.inFlight -= 1;
  if (entry.retired && entry.inFlight <= 0) close(entry);
}

function entryFor(tenant: Tenant): PoolEntry {
  const { pools, poolCounts } = tenancyState();
  const now = Date.now();
  const hit = pools.get(tenant.id);
  if (hit && hit.url === tenant.dbUrl) {
    hit.lastUsed = now;
    // Re-inserted, so iteration order is least-recently-used first.
    pools.delete(tenant.id);
    pools.set(tenant.id, hit);
    return hit;
  }
  if (hit) {
    // The workspace moved to another database: the old pool goes, the new one comes.
    pools.delete(tenant.id);
    retire(hit);
  }
  for (const [id, entry] of pools) {
    if (now - entry.lastUsed > IDLE_MS && entry.inFlight <= 0) {
      pools.delete(id);
      retire(entry);
    }
  }
  // Least recently used first, but never one with work running on it: ending it would not free its
  // connections until the work ends, and the same request's next query would open a second pool.
  // While every kept pool is busy the process goes over the cap, by at most the work running at
  // once, and comes back under it as that finishes.
  for (const [id, entry] of pools) {
    if (pools.size < MAX_POOLS) break;
    if (entry.inFlight > 0) continue;
    pools.delete(id);
    retire(entry);
  }

  const { pool, schema } = poolSettings(appUrl(tenant.dbUrl), { max: 2 });
  if (schema !== "public") throw new Error(`Workspace "${tenant.slug}" is not in the public schema — every workspace database is, and the shared client assumes it.`);
  const entry: PoolEntry = {
    adapter: new PrismaPg(pool, {
      schema,
      // A connection the server dropped while idle (a restart, a database closed): said, not thrown.
      onPoolError: (err) => console.warn(`[${tenant.slug}] an idle database connection was dropped: ${err.message}`),
    }).connect(),
    url: tenant.dbUrl,
    lastUsed: now,
    inFlight: 0,
    retired: false,
    closed: false,
  };
  poolCounts.opened += 1;
  pools.set(tenant.id, entry);
  return entry;
}

// ─── The routing adapter ───────────────────────────────────────────────────────────────────────

type PgAdapter = Awaited<PoolEntry["adapter"]>;
type Query = Parameters<PgAdapter["queryRaw"]>[0];
type Isolation = Parameters<PgAdapter["startTransaction"]>[0];

function current(): PoolEntry {
  const tenant = tenancyState().als.getStore();
  if (!tenant) throw new Error("A workspace query outside any workspace. Queries go through db (src/lib/db.ts), which runs each as its workspace.");
  return entryFor(tenant);
}

async function counted<T>(work: (adapter: PgAdapter) => Promise<T>): Promise<T> {
  const entry = current();
  entry.inFlight += 1;
  try {
    return await work(await entry.adapter);
  } finally {
    release(entry);
  }
}

const router = {
  provider: "postgres" as const,
  adapterName: "deskzo-workspaces",
  queryRaw: (query: Query) => counted((adapter) => adapter.queryRaw(query)),
  executeRaw: (query: Query) => counted((adapter) => adapter.executeRaw(query)),
  executeScript: (script: string) => counted((adapter) => adapter.executeScript(script)),
  /** On the workspace's pool, and counted on it until committed or rolled back. */
  async startTransaction(isolation?: Isolation) {
    const entry = current();
    entry.inFlight += 1;
    let tx: Awaited<ReturnType<PgAdapter["startTransaction"]>>;
    try {
      tx = await (await entry.adapter).startTransaction(isolation);
    } catch (err) {
      release(entry);
      throw err;
    }
    let open = true;
    const end = () => {
      if (!open) return;
      open = false;
      release(entry);
    };
    // One connection: its queries one after another, as the Rust engine ran them. Code that awaits
    // several at once inside a transaction (Promise.all over tx) otherwise hands node-postgres
    // overlapping queries on one client, which it warns about now and refuses from pg 9.
    let queue: Promise<unknown> = Promise.resolve();
    const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
      const turn = queue.then(work, work);
      queue = turn.catch(() => {});
      return turn;
    };
    return {
      provider: tx.provider,
      adapterName: tx.adapterName,
      options: tx.options,
      queryRaw: (query: Query) => inTurn(() => tx.queryRaw(query)),
      executeRaw: (query: Query) => inTurn(() => tx.executeRaw(query)),
      commit: async () => {
        try {
          await tx.commit();
        } finally {
          end();
        }
      },
      rollback: async () => {
        try {
          await tx.rollback();
        } finally {
          end();
        }
      },
    };
  },
  // The same for every workspace: each database is in the public schema (entryFor makes sure).
  getConnectionInfo: () => ({ schemaName: "public", supportsRelationJoins: true }),
  dispose: () => closeAllPools(),
};

const factory = { provider: "postgres" as const, adapterName: "deskzo-workspaces", connect: async () => router };

type Batcher = { _requestHandler?: { dataloader?: { options?: { batchBy?: unknown } } } };
type BatchedRequest = { transaction?: { id?: string | number } };

/**
 * Columns left out of every query that doesn't name them, until every workspace has them.
 *
 * A query without a `select` — a sign-in's lookup of the person, an update's RETURNING — lists every
 * column Prisma knows. A release serves before `tenants:migrate` has reached every workspace
 * (docs/deploy-coolify.md), so a column added to a busy table would fail those queries in each
 * workspace still waiting its turn: nobody there could sign in. A query that wants one of these
 * names it in its `select`, and is ready for the column not to be there yet. (The client is typed
 * as if nothing were left out; nothing reads these but by name.)
 *
 * Take an entry out in a later release, once every workspace is past the migration that added it.
 */
const NOT_YET_EVERYWHERE = {
  // 20261228100000_help_desk_phase_2: whether a kind of help desk request is approved first, read and written by name in
  // src/lib/desks/server.ts, whose pages wait for the migration (help-desk-gate.tsx).
  deskRequestType: { approval: true },
  // 20261225200000_copilot_review: when a chat's owner deleted it, read and written by name in src/lib/copilot/review.ts,
  // which takes a workspace without it as chats deleted outright, as before.
  copilotConversation: { hiddenAt: true },
  // 20261221800000_smart_lists_phase_4: a Deskzo Connect guest's change in a Smart List row's history, written and read by
  // name in src/lib/smart-lists/history.ts, which takes a workspace without it as no guest changes.
  workbookRowChange: { byGuestId: true },
  // 20261220600000_nurture_replies: nurture phase 4's switches and an email's send time, read and written by name in
  // src/lib/nurture/server.ts, which takes a workspace without them as auto-start off, booking links on, sent at once.
  nurtureSettings: { autoStart: true, autoStartSince: true, bookingLinks: true },
  nurtureTouch: { sendAt: true },
  // 20261218600000_asset_types: an asset's own type, read and written by name in src/lib/assets/types.ts, which takes a
  // workspace without it as Deskzo's eleven kinds.
  asset: { typeId: true },
  // 20261216700000_project_customer_tasks: a stage the customer does, read and written by name in src/lib/projects/portal.ts
  // and src/actions/project-portal.ts (projectStageEmails is beside customerEmailSettings' other entry below).
  projectPortalStage: { customerTask: true },
  // 20261216400000_project_questionnaires: a project type's questions, read and written by name in
  // src/actions/project-questionnaire.ts, which takes a workspace without it as types with none.
  projectType: { questions: true },
  // 20261216200000_billing_plans: whether a plan keeps renewing on itself, read by name in src/lib/recurring-billing and
  // src/actions/recurring-billing.ts, which take a workspace without it as renewing once.
  recurringBilling: { keepRenewing: true },
  // 20261216100000_audience_smart_list: the Smart List an audience follows, read and written by name in
  // src/lib/marketing/smart-list-audience.ts, which takes a workspace without it as audiences with none.
  audience: { smartListId: true },
  // 20261215620000_notification_email_default_subject: every notification email's subject, read by name in
  // src/lib/notifications/email-settings.ts, which takes a workspace without it as Deskzo's subject.
  // 20261218100000_notification_email_default_body: the frame's message, read the same way (owner, 18 Nov 2026).
  notificationEmailLayout: { subject: true, body: true },
  // 20261215400000_portal_asset_requests: the machine a portal request is about, read and written by name in
  // src/lib/portal/assets.ts and src/actions/portal.ts, which take a workspace without it as no asset requests.
  portalRequest: { assetId: true },
  // 20261215100000_domain_social_links: the company's social pages, read and written by name in src/actions/domain.ts,
  // which takes a workspace without the column as none found.
  // 20261215500000_domain_favicon: the site's icon, read by name in src/actions/domain.ts and the company page
  // (src/lib/domain-intel/favicon.ts), which take a workspace without the column as no icon.
  domainProfile: { socialLinks: true, favicon: true },
  // 20261213200000_unconfirmed_contacts (contact.unconfirmedFrom, merged into the contact entry below): a visitor-made
  // contact on an existing company, read by name in src/lib/contacts/unconfirmed.ts, which takes a workspace without
  // it as everyone confirmed.
  // 20261213140000_customer_mail_cap: the 24-hour limit, read by name in src/lib/customer-mail-cap.ts, which takes a
  // workspace without it as no limit.
  customerEmailSettings: { maxPerRecipientPerDay: true, projectStageEmails: true },
  // 20261208110000_capture_key_credit: who a website form's leads are raised by, read by name in src/lib/lead-capture/credit.ts,
  // which tolerates a workspace not migrated yet.
  leadCaptureKey: { creditMode: true, creditUserId: true, creditLabel: true, rateWindowStart: true, rateWindowCount: true }, // + 20261213100000_lead_intake_guards
  // 20261207110000_web_visitor_invite: a chat started for a visitor, read by name in src/lib/inbox/activity.ts, whose ping
  // tolerates a workspace not migrated yet.  Visitor rows are written without a select on every page view.
  webVisitor: { inviteConversationId: true, inviteAt: true },
  // 20261207120000_verifiable_search: read by name in src/actions/verifiable.ts and src/lib/verifiable/search.ts.
  // and 20261207130000_certificate_fields_and_design.
  verifiableDocument: { numberKey: true, inSearch: true, holderIsPerson: true, customFields: true },
  // 20261201280000_marketing_template_design: the email builder's design, read and written on its own by
  // src/actions/email-builder.ts, which tolerates a workspace not migrated yet.
  marketingTemplate: { design: true },
  // 20261212120000_id_card_version: read and raised by name in src/lib/id-cards/cards.ts, which tolerates a workspace
  // not migrated yet (every card is version 0 there).
  employeeProfile: { idCardVersion: true },
  // 20261212130000_device_key_and_customer_knowledge: a terminal's secret address, read by name in the iclock route and
  // src/actions/biometric.ts; and which AI Knowledge files the website bot may use, read by name in
  // src/lib/ai-knowledge. Both tolerate a workspace not migrated yet.
  biometricDevice: { accessKeyHash: true },
  aiKnowledgeFile: { forCustomers: true },
  // 20261124140000_inbox_needs_person. Read by name in src/lib/inbox (report.ts and the list), written on its own
  // where a customer first needs a person; the inbox tolerates a workspace not migrated yet.
  // and 20261124150000_inbox_visitor_info: the visitor panel's facts, written on their own and read by name.
  conversation: {
    needsPersonAt: true,
    visitorCountry: true,
    visitorRegion: true,
    visitorCity: true,
    visitorTimezone: true,
    visitorLanguage: true,
    visitorDevice: true,
    visitCount: true,
    lastSeenAt: true,
    pagesSeen: true,
    // 20261124160000_inbox_team_tools: tags, the customer's rating, the emailed follow-up.
    tags: true,
    rating: true,
    ratingComment: true,
    ratingAskedAt: true,
    ratedAt: true,
    followUpAt: true,
    // 20261124170000_inbox_customer_company: the company they're from.
    customerCompany: true,
  },
  // 20261122140000_restore_safety_and_workspace_reset. Read by name in src/lib/backup (the safety copy
  // before a restore or a reset, and the retention that keeps it), which tolerates a workspace not
  // migrated yet.
  backup: { reason: true, keepUntil: true },
  // 20261127120000_lead_assignment_performance. Read by name in src/lib/leads/assign.ts, which falls back to the
  // older conditions where a workspace isn't migrated yet. And 20261213090000_lead_limits: a rule's overflow mode, read
  // with a column probe in the same file (owner, 12 Nov 2026 — Phase 4 lead limits).
  leadAssignmentRule: { countries: true, cities: true, pincodes: true, customerCategoryIds: true, itemIds: true, responseHours: true, overflow: true },
  // 20261201160000_uae_vat_categories. Read by name in src/lib/vat (the return, the print, the line's default), written
  // only by a workspace outside India — India's lines and items never carry one. The item's is with its others below.
  tradeDocumentLine: { taxCategory: true },
  // 20261130220000_mail_blocks. Read by name in src/lib/mail-blocks.ts, which treats a workspace not migrated yet as
  // having no all-mail blocks (its blocks by hand still stop marketing and reminders, as before).
  suppression: { allMail: true },
  // 20261202120000_marketing_opt_in_switch. Read by name in src/lib/marketing/policy.ts, which treats a workspace not
  // migrated yet as not asking for an opt-in.
  marketingPolicy: { requireOptIn: true },
  // 20261203100000_reminder_threads. Read by name in src/lib/collect/settings.ts, which treats a workspace not migrated
  // yet as sending each reminder as its own email.
  collectionSettings: { reminderThread: true, senderMode: true, collectionsFromName: true, collectionsEmail: true },
  // 20261203120000_reminder_review. Read by name in src/lib/collect (sender.ts, review.ts); a workspace not migrated
  // yet sends every step by itself, as before.
  paymentReminder: { snoozedUntil: true, subject: true, body: true, decidedByUserId: true },
  // 20261203140000_notice_cc. Read by name in src/lib/marketing/pipeline.ts `sendQueued`, written by
  // src/lib/marketing/order-notice.ts; a workspace not migrated yet sends a notice uncopied, as before.
  marketingMessage: { ccEmails: true },
  // 20261122150000_workspace_reset_mode. Read by name in src/lib/workspace-reset.ts, which refuses to run a reset
  // whose kind it can't read rather than guess it.
  workspaceReset: { mode: true },
  // 20261112100000_automate_builder. Read by name in src/lib/automate (refs, the builder, converting
  // pipeline automations); Automate tolerates a workspace not migrated yet.
  automationWorkflow: { workflowSeq: true, migratedFrom: true },
  // 20261114100000_automate_webhooks. Read by name in src/lib/automate/webhooks.ts.
  automationWebhook: { requireSignature: true },
  // 20261116100000_automate_advanced_steps. Read by name in src/lib/automate/engine.ts.
  automationRun: { parentRunId: true, parentStepKey: true },
  // 20261117100000_deskzo_ai_credits. Read by name in src/lib/copilot/settings.ts, which treats a workspace
  // without them as drafting wherever the copilot is on, with no daily cap.
  copilotSettings: { draftingEnabled: true, dailyCreditLimit: true },
  // 20261118130000_deskzo_app_calls. Read by name in src/lib/app (the Deskzo app's call sync) and the call list.
  callLog: { source: true, appDeviceId: true, phoneCallKey: true, reviewedAt: true },
  // 20261118140000_app_web_pages. Read by name in src/lib/app. And 20261201130000_app_device_last_call_sync: written
  // on its own in src/lib/app/calls.ts, read by name for Settings › Security › Access › Phones.
  appDevice: { secretDigest: true, lastCallSyncAt: true },
  // 20261122160000_field_work. Read by name in src/lib/expenses/receipts.ts, which treats a workspace without it as
  // never requiring a receipt.
  expenseSettings: { receiptRequiredAbove: true },
  // 20261130150000_renewal_watch. Read by name in src/lib/renewal-lapse.ts (`renewalConfig`), which treats a workspace
  // without them as the defaults.
  // and 20261130170000_renewal_nobody_recipients, read by name in src/lib/renewal-lapse.ts and src/lib/notify.ts — no one
  // chosen, every admin, until it is there; and 20261130180000_renewal_customer_reminders, read by name in
  // src/lib/renewal-lapse.ts — no customer reminders until it is there; and 20261213110000_renewal_customer_cc, read by
  // name there too — nobody copied until it is there; and 20261223500000_renewal_team_cc, read by name in
  // src/lib/renewal-team-copies.ts — the team's reminders copied to nobody until it is there.
  oldProposal: { attachments: true },
  renewalSettings: { reminderDays: true, escalateManagerDays: true, escalateAdminDays: true, taskLeadDays: true, weeklyList: true, nobodyRecipientIds: true, customerReminderDays: true, customerReminderCc: true, customerReminderCcManager: true, teamReminderCc: true },
  // 20261130190000_department_assign_teams. Read by name in src/lib/companies/assign-teams.ts, which takes a workspace
  // without them as no department ticked — anyone may be given the company.
  // and 20261221600000_department_lead_owner_team, read by name there and in src/actions/department.ts.
  department: { callerTeam: true, accountManagerTeam: true, renewalManagerTeam: true, leadOwnerTeam: true },
  // 20261118170000_app_browser_sign_in. Read by name in src/lib/app/pairing.ts.
  appPairing: { codeChallenge: true },
  // 20261013100000_deskzo_updates_seen. Read by name in src/actions/help.ts only.
  user: { deskzoUpdatesSeenAt: true, reminderSounds: true },
  // 20261014100000_custom_fields. Read by name (`select` or `omit: { customFields: false }`) through
  // src/lib/custom-fields/server.ts, which treats a workspace without the column as having no values.
  // and 20261119100000_company_two_roles: read by name through src/lib/companies/roles.ts, which treats a
  // workspace without them as every company having its one kind.
  // and 20261130100000_renewal_manager: read by name through src/lib/companies/renewal-manager.ts, which treats a
  // workspace without it as every renewal being its account manager's.
  // and 20261201100000_currency_defaults_and_rates: read by name through src/lib/companies/default-currency.ts, which
  // treats a workspace without it as every company in the workspace's own currency.
  // 20261214500000_company_former_names (company.formerNames): read and searched through src/lib/companies/former-names.ts,
  // which asks whether the column is there first.
  company: { customFields: true, alsoCustomer: true, alsoVendor: true, sideOwnerUserId: true, renewalManagerId: true, defaultCurrency: true, formerNames: true },
  // 20261201120000_fx_revaluation_and_bank_currency: an EEFC account's currency, read by name through
  // src/lib/finance/bank-currency.ts, which treats a workspace without it as every account in its own currency.
  bankAccount: { currency: true },
  // 20261201140000_foreign_pay_links: read by name in src/lib/collect (gateways.ts, links.ts) and the payment
  // collection settings, which treat a workspace without them as no gateway taking international payments and no
  // link held.
  paymentGateway: { internationalOn: true },
  paymentLink: { heldReason: true },
  // 20261119110000_activity_subjects: written and read by name in src/lib/audit.ts and src/lib/activity, which
  // write an entry without them, and show no Activity, where a workspace doesn't have them yet.
  auditLog: { companyId: true, leadId: true, changes: true },
  // and 20261029100000_contact_left, 20261029110000_designations_vendor_fields_reminders: read by name in
  // src/lib/contacts/left.ts, designations.ts and moves.ts. user.reminderSounds: src/actions/reminder-sounds.ts.
  contact: { customFields: true, leftAt: true, designationId: true, previousContactId: true, unconfirmedFrom: true },
  // 20261015100000_lead_pipeline. Read by name through src/lib/pipeline/server.ts and the lead actions.
  // and 20261102100000_team_pipelines: the pipeline and the lead carried on from, read by name through
  // src/lib/pipeline/server.ts; a stage's pipeline and rule, read by name there and in src/actions/pipeline.ts.
  // and 20261127200000_lead_idempotency_key: read by name in createLead (src/actions/lead.ts), which makes the
  // lead without it where a workspace isn't migrated yet.
  lead: { customFields: true, stageId: true, stageChangedAt: true, pipelineId: true, fromLeadId: true, idempotencyKey: true, idempotencyHash: true }, // + 20261213100000_lead_intake_guards
  leadStage: { pipelineId: true, requiredFields: true },
  // and 20261122110000_finance_accounts: the item's batch, expiry and serial tracking, barcode and reorder
  // quantity, read by name in src/lib/inventory and the item screens.
  item: { customFields: true, trackBatches: true, trackExpiry: true, trackSerials: true, barcode: true, reorderQuantity: true, taxCategory: true },
  // 20261122110000_finance_accounts. A movement's warehouse, cost and source, read by name in src/lib/inventory.
  stockMovement: {
    warehouseId: true, batchId: true, serialNumbers: true, movementDate: true, unitCost: true, value: true,
    sourceType: true, sourceId: true, sourceLineId: true, tradeDocumentId: true, stockDocumentId: true,
    idempotencyKey: true, reversesId: true,
  },
  // 20261122110000_finance_accounts. Read by name in src/lib/ledger/journal.ts and src/lib/accounts.
  journalEntry: { postingKey: true, accountVoucherId: true, stockDocumentId: true },
  // 20261016100000_order_steps. Read by name through src/lib/pipeline/order-steps-server.ts.
  // + 20261216300000_order_vendor_invoice, 20261216500000_order_vendor_billed_amount: the vendor's invoice number and what
  // it billed, read by name in src/lib/orders/vendor-invoice.ts.
  companyProduct: { customFields: true, stepId: true, stepChangedAt: true, vendorInvoiceNumber: true, vendorBilledAmount: true },
  // 20261018100000_workplace_sign_in_and_mail. A Zoho mailbox's details are read by name in
  // src/lib/mail/mailbox.ts.
  mailConnection: { zohoAccountsServer: true, zohoMailAccountId: true },
  // 20261129130000_zoho_daily_call_limit. Read by name in src/lib/zoho/client.ts (zohoAllowance), which falls back to
  // the plan's limit where a workspace isn't migrated yet; and 20261129160000_zoho_nightly_top_up, read by name in
  // src/lib/zoho/nightly.ts, which takes a workspace not migrated yet as having it off.
  zohoConnection: { dailyCallLimit: true, nightlyTopUp: true, nightlyTopUpById: true },
  // 20261129140000_portal_codes. Read by name in src/lib/portal/device.ts (portalRequiresCode), which takes a workspace
  // not migrated yet as asking for none.
  portalSettings: { requireCode: true },
  // 20261129150000_custom_field_secrets_files. Read by name in src/lib/custom-fields/server.ts (portalKeys), which
  // takes a workspace not migrated yet as showing no field in the portal.
  customFieldDefinition: { showInPortal: true },
  // 20261019100000_watermark_scope. The DLP policy is read on every page; read by name in
  // src/lib/security/store.ts.
  securityPolicy: { watermarkScope: true },
  // 20261028110000_bank_accounts_vendor_codes. Read by name in src/lib/companies/vendor-code.ts and
  // src/lib/banking/organisation-accounts.ts, which fall back when the column is not there yet.
  // and 20261121100000_letter_signatures_templates: read by name in src/lib/organisation.ts (the letter signature).
  // …and 20261201290000_marketing_utm: read and written on its own (src/lib/marketing/utm-settings.ts).
  organisationSettings: { vendorCodePrefix: true, letterSignatureDataUrl: true, letterSignByDefault: true, marketingUtm: true, importDay: true, importRows: true }, // + 20261213100000_lead_intake_guards
  // and 20261122120000_geo_attendance: the office's point and attendance rule, read by name in src/lib/hr/clock.ts
  // and src/actions/attendance-locations.ts, which treat a workspace without them as enforcing nothing.
  branch: { defaultBankAccountId: true, latitude: true, longitude: true, geofenceRadiusM: true, geoMaxAccuracyM: true, geofenceEnforced: true, geoExceptionsAllowed: true },
  // 20261122120000_geo_attendance: how a clocking's location was checked — written and read by name in src/lib/hr/clock.ts.
  attendanceLocation: { check: true, branchId: true, distanceM: true, radiusM: true, mocked: true, exceptionId: true },
  // and 20261029120000_document_cancel_reason_pi_issued: read by name in src/lib/documents/cancellation.ts.
  // and 20261122110000_finance_accounts: the warehouse its goods leave or arrive in (src/lib/inventory/documents.ts).
  tradeDocument: { bankAccountId: true, cancelReason: true, cancelledAt: true, cancelledById: true, paidBefore: true, warehouseId: true },
  // 20261108100000_support_reply_from. Read by name in src/lib/support-mail/send.ts and
  // src/actions/support-mail.ts, which treat a workspace without them as replying through Deskzo.
  supportMailSettings: { replyFrom: true, companyFrom: true },
  // 20261110100000_field_access_unmask. Read by name in src/lib/authz/role-registry.ts and
  // src/actions/role.ts, which treat a workspace without it as having every role active.
  role: { active: true },
  // 20261110160000_income_tax_tds. Read by name in src/actions/payroll.ts and the payslip screens, which
  // show how TDS was worked out — the payroll pages need the migration.
  // And 20261201200000_employee_loans: the month's loan recovery, read by name in payroll, the payslip and the ledger.
  // And 20261201210000_payslip_pf_split: the PF return's figures, read by name in src/lib/hr/statutory-data.ts.
  // And 20261214100000_payslip_bank_copy (security audit round three, R3-11): the account copied at lock, read by name in
  // src/actions/payroll.ts and src/lib/hr/statutory-data.ts, which fall back to the employee record without it.
  payslip: { incomeTaxBasis: true, taxWorking: true, customEarnings: true, loanRecovery: true, pfWages: true, epsWages: true, epsEmployer: true, bankAccountNumber: true, bankIfsc: true, bankName: true, bankHolderName: true },
  // 20261201250000_insurance_learning_referrals: who referred a candidate, read by name in src/actions/referrals.ts.
  candidate: { referredById: true },
  // 20261121110000_salary_components_revisions. Read by name in src/actions/payroll.ts (STRUCTURE_EXTRAS),
  // src/actions/settlement.ts and src/actions/employee-docs.ts — the salary pages need the migration, as
  // the payroll pages do; and a payslip's custom earnings by the payslip screens.
  // and 20261123100000_salary_statutory_fixed: PF, ESI and TDS fixed at the split, read by name the same way.
  salaryStructure: { customComponents: true, annualCtc: true, revisionBasis: true, revisionValue: true, statutoryFixed: true },
  // 20261121100000_letter_signatures_templates. Read by name in src/actions/employee-docs.ts and the letter
  // pages, which treat a workspace without them as letters with no signature choice or template.
  employeeLetter: { signed: true, signatureDataUrl: true, templateId: true, templateName: true },
  // 20261110150000_leave_opening_balances. Asked for with `omit: TYPED_OPENING` in
  // src/lib/hr/leave-balance.ts, which every balance goes through — so the leave pages need the migration.
  leaveBalance: { openingTyped: true, usedBefore: true, openingNote: true },
  // 20261110140000_tasks_advanced. Asked for with `omit: ADVANCED` (src/lib/tasks/server.ts) by the task
  // actions — the Tasks page and the task lists on a company, lead and ticket — which need the migration;
  // everything else that reads a task keeps to the columns it always had.
  task: {
    status: true,
    priority: true,
    startDate: true,
    estimateMinutes: true,
    departmentId: true,
    challengeId: true,
    xp: true,
    xpSetById: true,
    badge: true,
    xpEarned: true,
    xpEarnedById: true,
    xpEarnedAt: true,
    repeat: true,
    repeatUntil: true,
    repeatedFromId: true,
  },
  // 20261113100000_native_calendar. Read by name in src/lib/calendar/native.ts, mirror.ts and sync.ts, which
  // treat a workspace without them as having none of Deskzo's own meetings (scheduling asks for a calendar).
  calendarEvent: { sequence: true, mirrorProvider: true, mirrorId: true, mirrorEtag: true, mirroredAt: true },
  // 20261130200000_telephony_incoming. Read by name in src/lib/telephony/ingest.ts (missing reads as on, as before)
  // and the Cloud calling settings.
  telephonyConnection: { incomingCallbacks: true },
  // 20261213210000_token_hashes (security audit round two, O6). Read by name in src/lib/portal/link-token.ts — a
  // workspace without them finds and shows its links by the plain token, as before.
  portalLogin: { tokenHash: true, tokenCipher: true },
  visitorKiosk: { tokenHash: true, tokenCipher: true },
} satisfies Prisma.GlobalOmitConfig;

/** The one client, made on first use. */
export function sharedClient(): PrismaClient {
  const state = tenancyState();
  if (state.shared) return state.shared;
  const client = new PrismaClient({ adapter: factory as unknown as Prisma.PrismaClientOptions["adapter"], omit: NOT_YET_EVERYWHERE }) as unknown as PrismaClient;
  // Same-tick findUnique calls are merged only within one transaction — see the top of this file.
  const options = (client as unknown as Batcher)._requestHandler?.dataloader?.options;
  if (!options || typeof options.batchBy !== "function") {
    throw new Error("Prisma's request batching is not where src/lib/tenancy/clients.ts expects it — refusing to share one client between workspaces. Check after upgrading Prisma.");
  }
  options.batchBy = (request: BatchedRequest) => (request.transaction?.id ? `transaction-${request.transaction.id}` : undefined);
  state.shared = client;
  return client;
}

/**
 * Runs `work` as the workspace, on the shared client, with the workspace's pool counted as busy
 * throughout — so it is not ended between two of the work's queries. What `work` returns is awaited
 * here, inside: a Prisma query is lazy and runs where it is awaited.
 */
export async function withClient<T>(tenant: Tenant, work: (client: PrismaClient) => PromiseLike<T>): Promise<T> {
  const entry = entryFor(tenant);
  entry.inFlight += 1;
  try {
    return await tenancyState().als.run(tenant, async () => await work(sharedClient()));
  } finally {
    release(entry);
  }
}

/**
 * The client as one workspace's — for a helper that takes a `PrismaClient`. Every call on it runs as
 * that workspace, wherever it is made; closing it closes nothing (the client is everybody's).
 */
export function clientFor(tenant: Tenant): PrismaClient {
  const shared = sharedClient();
  const run = (fn: (...args: unknown[]) => unknown, self: unknown, args: unknown[]) => withClient(tenant, async () => await (fn.apply(self, args) as PromiseLike<unknown>));
  return new Proxy(shared, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof prop !== "string") return value;
      if (prop === "then") return undefined;
      if (prop === "$disconnect" || prop === "$connect") return async () => {};
      if (typeof value === "function") return (...args: unknown[]) => run(value as (...a: unknown[]) => unknown, target, args);
      if (value && typeof value === "object" && !prop.startsWith("$") && !prop.startsWith("_")) {
        // A model: each of its operations runs as the workspace.
        return new Proxy(value as object, {
          get(delegate, method) {
            const fn = Reflect.get(delegate, method);
            return typeof fn === "function" ? (...args: unknown[]) => run(fn as (...a: unknown[]) => unknown, delegate, args) : fn;
          },
        });
      }
      return value;
    },
  });
}

/** Pools kept now, and opened and ended so far — for the load test and diagnostics. */
export function clientStats(): { kept: number; opened: number; closed: number; closing: number } {
  const { pools, poolCounts } = tenancyState();
  return { kept: pools.size, ...poolCounts, closing: poolCounts.opened - poolCounts.closed - pools.size };
}

async function closeAllPools(): Promise<void> {
  const { pools, poolCounts } = tenancyState();
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(
    all.map(async (entry) => {
      if (entry.closed) return;
      entry.closed = true;
      if (entry.backstop) clearTimeout(entry.backstop);
      poolCounts.closed += 1;
      await (await entry.adapter).dispose().catch(() => {});
    }),
  );
}

/** For scripts and check suites: end every workspace's pool now, so the process can exit. */
export async function closeAllClients(): Promise<void> {
  await closeAllPools();
}
