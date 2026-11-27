/**
 * check:smart-lists-phase-2 — Smart Lists phase 2 (owner, 20 Nov 2026; src/lib/smart-lists/view-query*.ts, reminders.ts,
 * links.ts, files.ts, totals.ts; src/actions/smart-list-links.ts):
 *
 *   · A view's filters: every kind's rules, "is not" and "doesn't contain" taking in the empty ones, text whatever its
 *     case, "me", days relative to today, all or any; its sort, empties last; saved for everyone by the builder only;
 *     tried in the address bar by anybody. On a list of its own rows and on a list of companies.
 *   · The footer: every column added up over the rows the view shows.
 *   · Reminders from a Date column: once a date, again when the date changes, never a date gone by, only people who
 *     may open the list, emailed.
 *   · Links to companies, another list's rows: only what the person may see; names shown, "In these lists".
 *   · Files: a PDF or an image only, downloaded by whoever may open the list, deleted when taken off or the row goes.
 *   · Many rows at once.
 *
 * Against the local database, as its super admin and one person who can't manage every list; everything made is removed.
 *
 *   npm run check:smart-lists-phase-2
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "ADMIN", name: "Zz Lists 2", email: "zz-lists2@example.invalid" };
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/smart-lists",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  // A company list's page reads its view mode from a cookie: none here, so the table.
  if (request === "next/headers") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) };
  }
  if (request === "@/lib/auth") {
    return { auth: async () => ({ user: { ...actor, sid: null } }), signIn: async () => {}, signOut: async () => {}, handlers: {} };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function main() {
  const vq = await import("../src/lib/smart-lists/view-query");

  section("Rules, as kept");
  const props0 = [
    { id: "pstatusaaaa", name: "Status", kind: "SELECT" as const, options: [{ id: "live", name: "Live", color: "green" as const }] },
    { id: "pnumberaaaa", name: "DA", kind: "NUMBER" as const, options: [] },
  ];
  const cleaned = vq.cleanQuery({ match: "any", rules: [{ field: "pstatusaaaa", op: "any_of", value: ["live", "nope"] }, { field: "pnumberaaaa", op: "contains", value: "x" }, { field: "gone", op: "empty" }, { field: "pnumberaaaa", op: "gt", value: "40" }], sort: [{ field: "pnumberaaaa", dir: "desc" }, { field: "pnumberaaaa", dir: "asc" }] }, props0, true);
  ok("unknown choices, ops a kind doesn't offer and gone columns dropped; numbers read; a column sorted once", JSON.stringify(cleaned) === JSON.stringify({ match: "any", rules: [{ field: "pstatusaaaa", op: "any_of", value: ["live"] }, { field: "pnumberaaaa", op: "gt", value: 40 }], sort: [{ field: "pnumberaaaa", dir: "desc" }], group: null }), cleaned);
  ok("the address bar's form reads back the same", JSON.stringify(vq.cleanQuery(vq.decodeQuery(vq.encodeQuery(cleaned)), props0, true)) === JSON.stringify(cleaned));
  ok("ranges from today: the next 7 days, this month, gone by", JSON.stringify(vq.resolveRange("next_7", "2026-11-20")) === JSON.stringify({ from: "2026-11-20", to: "2026-11-27" }) && JSON.stringify(vq.resolveRange("this_month", "2026-02-10")) === JSON.stringify({ from: "2026-02-01", to: "2026-02-28" }) && vq.resolveRange("overdue", "2026-11-20").to === "2026-11-19");
  ok("a rule in words", vq.describeRule(cleaned.rules[0]!, props0, "Page") === "Status is any of Live");

  const db = directClient();
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true } });
  if (!admin) throw new Error("No super admin in the local database.");
  const { hasEffectivePermission } = await import("../src/actions/permission");
  const candidates = await db.user.findMany({ where: { active: true, isSuperAdmin: false }, select: { id: true, name: true, email: true }, take: 60 });
  let other: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    if (!(await hasEffectivePermission(c.id, "workspace.manageAny"))) {
      other = c;
      break;
    }
  }
  if (!other) throw new Error("No active person without workspace.manageAny in the local database.");
  const as = (u: { id: string; name: string; email: string | null }) => {
    actor = { id: u.id, role: "ADMIN", name: u.name, email: u.email ?? "zz@example.invalid" };
  };
  as(admin);

  const run = Date.now().toString(36);
  const workbooks: string[] = [];
  const companies: string[] = [];
  const rows = await import("../src/actions/smart-list-rows");
  const board = await import("../src/actions/smart-list-board");
  const links = await import("../src/actions/smart-list-links");
  const own = await import("../src/lib/smart-lists/own-rows");
  const vqs = await import("../src/lib/smart-lists/view-query-server");
  const totalsLib = await import("../src/lib/smart-lists/totals");
  const { workspaceClock } = await import("../src/lib/time/workspace");
  const clock = await workspaceClock();
  const today = clock.today();
  const plus = (n: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const mailer = await import("../src/lib/platform/mailer");
  const mails: { to?: unknown; subject?: unknown }[] = [];
  mailer.setTestPlatformMailer(async (m) => void mails.push(m as { to?: unknown; subject?: unknown }));

  try {
    section("A list of its own rows, filtered and sorted");
    const made = await rows.createOwnRowList({ name: `Zz Phase2 ${run}` });
    const articles = await rows.createOwnRowList({ name: `Zz Articles ${run}` });
    if (!made.ok || !articles.ok) throw new Error("lists not made");
    const id = made.data.id;
    workbooks.push(id, articles.data.id);
    const col = async (name: string, kind: string, options?: unknown) => {
      const r = await board.addListProperty({ workbookId: id, name, kind, options });
      if (!r.ok) throw new Error(`${name}: ${r.error}`);
      return r.data.id;
    };
    const status = await col("Status", "SELECT", [{ name: "Live" }, { name: "Lost" }, { name: "Pending" }]);
    const da = await col("DA", "NUMBER");
    const due = await col("Due", "DATE");
    const owner = await col("Owner", "PERSON");
    const done = await col("Done", "CHECKBOX");
    const notes = await col("Notes", "TEXT");
    const cost = await col("Cost", "MONEY");
    const customer = await col("Customer", "COMPANY");
    const proof = await col("Proof", "FILE");
    ok("a Row column must name a list with rows of its own", !(await board.addListProperty({ workbookId: id, name: "Article", kind: "ROW", options: { listId: id + "x" } })).ok);
    const article = await col("Article", "ROW", { listId: articles.data.id });
    const opts = (await db.workbookProperty.findUnique({ where: { id: status }, select: { options: true } }))!.options as { id: string; name: string }[];
    const [live, lost] = [opts.find((o) => o.name === "Live")!.id, opts.find((o) => o.name === "Lost")!.id];

    const add = async (title: string) => {
      const r = await rows.addOwnRow({ workbookId: id, title });
      if (!r.ok) throw new Error(r.error);
      return r.data.id;
    };
    const A = await add("Alpha page");
    const B = await add("Beta page");
    const C = await add("Gamma page");
    const D = await add("Delta page");
    const set = async (rowId: string, propertyId: string, value: unknown) => {
      const r = await rows.setOwnRowValue({ rowId, propertyId, value });
      if (!r.ok) throw new Error(`${propertyId}: ${r.error}`);
    };
    await set(A, status, live);
    await set(A, da, 50);
    await set(A, due, plus(2));
    await set(A, owner, admin.id);
    await set(A, done, true);
    await set(A, notes, "An Alpha note");
    await set(A, cost, 100);
    await set(B, status, lost);
    await set(B, da, 20);
    await set(B, due, plus(-3));
    await set(B, owner, other.id);
    await set(B, notes, "beta");
    await set(C, status, opts.find((o) => o.name === "Pending")!.id);
    await set(C, da, 70);
    await set(C, cost, 50);
    await set(D, da, 5);

    const props = await own.propsOf(id);
    const ctx = { userId: admin.id, clock, today };
    const titles = async (q: unknown) => {
      const query = vq.cleanQuery(q, props, true);
      const filter = await vqs.ownRowsQueryWhere(id, query, props, ctx);
      const page = await own.ownRowsPage(id, props, { skip: 0, take: 50, filter, sort: query.sort });
      return page.rows.map((r) => r.title[0]).join("");
    };
    const rule = (field: string, op: string, value?: unknown) => ({ rules: [{ field, op, value }] });
    ok("a choice: is any of", (await titles(rule(status, "any_of", [live]))) === "A");
    ok("is none of takes in the empty ones", (await titles(rule(status, "none_of", [live]))) === "BGD");
    ok("a number: greater than", (await titles(rule(da, "gt", 30))) === "AG");
    ok("a date within the next 7 days, before today, or empty", (await titles(rule(due, "within", "next_7"))) === "A" && (await titles(rule(due, "before", "today"))) === "B" && (await titles(rule(due, "empty"))) === "GD");
    ok("a person: me", (await titles(rule(owner, "any_of", ["@me"]))) === "A");
    ok("a checkbox ticked, and not", (await titles(rule(done, "ticked"))) === "A" && (await titles(rule(done, "not_ticked"))) === "BGD");
    ok("text contains, whatever its case; doesn't contain takes in the empty ones", (await titles(rule(notes, "contains", "ALPHA"))) === "A" && (await titles(rule(notes, "not_contains", "alpha"))) === "BGD" && (await titles(rule(notes, "is", "BETA"))) === "B");
    ok("the title, and the day a row was added", (await titles(rule("title", "contains", "elt"))) === "D" && (await titles(rule("createdAt", "is", "today"))) === "ABGD");
    ok("any of several rules", (await titles({ match: "any", rules: [{ field: status, op: "any_of", value: [live] }, { field: da, op: "gt", value: 60 }] })) === "AG");
    ok("all of several rules", (await titles({ match: "all", rules: [{ field: da, op: "gt", value: 10 }, { field: status, op: "not_empty" }] })) === "ABG");
    ok("sorted: a number high to low, a choice in its order (empty last), the title backwards", (await titles({ sort: [{ field: da, dir: "desc" }] })) === "GABD" && (await titles({ sort: [{ field: status, dir: "asc" }] })) === "ABGD" && (await titles({ sort: [{ field: "title", dir: "desc" }] })) === "GDBA");
    const sums = await totalsLib.ownRowTotals(id, props, { filter: null });
    ok("the footer over every row: rows, sums, ticked, filled", sums.count === 4 && sums.columns[da]?.sum === 145 && sums.columns[cost]?.sum === 150 && sums.columns[done]?.ticked === 1 && sums.columns[status]?.filled === 3, sums);
    const narrowed = await totalsLib.ownRowTotals(id, props, { filter: await vqs.ownRowsQueryWhere(id, vq.cleanQuery(rule(da, "gt", 30), props, true), props, ctx) });
    ok("…and over the rows a filter leaves", narrowed.count === 2 && narrowed.columns[da]?.sum === 120);

    section("Saving a view's filters");
    const view = await board.addListView({ workbookId: id, name: "Live", kind: "TABLE" });
    if (!view.ok) throw new Error(view.error);
    const savedQ = await links.saveViewQuery({ viewId: view.data.id, query: { rules: [{ field: status, op: "any_of", value: [live, "nope"] }], sort: [{ field: da, dir: "desc" }] } });
    ok("the builder saves them, cleaned", savedQ.ok && JSON.stringify(savedQ.data.rules) === JSON.stringify([{ field: status, op: "any_of", value: [live] }]));
    const pq = await vqs.pageQuery({ workbookId: id, viewId: view.data.id, param: undefined, props, own: true });
    const tried = await vqs.pageQuery({ workbookId: id, viewId: view.data.id, param: vq.encodeQuery({ match: "all", rules: [{ field: da, op: "lt", value: 30 }], sort: [] }), props, own: true });
    ok("the page shows the saved view, or the one tried in the address bar", pq.current.rules.length === 1 && pq.current.sort[0]?.field === da && tried.current.rules[0]?.op === "lt" && tried.saved.rules.length === 1);
    as(other);
    ok("somebody else can't save them", !(await links.saveViewQuery({ viewId: view.data.id, query: {} })).ok);
    as(admin);
    ok("emptied, they go", (await links.saveViewQuery({ viewId: view.data.id, query: {} })).ok && (await db.workbookViewQuery.count({ where: { viewId: view.data.id } })) === 0);

    section("Links");
    const city = `Zzcity2${run}`;
    const mkCompany = async (name: string) => {
      const c = await db.company.create({ data: { name: `Zz P2 ${run} ${name}`, normalizedName: `zz p2 ${run} ${name}`.toLowerCase(), createdById: admin.id, ownerUserId: admin.id }, select: { id: true } });
      companies.push(c.id);
      await db.companyLocation.create({ data: { companyId: c.id, label: "Head office", city, isPrimary: true } });
      return c.id;
    };
    const acme = await mkCompany("Acme");
    const found = await links.searchLinkTargets({ propertyId: customer, query: `Zz P2 ${run} Ac` });
    ok("a company found by name", found.length === 1 && found[0]!.id === acme, found);
    await set(A, customer, [acme]);
    const notReal = "cnotarealcompanyid0000000";
    ok("a record that isn't the person's to link is refused", !(await rows.setOwnRowValue({ rowId: B, propertyId: customer, value: [notReal] })).ok);
    const art = await rows.addOwnRow({ workbookId: articles.data.id, title: "Best CRM in India" });
    if (!art.ok) throw new Error(art.error);
    await set(A, article, [art.data.id]);
    ok("a row of another list, and none of a third", !(await rows.setOwnRowValue({ rowId: B, propertyId: article, value: [A] })).ok);
    const { linkLabels, listsLinking } = await import("../src/lib/smart-lists/links");
    const page = await own.ownRowsPage(id, props, { skip: 0, take: 50 });
    const labels = await linkLabels(await board.getListBoard(id, []).then((b) => b!.properties), page.values, admin.id);
    ok("linked records shown by name, each with its page", labels[acme]?.name === `Zz P2 ${run} Acme` && !!labels[acme]?.href?.startsWith("/companies/") && labels[art.data.id]?.name === "Best CRM in India", labels);
    const linking = await listsLinking("COMPANY", acme, admin.id);
    ok("the company's page lists the list and the row", linking.length === 1 && linking[0]!.listId === id && linking[0]!.rows[0]!.title === "Alpha page");
    const { companyScope } = await import("../src/lib/authz/company-scope");
    const otherSees = (await db.company.count({ where: { AND: [await companyScope(other.id), { id: acme }] } })) > 0;
    const otherLabels = await linkLabels(await board.getListBoard(id, []).then((b) => b!.properties), page.values, other.id);
    ok(otherSees ? "somebody who sees the company sees its name" : "somebody who can't see the company sees 'Hidden', never its name", otherSees ? otherLabels[acme]?.name === `Zz P2 ${run} Acme` : otherLabels[acme]?.name === "Hidden" && !otherLabels[acme]?.href);

    section("Files");
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    const upload = (rowKey: string, file: File) => {
      const f = new FormData();
      f.set("propertyId", proof);
      f.set("rowKey", rowKey);
      f.set("file", file);
      return links.attachListFile(f);
    };
    const shot = await upload(A, new File([png], "screenshot"));
    ok("an image attached — named for what it is — and in the cell", shot.ok && shot.data.name === "screenshot.png" && shot.data.value.length === 1, shot);
    ok("a file that isn't a PDF or an image is refused", !(await upload(A, new File(["just text"], "notes.txt"))).ok);
    ok("not into a row of another list", !(await upload(art.data.id, new File([png], "x.png"))).ok);
    if (shot.ok) {
      const fileId = shot.data.value[0]!;
      const route = await import("../src/app/api/smart-lists/files/[id]/route");
      const get = () => route.GET(new Request(`http://local/api/smart-lists/files/${fileId}`), { params: Promise.resolve({ id: fileId }) });
      const res = await get();
      ok("downloaded by whoever may open the list", res.status === 200 && res.headers.get("content-type") === "image/png" && res.headers.get("x-content-type-options") === "nosniff");
      as(other);
      const res2 = await get();
      await db.workbook.update({ where: { id }, data: { shared: false } });
      const res3 = await get();
      await db.workbook.update({ where: { id }, data: { shared: true } });
      as(admin);
      ok("…by somebody else while it's shared, and not once it's private", res2.status === 200 && res3.status === 404);
      await set(A, proof, []);
      ok("taken off its cell, the file goes", (await db.workbookFile.count({ where: { id: fileId } })) === 0);
      const again = await upload(D, new File([png], "d.png"));
      ok("a row deleted takes its files", again.ok && (await rows.deleteOwnRows({ workbookId: id, rowIds: [D] })).ok && (await db.workbookFile.count({ where: { rowKey: D } })) === 0);
    }

    section("Many rows at once");
    const many = await links.setManyValues({ workbookId: id, propertyId: status, rowKeys: [B, C, "not-a-row"], value: live });
    const nowLive = await titles(rule(status, "any_of", [live]));
    ok("one column set on the ticked rows of this list", many.ok && many.data.changed === 2 && nowLive === "ABG", { many, nowLive });
    ok("emptied on them", (await links.setManyValues({ workbookId: id, propertyId: done, rowKeys: [A], value: null })).ok && (await titles(rule(done, "ticked"))) === "");
    ok("files aren't set in bulk", !(await links.setManyValues({ workbookId: id, propertyId: proof, rowKeys: [A], value: [] })).ok);

    section("Reminders");
    as(other);
    ok("only the builder sets one", !(await links.setColumnReminder({ propertyId: due, reminder: { daysBefore: 3, notify: "ADDER" } })).ok);
    as(admin);
    ok("not to a company's account owner — these rows aren't companies", !(await links.setColumnReminder({ propertyId: due, reminder: { daysBefore: 3, notify: "ACCOUNT_OWNER" } })).ok);
    ok("not on a column that isn't a date", !(await links.setColumnReminder({ propertyId: da, reminder: { daysBefore: 3, notify: "ADDER" } })).ok);
    const setR = await links.setColumnReminder({ propertyId: due, reminder: { daysBefore: 3, notify: "PERSON", personPropertyId: owner } });
    ok("three days before, to the person in Owner", setR.ok && (await links.columnReminder(due))?.notify === "PERSON");
    // Gamma is due tomorrow, Owner somebody else; Alpha in two days, Owner the builder; Beta's date has gone by.
    await set(C, due, plus(1));
    await set(C, owner, other.id);
    const { runListReminders } = await import("../src/lib/smart-lists/reminders");
    const since = new Date();
    const first = await runListReminders();
    const notes1 = await db.notification.findMany({ where: { type: "SMART_LIST_REMINDER", createdAt: { gte: since } }, select: { userId: true, title: true, link: true } });
    const mine = notes1.filter((n) => n.title.includes(" page"));
    ok("each person told about their own row's date — none for a date gone by", mine.length === 2 && mine.some((n) => n.userId === admin.id && n.title === "Due in 2 days: Alpha page") && mine.some((n) => n.userId === other.id && n.title === "Due tomorrow: Gamma page"), mine);
    ok("…linking to the list", mine.every((n) => n.link?.startsWith(`/smart-lists/${id}`)));
    ok("…and emailed", mails.length >= 2, mails.length);
    const second = await runListReminders();
    ok("once a date: the next run tells nobody again", (await db.notification.count({ where: { type: "SMART_LIST_REMINDER", createdAt: { gte: since }, title: { contains: " page" } } })) === 2, { first, second });
    await set(A, due, plus(3));
    await db.workbook.update({ where: { id }, data: { shared: false } });
    await set(C, due, plus(2));
    const since2 = new Date();
    await runListReminders();
    const notes2 = await db.notification.findMany({ where: { type: "SMART_LIST_REMINDER", createdAt: { gte: since2 }, title: { contains: " page" } }, select: { userId: true, title: true } });
    ok("a date changed is reminded again — but not to somebody who can no longer open the list", notes2.length === 1 && notes2[0]!.userId === admin.id && notes2[0]!.title === "Due in 3 days: Alpha page", notes2);
    await db.workbook.update({ where: { id }, data: { shared: true } });

    section("A list of companies, filtered, sorted and totalled");
    const beta = await mkCompany("Beta");
    const gamma = await mkCompany("Gamma");
    const wb = await db.workbook.create({ data: { name: `Zz P2 companies ${run}`, filters: { city: [city] }, ownerUserId: admin.id, shared: true }, select: { id: true } });
    workbooks.push(wb.id);
    const stage = await board.addListProperty({ workbookId: wb.id, name: "Stage", kind: "SELECT", options: [{ name: "Hot" }, { name: "Cold" }] });
    const score = await board.addListProperty({ workbookId: wb.id, name: "Score", kind: "NUMBER" });
    if (!stage.ok || !score.ok) throw new Error("columns");
    const so = (await db.workbookProperty.findUnique({ where: { id: stage.data.id }, select: { options: true } }))!.options as { id: string; name: string }[];
    const hot = so.find((o) => o.name === "Hot")!.id;
    for (const [c, s, n] of [[acme, hot, 10], [beta, hot, 30], [gamma, so[1]!.id, 20]] as const) {
      await board.setListValue({ propertyId: stage.data.id, companyId: c, value: s });
      await board.setListValue({ propertyId: score.data.id, companyId: c, value: n });
    }
    const { runWorkbook } = await import("../src/actions/workspace");
    const res = await runWorkbook({ filters: { city: [city] }, page: 1, pageSize: 25, workbookId: wb.id, query: { rules: [{ field: stage.data.id, op: "any_of", value: [hot] }], sort: [{ field: score.data.id, dir: "desc" }] }, totals: true });
    ok("only the Hot ones, highest score first", res.rows.map((r) => r.id).join() === [beta, acme].join() && res.total === 2, res.rows.map((r) => r.name));
    ok("the footer over them", res.totals?.count === 2 && res.totals.columns[score.data.id]?.sum === 40);
    const byName = await runWorkbook({ filters: { city: [city] }, page: 1, pageSize: 25, workbookId: wb.id, query: { sort: [{ field: "title", dir: "desc" }] } });
    ok("by name, backwards", byName.rows.map((r) => r.id).join() === [gamma, beta, acme].join());
    const sneaky = await runWorkbook({ filters: { city: [city] }, page: 1, pageSize: 25, workbookId: wb.id, query: { rules: [{ field: "ownerUserId", op: "is", value: admin.id }] } });
    ok("a rule on anything but the list's own columns is dropped, not obeyed", sneaky.total === 3);
    const bulk = await links.setManyValues({ workbookId: wb.id, propertyId: score.data.id, rowKeys: [acme, gamma], value: 99 });
    ok("many companies at once — only those in the list", bulk.ok && bulk.data.changed === 2 && (await db.workbookValue.count({ where: { propertyId: score.data.id, value: { equals: 99 } } })) === 2);

    section("The screens");
    const { renderHtml } = await import("./lib/render-html");
    type Page = (props: never) => Promise<unknown>;
    const render = async (pg: Page, params: Record<string, unknown>, searchParams: Record<string, unknown> = {}) => {
      const html = await renderHtml(pg({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) } as never));
      return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/\s+/g, " ");
    };
    const ListPage = (await import("../src/app/(dashboard)/smart-lists/[id]/page")).default as Page;
    const filtered = await render(ListPage, { id }, { fq: vq.encodeQuery({ match: "all", rules: [{ field: da, op: "gt", value: 40 }], sort: [{ field: da, dir: "desc" }] }) });
    ok("own rows: the filter as a chip, the rows it leaves, the footer", filtered.includes("DA > 40") && filtered.includes("Gamma page") && filtered.includes("Alpha page") && !filtered.includes("Beta page") && filtered.includes("2 rows found") && /2 rows .*₹100/.test(filtered));
    ok("…linked records by name", filtered.includes(`Zz P2 ${run} Acme`) && filtered.includes("Best CRM in India"));
    const companiesPage = await render(ListPage, { id: wb.id }, { fq: vq.encodeQuery({ match: "all", rules: [{ field: stage.data.id, op: "any_of", value: [hot] }], sort: [] }) });
    ok("companies: the filter as a chip, the companies it leaves, the footer", companiesPage.includes("Stage is any of Hot") && companiesPage.includes(`Zz P2 ${run} Beta`) && !companiesPage.includes(`Zz P2 ${run} Gamma`) && companiesPage.includes("2 companies"));
    const { InTheseLists } = await import("../src/components/smart-lists/in-these-lists");
    const card = (await renderHtml(InTheseLists({ kind: "COMPANY", recordId: acme }))).replace(/<[^>]+>/g, " ");
    ok("a company's page: In these lists", card.includes("In these lists") && card.includes(`Zz Phase2 ${run}`) && card.includes("Alpha page"));
  } finally {
    as(admin);
    mailer.setTestPlatformMailer(null);
    await db.notification.deleteMany({ where: { type: "SMART_LIST_REMINDER", title: { contains: " page" } } });
    await db.workbookReminderSent.deleteMany({ where: { propertyId: { in: (await db.workbookProperty.findMany({ where: { workbookId: { in: workbooks } }, select: { id: true } })).map((p) => p.id) } } });
    await db.workbook.deleteMany({ where: { id: { in: workbooks } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
    console.log(`\n${passes} passed, ${failures} failed.`);
    await db.$disconnect();
  }
}

main()
  .then(() => process.exit(failures ? 1 : 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
