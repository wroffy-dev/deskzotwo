"use server";

import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { orderAccess } from "@/lib/authz/access";
import { renewalGroup } from "@/lib/subscriptions/proration";
import { resolveRenewalStage, type RenewalStageKey } from "@/lib/renewals";
import { UNPAGED_LIST_CEILING, pageSlice } from "@/lib/pagination";
import { workspaceClock } from "@/lib/time/workspace";
import { revalidatePath } from "next/cache";
import { notifyUser } from "@/lib/notify";
import { formatOrderId } from "@/lib/order-id";
import { bulkRenewalTasksSchema } from "@/lib/validation/task";
import type { ActionResult } from "@/actions/company";
import type { Prisma } from "@prisma/client";
import { viewerHas } from "@/actions/permission";
import { RAISED_IN_DESKZO } from "@/lib/documents/imported";
import { lapsedWhere } from "@/lib/renewal-lapse-rules";
import { nextBill } from "@/lib/recurring-billing/check-rules";
import { AT_RISK_DAYS, atRiskWhere, renewalTaskTitle } from "@/lib/renewal-watch-rules";
import { buildRenewalReport, type RenewalReport } from "@/lib/renewals-report";
import { recordAudit } from "@/lib/audit";
import { mayChangeAccountManager, reassignRights } from "@/lib/authz/reassign";
import { assignRefusal } from "@/lib/companies/assign-teams";
import { myReminderOrderSeqs, myRemindersFor } from "@/lib/renewal-reminders";
import { TIDY_NOTE } from "@/lib/renewal-tidy";
import { renewalManagersHere, renewalManagersOf, renewalManagerWhere } from "@/lib/companies/renewal-manager";
import { RENEWAL_SORTS, resolveSort } from "@/lib/tables/sort-options";
import { inIdOrder, pageOfRanked, readInChunks } from "@/lib/tables/sorted-page";
import { lastContactOfRenewals } from "@/lib/tables/list-extras";
import { orderSearchTerms } from "@/lib/orders/search";
import { contactMasker } from "@/lib/contacts/masking";
import { TEXT_MAX, tooMany } from "@/lib/validation/text";

/**
 * "lapsed": ended, not renewed and nobody has marked it (owner, 26 Oct 2026 — src/lib/renewal-lapse.ts).
 * "atrisk": ending within thirty days and not started — no call, no quote, not renewed, not marked (owner, 30 Oct
 * 2026 — src/lib/renewal-watch-rules.ts).
 */
/** "open": still to come, or ended within the last 90 days — the list's default (owner, 31 Oct 2026). */
export type RenewalWindow = "open" | "expired" | "lapsed" | "atrisk" | "reminders" | "30" | "60" | "90";

/** How long after it ended a subscription is still open to chase, on the list's default view. */
const OPEN_DAYS = 90;

/**
 * Which subscriptions the renewals list is about, as one `where` both the page query and the two
 * counts are built from — so a filter can never mean one thing to the rows and another to the
 * tally beside them.
 *
 * `today` is passed in rather than taken here, because the window bound and the expired bound have to
 * be the same day: computing them a few milliseconds apart, across midnight, would let a subscription
 * expiring in that gap be inside the window and outside the expired count at the same time.
 *
 * It is the workspace's today as the column holds a day (`clock.calendarDate(now)`). An end date is a
 * calendar day, kept as its midnight UTC, so a subscription runs through its last day and has expired
 * the day after. Compared with the moment instead, it lapsed at midnight UTC on its last day — 05:30
 * in India, the evening before in America.
 *
 * The account scope lives here for the same reason the filters do. A renewal is an order, so it
 * reaches its account through its own company, one hop — and the page runs this `where` three
 * times: the rows, the total, and the expired tally. Applied at the call sites instead, the tally
 * is the one that gets forgotten, and "14 expired" beside four rows is a headline count of
 * somebody else's book.
 */
