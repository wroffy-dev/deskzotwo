import { zohoChores } from "@/lib/zoho/pull";
import { nightlyChores } from "@/lib/zoho/nightly";
import { filingChores } from "@/lib/compliance/filings";
import { isModuleEnabled } from "@/actions/module";
import { runMarketingTick } from "@/lib/marketing/tick";
import { refreshStaleLeadScores } from "@/lib/leads/score-store";
import { refreshStaleCreditRatings } from "@/lib/credit/load";
import { detectSalesWins } from "@/lib/wins/detect";
import { announceActivityAwards } from "@/lib/performance/announce";
import { announcePrizes } from "@/lib/wins/prize-announce";
import { runRevenueAndClose } from "@/lib/close/nightly";
import { runOrderReleases } from "@/lib/orders/handoff";
import { runCollectionsDaily } from "@/lib/collections/daily";
import { sweepPayLinks } from "@/lib/collect/links";
import { runPaymentReminders } from "@/lib/collect/reminders";
import { runRecurringBilling } from "@/lib/recurring-billing/run";
import { calendarChores } from "@/lib/calendar/chores";
import { workTenant } from "@/lib/automate/engine";
import { platformPausedForWorker } from "@/lib/automate/switches";
import { signatureChores } from "@/lib/signatures/sync";
import { mailReadingChores } from "@/lib/mail-reading/server";
import { arjunMoneyMail, tellMailBills } from "@/lib/mail-reading/arjun";
import { taraReadsReplies } from "@/lib/mail-reading/tara";
import { supportReadsMail } from "@/lib/mail-reading/support";
import { purgeExpiredChat } from "@/lib/chat/retention";
import { purgeOldDeskzoSends } from "@/lib/documents/deskzo-mail-allowance";
import { emailReminders } from "@/lib/notifications/reminder-emails";
import { releaseHeldEmails } from "@/lib/notifications/held-emails";
import { telephonyChores } from "@/lib/telephony/sync";
import { leadResponseChores } from "@/lib/leads/response";
import { runRenewalLapses } from "@/lib/renewal-lapse";
import { runRenewalTasks } from "@/lib/renewal-watch";
import { runElsewhereReminders } from "@/lib/customers/elsewhere";
import { runListReminders } from "@/lib/smart-lists/reminders";
import { runFormulaDay } from "@/lib/smart-lists/formula-server";
import { runSmartListDay } from "@/lib/smart-lists/repeats";
import { runCustomerRenewalReminders } from "@/lib/renewal-customer-reminders";
import { runCustomerStats } from "@/lib/customers/stats";
import { fetchRatesInUse } from "@/lib/finance/rates";
import { fillWebsitesFromEmail } from "@/lib/companies/website-from-email";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import type { TickResult } from "@/lib/marketing/tick";
import { sweepWebActivity } from "@/lib/inbox/activity";
import { openDueJobs } from "@/lib/service-cycles/server";
import { deskChores } from "@/lib/desks/server";
import { resumeMergeJobs } from "@/lib/companies/gstin-merge";
import { runAutoPlans } from "@/lib/research/auto-plan";
import { runNurture } from "@/lib/nurture/server";
import { runReengage } from "@/lib/reengage/server";
import { readChaseReplies } from "@/lib/collections/chase-server";
import { runArjunMorning, runArjunWeekly } from "@/lib/collections/arjun-auto";
import { sweepRecordings } from "@/lib/calls/recordings";
import { sweepUnclaimedFieldFiles } from "@/lib/custom-fields/secure";
import { sweepOldCopilotConversations } from "@/lib/copilot/retention";
import { pruneTeammateWork } from "@/lib/ai/teammate-work";
import { runTeamWeekly } from "@/lib/ai/team-weekly";
import { runTeamDaily } from "@/lib/ai/team-daily";

const lastActivitySweep = new Map<string, number>();

/** What the tick reports for a workspace that has no campaigns to run. */
const NO_MARKETING: TickResult = { runId: "", enrolled: 0, stepped: 0, exited: 0, claimed: 0, sent: 0, failed: 0, tasks: 0, ms: 0 };

/**
 * Everything the app does on its five-minute heartbeat, for the workspace in hand — called by
 * /api/marketing/tick, once or for every workspace (src/lib/platform/fanout.ts).
 *
 * The marketing tick itself decides whether it succeeded; the rest ride along and are isolated, so
 * a scoring failure never reports the heartbeat as failed or stops it. Each part runs only where the
 * workspace has its module — in the plan and switched on; the wins announcements ask for themselves.
 */
