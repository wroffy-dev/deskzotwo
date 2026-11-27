import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { companiesOutOfReach } from "@/lib/companies/out-of-reach";
import { notFound } from "next/navigation";
import { FileText, MapPin } from "lucide-react";
import { CallButton } from "@/components/calls/call-button";
import { ScheduleMeetingButton } from "@/components/calendar/schedule-meeting-button";
import { RemindMeButton } from "@/components/reminders/remind-me-button";
import { myLeadRemindersFor } from "@/lib/lead-reminders";
import { RecordMeetings } from "@/components/calendar/record-meetings";
import { DomainPanel } from "@/components/domains/domain-panel";
import { ApolloPanel, type EnrichProvider } from "@/components/companies/apollo-panel";
import { apolloSetup, latestCompanyLookup } from "@/lib/apollo/server";
import { lushaSetup } from "@/lib/lusha/server";
import { mayWorkWithContactsOf } from "@/lib/authz/contact-access";
import { getDomainBriefing } from "@/actions/domain";
import { isModuleEnabled } from "@/actions/module";
import { getLead, leadConnections, updateLeadCustomFields } from "@/actions/lead";
import { leadOwnership } from "@/actions/lead-owner";
import { LeadOwnerControl } from "@/components/leads/lead-owner-control";
import { DeleteLeadButton } from "@/components/leads/delete-lead-button";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { formatLeadId } from "@/lib/order-id";
import { listLeadDocuments } from "@/actions/trade-document";
import { listLeadVisits } from "@/actions/visit";
import { listItemOptions } from "@/actions/item";
import { listTasks } from "@/actions/task";
import { listAssignableUsers } from "@/actions/company";
import { hasEffectivePermission } from "@/actions/permission";
import { accessLevel } from "@/lib/authz/access";
import { currentUser } from "@/lib/session";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CompanyLinks } from "@/components/companies/company-links";
import { CompanyStageBadge } from "@/components/companies/company-stage-badge";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { workspaceClock } from "@/lib/time/workspace";
import { LeadDocuments } from "@/components/leads/lead-documents";
import { LeadVisits } from "@/components/leads/lead-visits";
import { LeadWebActivity } from "@/components/inbox/web-activity";
import { activityOfLead } from "@/lib/inbox/activity";
import { LeadStatusBadge } from "@/components/leads/lead-status-badge";
import { LeadStatusControl } from "@/components/leads/lead-status-control";
import { leadStages, stagesOfLeads } from "@/lib/pipeline/server";
import { kindOf } from "@/lib/pipeline/rules";
import { LeadPipelineControls } from "@/components/leads/lead-pipeline-controls";
import { db } from "@/lib/db";
import { STILL_THERE } from "@/lib/contacts/left";
import { ActivityForm } from "@/components/leads/activity-form";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { activityGroupsFor, recordActivity } from "@/lib/activity/timeline";
import { RequirementsList } from "@/components/leads/requirements-list";
import { TaskList } from "@/components/tasks/task-list";
import { LeadScoreBadge, LeadScoreCard } from "@/components/leads/lead-score";
import { ResearchPlanCard } from "@/components/research/research-plan-card";
import { planCardData } from "@/lib/research/plan-view";
import { NurtureCard } from "@/components/research/nurture-card";
import { nurtureCardData } from "@/lib/nurture/view";
import { RecordTeam } from "@/components/ai/record-team";
import { leadTeam } from "@/lib/ai/record-team";
import { refreshLeadScoreQuietly } from "@/lib/leads/score-store";
import { keyCredit } from "@/lib/lead-capture/credit";
import { leadSourceLabel } from "@/lib/leads/source";
import { CategoryChip } from "@/components/customers/category-chip";
import { CustomFieldsCard } from "@/components/custom-fields/custom-fields-card";
import { InTheseLists } from "@/components/smart-lists/in-these-lists";
import { EditCustomFields } from "@/components/custom-fields/edit-custom-fields";
import { displayFields, formSetup, valuesFor } from "@/lib/custom-fields/server";
import { companyPath, leadPath } from "@/lib/record-links";
import { detailLeadMasker, redactorForLead } from "@/lib/leads/masking";
import { customFieldKey } from "@/lib/authz/field-policy";
import { unmaskUsageToday } from "@/lib/authz/unmask";
import { LeadUnmask } from "@/components/leads/lead-unmask";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";