async function renewalWhere(
  params: { window?: RenewalWindow; search?: string; manager?: string } | undefined,
  today: Date,
  userId: string,
) {
  const endDate: { not: null; lt?: Date; gte?: Date; lte?: Date } = { not: null };
  if (params?.window === "expired" || params?.window === "lapsed") {
    endDate.lt = today;
  } else if (params?.window === "30" || params?.window === "60" || params?.window === "90") {
    endDate.gte = today;
    // Days added to a midnight UTC: UTC has no clock changes, so this is the day `window` days on.
    endDate.lte = new Date(today.getTime() + Number(params.window) * 86_400_000);
  } else if (params?.window === "open") {
    endDate.gte = new Date(today.getTime() - OPEN_DAYS * 86_400_000);
  } else if (params?.window === "atrisk") {
    endDate.gte = today;
    endDate.lte = new Date(today.getTime() + AT_RISK_DAYS * 86_400_000);
  }

  return {
    item: { type: "SUBSCRIPTION" as const },
    // Parents only. An addon co-terminates with its subscription and comes back with it — listing
    // it separately would turn one renewal conversation into three.
    parentId: null,
    endDate,
    // The scope and the search both narrow through `company`, so they are two `AND` terms rather
    // than two spreads into one object — a second `company` key would replace the first, and the
    // one written first is the scope. The access engine answers the scope (`orderAccess`).
    AND: [
      await orderAccess(userId, "view"),
      // Lapsed: not renewed, not cancelled, and nobody has marked it — the ones to chase or to call lost.
      ...(params?.window === "lapsed" ? [lapsedWhere(today)] : []),
      // At risk: nobody has started it, or somebody did and it has gone quiet (owner, 11 Nov 2026) — and it isn't
      // renewed, cancelled or refused.
      ...(params?.window === "atrisk" ? [atRiskWhere(new Date()), { orderStatus: { notIn: ["CANCELLED" as const, "REJECTED" as const] } }] : []),
      // My reminders: the renewals this person asked to be reminded about (src/lib/renewal-reminders.ts), whenever they end.
      ...(params?.window === "reminders" ? [{ orderSeq: { in: await myReminderOrderSeqs(userId) } }] : []),
      // The renewal's number (its order's — "ORD-044148"), customer, end customer, product or PO (owner, 1 Nov 2026).
      ...(params?.search?.trim() ? [{ OR: orderSearchTerms(params.search) }] : []),
      // The renewal manager: the customer's own, else its account manager (owner, 30 Oct 2026).
      ...(params?.manager ? [{ company: await renewalManagerWhere(params.manager) }] : []),
    ],
  };
}

const renewalInclude = {
  company: {
    select: {
      id: true,
      companySeq: true,
      name: true,
      stage: true,
      relationshipType: true,
      // Whose number this is, and who to ring. Both are what the list is actually used for.
      owner: { select: { id: true, name: true } },
      // Its caller, for that column (owner, 30 Oct 2026).
      assignedTo: { select: { id: true, name: true } },
      contacts: {
        where: { phone: { not: null } },
        orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
        take: 1,
        select: { id: true, name: true, phone: true },
      },
    },
  },
  // Set once a renewal has been punched, so the list stops asking for one.
  renewedBy: { select: { id: true, orderSeq: true, orderStatus: true } },
  // Who pinned the stage, where somebody has. The column says so rather than implying the app knew.
  renewalStageBy: { select: { id: true, name: true } },
  // On a reseller's order this is whose subscription it actually is — renew through the
  // reseller, but the seats and expiry belong to the end customer.
  endCustomer: { select: { id: true, companySeq: true, name: true } },
  // The selling price stands in for an order recorded without one (owner, 3 Nov 2026), as on a customer's Products tab.
  item: { select: { id: true, name: true, sku: true, unit: true, sellingPrice: true } },
  addedBy: { select: { id: true, name: true } },
  // How it bills itself, for the "Next bill" column.
  recurringBilling: { select: { mode: true, cycle: true, billFrom: true } },
  addons: {
    where: { orderStatus: { not: "CANCELLED" as const } },
    select: { id: true, quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true },
  },
} satisfies Prisma.CompanyProductInclude;