export async function runHeartbeat() {
  // Website activity's clean-up (a year of pages, 90 days of addresses): once a day, on whichever heartbeat comes first.
  if (Date.now() - (lastActivitySweep.get(await tenantOrigin()) ?? 0) > 86_400_000) {
    lastActivitySweep.set(await tenantOrigin(), Date.now());
    await sweepWebActivity().catch((err) => console.error("website activity sweep failed", err));
    // Call recordings past the days the workspace keeps them (src/lib/calls/recordings.ts).
    await sweepRecordings().catch((err) => console.error("call recording sweep failed", err));
    // Vendor bills that came by email to a mailbox Arjun reads, told to its owner (src/lib/mail-reading/arjun.ts).
    await tellMailBills().catch((err) => console.error("telling of emailed bills failed", err));
    // Custom-field files uploaded and never saved on a record (security audit, 11 Nov 2026 — SEC-62).
    await sweepUnclaimedFieldFiles().catch((err) => console.error("custom field file sweep failed", err));
    // Security audit, 13 Nov 2026 (A7): copilot conversations nobody has touched in 90 days (src/lib/copilot/retention.ts).
    await sweepOldCopilotConversations().catch((err) => console.error("copilot conversation sweep failed", err));
    // Companies still without a website, from their people's work email — imports and every other way people arrive
    // (owner, 18 Nov 2026 — src/lib/companies/website-from-email.ts). Never over one already there.
    await fillWebsitesFromEmail();
  }
  // Service cycles' jobs now near become their owners' tasks (src/lib/service-cycles). Tasks are in every plan.
  // A background merge of duplicate companies the process stopped in the middle of (src/lib/companies/gstin-merge.ts).
  await resumeMergeJobs().catch((err) => console.error("company merge job failed", err));
  // New leads researched and planned by Deskzo AI by itself, where switched on (src/lib/research/auto-plan.ts).
  await runAutoPlans().catch((err) => console.error("auto research & plan failed", err));
  // Leads being nurtured: the next email drafted for its owner to send, or the nurture ended (src/lib/nurture).
  await runNurture().catch((err) => console.error("nurture failed", err));
  // Quiet customers: Tara's check-ins for their account managers, where switched on, and those approved sent (src/lib/reengage).
  await runReengage().catch((err) => console.error("re-engaging customers failed", err));
  // Customers' money mail in the mailboxes Arjun may read, handed to the same reader (src/lib/mail-reading/arjun.ts).
  await arjunMoneyMail().catch((err) => console.error("Arjun's money mail failed", err));
  // Leads' and customers' replies in the mailboxes Tara and Ved may read, to Tara's readers (src/lib/mail-reading/tara.ts).
  await taraReadsReplies().catch((err) => console.error("Tara's mailbox replies failed", err));
  // Customers' emails about a problem, in the mailboxes Support may read, to tickets with Kabir's draft (src/lib/mail-reading/support.ts).
  await supportReadsMail().catch((err) => console.error("Support's mailbox tickets failed", err));
  // Customers' replies to chase emails, read by Arjun for a promise, a payment or a dispute (src/lib/collections).
  await readChaseReplies().catch((err) => console.error("reading chase replies failed", err));
  // Arjun by himself, where switched on: each morning's chase emails drafted for the hard cases, and the Monday note.
  await runArjunMorning().catch((err) => console.error("Arjun's morning drafts failed", err));
  await runArjunWeekly().catch((err) => console.error("Arjun's Monday note failed", err));
  // What the AI teammates did is kept 30 days (src/lib/ai/teammate-work.ts).
  await pruneTeammateWork();
  // On a Monday, once: what each person's AI team finished for them last week (src/lib/ai/team-weekly.ts).
  await runTeamWeekly().catch((err) => console.error("the AI team's weekly note failed", err));
  // Each working morning after nine, once: what the team did yesterday and what waits (src/lib/ai/team-daily.ts).
  await runTeamDaily().catch((err) => console.error("the AI team's morning note failed", err));
  if (await moduleAvailableForTenant("tasks")) await openDueJobs().catch((err) => console.error("service cycle jobs failed", err));
  // The internal help desk: requests past their time told, and one whose person has left back with its desk (src/lib/desks).
  await deskChores().catch((err) => console.error("help desk chores failed", err));
  // Links in the mail have to be absolute and work from outside: the workspace's own address.
  const origin = await tenantOrigin();
  // A plan without marketing sends nothing, even a campaign queued before the plan changed.
  const result = (await moduleAvailableForTenant("marketing")) ? await runMarketingTick(origin) : NO_MARKETING;
  /**
   * Lead scores. Part of a score is time — a lead nobody has touched gets colder by the day with
   * nothing about it changing — so scores not refreshed in 12 hours are recomputed, 500 at a time.
   */
  const leadScoresRefreshed = !(await moduleAvailableForTenant("leads"))
    ? 0
    : await refreshStaleLeadScores({ limit: 500 }).catch((err) => {
        console.error("lead score refresh failed", err);
        return 0;
      });
  /**
   * Credit ratings, for the same reason: an invoice passing its due date changes a rating with
   * nothing being written. Only the stored copy the Customer credit list sorts by — decisions always
   * recompute — so a failure here costs freshness, never a wrong approval.
   */
  const creditRatingsRefreshed = !(await moduleAvailableForTenant("receivables")) ? 0 : await refreshStaleCreditRatings({ limit: 500 }).catch((err) => {
    console.error("credit rating refresh failed", err);
    return 0;
  });
  /**
   * Sales wins: a target crossed by an invoice paid overnight, the month's top performer on the
   * 1st. Deals and first orders are caught the moment they happen too; this catches the rest.
   */
  const salesWins = await detectSalesWins().catch((err) => {
    console.error("sales wins detection failed", err);
    return { created: 0 };
  });
  /** The fortnight's most active people, the morning after it closes. Once — the award row is the claim. */
  const activityAward = await announceActivityAwards().catch((err) => {
    console.error("activity awards failed", err);
    return { announced: null };
  });
  /** What is up for grabs, as a month or fortnight opens. Once each — the announcement row is the claim. */
  const prizes = await announcePrizes().catch((err) => {
    console.error("prize announcements failed", err);
    return { announced: [] as string[] };
  });
  /**
   * Revenue & Close, once a day: the month-end checklist generated and checked, revenue recognised and
   * prepaids and accruals posted as the Automation account. Its own claim row decides who runs it; it
   * asks after its own module (and runs the postings without it while schedules are still running).
   */
  const revenueAndClose = await runRevenueAndClose().catch((err) => {
    console.error("revenue & close nightly failed", err);
    return { ran: false };
  });
  /**
   * Orders scheduled to go to purchase today, released once a day — its own claim row decides who runs
   * it. Purchase's screens release due orders as they load too, so this is the guarantee, not the only way.
   */
  const orderReleases = await runOrderReleases().catch((err) => {
    console.error("order release failed", err);
    return { ran: false, released: 0 };
  });
  /**
   * Collections, once a day: promises to pay resolved (kept, or broken once their day has passed), each
   * broken one told to whoever logged it and their manager, one summary to accounts, and that morning's
   * follow-up reminders where there is no task. Its own claim row decides who runs it.
   */
  const collections = await runCollectionsDaily().catch((err) => {
    console.error("collections daily failed", err);
    return { ran: false, broken: 0 };
  });
  /**
   * Payment recovery (src/lib/collect): pay-now links asked about again — a payment whose notice never came
   * is recorded, a link whose invoice was settled some other way is closed — and, from 9 in the morning, the
   * day's payment reminders and, on the 1st, statements. Only where Receivables is on; each asks for itself.
   */
  const receivablesOn = await moduleAvailableForTenant("receivables");
  const payLinks = !receivablesOn
    ? null
    : await sweepPayLinks().catch((err) => {
        console.error("pay link sweep failed", err);
        return null;
      });
  const paymentReminders = !receivablesOn
    ? null
    : await runPaymentReminders(new Date(), { budgetMs: 60_000 }).catch((err) => {
        console.error("payment reminders failed", err);
        return null;
      });
  /**
   * Recurring billing, once a day: subscriptions switched on to renew themselves are renewed on the
   * first day of their next term, and instalments that have begun are raised — all as drafts, with one
   * notice to whoever issues documents. Its own claim row decides who runs it; it asks after its modules.
   */
  const recurringBilling = await runRecurringBilling().catch((err) => {
    console.error("recurring billing failed", err);
    return { ran: false, drafts: 0 };
  });
  /**
   * Calendars: whoever is due is kept in step with Outlook, Google or Zoho — as many as a minute allows,
   * the longest-waiting first, the rest on the next beat — and meetings held go on their leads' timelines.
   * Only where Calendar is on; it asks for itself.
   */
  const calendars = await calendarChores({ budgetMs: 60_000 }).catch((err) => {
    console.error("calendar sync failed", err);
    return null;
  });
  /**
   * Email signatures: everybody's drawn afresh and only what changed put into Gmail or Zoho Mail — where
   * Signatures is in the plan, a suite is connected, and the company keeps them in step. It asks for itself.
   */
  const signatures = await signatureChores({ budgetMs: 45_000 }).catch((err) => {
    console.error("signature sync failed", err);
    return null;
  });
  /**
   * Reading the mailboxes an admin lets the AI teammates read (owner, 23 Nov 2026 — src/lib/mail-reading): each one forward
   * from where it got to, keeping only mail with somebody already in Deskzo. Nothing where reading is off.
   */
  const mailRead = await mailReadingChores({ budgetMs: 45_000 }).catch((err) => {
    console.error("mail reading failed", err);
    return null;
  });
  /**
   * Reminders by email: a task due or overdue, a callback, a meeting about to start… — the kinds the
   * workspace emails (Settings › Email notifications), for everyone, as they fall due. Nothing at all
   * where it emails none of them; as many people as a minute allows, the rest on the next beat.
   */
  const reminderEmails = await emailReminders({ budgetMs: 60_000 }).catch((err) => {
    console.error("reminder emails failed", err);
    return null;
  });
  /** Notification emails held overnight, sent once the hours open (10:00–17:45, workspace time). */
  const heldEmails = await releaseHeldEmails().catch((err) => {
    console.error("held notification emails failed", err);
    return null;
  });
  /**
   * Chat: messages older than the workspace keeps them (Settings → Chat), deleted once a workspace day.
   * Kept for good unless an admin chose otherwise.
   */
  const chatPurge = await purgeExpiredChat().catch((err) => {
    console.error("chat retention failed", err);
    return null;
  });
  /**
   * Deskzo Automate's workflows: the platform worker carries them out as they fall due; here too, so they
   * run — at most a beat late — wherever the worker isn't running. Every run is claimed under a lease and
   * every event and schedule once, so the two never do one twice. It asks for its module and switches.
   */
  const automate = (await platformPausedForWorker())
    ? null
    : await workTenant({ budgetMs: 45_000 }).catch((err) => {
        console.error("automate failed", err);
        return null;
      });
  /**
   * Cloud calling (src/lib/telephony): the business's CallerDesk call list read since the last beat — every
   * call kept for the line's figures, those to contacts logged on Calls, missed ones made callbacks. Only where
   * Calls is on; it asks for itself.
   */
  const telephony = await telephonyChores({ budgetMs: 45_000 }).catch((err) => {
    console.error("telephony sync failed", err);
    return null;
  });
  /**
   * Leads answered and leads left (src/lib/leads/response.ts): each new owner's first touch noted — the
   * performance share's answering time — and a lead untouched past its assignment rule's response hours moved
   * on by the same rule. Only where Leads is on; it asks for itself.
   */
  const leadResponse = await leadResponseChores(new Date(), { budgetMs: 30_000 }).catch((err) => {
    console.error("lead response sweep failed", err);
    return null;
  });
  /**
   * Renewals nobody renewed (src/lib/renewal-lapse.ts): a subscription ended past Settings › Renewals' days, not
   * renewed and not marked, is marked Lost — "Lapsed — not renewed" — its auto-renew off, its owner told.
   * Only where Renewals is on; it asks for itself.
   */
  const renewalLapses = await runRenewalLapses().catch((err) => {
    console.error("renewal lapse sweep failed", err);
    return null;
  });
  /**
   * Renewal tasks raised ahead (src/lib/renewal-watch.ts): Settings › Renewals' days before a subscription ends, a
   * "Renew …" task for its renewal manager, once a term. The reminders and escalations are the bell sweep's. Only where
   * Renewals is on; it asks for itself.
   */
  const renewalTasks = await runRenewalTasks().catch((err) => {
    console.error("renewal task sweep failed", err);
    return null;
  });
  /**
   * Renewals elsewhere (src/lib/customers/elsewhere.ts, owner 2 Nov 2026): a task for the account manager each entry's
   * own days before something a customer bought from another seller renews, once a renewal date. Where Companies is on.
   */
  const elsewhereReminders = await runElsewhereReminders().catch((err) => {
    console.error("installed elsewhere reminders failed", err);
    return null;
  });
  /**
   * Smart Lists' Date-column reminders (src/lib/smart-lists/reminders.ts, owner 20 Nov 2026): somebody told the set
   * days before each row's date, once a date. Where Smart Lists are on; it asks for itself and never throws.
   */
  await runListReminders();
  // Smart Lists' formulas that read today ("days until…"), worked out again once a day (phase 4). Never throws.
  await runFormulaDay();
  // Smart Lists' repeating rows, and public form answers past keeping — once a day (phase 4). Never throws.
  await runSmartListDay();
  /**
   * The renewal reminder the customer gets by itself (src/lib/renewal-customer-reminders.ts), on Settings › Renewals'
   * customer days; off where none are set. It asks for itself whether Renewals is on.
   */
  const customerReminders = await runCustomerRenewalReminders().catch((err) => {
    console.error("customer renewal reminders failed", err);
    return null;
  });
  /**
   * Each customer's history with us and its loyalty tier (src/lib/customers/stats.ts, owner 31 Oct 2026): worked out
   * whole once a day, where Companies is on; it claims the day's run itself so two ticks never both start it.
   */
  const customerStats = (await moduleAvailableForTenant("companies").catch(() => false))
    ? await runCustomerStats().catch((err) => {
        console.error("customer stats refresh failed", err);
        return null;
      })
    : null;
  /**
   * Exchange rates (src/lib/finance/rates.ts, owner 30 Oct 2026): the day's rate for each currency the workspace's
   * customers, vendors and documents use, fetched about once a day and kept — never over one somebody typed.
   */
  const exchangeRates = await fetchRatesInUse().catch((err) => {
    console.error("exchange rate fetch failed", err);
    return null;
  });
  /**
   * A pull from Zoho Books (src/lib/zoho/pull.ts) worked a minute a tick, page open or not, carrying on by itself the
   * day after Zoho's calls run out. Only where a pull is going; it asks for itself.
   */
  const zohoPull = await zohoChores({ budgetMs: 60_000 }).catch((err) => {
    console.error("zoho pull failed", err);
    return null;
  });
  /**
   * The night's top-up from Zoho (src/lib/zoho/nightly.ts), where it is turned on: what Zoho changed since the last
   * pull, fetched in the small hours and imported section by section once it is done.
   */
  const zohoNightly = await nightlyChores({ budgetMs: 60_000 }).catch((err) => {
    console.error("zoho nightly top-up failed", err);
    return null;
  });
  /**
   * The filing calendar (src/lib/compliance/filings.ts): GSTR-1, GSTR-3B, TDS deposited and its returns — told to whoever
   * keeps the books three days before each is due and the day after one was missed, until it is marked filed. Only where
   * Accounting is on.
   */
  const filings = (await isModuleEnabled("accounting").catch(() => false))
    ? await filingChores().catch((err) => {
        console.error("filing reminders failed", err);
        return null;
      })
    : null;
  // The count of documents sent through Deskzo's mail only matters for today; older rows go.
  await purgeOldDeskzoSends().catch((err) => console.error("deskzo send count purge failed", err));
  return {
    ...result,
    leadScoresRefreshed,
    creditRatingsRefreshed,
    salesWinsCelebrated: salesWins.created,
    activityAwardAnnounced: activityAward.announced,
    prizesAnnounced: prizes.announced,
    revenueAndCloseRan: revenueAndClose.ran,
    ordersReleased: orderReleases.released,
    promisesBroken: collections.broken,
    paidOnline: payLinks?.paid ?? 0,
    paymentRemindersSent: (paymentReminders?.sent ?? 0) + (paymentReminders?.statements ?? 0),
    recurringDrafts: recurringBilling.drafts,
    calendarsSynced: calendars?.synced ?? 0,
    meetingsHeld: calendars?.held ?? 0,
    signaturesSynced: signatures?.synced ?? 0,
    mailRead: mailRead?.kept ?? 0,
    chatMessagesPurged: chatPurge?.deleted ?? 0,
    remindersEmailed: reminderEmails?.emailed ?? 0,
    heldEmailsSent: heldEmails?.sent ?? 0,
    workflowRuns: automate?.runs ?? 0,
    cloudCallsRead: telephony?.reduce((n, t) => n + t.calls, 0) ?? 0,
    leadsMovedForNoResponse: leadResponse?.moved ?? 0,
    renewalsLapsed: renewalLapses?.marked ?? 0,
    renewalTasksRaised: renewalTasks?.raised ?? 0,
    elsewhereRemindersRaised: elsewhereReminders?.raised ?? 0,
    customerRenewalReminders: customerReminders?.sent ?? 0,
    customerStatsRefreshed: customerStats?.refreshed ?? 0,
    exchangeRatesFetched: exchangeRates?.fetched ?? 0,
    zohoPullsWorked: zohoPull?.worked ?? 0,
    zohoNightly: zohoNightly?.started ? `started, since ${zohoNightly.started}` : zohoNightly?.imported === undefined ? null : zohoNightly.imported ? "imported" : "importing",
    filingReminders: filings?.told ?? 0,
  };
}
