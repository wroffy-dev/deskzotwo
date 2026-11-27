"use server";

import { pageSlice } from "@/lib/pagination";
import { revalidatePath } from "next/cache";
import { elsewhereCategoryOptions } from "@/lib/customers/elsewhere-categories";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { companyScope } from "@/lib/authz/company-scope";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { buildWhere, countActiveFilters, withoutMaskedFilters, withoutResellerFlag, type WorkbookFilters } from "@/lib/workspace/filters";
import { notifyUser } from "@/lib/notify";
import { callersChanged, reshareUncalled } from "@/lib/workspace/reshare";
import { workspaceClock } from "@/lib/time/workspace";
import { companyMasker, maskCompanyWith } from "@/lib/companies/masking";
import { domainProfileAsSeen } from "@/lib/domain-intel/masking";
import type { ActionResult } from "@/actions/company";
import { clip, clipOrNull, withinSize, TEXT_MAX } from "@/lib/text/bounded";
import { syncSmartListAudiences } from "@/lib/marketing/smart-list-audience";
import { listMembersWhere, smartListsReady } from "@/lib/smart-lists/membership";
import { copyRowList, ownRowsReady } from "@/lib/smart-lists/own-rows";
import { cleanQuery, effectiveSort } from "@/lib/smart-lists/view-query";
import { companyPageByColumn, companyQueryWhere } from "@/lib/smart-lists/view-query-server";
import { companyTotals, type ListTotals } from "@/lib/smart-lists/totals";
import { rightsFor, rightsForMany } from "@/lib/smart-lists/access";
import { optionsOf, type PropertyKind } from "@/lib/smart-lists/values";
import { formulaOf } from "@/lib/smart-lists/formulas";

const rowSelect = {
  id: true,
  companySeq: true,
  name: true,
  relationshipType: true,
  stage: true,
  employeeCount: true,
  website: true,
  tags: true,
  createdAt: true,
  industry: { select: { name: true } },
  owner: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
  locations: {
    orderBy: { isPrimary: "desc" as const },
    take: 5,
    select: { city: true, state: true, isPrimary: true },
  },
  domainProfile: { select: { emailProvider: true, platform: true, dmarcRecord: true, dmarcPolicy: true } },
  _count: { select: { contacts: true, products: true, leads: true, locations: true } },
  calls: { orderBy: { startedAt: "desc" as const }, take: 1, select: { startedAt: true, outcome: true } },
} satisfies Prisma.CompanySelect;

/**
 * Runs a filter set and returns the matching companies.
 *
 * Used for the live preview while someone builds a list and again when they open a saved one, so
 * what they saw when saving is exactly what they get back — there's no second code path to drift.
 */