/**
 * Soonest expiry first, and `id` to break a tie.
 *
 * The tiebreaker is not cosmetic. 28 of today's expiry dates are shared by more than one order (64
 * rows, the largest group 7), and one of those groups straddles the page-4/page-5 boundary. Ordering
 * by `endDate` alone leaves the order within a tie up to the query plan, which is harmless when one
 * query fetches everything and slices in memory, but not when each page is its own `LIMIT`/`OFFSET`:
 * two such queries may break the same tie differently, and a row then shows up on both pages or on
 * neither. A unique final key makes the sequence total, so the pages partition the list exactly.
 */
const renewalOrderBy = [
  { endDate: "asc" },
  { id: "asc" },
] satisfies Prisma.CompanyProductOrderByWithRelationInput[];

type RenewalGroupSource = {
  id: string;
  quantity: number;
  unitPrice: unknown;
  fullTermUnitPrice: unknown;
  startDate: Date | null;
  addons: { id: string; quantity: number; unitPrice: unknown; fullTermUnitPrice: unknown; startDate: Date | null }[];
  item: { sellingPrice: unknown };
};

/**
 * The seat count and the renewal value are the group's, not the parent's — "15 seats expiring on
 * the 9th" is the conversation, not "10 seats, and separately 5 seats".
 *
 * Purely a rendered value: nothing about the group takes part in the `where` or the `orderBy`, so it
 * can be worked out for one page's rows without changing which rows that page holds.
 */
function withRenewalGroup<T extends RenewalGroupSource>(row: T) {
  // Seats added later are the same product, so the same selling price stands in for theirs.
  const listPrice = row.item.sellingPrice ? Number(row.item.sellingPrice) : null;
  return {
    ...row,
    group: renewalGroup([
      {
        id: row.id,
        quantity: row.quantity,
        unitPrice: row.unitPrice ? Number(row.unitPrice) : null,
        fullTermUnitPrice: row.fullTermUnitPrice ? Number(row.fullTermUnitPrice) : null,
        startDate: row.startDate,
        isAddon: false,
        listPrice,
      },
      ...row.addons.map((a) => ({
        id: a.id,
        quantity: a.quantity,
        unitPrice: a.unitPrice ? Number(a.unitPrice) : null,
        fullTermUnitPrice: a.fullTermUnitPrice ? Number(a.fullTermUnitPrice) : null,
        startDate: a.startDate,
        isAddon: true,
        listPrice,
      })),
    ]),
  };
}

type StageSource = {
  id: string;
  companyId: string;
  item: { name: string };
  company: { name: string };
  renewedBy: { id: string } | null;
};

/**
 * What the record already says about how far each renewal has got.
 *
 * Four batched queries for the whole page rather than four per row — the alternative is 100 round
 * trips to render 25 lines, which is the shape of slow list page nobody notices until the book
 * doubles.
 *
 * The task signal matches on company and title because a `Task` has no link to an order. That is
 * not a guess: `bulkCreateRenewalTasks` recognises its own tasks the same way, so this reads exactly
 * what that writes. It is the weakest of the four — renaming the product orphans the match — which
 * is why it is the lowest rung and why the three above it are real foreign keys.
 */
