import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { mayAttachTo } from "@/lib/authz/attachments";
import { isModuleEnabled } from "@/actions/module";
import { findCompanyMatches, getCompany, listAssignableUsers } from "@/actions/company";
import { companyMasker } from "@/lib/companies/masking";
import { listLeadsPaged } from "@/actions/lead";
import { listOrdersPaged } from "@/actions/order";
import { listRenewalsPaged } from "@/actions/renewal";
import { listTicketsPaged } from "@/actions/ticket";
import { listPeople } from "@/actions/hr";
import { getDashboardSummary } from "@/actions/dashboard";
import { reportOptions, runAnalyticsReport } from "@/actions/analytics";
import { formatCompanyId, formatLeadId, formatOrderId, parseSeqQuery } from "@/lib/order-id";
import { formatTicketId } from "@/lib/tickets";
import { workspaceClock } from "@/lib/time/workspace";
import { PEOPLE_ONLY } from "@/lib/people";
import { hasEffectivePermission } from "@/actions/permission";
import { companyNamedLike } from "@/lib/companies/by-name";
import { COPILOT_KNOWLEDGE_CHUNKS, copilotRender, fitKnowledge } from "@/lib/ai-knowledge/budget";
import { searchKnowledge } from "@/lib/ai-knowledge/search";
import { hasKnowledge } from "@/lib/ai-knowledge/store";
import { changeRows, draftLeadUpdate } from "@/lib/copilot/lead-update";
import type { DisplayBlock, ToolSpec } from "@/lib/copilot/types";
import { makeResearchPlan } from "@/actions/research-plan";
import { startNurture } from "@/actions/nurture";
import { arjunForMe, draftChaseEmail } from "@/actions/collection-chase";
import { companyPath, leadPath } from "@/lib/record-links";

/**
 * What the copilot can do — and the whole of the promise that it can't see or do more than the
 * person using it.
 *
 * Every read goes through an action the app's own screens use — `getCompany`, `listLeadsPaged`,
 * `runAnalyticsReport`… — which resolve the signed-in person and apply their account scope, their
 * view permissions and the reseller redaction themselves. Nothing here writes its own `where` over
 * business data, so nothing here can be wider than the screen it stands in for. The exceptions are
 * the person's own tasks, theirs by construction, and the products on the leads a list just returned.
 *
 * Nothing writes, either. "Create a task" and "change this lead's quantity" become proposals: a card
 * the person confirms, which then goes through the same action the app's form uses, as them.
 *
 * Each tool's input is checked against its schema before it runs, whichever provider produced it —
 * a model's arguments are untrusted text like any other request body.
 */

export type ToolContext = { userId: string; conversationId: string };
export type ToolOutcome = { output: unknown; blocks?: DisplayBlock[]; activity: string };

type CopilotTool = {
  name: string;
  description: string;
  schema: z.ZodType;
  /** The module that has to be on — for this person, which includes its view permission. */
  module?: string;
  /** Offered only while this says so — search_knowledge, once AI Knowledge has a file to search. */
  available?: () => Promise<boolean>;
  run(ctx: ToolContext, input: never): Promise<ToolOutcome>;
};

const tool = <S extends z.ZodType>(t: {
  name: string;
  description: string;
  schema: S;
  module?: string;
  available?: () => Promise<boolean>;
  run(ctx: ToolContext, input: z.infer<S>): Promise<ToolOutcome>;
}): CopilotTool => t as CopilotTool;

/** Kept short: every row here is paid for in tokens on every turn after it. */
const MAX_OUTPUT_CHARS = 12_000;
export const MAX_REPORT_ROWS = 40;

const money = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/**
 * `yyyy-mm-dd` for a column holding a typed calendar day — an order's end, a lead's close, a task's due
 * date — which is kept at UTC midnight: the day it holds, whatever the zone. A moment is the workspace's
 * day instead: `clock.dateKey`.
 */
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const limitField = z.number().int().min(1).max(25).optional().describe("How many to return, at most 25. Default 10.");

// ─── Resolving what the model names ──────────────────────────────────────────

async function companyIdFor(userId: string, ref: string): Promise<string | null> {
  const seq = parseSeqQuery(ref);
  const company = await db.company.findFirst({
    where: seq !== null ? { companySeq: seq } : { id: ref },
    select: { id: true, ownerUserId: true, relationshipType: true },
  });
  // Not there and not yours read the same, as they do everywhere else.
  return company && (await canSeeCompany(userId, company)) ? company.id : null;
}

async function leadIdFor(ref: string): Promise<string | null> {
  const seq = parseSeqQuery(ref);
  return (await db.lead.findFirst({ where: seq !== null ? { leadSeq: seq } : { id: ref }, select: { id: true } }))?.id ?? null;
}

async function ticketIdFor(ref: string): Promise<string | null> {
  const seq = parseSeqQuery(ref);
  return (await db.ticket.findFirst({ where: seq !== null ? { ticketSeq: seq } : { id: ref }, select: { id: true } }))?.id ?? null;
}

// ─── The tools ───────────────────────────────────────────────────────────────