export async function runWorkbook(params: {
  filters: WorkbookFilters;
  page: number;
  pageSize: number;
  search?: string;
  /** A saved list's id: the companies added to it by hand come too (src/lib/smart-lists/membership.ts). */
  workbookId?: string;
  /**
   * A view's filters and sort on the list's own columns (Smart Lists phase 2, src/lib/smart-lists/view-query.ts) — the
   * rules as the page has them, checked here against the list's columns like anything else a page sends.
   */
  query?: unknown;
  /** Every column added up over the rows the view shows, for the table's footer. */
  totals?: boolean;
}) {
  const user = await requireModuleAccess("workspace");

  /**
   * A saved list is a view of the company table, and it was the one that forgot to say whose.
   *
   * Every other company list narrows to the accounts somebody manages. This one did not, and it is
   * the most complete view in the app: name, website, stage, tags, industry, city, the real account
   * manager's name, how many contacts and products and leads each has, and the outcome of the last
   * call. Measured while wiring the rest up — a sales executive entitled to 47 companies got 476
   * from a workbook with no filters at all, which is every customer in the business with a summary
   * beside each one.
   *
   * Worse than a list, because a workbook feeds `startCallingActivity`: the rows become a call
   * sheet somebody works through.
   *
   * `AND` rather than side by side — `companyScope` writes `ownerUserId` and `buildWhere` may write
   * it too, and a spread is an assignment. See `agingReport` for what that costs when it goes
   * unnoticed.
   */
  // Security audit round three, 14 Nov 2026 (R3-21): a filter on a field the list masks for this person (city,
  // state, the website and its domain's facts) is dropped, or it answers the masked value one company at a time.
  const shown = await companyMasker(user.id, "list");
  // A saved list's own companies, filters or added by hand (owner, 20 Nov 2026), inside the same scope; a builder's
  // preview has no id and is its filters alone, as before.
  const members =
    typeof params.workbookId === "string" && params.workbookId
      ? await listMembersWhere(user.id, params.workbookId, params.filters ?? {})
      : { AND: [await companyScope(user.id), buildWhere(withoutMaskedFilters(params.filters ?? {}, shown), await workspaceClock())] };
  // A view's rules and order (Smart Lists phase 2): only on a saved list, only its own columns.
  const listId = typeof params.workbookId === "string" && params.workbookId ? params.workbookId : null;
  const props = listId && (params.query || params.totals) && (await smartListsReady())
    ? (await db.workbookProperty.findMany({ where: { workbookId: listId }, select: { id: true, name: true, kind: true, options: true } })).map((p) => ({ id: p.id, name: p.name, kind: p.kind as PropertyKind, options: optionsOf(p.options), formula: p.kind === "FORMULA" ? formulaOf(p.options) : null }))
    : [];
  const view = listId && params.query ? cleanQuery(params.query, props, false) : null;
  const clock = await workspaceClock();
  const ruled = view && listId ? await companyQueryWhere(listId, view, props, { userId: user.id, clock, today: clock.today() }) : null;
  const where: Prisma.CompanyWhereInput = {
    AND: [members, ...(typeof params.search === "string" && params.search ? [{ name: { contains: params.search, mode: "insensitive" as const } }] : []), ...(ruled ? [ruled] : [])],
  };
  // A group's column first (Smart Lists phase 3), then the view's sort.
  const firstSort = view ? (effectiveSort(view)[0] ?? null) : null;
  const byColumn = firstSort ? props.find((p) => p.id === firstSort.field) ?? null : null;

  let rows;
  let total: number;
  if (byColumn && firstSort) {
    // Sorted by one of the list's columns: the companies with a value in its order, then the rest by name.
    const { skip, take } = pageSlice(params.page, params.pageSize);
    const paged = await companyPageByColumn({ members: where, prop: byColumn, dir: firstSort.dir, skip: skip ?? 0, take: take ?? params.pageSize });
    const found = await db.company.findMany({ where: { id: { in: paged.ids } }, select: rowSelect });
    const at = new Map(paged.ids.map((id, i) => [id, i]));
    rows = found.sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0));
    total = paged.total;
  } else {
    [rows, total] = await Promise.all([
      db.company.findMany({
        where,
        orderBy: { name: firstSort?.dir === "desc" ? "desc" : "asc" },
        ...pageSlice(params.page, params.pageSize),
        select: rowSelect,
      }),
      db.company.count({ where }),
    ]);
  }
  const totals: ListTotals | null = params.totals && listId && props.length ? await companyTotals(listId, where, props) : null;

  // Each company's website, city and state as a company list shows them (owner, 5 Nov 2026 — Phase 3 masking fixes,
  // audit H.4.1; src/lib/companies/masking.ts): a saved list printed them in full whatever the person's field access —
  // and its DMARC record names the website's domain (src/lib/domain-intel/masking.ts).
  return toPlain({ rows: rows.map((r) => ({ ...maskCompanyWith(shown, r), domainProfile: r.domainProfile ? domainProfileAsSeen(shown, r.website, r.domainProfile) : null })), total, totals });
}

/** Just the count, for the live "matches N companies" figure as filters are toggled. */
export async function countWorkbook(filters: WorkbookFilters) {
  const user = await requireModuleUser("workspace");
  // The live count under the filter builder. Unscoped, it told somebody how many companies match
  // across the whole business — a smaller leak than the rows, and the same one.
  // The masked fields' filters dropped, as on the list (R3-21) — the count would answer them as well.
  const shown = await companyMasker(user.id, "list");
  return db.company.count({ where: { AND: [await companyScope(user.id), buildWhere(withoutMaskedFilters(filters ?? {}, shown), await workspaceClock())] } });
}