async function renewalStageSignals(rows: StageSource[]) {
  const signals = new Map<
    string,
    { renewed: boolean; quoted: boolean; contacted: boolean; taskRaised: boolean; quote: QuoteRef | null }
  >();
  if (rows.length === 0) return signals;

  const ids = rows.map((r) => r.id);

  const [quoteLines, calls, tasks] = await Promise.all([
    /**
     * A document quoting this subscription's next term.
     *
     * Proformas and invoices count as well as proposals: a renewal billed directly, without a quote
     * ever going out, has plainly got past "Contacted". Cancelled, rejected and expired documents do
     * not count — a withdrawn quote is not a quote outstanding.
     */
    db.tradeDocumentLine.findMany({
      where: {
        companyProductId: { in: ids },
        document: {
          docType: { in: ["PROPOSAL", "PROFORMA", "INVOICE"] },
          status: { notIn: ["CANCELLED", "REJECTED", "EXPIRED"] },
          ...RAISED_IN_DESKZO,
        },
      },
      select: {
        companyProductId: true,
        document: { select: { id: true, docNumber: true, docType: true, status: true, issueDate: true } },
      },
      orderBy: { document: { issueDate: "desc" } },
    }),
    db.callLog.findMany({ where: { companyProductId: { in: ids } }, select: { companyProductId: true } }),
    db.task.findMany({
      where: {
        done: false,
        OR: rows.map((r) => ({ companyId: r.companyId, title: renewalTaskTitle(r.item.name, r.company.name) })),
      },
      select: { companyId: true, title: true },
    }),
  ]);

  const quoted = new Map<string, QuoteRef>();
  for (const line of quoteLines) {
    // Ordered newest first, so the first one seen for an order is the one worth linking to.
    if (line.companyProductId && !quoted.has(line.companyProductId)) {
      quoted.set(line.companyProductId, {
        id: line.document.id,
        docNumber: line.document.docNumber,
        docType: line.document.docType,
        status: line.document.status,
      });
    }
  }
  const called = new Set(calls.map((c) => c.companyProductId).filter(Boolean) as string[]);
  const tasked = new Set(tasks.map((t) => `${t.companyId}::${t.title}`));

  for (const row of rows) {
    const quote = quoted.get(row.id) ?? null;
    signals.set(row.id, {
      renewed: Boolean(row.renewedBy),
      quoted: Boolean(quote),
      contacted: called.has(row.id),
      taskRaised: tasked.has(`${row.companyId}::${renewalTaskTitle(row.item.name, row.company.name)}`),
      quote,
    });
  }
  return signals;
}

export type QuoteRef = { id: string; docNumber: string; docType: string; status: string };

/**
 * Each row with the stage it is at, resolved from the evidence and whatever somebody pinned.
 *
 * Done here rather than in the component so the list, any export and any future report all answer
 * the question the same way — a stage worked out twice is a stage that eventually disagrees with
 * itself.
 */
async function withRenewalStage<T extends StageSource & { renewalStage: unknown; renewalStageNote: string | null; renewalStageAt: Date | null; renewalStageBy: { id: string; name: string } | null }>(
  rows: T[],
) {
  const signals = await renewalStageSignals(rows);
  return rows.map((row) => {
    const signal = signals.get(row.id) ?? { renewed: false, quoted: false, contacted: false, taskRaised: false, quote: null };
    const resolved = resolveRenewalStage({
      override: (row.renewalStage as RenewalStageKey | null) ?? null,
      signals: signal,
    });
    return {
      ...row,
      stage: {
        ...resolved,
        note: row.renewalStageNote,
        setAt: row.renewalStageAt,
        setBy: row.renewalStageBy,
        /** The document behind a "Quoted", so the cell can link straight to it. */
        quote: signal.quote,
      },
    };
  });
}

/**
 * Who to ring on each, as the contacts policy shows them in a list (owner, 5 Nov 2026 — Phase 3 masking fixes, audit
 * H.4.3; src/lib/contacts/masking.ts): the list sent each account's first contact's number in full to anybody with
 * orders.view. The Call button still rings a masked number — the server dials it (`dialledNumber`).
 */