const TOOLS: CopilotTool[] = [
  tool({
    // AI Knowledge (owner, 3 Nov 2026; src/lib/ai-knowledge): the company's own guides — not business data, so
    // nothing to scope. Offered once there's a file to search.
    name: "search_knowledge",
    description:
      "Search the company's own knowledge files (AI Knowledge: its guides, product and service notes, processes and policies). Returns the 5 passages that best match, each with the file it came from. Use this first for any question about the company, its products or services, or how something is done.",
    available: hasKnowledge,
    schema: z.object({ query: z.string().trim().min(2).max(200).describe("What to look for — the question, or its key words") }),
    async run(_ctx, input) {
      // At most 4,000 characters of knowledge at a time, the model's context being 8k (src/lib/ai-knowledge/budget.ts).
      const hits = fitKnowledge(await searchKnowledge(input.query, COPILOT_KNOWLEDGE_CHUNKS), copilotRender);
      return {
        output: hits.length
          ? {
              results: hits.map((h) => ({ file: h.file, section: h.heading, text: h.text })),
              note: "Answer from these, and name the file(s) you used at the end, e.g. (Source: crm-leads.md). If they don't answer the question, say so.",
            }
          : { results: [], note: "Nothing in the company's knowledge files matches. Say so plainly; don't answer from memory." },
        activity: `Searched AI Knowledge for “${input.query}” — ${hits.length ? `${hits.length} passage${hits.length === 1 ? "" : "s"} from ${[...new Set(hits.map((h) => h.file))].join(", ")}` : "nothing found"}`,
      };
    },
  }),

  tool({
    name: "search_companies",
    description: "Find companies (customers, vendors, resellers…) by part of their name. Returns their COM- references. Use this before anything about a named company.",
    schema: z.object({ query: z.string().trim().min(2).max(80).describe("Part of the company's name") }),
    async run(_ctx, input) {
      const { matches } = await findCompanyMatches(input.query);
      return {
        output: matches.slice(0, 15).map((m) => ({ ref: m.ref, name: m.name, kind: m.relationshipType, city: m.city, accountManager: m.owner })),
        activity: `Searched companies for “${input.query}” — ${matches.length} found`,
      };
    },
  }),

  tool({
    name: "get_company",
    description: "Everything about one company: its details, contacts, open leads, recent orders. Takes a COM- reference from search_companies.",
    schema: z.object({ ref: z.string().trim().min(1).max(60).describe("The company's COM- reference, as search_companies or the user gave it") }),
    async run(ctx, input) {
      const id = await companyIdFor(ctx.userId, input.ref);
      const company = id ? await getCompany(id) : null;
      if (!company) return { output: { error: "No such company, or not one this person can see." }, activity: `Looked for ${input.ref} — not found` };
      // What goes to the model is a list's answer (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2 and H.4.4):
      // `getCompany` masks as the company's page does, and a field masked in lists is masked here too.
      const shown = await companyMasker(ctx.userId, "list");
      const primary = company.locations[0] ? shown.location(company.locations[0]) : undefined;
      return {
        output: {
          ref: formatCompanyId(company.companySeq),
          name: company.name,
          kind: company.relationshipType,
          stage: company.stage,
          category: company.customerCategory?.name ?? null,
          accountManager: company.owner?.name ?? null,
          caller: company.assignedTo?.name ?? null,
          paymentTerms: company.paymentTerms,
          website: shown.present("website", company.website),
          address: primary ? { city: primary.city, state: primary.state, gstin: primary.gstNumber } : null,
          tags: company.tags,
          contacts: company.contacts.slice(0, 10).map((c) => ({ name: c.name, designation: c.designation, email: c.email, phone: c.phone, primary: c.isPrimary })),
          leads: company.leads.slice(0, 10).map((l) => ({ ref: formatLeadId(l.leadSeq), title: l.title, status: l.status, value: money(l.estimatedValue), owner: l.owner?.name ?? null })),
          recentOrders: company.products.slice(0, 8).map((o) => ({
            ref: formatOrderId(o.orderSeq),
            item: o.item.name,
            quantity: o.quantity,
            status: o.orderStatus,
            unitPrice: money(o.unitPrice),
            ends: day(o.endDate),
          })),
        },
        activity: `Opened ${formatCompanyId(company.companySeq)} ${company.name}`,
      };
    },
  }),

  tool({
    name: "list_leads",
    description: "Leads in the pipeline, newest or hottest first, with the products and quantities on each. Filter by status, by the person's own, by hot/warm/cold, or by words in the title or company.",
    module: "leads",
    schema: z.object({
      status: z.enum(["NEW", "CONTACTED", "QUALIFYING", "QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION", "WON", "LOST", "DISQUALIFIED"]).optional(),
      mine: z.boolean().optional().describe("Only leads owned by the person asking"),
      grade: z.enum(["HOT", "WARM", "COLD"]).optional(),
      search: z.string().trim().max(80).optional(),
      closingFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Expected close on or after, YYYY-MM-DD"),
      closingTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Expected close on or before, YYYY-MM-DD"),
      limit: limitField,
    }),
    async run(ctx, input) {
      const { rows, total } = await listLeadsPaged({
        status: input.status,
        ownerUserId: input.mine ? ctx.userId : undefined,
        grade: input.grade,
        search: input.search,
        closeFrom: input.closingFrom,
        closeTo: input.closingTo,
        sort: input.grade ? "score" : undefined,
        page: 1,
        pageSize: input.limit ?? 10,
      });
      // What each lead is for — "the lead for 50 laptops" — as its page shows it while Items is on.
      const lines =
        rows.length && (await isModuleEnabled("items"))
          ? await db.leadRequirement.findMany({ where: { leadId: { in: rows.map((l) => l.id) } }, orderBy: { createdAt: "asc" }, select: { leadId: true, quantity: true, item: { select: { name: true } } } })
          : [];
      return {
        output: {
          total,
          leads: rows.map((l) => ({
            ref: formatLeadId(l.leadSeq),
            title: l.title,
            company: l.company.name,
            status: l.status,
            value: money(l.estimatedValue),
            expectedClose: day(l.expectedCloseDate),
            score: l.score,
            owner: l.owner?.name ?? null,
            products: lines.filter((r) => r.leadId === l.id).slice(0, 5).map((r) => ({ product: r.item.name, quantity: r.quantity })),
          })),
        },
        activity: `Looked up leads — ${total} match`,
      };
    },
  }),

  tool({
    name: "list_orders",
    description: "Orders and subscriptions, newest first. Filter by status or by words in the company or item.",
    module: "orders",
    schema: z.object({
      status: z.enum(["PENDING_APPROVAL", "APPROVED", "REJECTED", "PROCESSING", "FULFILLED", "CANCELLED"]).optional(),
      search: z.string().trim().max(80).optional(),
      limit: limitField,
    }),
    async run(_ctx, input) {
      const { rows, total } = await listOrdersPaged({ status: input.status, search: input.search, page: 1, pageSize: input.limit ?? 10 });
      return {
        output: {
          total,
          orders: rows.map((o) => ({
            ref: formatOrderId(o.orderSeq),
            company: o.company.name,
            item: o.item.name,
            quantity: o.quantity,
            unitPrice: money(o.unitPrice),
            status: o.orderStatus,
            starts: day(o.startDate),
            ends: day(o.endDate),
          })),
        },
        activity: `Looked up orders — ${total} match`,
      };
    },
  }),

  tool({
    name: "list_renewals",
    description: "Subscriptions coming up for renewal in the next 30, 60 or 90 days, or already expired.",
    module: "renewals",
    schema: z.object({ window: z.enum(["expired", "30", "60", "90"]).describe("Which renewals"), search: z.string().trim().max(80).optional(), limit: limitField }),
    async run(_ctx, input) {
      const { rows, total, expired } = await listRenewalsPaged({ window: input.window, search: input.search, page: 1, pageSize: input.limit ?? 10 });
      return {
        output: {
          total,
          expired,
          renewals: rows.map((r) => ({
            ref: formatOrderId(r.orderSeq),
            company: r.company.name,
            item: r.item.name,
            quantity: r.quantity,
            ends: day(r.endDate),
            unitPrice: money(r.unitPrice),
          })),
        },
        activity: `Looked up renewals (${input.window === "expired" ? "expired" : `next ${input.window} days`}) — ${total}`,
      };
    },
  }),

  tool({
    name: "list_tickets",
    description: "Support tickets, newest first. Filter by status, priority, or words in the title or company.",
    module: "helpdesk",
    schema: z.object({
      status: z.enum(["OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED"]).optional(),
      priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
      search: z.string().trim().max(80).optional(),
      limit: limitField,
    }),
    async run(_ctx, input) {
      const { rows, total } = await listTicketsPaged({
        status: input.status,
        priority: input.priority,
        search: input.search,
        page: 1,
        pageSize: input.limit ?? 10,
      });
      const clock = await workspaceClock();
      return {
        output: {
          total,
          tickets: rows.map((t) => ({
            ref: formatTicketId(t.ticketSeq),
            title: t.title,
            company: t.company.name,
            status: t.status,
            priority: t.priority,
            assignedTo: t.assignedTo?.name ?? null,
            // A moment, so the workspace's day.
            opened: clock.dateKey(t.createdAt),
          })),
        },
        activity: `Looked up tickets — ${total} match`,
      };
    },
  }),

  tool({
    name: "my_tasks",
    description: "The person's own tasks — assigned to them or created by them — open ones first, soonest due first.",
    module: "tasks",
    schema: z.object({ includeDone: z.boolean().optional(), limit: limitField }),
    async run(ctx, input) {
      // Theirs by construction: assigned to them, or written by them.
      const where: Prisma.TaskWhereInput = {
        OR: [{ assignedToUserId: ctx.userId }, { createdByUserId: ctx.userId }],
        ...(input.includeDone ? {} : { done: false }),
      };
      const [rows, total] = await Promise.all([
        db.task.findMany({
          where,
          orderBy: [{ done: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }],
          take: input.limit ?? 10,
          select: { title: true, dueDate: true, done: true, assignedTo: { select: { name: true } }, company: { select: { name: true } } },
        }),
        db.task.count({ where }),
      ]);
      return {
        output: { total, tasks: rows.map((t) => ({ title: t.title, due: day(t.dueDate), done: t.done, assignedTo: t.assignedTo?.name ?? null, company: t.company?.name ?? null })) },
        activity: `Looked at your tasks — ${total}`,
      };
    },
  }),

  tool({
    name: "dashboard_summary",
    description: "The headline numbers on the person's dashboard — this month's bookings, pipeline, renewals, tickets and the like, for what they can see.",
    schema: z.object({}),
    async run() {
      return { output: await getDashboardSummary(), activity: "Read your dashboard figures" };
    },
  }),

  tool({
    name: "report_options",
    module: "reports",
    description: "What reports can be run: each source (orders, leads, invoices, payments, tickets, visits…) with its measures, the dimensions it can be broken down by, and its date fields. Call this before run_report.",
    schema: z.object({}),
    async run() {
      const { sources, grains } = await reportOptions();
      return {
        output: {
          grains: grains.map((g) => g.key),
          sources: sources.map((s) => ({
            source: s.key,
            label: s.label,
            measures: s.measures.map((m) => ({ key: m.key, label: m.label })),
            dimensions: s.dimensions.map((d) => ({ key: d.key, label: d.label })),
            dateFields: s.dateFields.map((d) => ({ key: d.key, label: d.label })),
          })),
        },
        activity: "Checked which reports are available",
      };
    },
  }),

  tool({
    name: "run_report",
    module: "reports",
    description:
      "Run a report and show it in the chat as a chart and table. Totals, breakdowns and trends always come from here — never add up list results yourself. Use report_options for the valid keys. For a trend over time, use the date dimension as `column` or `dimension` with a grain.",
    schema: z.object({
      title: z.string().trim().min(3).max(90).describe("A short title for the chart, e.g. 'Bookings by salesperson, Sep 2026'"),
      source: z.string().max(40),
      measure: z.string().max(60),
      dimension: z.string().max(60).describe("What the rows are broken down by"),
      column: z.string().max(60).optional().describe("Optional second breakdown, shown as columns — often the date"),
      grain: z.enum(["day", "week", "month", "quarter", "year"]).optional().describe("How dates are bucketed. Default month"),
      dateField: z.string().max(60).optional().describe("Default: the source's main date"),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("First day, YYYY-MM-DD. Default: 12 months ago"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last day, YYYY-MM-DD. Default: today"),
      filters: z.record(z.string(), z.array(z.string().max(120)).max(20)).optional().describe("Dimension key → values to keep"),
    }),
    async run(_ctx, input) {
      // Owner, 20 Nov 2026: a small model left the dates out, was refused, and asked the person to run it. The dates
      // now default — the source's own date, the last 12 months, by month — so a plain question runs first time.
      const today = (await workspaceClock()).today();
      const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4, 8)}01`;
      const dateField = input.dateField ?? (await reportOptions()).sources.find((s) => s.key === input.source)?.dateFields[0]?.key ?? "";
      const r = await runAnalyticsReport({
        source: input.source,
        measure: input.measure,
        dimension: input.dimension,
        column: input.column,
        grain: input.grain ?? "month",
        dateField,
        from: input.from ?? yearAgo,
        to: input.to ?? today,
        filters: input.filters,
      });
      if (!r.ok) return { output: { error: r.error }, activity: `Couldn't run the report — ${r.error}` };
      const { sources } = await reportOptions();
      const measure = sources.find((s) => s.key === input.source)?.measures.find((m) => m.key === input.measure);
      const result = r.data;
      const shown = { ...result, rows: result.rows.slice(0, MAX_REPORT_ROWS) };
      return {
        output: {
          unit: result.unit,
          grandTotal: result.grandTotal,
          records: result.rowCount,
          truncated: result.truncated,
          scope: result.scopeNote,
          columns: result.columns.map((c) => c.label),
          rows: result.rows.slice(0, 25).map((row) => ({ label: row.label, total: row.total, ...(result.columns.length > 1 ? { byColumn: row.cells } : {}) })),
          moreRows: Math.max(0, result.rows.length - 25),
          note: "The chart and table are already shown to the user — summarise what stands out rather than repeating them.",
        },
        blocks: [{ type: "report", title: input.title, measureLabel: measure?.label ?? input.measure, averaged: measure?.average === true, result: shown }],
        activity: `Ran a report: ${input.title}`,
      };
    },
  }),

  tool({
    name: "find_colleague",
    description: "Find a colleague by name, for assigning a task to them. Returns their id.",
    schema: z.object({ name: z.string().trim().min(2).max(60) }),
    async run(_ctx, input) {
      const people = await listAssignableUsers();
      const needle = input.name.toLowerCase();
      const found = people.filter((p) => p.name.toLowerCase().includes(needle)).slice(0, 8);
      return { output: found.map((p) => ({ id: p.id, name: p.name, role: p.role })), activity: `Looked for colleague “${input.name}” — ${found.length}` };
    },
  }),

  /**
   * Owner, 20 Nov 2026: asked "how many employees", Deskzo AI had no HR tool at all and made up "250". The staff
   * directory as People shows it (listPeople, src/actions/hr.ts) — every active colleague's name, designation and
   * team, which everybody with People open may see; nothing private (joining dates, salary, exits) is in it.
   */
  tool({
    name: "people_directory",
    module: "hr",
    description:
      "The company's staff directory, as People shows it: how many employees there are, how many in each department, and who they are (name, designation, department). For 'how many employees', 'who is in Sales', 'find our HR people'. Active employees only.",
    schema: z.object({
      search: z.string().trim().max(60).optional().describe("A name, email, employee code or designation"),
      department: z.string().trim().max(60).optional().describe("A department's name, e.g. Sales"),
      limit: limitField,
    }),
    async run(_ctx, input) {
      const rows = await listPeople({ search: input.search, status: "active" });
      const people = input.department ? rows.filter((r) => r.department?.name.toLowerCase().includes(input.department!.toLowerCase())) : rows;
      const byDepartment = new Map<string, number>();
      for (const p of people) byDepartment.set(p.department?.name ?? "No department", (byDepartment.get(p.department?.name ?? "No department") ?? 0) + 1);
      const shown = people.slice(0, input.limit ?? 10);
      return {
        output: {
          total: people.length,
          byDepartment: Object.fromEntries([...byDepartment].sort((a, b) => b[1] - a[1])),
          people: shown.map((p) => ({ name: p.name, designation: p.employeeProfile?.designation ?? null, department: p.department?.name ?? null, manager: p.manager?.name ?? null })),
          more: Math.max(0, people.length - shown.length),
        },
        activity: `Looked in the staff directory — ${people.length} ${people.length === 1 ? "person" : "people"}`,
      };
    },
  }),

  tool({
    name: "propose_task",
    description:
      "Offer to create a task. The user sees a card and must press Create — nothing is saved until they do, so never say it has been created. Link it to a company, lead or ticket by reference when the conversation is about one.",
    module: "tasks",
    schema: z.object({
      title: z.string().trim().min(2).max(200),
      description: z.string().trim().max(2000).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
      assigneeUserId: z.string().max(40).optional().describe("From find_colleague; leave out to assign it to the person asking"),
      companyRef: z.string().max(60).optional(),
      leadRef: z.string().max(60).optional(),
      ticketRef: z.string().max(60).optional(),
    }),
    async run(ctx, input) {
      const attached = await attachments(ctx.userId, input);
      if ("error" in attached) return { output: { error: attached.error }, activity: "Couldn't draft the task" };
      // A person only, as find_colleague offers: never a support or Automation account (src/lib/people.ts).
      const assignee = input.assigneeUserId ? await db.user.findFirst({ where: { id: input.assigneeUserId, active: true, ...PEOPLE_ONLY }, select: { id: true, name: true } }) : null;
      if (input.assigneeUserId && !assignee) return { output: { error: "That colleague isn't an active user — use find_colleague." }, activity: "Couldn't draft the task" };
      const forOther = !!assignee && assignee.id !== ctx.userId;
      const asker = forOther ? null : await db.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
      const payload = {
        title: input.title,
        description: input.description ?? "",
        dueDate: input.dueDate ?? "",
        assignedToUserId: assignee?.id ?? ctx.userId,
        companyId: attached.companyId ?? "",
        leadId: attached.leadId ?? "",
        ticketId: attached.ticketId ?? "",
      };
      const due = input.dueDate ? ` — due ${formatDay(input.dueDate)}` : "";
      const summary = `${input.title}${due}${assignee && assignee.id !== ctx.userId ? ` — for ${assignee.name}` : ""}${attached.label ? ` — on ${attached.label}` : ""}`;
      const proposal = await db.copilotProposal.create({
        data: { conversationId: ctx.conversationId, userId: ctx.userId, kind: "TASK", payload, summary },
        select: { id: true },
      });
      return {
        output: { proposed: true, note: "Shown to the user as a card. It is NOT created until they press Create." },
        // Security audit, 13 Nov 2026 (A4): the whole description and the assignee go on the card.
        blocks: [
          {
            type: "proposal",
            id: proposal.id,
            kind: "TASK",
            summary,
            details: payload.description,
            assignee: { name: forOther ? assignee!.name : (asker?.name ?? "You"), other: forOther },
            status: "PENDING",
          },
        ],
        activity: "Drafted a task for you to confirm",
      };
    },
  }),

  tool({
    name: "propose_note",
    description:
      "Offer to make a private note on the person's note board, optionally with a reminder and linked to a company, lead or ticket. The user must press Save on the card — never say it has been saved.",
    module: "notes",
    schema: z.object({
      body: z.string().trim().min(1).max(2000),
      title: z.string().trim().max(80).optional(),
      remindAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional().describe("The workspace's local time, YYYY-MM-DDTHH:mm"),
      companyRef: z.string().max(60).optional(),
      leadRef: z.string().max(60).optional(),
      ticketRef: z.string().max(60).optional(),
    }),
    async run(ctx, input) {
      const attached = await attachments(ctx.userId, input);
      if ("error" in attached) return { output: { error: attached.error }, activity: "Couldn't draft the note" };
      const clock = await workspaceClock();
      const remindAt = input.remindAt ? clock.parseInput(input.remindAt) : null;
      if (input.remindAt && !remindAt) return { output: { error: "That reminder time isn't valid." }, activity: "Couldn't draft the note" };
      const payload = {
        title: input.title ?? "",
        body: input.body,
        color: "YELLOW",
        // Always private: a note on everybody's board is a broadcast, and not the copilot's to make.
        visibility: "PRIVATE",
        pinned: false,
        remindAt: remindAt ? remindAt.toISOString() : "",
        companyId: attached.companyId ?? "",
        leadId: attached.leadId ?? "",
        ticketId: attached.ticketId ?? "",
      };
      const summary = `${input.title ? `${input.title}: ` : ""}${input.body.slice(0, 140)}${input.body.length > 140 ? "…" : ""}${remindAt ? ` — reminder ${clock.dateTime(remindAt)}` : ""}${attached.label ? ` — on ${attached.label}` : ""}`;
      const proposal = await db.copilotProposal.create({
        data: { conversationId: ctx.conversationId, userId: ctx.userId, kind: "NOTE", payload, summary },
        select: { id: true },
      });
      return {
        output: { proposed: true, note: "Shown to the user as a card. It is NOT saved until they press Save." },
        // Security audit, 13 Nov 2026 (A4): the note's whole body goes on the card, not the first 140 characters.
        blocks: [{ type: "proposal", id: proposal.id, kind: "NOTE", summary, details: input.body, assignee: null, status: "PENDING" }],
        activity: "Drafted a note for you to confirm",
      };
    },
  }),

  /**
   * Owner, 20 Nov 2026: "I told the AI to create a lead and it made a note — I want it to do things." A lead, drafted
   * like a task: the card shows everything that will be saved, and pressing Create runs the app's own createLead as
   * the person (src/actions/copilot.ts), with every check the form makes. A lead is always with a company: an
   * existing one by reference, or a new one by name, made in the same step with the contact on it.
   */
  tool({
    name: "propose_lead",
    description:
      "Offer to create a lead (a sales enquiry). The user sees a card and must press Create lead — nothing is saved until they do, so never say it has been created. A lead is always with a company: give companyRef for one that exists (find it with search_companies first), or newCompanyName to create the company too — for a person with no company, use the person's name. Put the person's name, phone and email in contactName, contactPhone and contactEmail. Make up a short title from what the user said if they didn't give one.",
    module: "leads",
    schema: z.object({
      companyRef: z.string().max(60).optional().describe("An existing company's COM- reference, from search_companies"),
      newCompanyName: z.string().trim().min(2).max(200).optional().describe("Only when the company isn't in Deskzo yet"),
      title: z.string().trim().min(2).max(200).describe("What they want, e.g. 'Microsoft 365 for 50 users'"),
      description: z.string().trim().max(2000).optional(),
      estimatedValue: z.number().nonnegative().max(9_999_999_999).optional().describe("In the workspace's currency"),
      expectedCloseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
      contactName: z.string().trim().min(1).max(200).optional(),
      contactPhone: z.string().trim().max(100).optional(),
      contactEmail: z.string().trim().toLowerCase().email().max(254).optional(),
    }),
    async run(ctx, input) {
      const refuse = (error: string) => ({ output: { error }, activity: "Couldn't draft the lead" });
      if (!(await hasEffectivePermission(ctx.userId, "leads.create"))) {
        return refuse("This person can't create leads — their role doesn't have the Create leads permission. Tell them to ask their admin (Access Control → Roles & Permissions).");
      }
      // A small model sends both, with a made-up companyRef like "NEW": the new name wins unless the ref is a real one.
      const ref = input.companyRef && (!input.newCompanyName || (await companyIdFor(ctx.userId, input.companyRef))) ? input.companyRef : undefined;
      if (!ref && !input.newCompanyName) return refuse("Give companyRef (an existing company, from search_companies) or newCompanyName (a new one).");
      let companyId = "";
      let companyName = ref ? "" : (input.newCompanyName ?? "");
      if (ref) {
        input = { ...input, companyRef: ref, newCompanyName: undefined };
        const id = await companyIdFor(ctx.userId, ref);
        if (!id) return refuse(`No company ${ref} that this person can see. Use search_companies, or newCompanyName for a new one.`);
        companyId = id;
        companyName = (await db.company.findUnique({ where: { id }, select: { name: true } }))?.name ?? ref;
      } else {
        if (!(await isModuleEnabled("companies"))) return refuse("This person can't add companies, so the lead needs an existing one — use search_companies.");
        const existing = await companyNamedLike(input.newCompanyName!);
        if (existing) {
          const seq = (await db.company.findUnique({ where: { id: existing.id }, select: { companySeq: true } }))?.companySeq;
          return refuse(`${existing.name} is already in Deskzo${seq ? ` as ${formatCompanyId(seq)}` : ""} — use that as companyRef instead of making it again.`);
        }
      }
      const contact = input.contactName ? { name: input.contactName, phone: input.contactPhone ?? "", email: input.contactEmail ?? "" } : null;
      const payload = {
        companyId,
        newCompanyName: input.newCompanyName ?? "",
        title: input.title,
        description: input.description ?? "",
        estimatedValue: input.estimatedValue ?? null,
        expectedCloseDate: input.expectedCloseDate ?? "",
        contact,
      };
      const summary = `${input.title} — ${companyName}${input.newCompanyName ? " (new company)" : ""}`;
      const details = [
        `Company: ${companyName}${input.newCompanyName ? " — will be added as a new customer" : ""}`,
        contact ? `Contact: ${[contact.name, contact.phone, contact.email].filter(Boolean).join(" · ")}` : null,
        input.estimatedValue !== undefined ? `Value: ${input.estimatedValue}` : null,
        input.expectedCloseDate ? `Expected close: ${formatDay(input.expectedCloseDate)}` : null,
        input.description ? `\n${input.description}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      const proposal = await db.copilotProposal.create({
        // The card text goes with it, so the card reads the same when the conversation is opened again.
        data: { conversationId: ctx.conversationId, userId: ctx.userId, kind: "LEAD", payload: { ...payload, card: details } as Prisma.InputJsonValue, summary },
        select: { id: true },
      });
      return {
        output: { proposed: true, note: "Shown to the user as a card. It is NOT created until they press Create lead." },
        blocks: [{ type: "proposal", id: proposal.id, kind: "LEAD", summary, details, assignee: null, status: "PENDING" }],
        activity: "Drafted a lead for you to confirm",
      };
    },
  }),

  /**
   * "Edit the 50 laptop leads in to 60 laptop" was read as fifty leads, and answered that leads can't be changed. One
   * lead's change, drafted like a new one (./lead-update.ts): the card shows each field's old value and its new one, and
   * Save changes runs the lead's own actions as the person (src/actions/copilot.ts), with every check they make.
   */
  tool({
    name: "propose_lead_update",
    description:
      "Offer to change ONE existing lead: the quantity of a product on it, its title, description, estimated value or expected close date. The user sees a card with each old and new value and must press Save changes — nothing is saved until they do, so never say it has been changed. Find the lead with list_leads first. If several fit, or a number could be a quantity or a count of leads, list them and ask — never guess, never change several. Send only what the user asked to change. It can't change the owner, stage, contact or company, empty a field, or delete anything.",
    module: "leads",
    schema: z.object({
      leadRef: z.string().trim().min(1).max(60).describe("The lead's LEAD- reference, as list_leads or the user gave it"),
      quantity: z.number().int().positive().max(2_147_483_647).optional().describe("The new quantity of one product on the lead"),
      quantityNow: z.number().int().positive().optional().describe("The quantity the user said it has now, if they said one"),
      product: z.string().trim().min(1).max(200).optional().describe("Which product on the lead the quantity is of"),
      title: z.string().trim().min(2).max(200).optional().describe("The new title"),
      description: z.string().trim().min(1).max(5000).optional().describe("The new description, whole — it replaces the old one"),
      estimatedValue: z.number().nonnegative().max(9_999_999_999).optional().describe("The new value, in the workspace's currency"),
      expectedCloseDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine((v) => new Date(`${v}T00:00:00Z`).toJSON()?.slice(0, 10) === v, "isn't a real date")
        .optional()
        .describe("The new expected close date, YYYY-MM-DD"),
    }),
    async run(ctx, input) {
      const refuse = (output: { error: string }) => ({ output, activity: "Couldn't draft the change" });
      const draft = await draftLeadUpdate(ctx.userId, input);
      if ("error" in draft) return refuse(draft);
      // One lead a question, whatever the model calls — "all of them" is answered by asking which.
      const other = changedIn.get(ctx);
      if (other && other !== draft.payload.leadId) return refuse({ error: "One lead at a time: a change to another is already on its card. Ask the user which lead they mean." });
      changedIn.set(ctx, draft.payload.leadId);
      const { payload, summary } = draft;
      const proposal = await db.copilotProposal
        .create({ data: { conversationId: ctx.conversationId, userId: ctx.userId, kind: "LEAD_UPDATE", payload: payload as Prisma.InputJsonValue, summary }, select: { id: true } })
        .catch((err: unknown) => {
          // A workspace before 20261226100000_copilot_lead_update: its database doesn't know this kind of card yet.
          if (/invalid input value for enum/i.test(err instanceof Error ? err.message : String(err))) return null;
          throw err;
        });
      if (!proposal) return refuse({ error: "This workspace is still being updated for changing leads from the chat. Tell the user to try again in a few minutes, or to change it on the lead's page." });
      return {
        output: { proposed: true, note: "Shown to the user as a card. NOTHING has changed until they press Save changes." },
        blocks: [{ type: "proposal", id: proposal.id, kind: "LEAD_UPDATE", summary, changes: changeRows(payload), assignee: null, status: "PENDING" }],
        activity: "Drafted a change to a lead for you to confirm",
      };
    },
  }),

  // ─── The AI teammates, asked by name (owner, 20 Nov 2026 — "easily accessible", step 3) ─────────────────────────
  // Each runs the same action as its own button, as the person asking, with that button's checks; what it makes waits
  // for a person — a plan to read, an email to check and send — so nothing goes to a customer from here.

  tool({
    name: "ved_research_plan",
    description:
      "Ask Ved, the researcher, to research a lead or a company from public sources and plan how to work it: how warm it is, the next steps, a first email. Give leadRef or companyRef. Costs Deskzo AI credits; takes a little while. The plan shows on the record.",
    schema: z
      .object({ leadRef: z.string().max(60).optional().describe("A LEAD- reference the user or a tool gave"), companyRef: z.string().max(60).optional().describe("A COM- reference the user or a tool gave") })
      .refine((v) => !!v.leadRef || !!v.companyRef, { message: "Give leadRef or companyRef" }),
    async run(ctx, input) {
      const attached = await attachments(ctx.userId, input);
      if ("error" in attached) return { output: { error: attached.error }, activity: "Ved couldn't find that record" };
      const target = attached.leadId ? { kind: "lead" as const, id: attached.leadId } : { kind: "company" as const, id: attached.companyId! };
      const made = await makeResearchPlan(target);
      if (!made.ok) return { output: { error: made.error }, activity: "Ved couldn't plan it" };
      const plan = made.data.plan;
      const href = await recordHref(target);
      return {
        output: {
          teammate: "Ved",
          fit: plan.fit,
          summary: plan.summary,
          nextSteps: plan.steps.map((s) => s.title),
          firstEmailDrafted: !!plan.email,
          openAt: href,
          note: "The plan is on the record; its steps become tasks only when the person adds them there.",
        },
        activity: `Ved researched and planned ${attached.label ?? "it"}`,
      };
    },
  }),

  tool({
    name: "tara_nurture_lead",
    description:
      "Ask Tara, the nurture writer, to follow a lead up: four short emails over two weeks from the lead owner's mailbox. The lead needs a Research & plan first (ved_research_plan). Every email waits for the lead's owner to check and send — never say an email was sent.",
    module: "leads",
    schema: z.object({ leadRef: z.string().max(60).describe("A LEAD- reference the user or a tool gave") }),
    async run(ctx, input) {
      const attached = await attachments(ctx.userId, { leadRef: input.leadRef });
      if ("error" in attached || !attached.leadId) return { output: { error: "error" in attached ? attached.error : "No such lead." }, activity: "Tara couldn't find that lead" };
      const started = await startNurture(attached.leadId);
      if (!started.ok) return { output: { error: started.error }, activity: "Tara couldn't start" };
      return {
        output: {
          teammate: "Tara",
          started: true,
          openAt: await recordHref({ kind: "lead", id: attached.leadId }),
          note: "Started. The first email waits for the lead's owner on the lead and in Waiting for you on Today — nothing is sent until they send it.",
        },
        activity: `Tara started nurturing ${input.leadRef}`,
      };
    },
  }),

  tool({
    name: "arjun_who_to_chase",
    description:
      "Ask Arjun, the accounts teammate, who this person should chase for payment today, most pressing first, with why — and how many of his chase emails and customers' replies wait for them.",
    module: "receivables",
    schema: z.object({}),
    async run() {
      const today = await arjunForMe();
      if (!today) return { output: { error: "Following up payments isn't this person's to do." }, activity: "Arjun had nothing for them" };
      return {
        output: {
          teammate: "Arjun",
          toChase: today.list.slice(0, 8).map((i) => ({ company: i.companyName, ref: formatCompanyId(i.companySeq), why: i.reasons.slice(0, 2).join("; "), action: i.action })),
          chaseEmailsWaiting: today.waiting.length,
          repliesToActOn: today.replies.length,
          openAt: "/collections",
        },
        activity: "Arjun looked at who to chase",
      };
    },
  }),

  tool({
    name: "arjun_draft_chase",
    description:
      "Ask Arjun to draft a payment chase email to a customer about its overdue invoices. It waits on My collections for the person to check and send — never say it was sent. Costs Deskzo AI credits.",
    module: "receivables",
    schema: z.object({ companyRef: z.string().max(60).describe("A COM- reference the user or a tool gave") }),
    async run(ctx, input) {
      const companyId = await companyIdFor(ctx.userId, input.companyRef);
      if (!companyId) return { output: { error: `No company ${input.companyRef} that this person can see.` }, activity: "Arjun couldn't find that customer" };
      const drafted = await draftChaseEmail({ companyId });
      if (!drafted.ok) return { output: { error: drafted.error }, activity: "Arjun couldn't draft it" };
      return {
        output: { teammate: "Arjun", drafted: true, subject: drafted.data.subject, openAt: "/collections", note: "Drafted. It waits on My collections and in Waiting for you — nothing is sent until they send it." },
        activity: `Arjun drafted a chase email to ${drafted.data.companyName}`,
      };
    },
  }),
];

/** The lead each question has drafted a change to — one question's calls share a context (./agent.ts). */
const changedIn = new WeakMap<ToolContext, string>();

function formatDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
}

/** The records a proposal hangs on, each resolved and checked the way the note board checks them. */
/** A record's page, for a teammate's answer to point at. */
async function recordHref(target: { kind: "lead" | "company"; id: string }): Promise<string | null> {
  if (target.kind === "lead") {
    const lead = await db.lead.findUnique({ where: { id: target.id }, select: { leadSeq: true } });
    return lead ? leadPath(lead.leadSeq) : null;
  }
  const company = await db.company.findUnique({ where: { id: target.id }, select: { companySeq: true } });
  return company ? companyPath(company.companySeq) : null;
}

async function attachments(
  userId: string,
  input: { companyRef?: string; leadRef?: string; ticketRef?: string },
): Promise<{ companyId: string | null; leadId: string | null; ticketId: string | null; label: string | null } | { error: string }> {
  const companyId = input.companyRef ? await companyIdFor(userId, input.companyRef) : null;
  if (input.companyRef && !companyId) return { error: `No company ${input.companyRef} that this person can see.` };
  // A lead only where the plan has leads — a workspace that had them keeps them, out of sight.
  const leadId = input.leadRef && (await isModuleEnabled("leads")) ? await leadIdFor(input.leadRef) : null;
  const ticketId = input.ticketRef ? await ticketIdFor(input.ticketRef) : null;
  if ((input.leadRef && !leadId) || (input.ticketRef && !ticketId) || !(await mayAttachTo(userId, { companyId, leadId, ticketId }))) {
    return { error: "One of those records isn't there, or isn't one this person can see." };
  }
  const label = [input.companyRef, input.leadRef, input.ticketRef].filter(Boolean).join(", ") || null;
  return { companyId, leadId, ticketId, label };
}

// ─── Offering and running them ───────────────────────────────────────────────

export function toolSpec(t: CopilotTool): ToolSpec {
  const { $schema, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
  void $schema;
  return { name: t.name, description: t.description, parameters };
}

/** The tools this person may use, in a fixed order — a stable list keeps the model's cache warm. */
export async function toolsFor(): Promise<CopilotTool[]> {
  const on = await Promise.all(TOOLS.map(async (t) => (t.module ? await isModuleEnabled(t.module) : true) && (t.available ? await t.available() : true)));
  return TOOLS.filter((_, i) => on[i]);
}

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/** Runs one call: refused unless it is a tool this person was offered and its input fits the schema. */
export async function runTool(offered: CopilotTool[], ctx: ToolContext, name: string, input: unknown): Promise<ToolOutcome & { isError: boolean }> {
  const t = offered.find((x) => x.name === name);
  if (!t) return { output: { error: `There is no tool called ${name}.` }, activity: `Tried an unknown tool (${name})`, isError: true };
  const parsed = t.schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { output: { error: `Invalid input: ${issue?.path.join(".") || "input"} — ${issue?.message ?? "didn't match"}` }, activity: `Retrying ${name}`, isError: true };
  }
  try {
    const outcome = await t.run(ctx, parsed.data as never);
    const error = typeof outcome.output === "object" && outcome.output !== null && "error" in outcome.output;
    return { ...outcome, isError: error };
  } catch (err) {
    console.error(`copilot tool ${name} failed`, err);
    return { output: { error: "That lookup failed on the server." }, activity: `${name} failed`, isError: true };
  }
}

/** A tool's answer as the model receives it — JSON, cut short if it would cost more than it tells. */
export function outputText(output: unknown): string {
  const text = JSON.stringify(output);
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}… (cut short — narrow the question)` : text;
}