export async function saveWorkbook(input: {
  id?: string;
  name: string;
  description?: string;
  filters: WorkbookFilters;
  shared?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleAccess("workspace");

  // Typed text is capped before it is stored (owner, 15 Nov 2026 — input bounds).
  const name = clip(input.name, TEXT_MAX.name);
  if (!name) return { ok: false, error: "Give the list a name — it's how anyone finds it again." };
  if (!withinSize(input.filters)) return { ok: false, error: "That's too much to save at once." };

  if (input.id) {
    const existing = await db.workbook.findUnique({ where: { id: input.id }, select: { ownerUserId: true } });
    if (!existing) return { ok: false, error: "That list no longer exists." };
    // Shared lists are visible to everyone but stay editable only by whoever built them, so one
    // person's working list can't be redefined out from under them.
    if (existing.ownerUserId !== user.id && !(await hasEffectivePermission(user.id, "workspace.manageAny"))) {
      return { ok: false, error: "This list belongs to someone else. Duplicate it to make your own version." };
    }
  }

  const data = {
    name,
    description: clipOrNull(input.description, TEXT_MAX.paragraph),
    // Security audit round three, 14 Nov 2026 (R3-20): saved as sent, `includeResellerManaged` let a workbook reach
    // a reseller's end customers. A workbook never keeps it; only a report source may count them.
    filters: withoutResellerFlag(input.filters && typeof input.filters === "object" && !Array.isArray(input.filters) ? input.filters : {}) as Prisma.InputJsonValue,
    shared: input.shared ?? true,
  };

  const saved = input.id
    ? await db.workbook.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.workbook.create({ data: { ...data, ownerUserId: user.id }, select: { id: true } });
  // Marketing audiences that follow this list take its filters again (owner, 16 Nov 2026).
  if (input.id) await syncSmartListAudiences(saved.id, data.filters);

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "Workbook",
    entityId: saved.id,
    entityLabel: name,
  });
  revalidatePath("/smart-lists");
  return { ok: true, data: saved };
}

export async function deleteWorkbook(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("workspace");
  const workbook = await db.workbook.findUnique({ where: { id }, select: { name: true, ownerUserId: true } });
  if (!workbook) return { ok: false, error: "That list no longer exists." };
  if (workbook.ownerUserId !== user.id && !(await hasEffectivePermission(user.id, "workspace.manageAny"))) {
    return { ok: false, error: "This list belongs to someone else." };
  }

  await db.workbook.delete({ where: { id } });
  // Answers to its public forms go with it — strangers' answers aren't kept for a list that's gone (Smart Lists phase 4).
  await db.workbookFormSubmission.deleteMany({ where: { workbookId: id } }).catch(() => {});
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Workbook",
    entityId: id,
    entityLabel: `Deleted ${workbook.name}`,
  });
  revalidatePath("/smart-lists");
  return { ok: true, data: null };
}

/** Copies someone else's list so it can be changed without touching theirs. */
export async function duplicateWorkbook(id: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleAccess("workspace");
  const source = await db.workbook.findUnique({ where: { id }, select: { name: true, description: true, filters: true, shared: true, ownerUserId: true, mode: true } });
  // Only a list this person could open (getWorkbook's rule): a private one copied by its link was a
  // way to read somebody else's working list — its filters, and so who is on it.
  const visible = !!source && (source.shared || source.ownerUserId === user.id || (await hasEffectivePermission(user.id, "workspace.manageAny")));
  if (!source || !visible) return { ok: false, error: "That list no longer exists." };

  const copy = await db.workbook.create({
    data: {
      name: `${source.name} (copy)`,
      description: source.description,
      filters: source.filters as Prisma.InputJsonValue,
      ownerUserId: user.id,
      // A list with rows of its own is copied whole — its columns, views and rows (src/lib/smart-lists/own-rows.ts).
      ...(source.mode === "ROWS" ? { mode: "ROWS" as const } : {}),
    },
    select: { id: true },
  });
  if (source.mode === "ROWS" && (await ownRowsReady())) await copyRowList(id, copy.id, user.id);
  revalidatePath("/smart-lists");
  return { ok: true, data: copy };
}