async function withContactsAsSeen<T extends { company: { contacts: { id: string; name: string; phone: string | null }[] } }>(userId: string, rows: T[]): Promise<T[]> {
  const people = await contactMasker(userId, "list", [...new Set(rows.flatMap((r) => r.company.contacts.map((c) => c.id)))]);
  if (!people.active) return rows;
  return rows.map((r) => ({
    ...r,
    company: {
      ...r.company,
      contacts: r.company.contacts.map((c) => ({ ...c, name: people.present(c.id, "name", c.name) ?? "", phone: c.phone === null ? null : people.present(c.id, "phone", c.phone) })),
    },
  }));
}

/**
 * Every matching subscription, up to UNPAGED_LIST_CEILING (src/lib/pagination.ts).
 *
 * Nothing in the app calls this — the renewals screen goes through `listRenewalsPaged`. It is kept
 * for the export/tally case that genuinely wants the whole book, and it shares its `where`,
 * `include` and `orderBy` with the paged query so the two cannot drift apart. If you reach for it,
 * remember that it grows with the subscription book: 181 rows today, unbounded tomorrow.
 */
export async function listRenewals(params?: { window?: RenewalWindow; search?: string; manager?: string }) {
  const user = await requireModuleAccess("renewals");
  if (!(await viewerHas("renewals.view"))) return [];
  const rows = await db.companyProduct.findMany({
    where: await renewalWhere(params, (await workspaceClock()).calendarDate(new Date()), user.id),
    include: renewalInclude,
    orderBy: renewalOrderBy,
    // Security audit, 13 Nov 2026 (SEC-29): stops at the ceiling rather than handing the whole book to one call.
    take: UNPAGED_LIST_CEILING,
  });
  return withRenewalStage((await withContactsAsSeen(user.id, rows)).map(withRenewalGroup));
}

/**
 * One page of the renewals list.
 *
 * The page is cut in the database rather than in memory: fetching every matching subscription with
 * the include tree above to render 25 of them costs the deep read on all 181 rows, and that figure
 * only goes one way.
 */