/**
 * A lead's full detail — the requirement, its timeline, and the controls that move it along.
 * Rendered on its own page and again inside the Leads split view, so the two can't drift apart.
 */
export async function LeadDetail({ id }: { id: string }) {
  const sessionUser = await currentUser();
  const userId = sessionUser!.id;
  const [
    itemsEnabled,
    tasksEnabled,
    domainsEnabled,
    salesDocsEnabled,
    visitsEnabled,
    canEditProducts,
    canDeleteProducts,
    canDeleteAnyTask,
    calendarEnabled,
    canIssueDocuments,
    canScheduleMeetings,
  ] = await Promise.all([
    isModuleEnabled("items"),
    isModuleEnabled("tasks"),
    isModuleEnabled("domains"),
    isModuleEnabled("sales_documents"),
    isModuleEnabled("visits"),
    hasEffectivePermission(userId, "products.edit"),
    hasEffectivePermission(userId, "products.delete"),
    accessLevel(userId, "tasks", "delete").then((level) => level === "ALL"),
    isModuleEnabled("calendar"),
    // Create proposal is offered only to somebody who may raise one (owner, 8 Oct 2026).
    hasEffectivePermission(userId, "docs.createProposal"),
    hasEffectivePermission(userId, "meetings.schedule"),
  ]);
  // Deleting a lead is the super admin's alone (src/actions/super-admin-delete.ts).
  const canDeleteLead = await actingAsSuperAdmin(userId);
  const [lead, items, tasks, assignableUsers, documents, visits, ownership] = await Promise.all([
    getLead(id),
    itemsEnabled ? listItemOptions() : Promise.resolve([]),
    tasksEnabled ? listTasks({ leadId: id }) : Promise.resolve([]),
    // Also whose work the Activity feed can be narrowed to.
    listAssignableUsers(),
    salesDocsEnabled ? listLeadDocuments(id) : Promise.resolve([]),
    visitsEnabled ? listLeadVisits(id) : Promise.resolve([]),
    // Reassigning it here, and who had it — a failure is no control shown, never a page that fails.
    leadOwnership(id).catch(() => null),
  ]);
  if (!lead) notFound();
  // What they did on the website, for whoever may see it (owner, 6 Nov 2026 — src/lib/inbox/activity.ts).
  const webActivity = (await isModuleEnabled("inbox")) && (await hasEffectivePermission(userId, "website.activity")) ? await activityOfLead({ id: lead.id, contactId: lead.contactId }) : null;
  // Recomputed on view and stored, so what the page shows is never staler than the moment it opened —
  // and the list, which sorts by the stored figure, catches up at the same time.
  const score = await refreshLeadScoreQuietly(lead.id);
  // Deskzo AI's "Research & plan" (owner, 18 Nov 2026): shown to whoever may make one, or once one has been made.
  const planCard = await planCardData({ kind: "lead", id: lead.id }, userId).catch(() => null);
  // And nurturing it (phase 3, src/lib/nurture): four emails over two weeks, each sent by its owner.
  const nurtureCard = await nurtureCardData(lead.id, userId).catch(() => null);
  // Came in through a website form with no person credited: the name its admin chose, "Website" by default (src/lib/lead-capture/credit.ts).
  const formCredit = lead.captureKeyId && (!lead.createdBy || !lead.sourcedBy) ? (await keyCredit(lead.captureKeyId)).label : null;

  // A lead of theirs on an account they can't open (src/lib/authz/access.ts `leadsFollowing`): its name is no link.
  const companyShut = (await companiesOutOfReach(userId, [lead.company.id])).length > 0;
  // Fetched after the lead, because the briefing is keyed on the company the lead belongs to.
  const domainBriefing = domainsEnabled ? await getDomainBriefing(lead.company.id) : null;

  // The workspace's own stages (Settings → Pipeline, src/lib/pipeline): where this lead is, where it can go.
  // Its own pipeline's stages only — another team's is a move between pipelines (src/lib/pipeline).
  const [{ stages, pipelines }, stageOf, connections, companyContacts] = await Promise.all([
    leadStages(),
    stagesOfLeads([{ id: lead.id, status: lead.status }]),
    leadConnections(lead.id),
    db.contact.findMany({ where: { companyId: lead.company.id, ...STILL_THERE }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const stage = stageOf.get(lead.id)!;
  const stageChoices = stages.filter((s) => !s.archived && s.pipelineId === stage.pipelineId).map((s) => ({ id: s.id, label: s.label, status: s.status }));
  // Where an open lead may move: another pipeline in use, to one of its open stages.
  const moveTargets =
    connections?.multi && kindOf(lead.status) === "OPEN"
      ? pipelines
          .filter((p) => !p.archived && p.id !== stage.pipelineId)
          .map((p) => ({ id: p.id, name: p.name, stages: stages.filter((s) => s.pipelineId === p.id && !s.archived && kindOf(s.status) === "OPEN").map((s) => ({ id: s.id, label: s.label })) }))
          .filter((p) => p.stages.length > 0)
      : [];
  const closeDay = lead.expectedCloseDate ? new Date(lead.expectedCloseDate).toISOString().slice(0, 10) : "";

  // The workspace's own fields (src/lib/custom-fields) — whoever may open the lead may edit them, as
  // `updateLeadCustomFields` decides it.
  // Field access on this page (src/lib/leads/masking.ts): `getLead` has already masked the lead itself;
  // its custom fields are masked here the same way, and a masked one can't be edited until it's unmasked.
  const masker = await detailLeadMasker(userId, lead.id);
  const customValues = await valuesFor("LEAD", lead.id);
  const lockedCustom = Object.keys(customValues).filter((k) => masker.locked(customFieldKey(k)));
  const [customShown, customForm, unmaskUsage] = await Promise.all([
    displayFields("LEAD", userId, customValues, { present: (key, text) => masker.present(customFieldKey(key), text) ?? "" }),
    formSetup("LEAD", userId, customValues, { exclude: lockedCustom }),
    lead.masking.revealable.length > 0 ? unmaskUsageToday(userId) : Promise.resolve(null),
  ]);
  const concealed = new Set(lead.masking.concealed);
  // What people wrote about the lead elsewhere on this page — task and visit titles, documents,
  // meetings — quotes its fields too; those are masked in that text as well.
  const redact = await redactorForLead(userId, lead.id, masker);

  const company = lead.company;
  // Apollo or Lusha on the lead (owner, 15 Nov 2026): the company panel, for whoever may spend the credits and work with
  // the company's contacts — never where any of the lead's details are masked from them.
  const enrichProviders: EnrichProvider[] =
    concealed.size === 0 && (await hasEffectivePermission(userId, "companies.enrich")) && (await mayWorkWithContactsOf(userId, company.id))
      ? ([(await apolloSetup()).connected ? "apollo" : null, (await lushaSetup()).connected ? "lusha" : null].filter(Boolean) as EnrichProvider[])
      : [];
  const enrich = enrichProviders.length
    ? {
        last: await latestCompanyLookup(company.id),
        contacts: await db.contact.findMany({ where: { companyId: company.id, ...STILL_THERE }, orderBy: [{ isPrimary: "desc" }, { name: "asc" }], take: 20, select: { id: true, name: true, email: true, phone: true } }),
      }
    : null;
  // The address the deal belongs to: the account's primary site, which is what a rep means by "where
  // are they" — as `getLead` presents it, masked where this person's field access says.
  const place = lead.address.place ?? "";
  // A deal can be worked by someone other than whoever manages the account, so both are named
  // rather than collapsed into one "sales rep" that would be wrong half the time.
  const accountManager = company.assignedTo ?? company.owner ?? null;
  const clock = await workspaceClock();
  // Everything that happened to the lead and who did it (owner, 19 Oct 2026 — src/lib/activity): its
  // calls, notes, stage moves and edits, the kinds this person may see; `getLead` has checked they may open it.
  const [activity, activityGroups] = await Promise.all([recordActivity(userId, { leadId: lead.id }), activityGroupsFor(userId, "record")]);
  // The workspace's own words (Settings → Wording, src/lib/terms).
  const w = await getWording();

  return (
    <div className="@container space-y-6">
      {(lead.masking.concealed.length > 0 || lead.masking.revealable.length > 0) && (
        <LeadUnmask
          key={lead.id}
          leadId={lead.id}
          revealable={lead.masking.revealable.length > 0}
          revealed={lead.masking.revealed}
          concealed={lead.masking.concealed.length}
          // Still masked though theirs to reveal: what "Show" would reveal now (owner, 5 Nov 2026 — audit C.3.6, M-10).
          pending={lead.masking.revealable.filter((k) => lead.masking.concealed.includes(k)).length}
          usage={unmaskUsage}
        />
      )}
      {/*
        The header (owner, 15 Nov 2026 — "improve the ui"): the deal on the left with the room to read it; on the right,
        where it stands and the next step on top, then the day-to-day actions together in one toolbar.
      */}
      <div className="flex flex-col gap-4 @4xl:flex-row @4xl:items-start @4xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold leading-tight text-text">{lead.title}</h1>
            <LeadScoreBadge score={score?.score} />
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <CompanyLink shut={companyShut} href={companyPath(company.companySeq)} className="font-medium text-text hover:underline">
              {company.name}
            </CompanyLink>
            <CompanyStageBadge stage={company.stage} />
            <CategoryChip category={company.customerCategory} />
            {lead.contact && <span className="text-muted">· {lead.contact.name}</span>}
          </div>

          <p className="mt-1 text-sm text-muted">
            {[company.industry?.name, place].filter(Boolean).join(" · ") || "No address on file"}
          </p>

          <CompanyLinks website={company.website} linkedinUrl={company.linkedinUrl} />

          {connections && (connections.multi || connections.from || connections.into.length > 0) && (
            <p className="mt-1.5 text-xs text-subtle">
              Pipeline: <span className="text-muted">{connections.pipeline.name}</span>
              {connections.from && (
                <>
                  {" "}
                  · Carried on from{" "}
                  <Link href={leadPath(connections.from.leadSeq)} className="text-muted underline">
                    {connections.from.pipeline} #{connections.from.leadSeq}
                  </Link>
                </>
              )}
              {connections.into.map((l) => (
                <span key={l.id}>
                  {" "}
                  · Carried on into{" "}
                  <Link href={leadPath(l.leadSeq)} className="text-muted underline">
                    {l.pipeline} #{l.leadSeq}
                  </Link>
                </span>
              ))}
            </p>
          )}
          <div className="mt-1.5 text-xs text-subtle">
            Deal owner: <span className="text-muted">{lead.owner?.name ?? "Unassigned"}</span>
            {/* Assign or reassign it from the top too (owner, 20 Nov 2026) — the same control and rules as the panel below. */}
            {ownership && <LeadOwnerControl inline leadId={lead.id} ownerId={lead.owner?.id ?? null} ownership={ownership} />}
            {accountManager && accountManager.id !== lead.owner?.id && (
              <> · Account manager: <span className="text-muted">{accountManager.name}</span></>
            )}
          </div>
          {/* The AI team on this lead, one click each (owner, 20 Nov 2026 — src/lib/ai/record-team.ts). */}
          <RecordTeam record={{ kind: "lead", id: lead.id }} slots={leadTeam(planCard, nurtureCard)} />
        </div>

        <div className="flex shrink-0 flex-col gap-2 @4xl:items-end">
          <div className="flex flex-wrap items-center gap-2 @4xl:justify-end">
            <LeadStatusControl leadId={lead.id} current={{ id: stage.id, label: stage.label, status: stage.status }} stages={stageChoices} />
            {salesDocsEnabled && canIssueDocuments && (
              <Link href={`/documents/new?type=PROPOSAL&leadId=${lead.id}`}>
                <Button>
                  <FileText className="mr-1.5 h-4 w-4" />
                  Create proposal
                </Button>
              </Link>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 @4xl:justify-end">
            <div className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow-sm" role="group" aria-label="Actions">
              <CallButton
                companyId={company.id}
                companyName={company.name}
                leadId={lead.id}
                variant="ghost"
                // A masked number is no number to dial or to log a call against: only the real one, or none.
                contact={lead.contact ? { id: lead.contact.id, name: lead.contact.name, phone: concealed.has("phone") ? null : lead.contact.phone } : undefined}
              />
              {/* Icons, each named on hover (owner, 15 Nov 2026). */}
              {calendarEnabled && canScheduleMeetings && <ScheduleMeetingButton record={{ kind: "lead", id: lead.id }} size="icon" variant="ghost" />}
              {/* Their own "Remind me" on this lead (owner, 31 Oct 2026). */}
              <RemindMeButton target={{ kind: "lead", leadId: lead.id }} label={`${formatLeadId(lead.leadSeq)} — ${lead.title}`} reminder={(await myLeadRemindersFor(userId, [lead.id])).get(lead.id) ?? null} />
              {visitsEnabled && (
                <Link href={`/visits/new?companyId=${company.id}&leadId=${lead.id}`} title={slot(w, "Plan visit", "visit", "Plan {one:lower}")} aria-label={slot(w, "Plan visit", "visit", "Plan {one:lower}")}>
                  <Button variant="ghost" size="icon" tabIndex={-1}>
                    <MapPin className="h-4 w-4" />
                  </Button>
                </Link>
              )}
            </div>
            <LeadPipelineControls
              leadId={lead.id}
              details={{
                title: lead.title,
                description: lead.description ?? "",
                estimatedValue: lead.estimatedValue === null || lead.estimatedValue === undefined ? "" : String(lead.estimatedValue),
                expectedCloseDate: closeDay,
                contactId: lead.contactId ?? "",
              }}
              // Names one may not see aren't offered to choose from; the lead keeps its contact.
              contacts={concealed.has("contactName") ? companyContacts.filter((c) => c.id === lead.contactId).map((c) => ({ id: c.id, name: lead.contact?.name ?? c.name })) : companyContacts}
              moveTargets={moveTargets}
              locked={(["title", "description", "contactName"] as const).filter((f) => concealed.has(f))}
            />
            {canDeleteLead && <DeleteLeadButton leadId={lead.id} label={formatLeadId(lead.leadSeq)} iconOnly />}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-3">
        <div className="space-y-6 @3xl:col-span-2">
          {itemsEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Products required</CardHeader>
              <CardContent>
                <RequirementsList
                  leadId={lead.id}
                  requirements={lead.requirements}
                  items={items}
                  canEdit={canEditProducts}
                  canDelete={canDeleteProducts}
                />
              </CardContent>
            </Card>
          )}

          {salesDocsEnabled && (
            <LeadDocuments documents={redact.deep(documents)} leadId={lead.id} canCreate={canIssueDocuments} />
          )}

          {tasksEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Tasks</CardHeader>
              <CardContent>
                <TaskList
                  tasks={redact.deep(tasks)}
                  users={assignableUsers}
                  currentUserId={userId}
                  canDeleteAny={canDeleteAnyTask}
                  context={{ companyId: lead.company.id, leadId: lead.id }}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="text-sm font-medium text-text">Activity</CardHeader>
            <CardContent className="space-y-4">
              <ActivityForm leadId={lead.id} />
              <div className="border-t border-line pt-4">
                {/* Keyed to its newest line, so what was just logged shows when the page refreshes. */}
                <ActivityFeed
                  key={activity.items[0]?.id ?? "none"}
                  source={{ kind: "lead", id: lead.id }}
                  initial={activity}
                  groups={activityGroups}
                  people={assignableUsers.map((u) => ({ id: u.id, name: u.name }))}
                  zone={clock.zone}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {calendarEnabled && <RecordMeetings record={{ kind: "lead", id: lead.id }} viewerId={userId} redact={redact.deep} />}

          {visitsEnabled && <LeadVisits visits={redact.deep(visits)} leadId={lead.id} companyId={company.id} />}

          {webActivity && <LeadWebActivity activity={webActivity} clock={clock} />}

          {domainBriefing && <DomainPanel companyId={company.id} briefing={domainBriefing} />}

          {enrich && (
            <ApolloPanel
              companyId={company.id}
              contacts={enrich.contacts}
              last={enrich.last ? { at: enrich.last.at, found: enrich.last.found, provider: enrich.last.provider } : null}
              providers={enrichProviders}
            />
          )}

          {planCard && (planCard.mayPlan || planCard.plan) && (
            <div id="research-plan" className="scroll-mt-20">
              <ResearchPlanCard data={planCard} />
            </div>
          )}
          {nurtureCard && (nurtureCard.nurture || nurtureCard.enabled) && (
            <div id="nurture" className="scroll-mt-20">
              <NurtureCard key={nurtureCard.nurture?.touches.find((t) => t.status === "WAITING")?.id ?? "none"} data={nurtureCard} />
            </div>
          )}

          {score && <LeadScoreCard result={score} title={slot(w, "Lead score", "lead", "{one} score")} />}

          <Card>
            <CardHeader className="text-sm font-medium text-text">{slot(w, "Lead Details", "lead", "{one} Details")}</CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Stage</span>
                <LeadStatusBadge status={lead.status} stage={stage} lostReason={lead.lostReason} />
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Account status</span>
                <span className="text-text">{company.stage}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Owner</span>
                <span className="text-right text-text">
                  {lead.owner?.name ?? "Unassigned"}
                  {/* Why it landed on this person — so they, and whoever set the rules, can see. */}
                  {lead.assignmentNote && <span className="block text-[11px] text-subtle">{lead.assignmentNote}</span>}
                  {/* Reassigning it here, for whoever may, and who had it before (owner, 26 Oct 2026). */}
                  {ownership && <LeadOwnerControl leadId={lead.id} ownerId={lead.owner?.id ?? null} ownership={ownership} />}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-x-3">
                <span className="shrink-0 text-muted">Source</span>
                <span className="min-w-0 text-right text-text">
                  {leadSourceLabel(lead.source)}
                  {/* A page address can be long and unbroken: it wraps inside the card instead of running out of it. */}
                  {lead.sourceDetail && <span className="block break-all text-[11px] text-subtle">{lead.sourceDetail}</span>}
                </span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Account manager</span>
                <span className="text-text">{accountManager?.name ?? "—"}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">{slot(w, "Contact", "contact", "{one}")}</span>
                <span className="text-right text-text">{lead.contact?.name ?? "—"}</span>
              </div>
              {lead.contact && (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Email</span>
                    <span className="break-all text-right text-text">{lead.contact.email ?? "—"}</span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Phone</span>
                    <span className="text-right text-text">{lead.contact.phone ?? "—"}</span>
                  </div>
                </>
              )}
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Address</span>
                <span className="text-right text-text">{lead.address.line ?? "—"}</span>
              </div>
              {/* Who opened it, when somebody else owns it — support passing one on (owner, 1 Nov 2026). */}
              {lead.createdBy && lead.createdBy.id !== lead.owner?.id && (
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Raised by</span>
                  <span className="text-text">{lead.createdBy.name}</span>
                </div>
              )}
              {!lead.createdBy && formCredit && (
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Raised by</span>
                  <span className="text-text">{formCredit}</span>
                </div>
              )}
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Sourced by</span>
                <span className="text-text">{lead.sourcedBy?.name ?? formCredit ?? "—"}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Qualified by</span>
                <span className="text-text">{lead.qualifiedBy?.name ?? "—"}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Estimated value</span>
                <span className="text-text">{formatCurrency(lead.estimatedValue?.toString())}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Expected close</span>
                {/* A typed day, held as midnight UTC. */}
                <span className="text-text">{formatCalendarDay(lead.expectedCloseDate)}</span>
              </div>
              {lead.lostReason && (
                <div className="pt-2 text-danger">
                  <span className="font-medium">Reason: </span>
                  {lead.lostReason}
                </div>
              )}
              {lead.description && (
                <div className="whitespace-pre-line break-words border-t border-line pt-2 text-text">{lead.description}</div>
              )}
            </CardContent>
          </Card>

          <CustomFieldsCard
            groups={customShown}
            action={
              <EditCustomFields
                title={`More details — ${lead.title}`}
                fields={customForm.fields}
                initial={customForm.values}
                people={customForm.people}
                save={updateLeadCustomFields.bind(null, lead.id)}
              />
            }
          />
          {/* Smart Lists whose rows link to this lead (owner, 20 Nov 2026 — Smart Lists phase 2). */}
          <InTheseLists kind="LEAD" recordId={lead.id} />
        </div>
      </div>
    </div>
  );
}