export async function getWorkbook(id: string) {
  const user = await requireModuleAccess("workspace");
  const workbook = await db.workbook.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      filters: true,
      shared: true,
      ownerUserId: true,
      mode: true,
      dueAt: true,
      startedAt: true,
      allocationMethod: true,
      createdAt: true,
      updatedAt: true,
      owner: { select: { id: true, name: true } },
      assignees: {
        orderBy: { assignedAt: "asc" },
        select: {
          userId: true,
          note: true,
          assignedAt: true,
          user: { select: { id: true, name: true } },
          assignedBy: { select: { name: true } },
        },
      },
    },
  });
  if (!workbook) return null;
  // Who may see it (Smart Lists phase 4 — src/lib/smart-lists/access.ts): private, chosen people and departments.
  const rights = await rightsFor(user.id, workbook);
  if (!rights.view) return null;

  // Not awaited: a failed timestamp write should never stop the list from opening.
  void db.workbook.update({ where: { id }, data: { lastOpenedAt: new Date() } }).catch(() => null);

  return toPlain({
    ...workbook,
    filters: (workbook.filters ?? {}) as WorkbookFilters,
    canEdit: rights.shape,
    canFill: rights.fill,
  });
}

export async function listWorkbooks() {
  const user = await requireModuleAccess("workspace");
  const rows = await db.workbook.findMany({
    where: { OR: [{ shared: true }, { ownerUserId: user.id }] },
    orderBy: [{ lastOpenedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      description: true,
      filters: true,
      shared: true,
      ownerUserId: true,
      mode: true,
      dueAt: true,
      lastOpenedAt: true,
      updatedAt: true,
      owner: { select: { name: true } },
      _count: { select: { records: true } },
      assignees: { select: { userId: true, user: { select: { id: true, name: true } } } },
    },
  });

  // Only lists this person may see — a list open to chosen people only isn't listed for anybody else (Smart Lists phase 4).
  const rights = await rightsForMany(user.id, rows);
  return toPlain(
    rows.filter((w) => rights.get(w.id)?.view).map((w) => ({
      ...w,
      filterCount: countActiveFilters((w.filters ?? {}) as WorkbookFilters),
      mine: w.ownerUserId === user.id,
      assignedToMe: w.assignees.some((a) => a.userId === user.id),
    })),
  );
}

/**
 * The values the filter form offers.
 *
 * Read from the data rather than hard-coded, so the city and industry lists only ever contain
 * things that will actually match something — an empty result from a filter nobody could satisfy
 * is the fastest way to make a list builder feel broken.
 */
export async function workbookFilterOptions() {
  const user = await requireModuleUser("workspace");
  const [industries, cities, states, categories, users, tags, providers, platforms, brands, families, items] = await Promise.all([
    db.industry.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.companyLocation.findMany({
      where: { city: { not: null } },
      distinct: ["city"],
      orderBy: { city: "asc" },
      select: { city: true },
    }),
    db.companyLocation.findMany({
      where: { state: { not: null } },
      distinct: ["state"],
      orderBy: { state: "asc" },
      select: { state: true },
    }),
    db.company.findMany({
      where: { category: { not: null } },
      distinct: ["category"],
      orderBy: { category: "asc" },
      select: { category: true },
    }),
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.company.findMany({ where: { tags: { isEmpty: false } }, select: { tags: true }, take: 500 }),
    db.domainProfile.findMany({
      where: { emailProvider: { not: null } },
      distinct: ["emailProvider"],
      select: { emailProvider: true },
    }),
    db.domainProfile.findMany({
      where: { platform: { not: null } },
      distinct: ["platform"],
      select: { platform: true },
    }),
    db.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.productFamily.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    // Only items somebody has actually ordered — filtering on a product nobody bought returns an
    // empty list, which reads as the builder being broken rather than the filter being wrong.
    db.item.findMany({
      where: { companyProducts: { some: {} } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, sku: true },
    }),
  ]);

  // The cities and states offered only to somebody who sees them in the clear in a list (owner, 5 Nov 2026 — Phase 3
  // masking fixes, audit H.4.1; src/lib/companies/masking.ts): the options were every company's, spelt out — the very
  // values the companies policy masks. "City only" leaves the cities, and masks the states.
  const places = (await companyMasker(user.id, "list")).location({ city: "x", state: "x" });
  return {
    industries,
    cities: places.city === "x" ? cities.map((c) => c.city!).filter(Boolean) : [],
    states: places.state === "x" ? states.map((s) => s.state!).filter(Boolean) : [],
    categories: categories.map((c) => c.category!).filter(Boolean),
    users,
    tags: [...new Set(tags.flatMap((t) => t.tags))].sort(),
    emailProviders: providers.map((p) => p.emailProvider!).filter(Boolean),
    platforms: platforms.map((p) => p.platform!).filter(Boolean),
    brands,
    families,
    items,
    // Installed elsewhere's categories (Settings › Lists), as id/name so a saved list's chip reads the name.
    elsewhereCategories: (await elsewhereCategoryOptions()).map((c) => ({ id: c.key, name: c.name })),
  };
}

/**
 * Hands a list to the people who will work it.
 *
 * Replaces the whole set rather than adding one at a time: assignment is edited as "these people",
 * and a bare add would make removing somebody a second, easily-forgotten step. Everyone assigned
 * gets told, because a list nobody knows about is a list nobody works.
 */
export async function assignWorkbook(input: {
  id: string;
  userIds: string[];
  note?: string;
}): Promise<ActionResult<{ assigned: number }>> {
  const user = await requireModuleAccess("workspace");
  const workbook = await db.workbook.findUnique({
    where: { id: input.id },
    select: { id: true, name: true, ownerUserId: true, mode: true, allocationMethod: true, dueAt: true, assignees: { select: { userId: true, taskId: true } } },
  });
  if (!workbook) return { ok: false, error: "That list no longer exists." };
  if (workbook.ownerUserId !== user.id && !(await hasEffectivePermission(user.id, "workspace.manageAny"))) {
    return { ok: false, error: "Only the person who built this list can assign it." };
  }

  const wanted = [...new Set(input.userIds.filter(Boolean))];
  const already = new Set(workbook.assignees.map((a) => a.userId));
  const added = wanted.filter((id) => !already.has(id));

  // A calling activity's people are its callers (owner, 11 Nov 2026): somebody added here had no records, so no queue
  // and no row under "By caller". The uncalled records are shared out again between whoever is on it now.
  const calling = workbook.mode === "COLD_CALLING";
  if (calling && wanted.length === 0) return { ok: false, error: "A calling activity needs at least one caller. Its uncalled records have to be somebody's." };
  const shares = new Map<string, number>();

  await db.$transaction(async (tx) => {
    await tx.workbookAssignee.deleteMany({ where: { workbookId: workbook.id, userId: { notIn: wanted.length > 0 ? wanted : ["-"] } } });
    await tx.workbookAssignee.createMany({
      data: added.map((userId) => ({
        workbookId: workbook.id,
        userId,
        assignedByUserId: user.id,
        note: input.note?.trim() || null,
      })),
      skipDuplicates: true,
    });
    if (!calling) return;
    const holders = await tx.workbookRecord.findMany({ where: { workbookId: workbook.id }, distinct: ["assignedToUserId"], select: { assignedToUserId: true } });
    if (!callersChanged(wanted, holders.map((h) => h.assignedToUserId))) return;
    for (const a of await reshareUncalled(tx, workbook.id, wanted, workbook.allocationMethod)) shares.set(a.userId, (shares.get(a.userId) ?? 0) + 1);
    // A caller with no task for it yet gets one, as the callers it started with did.
    const tasked = new Set(workbook.assignees.filter((a) => a.taskId).map((a) => a.userId));
    for (const userId of wanted.filter((id) => !tasked.has(id))) {
      const share = shares.get(userId) ?? 0;
      const task = await tx.task.create({
        data: {
          title: `Call through ${workbook.name}`,
          description: `${share} compan${share === 1 ? "y" : "ies"} to call.` + (input.note?.trim() ? ` ${input.note.trim()}` : ""),
          dueDate: workbook.dueAt,
          assignedToUserId: userId,
          createdByUserId: user.id,
        },
        select: { id: true },
      });
      await tx.workbookAssignee.update({ where: { workbookId_userId: { workbookId: workbook.id, userId } }, data: { taskId: task.id, dueAt: workbook.dueAt } });
    }
  });

  for (const userId of added) {
    await notifyUser({
      userId,
      type: "TASK_ASSIGNED",
      title: calling ? "Calling list assigned to you" : "A list was assigned to you",
      message: calling ? `${workbook.name} — ${shares.get(userId) ?? 0} to call${input.note?.trim() ? `. ${input.note.trim()}` : ""}` : `${workbook.name} — ${input.note?.trim() || "ready to work"}`,
      link: calling ? `/smart-lists/${workbook.id}/call` : `/smart-lists/${workbook.id}`,
    });
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Workbook",
    entityId: workbook.id,
    entityLabel: `Assigned ${workbook.name} to ${wanted.length} person(s)`,
  });
  revalidatePath("/smart-lists");
  revalidatePath(`/smart-lists/${workbook.id}`);
  return { ok: true, data: { assigned: wanted.length } };
}