export async function listRenewalsPaged(params: { window?: RenewalWindow; search?: string; manager?: string; sort?: string; dir?: string; page: number; pageSize: number }) {
  const user = await requireModuleUser("renewals");
  if (!(await viewerHas("renewals.view"))) return { rows: [], total: 0, expired: 0, totalValue: 0 };
  const today = (await workspaceClock()).calendarDate(new Date());
  const where = await renewalWhere(params, today, user.id);
  // The Sort control's choice (owner, 31 Oct 2026): the end date unless another is chosen. Renewal value and last
  // contacted are ranked across every subscription the filters match, then the page cut — those without either last.
  const s = resolveSort(RENEWAL_SORTS, params.sort, params.dir);
  const ranked = s.key === "value" || s.key === "lastContacted";
  const last = { sort: s.dir, nulls: "last" } as const;
  const sortOrder: Prisma.CompanyProductOrderByWithRelationInput[] =
    s.key === "customer" ? [{ company: { name: s.dir } }, ...renewalOrderBy]
    : s.key === "added" ? [{ createdAt: s.dir }, { id: "asc" }]
    : [{ endDate: last }, { id: "asc" }];

  const [paged, total, expired, valued] = await Promise.all([
    ranked
      ? null
      : db.companyProduct.findMany({
          where,
          include: renewalInclude,
          orderBy: sortOrder,
          ...pageSlice(params.page, params.pageSize),
        }),
    db.companyProduct.count({ where }),
    // The expired tally is over everything the filters match, not over the page — so it is its own
    // count, with the same `where` narrowed to what has already lapsed. Spreading the window's own
    // `endDate` bounds keeps the two consistent: on the 30/60/90 windows the added `lt: today` cannot
    // be satisfied alongside `gte: today`, which is right — nothing in a forward-looking window has
    // expired yet.
    db.companyProduct.count({ where: { ...where, endDate: { ...where.endDate, lt: today } } }),
    // The Renewal value column's total (owner, 31 Oct 2026) — over everything the filters match, not the page: each
    // one's group as its row works it out, read with only what that needs.
    db.companyProduct.findMany({
      where,
      select: { id: true, quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true, addons: renewalInclude.addons, item: { select: { sellingPrice: true } } },
      orderBy: renewalOrderBy,
    }),
  ]);
  const values = new Map(valued.map((r) => [r.id, withRenewalGroup(r).group.renewalValue]));
  const totalValue = Math.round([...values.values()].reduce((sum, v) => sum + v, 0) * 100) / 100;
  let rows = paged;
  if (!rows) {
    const ids = valued.map((r) => r.id);
    const rank =
      s.key === "value" ? values : new Map([...(await readInChunks(ids, lastContactOfRenewals))].map(([id, at]) => [id, at.getTime()]));
    const pageIds = pageOfRanked(ids, rank, s.dir, params.page, params.pageSize);
    rows = inIdOrder(await db.companyProduct.findMany({ where: { id: { in: pageIds } }, include: renewalInclude }), pageIds);
  }
  rows = await withContactsAsSeen(user.id, rows);

  // Who looks after each one's renewal: its customer's renewal manager, else its account manager.
  const managers = await renewalManagersOf(rows.map((r) => r.company));
  // This person's own "Remind me" on each (owner, 31 Oct 2026).
  const reminders = await myRemindersFor(user.id, rows.map((r) => ({ id: r.id, orderSeq: r.orderSeq, companyId: r.companyId })));
  const staged = await withRenewalStage(rows.map(withRenewalGroup));
  // When each bills itself next (owner, 30 Oct 2026) — by the rules the daily job keeps (check-rules.ts).
  const bills = new Map(
    rows.map((r) => [
      r.id,
      nextBill(
        r.recurringBilling && {
          ...r.recurringBilling,
          startDate: r.startDate,
          endDate: r.endDate,
          unitPrice: r.unitPrice === null ? null : Number(r.unitPrice),
          locationId: r.locationId,
          renewalStage: r.renewalStage,
          renewed: Boolean(r.renewedBy),
        },
        today,
      ),
    ]),
  );
  return {
    rows: toPlain(staged.map((r) => ({ ...r, renewalManager: managers.get(r.company.id) ?? null, nextBill: bills.get(r.id) ?? null, myReminder: reminders.get(r.id) ?? null }))),
    total,
    expired,
    totalValue,
  };
}

/**
 * The renewal manager of the customers behind a selection of renewals (owner, 30 Oct 2026): a person, or "account"
 * for back to each one's account manager. On the terms of changing an account manager, for every customer — all of
 * them or none — then a line on each that moves, and one bell for the person given them.
 */
export async function bulkSetRenewalManager(input: { orderIds: string[]; userId: string }): Promise<ActionResult<{ count: number }>> {
  const user = await requireModuleAccess("renewals");
  if (!(await renewalManagersHere())) return { ok: false, error: "Renewal managers aren't set up in this workspace yet." };
  const orderIds = Array.isArray(input?.orderIds) ? input.orderIds.filter((id) => typeof id === "string" && id) : [];
  if (orderIds.length === 0) return { ok: false, error: "Select at least one renewal." };
  if (orderIds.length > TEXT_MAX.ids) return { ok: false, error: tooMany(TEXT_MAX.ids, "renewals") };
  const next = input?.userId === "account" ? null : String(input?.userId ?? "");
  if (next === "") return { ok: false, error: "Choose who looks after them." };
  const orders = await db.companyProduct.findMany({
    where: { AND: [{ id: { in: orderIds } }, await orderAccess(user.id, "view")] },
    select: { company: { select: { id: true, name: true, ownerUserId: true, renewalManagerId: true } } },
  });
  if (orders.length !== new Set(orderIds).size) return { ok: false, error: "Some of the selected renewals are not yours to change." };
  const companies = [...new Map(orders.map((o) => [o.company.id, o.company])).values()];
  const rights = await reassignRights(user.id);
  const refused = companies.filter((c) => !mayChangeAccountManager(rights, user.id, c));
  if (refused.length) {
    return { ok: false, error: `You can't change who looks after ${refused.length === 1 ? refused[0]!.name : `${refused.length} of these customers`}.` };
  }
  if (next) {
    const person = await db.user.findUnique({ where: { id: next }, select: { active: true, name: true } });
    if (!person?.active) return { ok: false, error: "That person is not a valid, active user." };
    const notRenewals = await assignRefusal("renewalManager", next);
    if (notRenewals) return { ok: false, error: notRenewals };
  }
  await db.company.updateMany({ where: { id: { in: companies.map((c) => c.id) } }, data: { renewalManagerId: next } });
  const name = async (id: string | null) => (id ? ((await db.user.findUnique({ where: { id }, select: { name: true } }))?.name ?? "someone") : "the account manager");
  const to = await name(next);
  const moved = companies.filter((c) => c.renewalManagerId !== next);
  for (const c of moved) {
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: c.id, entityLabel: `${c.name} — renewal manager: ${await name(c.renewalManagerId)} → ${to}` });
  }
  if (next && next !== user.id && moved.length) {
    await notifyUser({
      userId: next,
      type: "ACCOUNT_MANAGER_ASSIGNED",
      title: "You were made renewal manager",
      message: `The renewals of ${moved.length} ${moved.length === 1 ? "customer" : "customers"} are yours to look after`,
      link: `/renewals?manager=${encodeURIComponent(next)}`,
    });
  }
  revalidatePath("/renewals");
  return { ok: true, data: { count: companies.length } };
}

/**
 * Turns a selection of expiring subscriptions into renewal tasks — the one action this screen
 * actually needs, since spotting an expiry is only useful if someone is then asked to chase it.
 * A task is skipped when an open renewal task already exists for that order, so re-running the
 * bulk action after adding a few more rows doesn't produce duplicates.
 */
export async function bulkCreateRenewalTasks(input: unknown): Promise<ActionResult<{ count: number; skipped: number }>> {
  const user = await requireModuleAccess("renewals");
  const parsed = bulkRenewalTasksSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orderIds, assignedToUserId, dueDate } = parsed.data;

  if (assignedToUserId) {
    const assignee = await db.user.findUnique({ where: { id: assignedToUserId }, select: { active: true } });
    if (!assignee || !assignee.active) return { ok: false, error: "That user can't be assigned tasks." };
  }

  const orders = await db.companyProduct.findMany({
    // Scoped as well as filtered by id. The rows were ticked on a list that is account-scoped now,
    // so a real selection is unaffected — but the ids are posted from the browser, and the task
    // this writes carries the customer's name onto a task list and onto their account.
    where: { AND: [{ id: { in: orderIds } }, await orderAccess(user.id, "view")] },
    select: {
      id: true,
      orderSeq: true,
      companyId: true,
      endDate: true,
      item: { select: { name: true } },
      company: { select: { name: true } },
    },
  });

  let created = 0;
  let skipped = 0;

  for (const order of orders) {
    const title = renewalTaskTitle(order.item.name, order.company.name);
    const existing = await db.task.findFirst({ where: { companyId: order.companyId, title, done: false } });
    if (existing) {
      skipped += 1;
      continue;
    }
    await db.task.create({
      data: {
        title,
        description: `${formatOrderId(order.orderSeq)} expires ${order.endDate ? order.endDate.toISOString().slice(0, 10) : "soon"}.`,
        dueDate: dueDate ? new Date(dueDate) : order.endDate,
        companyId: order.companyId,
        assignedToUserId: assignedToUserId || null,
        createdByUserId: user.id,
      },
    });
    created += 1;
    if (assignedToUserId && assignedToUserId !== user.id) {
      await notifyUser({
        userId: assignedToUserId,
        type: "TASK_ASSIGNED",
        title: "Renewal task assigned",
        message: title,
        link: "/tasks",
      });
    }
  }

  revalidatePath("/tasks");
  revalidatePath("/renewals");
  return { ok: true, data: { count: created, skipped } };
}

// ─── Renewals › Report ──────────────────────────────────────────────────────────────────────────

const MONTH = /^\d{4}-\d{2}$/;
const REPORT_MAX_MONTHS = 24;

export type RenewalReportView = RenewalReport & { from: string; to: string; thisMonth: string; clamped: boolean };

/**
 * Renewals › Report (owner, 26 Oct 2026 — src/lib/renewals-report.ts): the subscriptions that came up for renewal
 * in a run of months, within the viewer's reach — the renewals list's own rule. The last twelve months unless
 * told; two years at most.
 */
export async function renewalReport(params: { from?: string; to?: string }): Promise<RenewalReportView | null> {
  const user = await requireModuleAccess("renewals");
  if (!(await viewerHas("renewals.view"))) return null;
  const clock = await workspaceClock();
  const thisMonth = clock.today().slice(0, 7);
  const shiftMonth = (m: string, by: number) => {
    const [y, mo] = m.split("-").map(Number) as [number, number];
    const d = new Date(Date.UTC(y, mo - 1 + by, 1));
    return d.toISOString().slice(0, 7);
  };
  let to = params.to && MONTH.test(params.to) ? params.to : thisMonth;
  let from = params.from && MONTH.test(params.from) ? params.from : shiftMonth(to, -11);
  if (from > to) [from, to] = [to, from];
  const clamped = shiftMonth(from, REPORT_MAX_MONTHS - 1) < to;
  if (clamped) from = shiftMonth(to, -(REPORT_MAX_MONTHS - 1));
  // End dates are typed days, kept at midnight UTC: a month is its first day to the next month's.
  const range = { gte: new Date(`${from}-01T00:00:00.000Z`), lt: new Date(`${shiftMonth(to, 1)}-01T00:00:00.000Z`) };

  const rows = await db.companyProduct.findMany({
    where: {
      AND: [
        await orderAccess(user.id, "view"),
        { item: { type: "SUBSCRIPTION" }, parentId: null, orderStatus: { notIn: ["CANCELLED", "REJECTED"] }, endDate: range, company: { managedByResellerId: null } },
      ],
    },
    take: 20_000,
    select: {
      id: true,
      endDate: true,
      quantity: true,
      unitPrice: true,
      fullTermUnitPrice: true,
      renewalStage: true,
      renewalStageNote: true,
      item: { select: { name: true } },
      company: { select: { owner: { select: { id: true, name: true } } } },
      renewedBy: { select: { orderStatus: true } },
    },
  });
  const report = buildRenewalReport(
    // What the clean-up closed ended before Deskzo: no renewal anybody here won or lost (src/lib/renewal-tidy.ts).
    rows.filter((r) => r.renewalStageNote !== TIDY_NOTE).map((r) => {
      const price = Number(r.fullTermUnitPrice ?? r.unitPrice ?? 0);
      const renewed = !!r.renewedBy && r.renewedBy.orderStatus !== "CANCELLED" && r.renewedBy.orderStatus !== "REJECTED";
      return {
        id: r.id,
        endDate: r.endDate!,
        value: Math.round(price * r.quantity * 100) / 100,
        outcome: renewed ? "RENEWED" : r.renewalStage === "LOST" ? "LOST" : "OPEN",
        lostReason: r.renewalStageNote,
        product: r.item.name,
        ownerId: r.company.owner?.id ?? null,
        ownerName: r.company.owner?.name ?? null,
      };
    }),
    (d) => d.toISOString().slice(0, 7),
  );
  return { ...report, from, to, thisMonth, clamped };
}
