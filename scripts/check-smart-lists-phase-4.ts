/**
 * check:smart-lists-phase-4 — Smart Lists phase 4 (owner, 20 Nov 2026).
 *
 *   · Who may see and fill in a list: chosen people only, view-only, a member's role over everyone's, and the own-rows
 *     rule — a row changed only by the person its Person column names.
 *   · Formula columns: checked as they're written, worked out for every row, renamed columns followed, filtered,
 *     sorted and added up; hidden from guests; the morning's run once a day.
 *   · A timeline view: from a Date column to another.
 *   · A form's public link: consent, the bot checks, rate limits, answers waiting to be accepted — accepted into a row
 *     or declined and forgotten — or rows at once; no Person question outside; a new address; kept 90 days.
 *   · Repeating rows, a copy of a row just below it, and rows moved.
 *   · Deskzo Connect: a guest's change in the row's history by their name; a shared comment on an own row emailed to
 *     the guests who see that row.
 *
 * Against the local database, as its super admin and one person who can't manage every list; everything made is removed.
 *
 *   npm run check:smart-lists-phase-4
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "ADMIN", name: "Zz Lists 4", email: "zz-lists4@example.invalid" };
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
  const connections: string[] = [];
  const rows = await import("../src/actions/smart-list-rows");
  const board = await import("../src/actions/smart-list-board");
  const links = await import("../src/actions/smart-list-links");
  const team = await import("../src/actions/smart-list-team");
  const workspace = await import("../src/actions/workspace");
  const access = await import("../src/lib/smart-lists/access");
  const formulas = await import("../src/lib/smart-lists/formulas");
  const formulaServer = await import("../src/lib/smart-lists/formula-server");
  const publicForms = await import("../src/lib/smart-lists/public-forms");
  const repeats = await import("../src/lib/smart-lists/repeats");
  const dates = await import("../src/lib/smart-lists/repeat-dates");
  const own = await import("../src/lib/smart-lists/own-rows");
  const vqs = await import("../src/lib/smart-lists/view-query-server");
  const totals = await import("../src/lib/smart-lists/totals");
  const { workspaceClock } = await import("../src/lib/time/workspace");
  const clock = await workspaceClock();
  const today = clock.today();
  const since = new Date();

  const list = async (name: string) => {
    const r = await rows.createOwnRowList({ name: `Zz P4 ${run} ${name}` });
    if (!r.ok) throw new Error(r.error);
    workbooks.push(r.data.id);
    return r.data.id;
  };
  const col = async (workbookId: string, name: string, kind: string, options?: unknown) => {
    const r = await board.addListProperty({ workbookId, name, kind, options });
    if (!r.ok) throw new Error(`${name}: ${r.error}`);
    return r.data.id;
  };
  const add = async (workbookId: string, title: string) => {
    const r = await rows.addOwnRow({ workbookId, title });
    if (!r.ok) throw new Error(r.error);
    return r.data.id;
  };
  const set = async (rowId: string, propertyId: string, value: unknown) => {
    const r = await rows.setOwnRowValue({ rowId, propertyId, value });
    if (!r.ok) throw new Error(r.error);
  };
  const cell = async (rowId: string, propertyId: string) => (await db.workbookRowValue.findUnique({ where: { propertyId_rowId: { propertyId, rowId } }, select: { value: true } }))?.value ?? null;
  const optionId = async (propertyId: string, name: string) => ((await db.workbookProperty.findUnique({ where: { id: propertyId }, select: { options: true } }))!.options as { id: string; name: string }[]).find((o) => o.name === name)!.id;
  const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  try {
    const jobs = await list("Jobs");
    const qty = await col(jobs, "Qty", "NUMBER");
    const rate = await col(jobs, "Rate", "MONEY");
    const due = await col(jobs, "Due", "DATE");
    const ends = await col(jobs, "Ends", "DATE");
    const owner = await col(jobs, "Owner", "PERSON");
    const email = await col(jobs, "Email", "EMAIL");
    const status = await col(jobs, "Status", "SELECT", [{ name: "Open" }, { name: "Done" }]);
    const open = await optionId(status, "Open");
    const done = await optionId(status, "Done");
    const wb = await db.workbook.findUniqueOrThrow({ where: { id: jobs }, select: { id: true, shared: true, ownerUserId: true } });

    section("Who may see and fill in a list");
    const r0 = await access.rightsFor(other.id, wb);
    ok("a shared list with no rule: everybody opens and fills it in; only its builder changes its shape", r0.view && r0.fill && !r0.shape && (await access.rightsFor(admin.id, wb)).shape, r0);
    const mine = await add(jobs, "Fix the AC");
    const theirs = await add(jobs, "Paint the office");
    await set(mine, owner, admin.id);
    await set(theirs, owner, other.id);
    ok("chosen people only, with nobody chosen, is refused", !(await team.saveListAccess({ workbookId: jobs, audience: "CHOSEN", everyoneRole: "EDIT", rowRule: "ANY", members: [] })).ok);
    ok("chosen people only: shut to everybody else", (await team.saveListAccess({ workbookId: jobs, audience: "CHOSEN", everyoneRole: "EDIT", rowRule: "ANY", members: [{ userId: admin.id, role: "EDIT" }] })).ok && !(await access.rightsFor(other.id, wb)).view);
    as(other);
    ok("  they can't open it, or add to it", (await workspace.getWorkbook(jobs)) === null && !(await rows.addOwnRow({ workbookId: jobs, title: "x" })).ok);
    as(admin);
    await team.saveListAccess({ workbookId: jobs, audience: "CHOSEN", everyoneRole: "EDIT", rowRule: "ANY", members: [{ userId: other.id, role: "VIEW" }] });
    const r1 = await access.rightsFor(other.id, wb);
    as(other);
    const opened = await workspace.getWorkbook(jobs);
    const viewAdd = await rows.addOwnRow({ workbookId: jobs, title: "x" });
    const viewSet = await rows.setOwnRowValue({ rowId: theirs, propertyId: status, value: open });
    as(admin);
    ok("chosen to view: they open it, and change nothing — not a row, not a cell", r1.view && !r1.fill && !!opened && opened.canFill === false && !viewAdd.ok && !viewSet.ok, { r1, viewAdd, viewSet });
    await team.saveListAccess({ workbookId: jobs, audience: "EVERYONE", everyoneRole: "VIEW", rowRule: "ANY", members: [{ userId: other.id, role: "EDIT" }] });
    ok("everybody views; a member chosen to edit fills it in — their own role wins", (await access.rightsFor(other.id, wb)).fill);
    const settings = await team.listAccessSettings(jobs);
    ok("the settings read back, with the member's name", settings?.audience === "EVERYONE" && settings.everyoneRole === "VIEW" && settings.members[0]?.name === other.name && settings.personColumns.some((p) => p.id === owner), settings?.members);
    ok("the own-rows rule needs a Person column of this list", !(await team.saveListAccess({ workbookId: jobs, audience: "EVERYONE", everyoneRole: "EDIT", rowRule: "OWN", ownerPropertyId: status, members: [] })).ok);
    await team.saveListAccess({ workbookId: jobs, audience: "EVERYONE", everyoneRole: "EDIT", rowRule: "OWN", ownerPropertyId: owner, members: [] });
    as(other);
    const ownSet = await rows.setOwnRowValue({ rowId: theirs, propertyId: status, value: open });
    const notOwn = await rows.setOwnRowValue({ rowId: mine, propertyId: status, value: open });
    const many = await links.setManyValues({ workbookId: jobs, propertyId: status, rowKeys: [mine, theirs], value: done });
    as(admin);
    ok("own rows: they change the row whose Owner is them — not another's", ownSet.ok && !notOwn.ok && notOwn.error === access.ROW_NOT_YOURS, notOwn);
    ok("  set with others: only theirs changes", many.ok && JSON.stringify(await cell(theirs, status)) === JSON.stringify(done) && (await cell(mine, status)) === null);
    ok("whoever built it changes any row", (await rows.setOwnRowValue({ rowId: mine, propertyId: status, value: open })).ok);

    section("Formula columns");
    const cols = [
      { id: "q", name: "Qty" },
      { id: "r", name: "Rate" },
      { id: "d", name: "Due" },
      { id: "s", name: "Status" },
    ];
    const vals: Record<string, string | number | null> = { q: 3, r: 250, d: addDays(today, 10), s: "Open" };
    const calc = (expr: string) => {
      const c = formulas.compileFormula(expr, cols);
      return c.ok ? formulas.evaluate(c.node, (id) => vals[id] ?? null, today) : `error: ${c.error}`;
    };
    ok("arithmetic, with columns by name", calc("{Qty} * {Rate}") === 750 && calc("({Qty} + 1) * 2") === 8 && calc("round(10 / 3, 2)") === 3.33, [calc("{Qty} * {Rate}"), calc("round(10 / 3, 2)")]);
    ok("dates: days until, days between, add days", calc("days_until({Due})") === 10 && calc(`days_between({Due}, add_days({Due}, 7))`) === 7, [calc("days_until({Due})")]);
    ok("if, comparisons and words", calc(`if({Status} = 'Open', 'chase', 'leave')`) === "chase" && calc(`concat(upper('a'), lower('B'), len('xyz'))`) === "Ab3" && calc("{Qty} > 2 and {Rate} < 300") === true, [calc(`concat(upper('a'), lower('B'), len('xyz'))`)]);
    ok("a column the list hasn't got is an error; dividing by nothing is empty", String(calc("{Nothing}")).startsWith("error") && calc("1 / 0") === null);
    const bad = [formulas.compileFormula("{Nope} + 1", cols), formulas.compileFormula("1 +", cols), formulas.compileFormula("nofn(1)", cols), formulas.compileFormula("{Qty} + 1", cols, "q")];
    ok("refused with a reason: a column that isn't there, a half-written sum, an unknown word, itself", bad.every((b) => !b.ok && !!b.error), bad.map((b) => (b.ok ? "ok" : b.error)));
    ok("a formula that reads today is known", formulas.usesToday("days_until({Due})") && !formulas.usesToday("{Qty} * 2"));

    const badCol = await board.addListProperty({ workbookId: jobs, name: "Broken", kind: "FORMULA", options: { expr: "{Missing} * 2", format: "number" } });
    ok("a formula column naming a column the list hasn't got is refused", !badCol.ok && /Missing/.test(badCol.ok ? "" : badCol.error), badCol);
    const total = await col(jobs, "Total", "FORMULA", { expr: "{Qty} * {Rate}", format: "money" });
    const left = await col(jobs, "Left", "FORMULA", { expr: "days_until({Due})", format: "days" });
    const big = await col(jobs, "Big job", "FORMULA", { expr: "{Total} > 1000", format: "checkbox" });
    await set(mine, qty, 3);
    await set(mine, rate, 250);
    await set(mine, due, addDays(today, 5));
    await set(theirs, qty, 10);
    await set(theirs, rate, 200);
    ok("worked out as cells change — and a formula over a formula", (await cell(mine, total)) === 750 && (await cell(theirs, total)) === 2000 && (await cell(mine, left)) === 5 && (await cell(theirs, big)) === true && (await cell(mine, big)) === null, [await cell(mine, total), await cell(theirs, total), await cell(mine, left), await cell(mine, big)]);
    ok("never typed in", !(await rows.setOwnRowValue({ rowId: mine, propertyId: total, value: 5 })).ok);
    await board.updateListProperty({ id: qty, name: "Quantity" });
    const renamed = formulas.formulaOf((await db.workbookProperty.findUniqueOrThrow({ where: { id: total }, select: { options: true } })).options);
    ok("a column renamed: the formula says its new name, and still works", renamed?.expr === "{Quantity} * {Rate}" && (await cell(mine, total)) === 750, renamed);
    await board.updateListProperty({ id: total, formula: { expr: "{Quantity} * {Rate} * 2", format: "money" } });
    ok("a formula changed: every row worked out again", (await cell(mine, total)) === 1500 && (await cell(theirs, total)) === 4000);
    ok("  a changed formula is checked too", !(await board.updateListProperty({ id: total, formula: { expr: "{Total} + 1", format: "number" } })).ok);
    const shape = (await board.getListBoard(jobs, []))!;
    const filter = await vqs.ownRowsQueryWhere(jobs, { match: "all", rules: [{ field: total, op: "gt", value: 2000 }], sort: [], group: null }, shape.properties, { userId: admin.id, clock, today });
    const found = await own.ownRowsPage(jobs, shape.properties, { skip: 0, take: 50, filter });
    ok("filtered by what a formula works out", found.rows.map((r) => r.id).join() === theirs, found.rows.map((r) => r.title));
    const sorted = await own.ownRowsPage(jobs, shape.properties, { skip: 0, take: 50, sort: [{ field: total, dir: "desc" }] });
    ok("sorted by it", sorted.rows[0]?.id === theirs && sorted.rows[1]?.id === mine, sorted.rows.map((r) => r.title));
    const sums = await totals.ownRowTotals(jobs, shape.properties, {});
    ok("added up at the foot — money summed, ticks counted", sums.columns[total]?.sum === 5500 && sums.columns[big]?.ticked === 2, [sums.columns[total], sums.columns[big]]);
    ok("the morning's run: once a day a workspace", typeof (await formulaServer.runFormulaDay()) === "number" && (await formulaServer.runFormulaDay()) === 0);
    await db.workbookRowValue.deleteMany({ where: { propertyId: left, rowId: mine } });
    await formulaServer.recomputeFormulas(jobs);
    ok("worked out again from scratch", (await cell(mine, left)) === 5);

    section("A timeline view");
    ok("needs a Date column to start from", !(await board.addListView({ workbookId: jobs, name: "T", kind: "TIMELINE", propertyId: status })).ok);
    const tl = await board.addListView({ workbookId: jobs, name: "Schedule", kind: "TIMELINE", propertyId: due });
    ok("made from a Date column", tl.ok, tl);
    const tlId = tl.ok ? tl.data.id : "";
    ok("ends on a Date column, never another kind", !(await links.setTimelineOptions({ viewId: tlId, endPropertyId: status })).ok && (await links.setTimelineOptions({ viewId: tlId, endPropertyId: ends, scale: "month" })).ok);
    const tlView = (await board.getListBoard(jobs, []))!.views.find((v) => v.id === tlId);
    ok("its settings kept with the view", tlView?.kind === "TIMELINE" && tlView.options?.endPropertyId === ends && tlView.options?.scale === "month", tlView);
    as(other);
    ok("only whoever may change the list changes a view's settings", !(await links.setTimelineOptions({ viewId: tlId, endPropertyId: null })).ok);
    as(admin);
    await set(theirs, due, addDays(today, 2));
    await set(theirs, ends, addDays(today, 9));

    section("A form's public link");
    const form = await team.saveListForm({ workbookId: jobs, name: `Book a job ${run}`, intro: "Tell us what you need", fields: [{ propertyId: qty, required: true }, { propertyId: owner, required: false }, { propertyId: email, required: false }, { propertyId: status, required: false }], active: true });
    if (!form.ok) throw new Error(form.error);
    const formId = form.data.id;
    const on = await team.savePublicLink({ formId, on: true, consent: "", approve: true });
    const slug = on.ok ? on.data.slug! : "";
    ok("turned on: a long, unguessable address", on.ok && slug.length >= 16, on);
    const shown = await publicForms.publicFormFor(slug);
    const org = await (await import("../src/lib/organisation")).getOrganisation();
    const ourName = org.tradeName || org.legalName || "us";
    ok("the public form: its questions, never a Person one; the consent wording with the company's name", !!shown && shown.questions.map((q) => q.name).join() === "Quantity,Email,Status" && shown.consent.includes(ourName) && !shown.consent.includes("{company}"), shown && { q: shown.questions.map((q) => q.name), consent: shown.consent });
    ok("an address that isn't one reads the same as a closed one", (await publicForms.publicFormFor("zzzzzzzzzzzzzzzzzzzzzzzz")) === null && (await publicForms.publicFormFor("../etc")) === null);
    const answer = (over: Record<string, unknown> = {}) =>
      publicForms.answerPublicForm({ slug, title: "Service the lift", answers: { [qty]: 2, [email]: "Visitor@Example.com", [owner]: admin.id }, consent: true, elapsedMs: 6000, caller: "203.0.113.7", ...over });
    const pendingCount = () => db.workbookFormSubmission.count({ where: { formId, status: "PENDING" } });
    const first = await answer();
    const waitingRow = await db.workbookFormSubmission.findFirst({ where: { formId }, select: { answers: true, email: true, sourceHash: true } });
    ok("answered: it waits, keeping the answers asked — not a Person, not the sender's address", first.ok && (await pendingCount()) === 1 && !(owner in ((waitingRow?.answers ?? {}) as object)) && waitingRow?.email === "visitor@example.com" && !waitingRow.sourceHash.includes("203"), waitingRow);
    const told = await db.notification.findMany({ where: { type: "SMART_LIST_SUBMISSION", userId: admin.id, createdAt: { gte: since } }, select: { title: true, link: true } });
    ok("whoever made the form is told — once", told.length === 1 && told[0]!.link === `/smart-lists/${jobs}?answers=1`, told);
    const bot1 = await answer({ website: "http://spam.example" });
    const bot2 = await answer({ elapsedMs: 400 });
    ok("a bot — the hidden field filled, or sent too fast — is thanked and nothing is kept", bot1.ok && bot2.ok && (await pendingCount()) === 1);
    ok("the consent box must be ticked", !(await answer({ consent: false })).ok);
    ok("a question that must be answered must be", !(await answer({ answers: { [email]: "a@example.com" } })).ok);
    ok("a wrong answer is refused in the question's words", !(await answer({ answers: { [qty]: "lots" } })).ok);
    await answer({ title: "Second" });
    ok("a second answer within the hour tells nobody again", (await db.notification.count({ where: { type: "SMART_LIST_SUBMISSION", userId: admin.id, createdAt: { gte: since } } })) === 1);
    for (let i = 0; i < 3; i += 1) await answer({ title: `More ${i}` });
    const sixth = await answer({ title: "Too many" });
    ok("five an hour from one sender, then no more", !sixth.ok && (await pendingCount()) === 5, sixth);
    ok("another sender still can", (await answer({ title: "From elsewhere", caller: "198.51.100.4" })).ok && (await pendingCount()) === 6);
    const waiting = await team.answersWaiting(jobs);
    const lift = waiting?.find((w) => w.title === "Service the lift");
    ok("the answers waiting, in words", !!lift && lift.lines.some((l) => l.name === "Quantity" && l.text === "2") && lift.email === "visitor@example.com" && lift.formName === `Book a job ${run}`, lift);
    as(other);
    const theirView = await team.answersWaiting(jobs);
    const theirTry = lift ? await team.decidePublicAnswer({ workbookId: jobs, submissionId: lift.id, accept: true }) : null;
    as(admin);
    ok("only whoever may change the list sees and decides them", theirView === null && theirTry?.ok === false);
    const accepted = lift ? await team.decidePublicAnswer({ workbookId: jobs, submissionId: lift.id, accept: true }) : null;
    const newRow = accepted?.ok ? accepted.data.rowId : null;
    const madeRow = newRow ? await db.workbookRow.findUnique({ where: { id: newRow }, select: { title: true, createdByUserId: true } }) : null;
    const emptied = lift ? await db.workbookFormSubmission.findUnique({ where: { id: lift.id }, select: { status: true, title: true, email: true, answers: true, rowId: true } }) : null;
    ok("accepted: a row, added by whoever accepted it, and the answer's own copy emptied", madeRow?.title === "Service the lift" && madeRow.createdByUserId === admin.id && (await cell(newRow!, qty)) === 2 && emptied?.status === "ACCEPTED" && emptied.title === "" && emptied.email === null && JSON.stringify(emptied.answers) === "{}" && emptied.rowId === newRow, { madeRow, emptied });
    ok("  its history says where it came from", (await team.rowActivity(jobs, newRow!))?.history.at(-1)?.text === `Added the row from the public form "Book a job ${run}"`);
    ok("  and Deskzo Automate hears of a row added by a form", (await db.automationEvent.count({ where: { recordId: `${jobs}:${newRow}`, type: "smartlist.row_added", payload: { path: ["addedVia"], equals: "form" } } })) === 1);
    ok("  decided once", lift ? !(await team.decidePublicAnswer({ workbookId: jobs, submissionId: lift.id, accept: false })).ok : false);
    const second = waiting?.find((w) => w.title === "Second");
    const declined = second ? await team.decidePublicAnswer({ workbookId: jobs, submissionId: second.id, accept: false }) : null;
    const gone = second ? await db.workbookFormSubmission.findUnique({ where: { id: second.id }, select: { status: true, title: true, answers: true } }) : null;
    ok("declined: no row, and the answer forgotten", declined?.ok === true && declined.data.rowId === null && gone?.status === "DECLINED" && gone.title === "" && JSON.stringify(gone.answers) === "{}", gone);
    await team.savePublicLink({ formId, on: true, consent: "Yes, {company} may call me.", approve: false });
    const rowsBefore = await db.workbookRow.count({ where: { workbookId: jobs } });
    const atOnce = await answer({ title: "Straight in", caller: "192.0.2.9" });
    const straight = await db.workbookRow.findFirst({ where: { workbookId: jobs, title: "Straight in" }, select: { id: true, createdByUserId: true } });
    ok("waiting turned off: the answer is a row at once, added by nobody in the company", atOnce.ok && (await db.workbookRow.count({ where: { workbookId: jobs } })) === rowsBefore + 1 && !!straight && straight.createdByUserId === null, atOnce);
    ok("  its history says the public form", (await team.rowActivity(jobs, straight!.id))?.history.at(-1)?.text === `Added the row from the public form "Book a job ${run}"`);
    ok("  the builder's own consent wording", (await publicForms.publicFormFor(slug))?.consent === `Yes, ${ourName} may call me.`);
    const moved = await team.savePublicLink({ formId, on: true, consent: "", approve: true, newLink: true });
    const newSlug = moved.ok ? moved.data.slug : null;
    ok("a new address: the old link stops working", !!newSlug && newSlug !== slug && (await publicForms.publicFormFor(slug)) === null && !!(await publicForms.publicFormFor(newSlug!)));
    await team.savePublicLink({ formId, on: false, approve: true });
    ok("turned off: closed", (await publicForms.publicFormFor(newSlug!)) === null && !(await publicForms.answerPublicForm({ slug: newSlug!, title: "x", answers: { [qty]: 1 }, consent: true, elapsedMs: 5000, caller: null })).ok);
    const offAgain = await team.savePublicLink({ formId, on: true, consent: "", approve: true });
    ok("turned on again: the same address back", offAgain.ok && offAgain.data.slug === newSlug);
    const listed = (await team.listForms(jobs))?.find((f) => f.id === formId);
    ok("the forms list shows its public link", listed?.publicLink?.active === true && listed.publicLink.slug === newSlug);
    const old = await db.workbookFormSubmission.findFirstOrThrow({ where: { formId, status: "PENDING" }, select: { id: true } });
    await db.workbookFormSubmission.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 91 * 86_400_000) } });
    ok("answers are kept 90 days at most", (await publicForms.tidyPublicAnswers()) >= 1 && !(await db.workbookFormSubmission.findUnique({ where: { id: old.id } })));
    ok("the public address needs no sign-in (the proxy)", /"\/list-forms"/.test(readFileSync("src/proxy.ts", "utf8")));

    section("Repeating rows, a copy, rows moved");
    ok("a month's 31st: the 28th in February, the 31st again in March", dates.addMonths("2026-01-31", 1) === "2026-02-28" && dates.nextAfter("2026-01-31", "month", "2026-02-28") === "2026-03-31");
    ok("a leap day each year: the 28th, then the 29th again", dates.nextAfter("2024-02-29", "year", "2024-02-29") === "2025-02-28" && dates.nextAfter("2024-02-29", "year", "2027-03-01") === "2028-02-29");
    ok("weeks, days and quarters", dates.nextAfter("2026-11-02", "week", "2026-11-20") === "2026-11-23" && dates.nextAfter("2026-11-20", "day", "2026-11-20") === "2026-11-21" && dates.nextAfter("2026-01-15", "quarter", "2026-04-15") === "2026-07-15");
    ok("a title for its date", dates.titleFor("Rent — {month}", "2026-12-01") === "Rent — Dec 2026" && dates.titleFor("Check {date}", "2026-12-01") === "Check 1 Dec 2026");
    const service = await add(jobs, "AC service");
    await set(service, qty, 1);
    await set(service, status, open);
    as(other);
    ok("only whoever may change the list makes rows repeat", !(await rows.saveListRepeat({ workbookId: jobs, fromRowId: service, title: "x", every: "month", startOn: today })).ok);
    as(admin);
    ok("a repeat needs a title, how often and a first date", !(await rows.saveListRepeat({ workbookId: jobs, fromRowId: service, title: "x", every: "fortnight", startOn: today })).ok && !(await rows.saveListRepeat({ workbookId: jobs, fromRowId: service, title: "x", every: "month", startOn: "soon" })).ok);
    const rep = await rows.saveListRepeat({ workbookId: jobs, fromRowId: service, title: "AC service — {month}", every: "month", startOn: today });
    const firstTitle = dates.titleFor("AC service — {month}", today);
    const came = await db.workbookRow.findFirst({ where: { workbookId: jobs, title: firstTitle }, select: { id: true, createdByUserId: true } });
    ok("set from a row, starting today: today's row comes now, like the row", rep.ok && !!came && came.createdByUserId === admin.id && (await cell(came.id, qty)) === 1 && JSON.stringify(await cell(came.id, status)) === JSON.stringify(open), rep);
    ok("  its next date a month on", rep.ok && (await db.workbookRepeat.findUnique({ where: { id: rep.data.id }, select: { nextOn: true } }))?.nextOn === dates.nextAfter(today, "month", today));
    ok("  its history and Deskzo Automate say a repeat", (await team.rowActivity(jobs, came!.id))?.history.at(-1)?.text === "Added the row from a repeat (every month)" && (await db.automationEvent.count({ where: { recordId: `${jobs}:${came!.id}`, payload: { path: ["addedVia"], equals: "repeat" } } })) === 1);
    if (rep.ok) {
      const longAgo = dates.addMonths(today, -3);
      await db.workbookRepeat.update({ where: { id: rep.data.id }, data: { nextOn: longAgo, values: { cells: { [qty]: 4 }, startOn: longAgo } } });
      const before = await db.workbookRow.count({ where: { workbookId: jobs } });
      const made = await repeats.runDueRepeats(today);
      const nextNow = (await db.workbookRepeat.findUnique({ where: { id: rep.data.id }, select: { nextOn: true } }))?.nextOn ?? "";
      ok("dates missed while Deskzo was down: one row, for the latest — not three", made >= 1 && (await db.workbookRow.count({ where: { workbookId: jobs } })) === before + 1 && nextNow > today, { made, nextNow });
      ok("  a second run the same day makes nothing", (await repeats.runDueRepeats(today)) === 0 || (await db.workbookRow.count({ where: { workbookId: jobs } })) === before + 1);
      const lines = await rows.listRepeats(jobs);
      ok("the list's repeats, in words", lines?.length === 1 && lines[0]!.everyLabel === "Every month" && lines[0]!.by === admin.name && lines[0]!.cells === 1, lines);
      await rows.saveListRepeat({ workbookId: jobs, id: rep.data.id, title: "AC service — {month}", every: "month", startOn: today, active: false });
      await db.workbookRepeat.update({ where: { id: rep.data.id }, data: { nextOn: today } });
      const quiet = await db.workbookRow.count({ where: { workbookId: jobs } });
      await repeats.runDueRepeats(today);
      ok("stopped: no rows come", (await db.workbookRow.count({ where: { workbookId: jobs } })) === quiet);
      ok("deleted, the rows it made stay", (await rows.deleteListRepeat({ workbookId: jobs, id: rep.data.id })).ok && (await db.workbookRepeat.count({ where: { workbookId: jobs } })) === 0 && !!(await db.workbookRow.findUnique({ where: { id: came!.id } })));
    }

    await rows.saveOwnRowPage({ rowId: mine, notes: "Bring a ladder" });
    const order = async () => (await db.workbookRow.findMany({ where: { workbookId: jobs }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, title: true } })).map((r) => r.id);
    const before = await order();
    const copy = await rows.duplicateOwnRow({ rowId: mine });
    const after = await order();
    const copyId = copy.ok ? copy.data.id : "";
    ok("a copy, just below the row, with its cells and notes — its formulas worked out", copy.ok && after.indexOf(copyId) === after.indexOf(mine) + 1 && after.length === before.length + 1 && (await cell(copyId, qty)) === 3 && (await cell(copyId, total)) === 1500 && (await db.workbookRow.findUnique({ where: { id: copyId }, select: { notes: true } }))?.notes === "Bring a ladder");
    ok("  its history says it's a copy", (await team.rowActivity(jobs, copyId))?.history.at(-1)?.text === `Added the row from a copy of "Fix the AC"`);
    as(other);
    const theirCopy = await rows.duplicateOwnRow({ rowId: mine });
    as(admin);
    ok("under the own-rows rule a copy is the copier's — its Owner says them", theirCopy.ok && (await cell(theirCopy.data.id, owner)) === other.id);
    const lastId = (await order()).at(-1)!;
    const firstId = (await order())[0]!;
    ok("a row moved to the top", (await rows.moveOwnRow({ rowId: lastId, targetRowId: firstId, place: "before" })).ok && (await order())[0] === lastId);
    ok("  and below another", (await rows.moveOwnRow({ rowId: lastId, targetRowId: mine, place: "after" })).ok && (await order()).indexOf(lastId) === (await order()).indexOf(mine) + 1);
    const views = await team.saveListAccess({ workbookId: jobs, audience: "EVERYONE", everyoneRole: "VIEW", rowRule: "ANY", members: [] });
    as(other);
    ok("view only: no copy, no move", views.ok && !(await rows.duplicateOwnRow({ rowId: mine })).ok && !(await rows.moveOwnRow({ rowId: mine, targetRowId: theirs, place: "before" })).ok);
    as(admin);
    await team.saveListAccess({ workbookId: jobs, audience: "EVERYONE", everyoneRole: "EDIT", rowRule: "ANY", members: [] });

    section("Deskzo Connect: guests");
    const connect = await import("../src/actions/connect");
    const guestLists = await import("../src/lib/connect/guest-lists");
    const notices = await import("../src/lib/connect/notices");
    const mailer = await import("../src/lib/platform/mailer");
    const mail: { to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m));
    const conn = await db.connection.create({ data: { name: `Zz P4 brand ${run}` }, select: { id: true } });
    connections.push(conn.id);
    const guestEmail = `zz.client.${run}@zz-p4-${run}.example`;
    const guest = await db.guest.create({ data: { connectionId: conn.id, name: "Zz P4 client", email: guestEmail, status: "ACTIVE", inviteExpiresAt: new Date(Date.now() + 86_400_000) }, select: { id: true } });
    await board.updateListProperty({ id: status, guestVisible: true, guestEditable: true });
    await board.updateListProperty({ id: total, guestVisible: true });
    await connect.shareListWithGuest({ workbookId: jobs, guestId: guest.id });
    const shareId = (await db.listShare.findUniqueOrThrow({ where: { workbookId_guestId: { workbookId: jobs, guestId: guest.id } }, select: { id: true } })).id;
    const gview = await guestLists.guestListView(guest.id, shareId);
    ok("a formula column is never shown to a guest", !!gview && !gview.columns.some((c) => c.id === total) && gview.columns.some((c) => c.id === status), gview?.columns.map((c) => c.name));
    const gset = await guestLists.setGuestValue(guest.id, { shareId, propertyId: status, companyId: theirs, value: open });
    const hist = (await team.rowActivity(jobs, theirs))?.history[0];
    ok("a guest's change is in the row's history, by their name", gset.ok && hist?.by === "Zz P4 client (guest)" && hist.text === "Status: Done → Open", hist);
    const inPlan = await (await import("../src/lib/connect/activity")).connectInPlan();
    const said = await team.commentOnRow({ workbookId: jobs, rowId: theirs, body: "Done on Friday", shared: true });
    const notice = await db.guestNotice.count({ where: { guestId: guest.id, kind: "COMMENTS", workbookId: jobs } });
    if (inPlan) {
      ok("a comment shared on an own row: the guest who sees it is emailed", said.ok && notice === 1, notice);
      const sent = mail.filter((m) => m.to === guestEmail && /comment/i.test(`${m.subject} ${m.text}`));
      ok("  naming the list and who wrote — never the row", sent.every((m) => !`${m.subject} ${m.text}`.includes("Paint the office") && !`${m.subject} ${m.text}`.includes("Done on Friday")), sent.map((m) => m.subject));
    } else ok("Deskzo Connect isn't in this workspace's plan — no guest emails to check", true);
    const fake = { listShared: async () => {}, comments: async () => void fakeSent.push("c"), decided: async () => {} };
    const fakeSent: string[] = [];
    const tick = await col(jobs, "For the client", "CHECKBOX");
    await connect.setShareRows(shareId, tick);
    await db.guestNotice.deleteMany({ where: { guestId: guest.id } });
    const n = await notices.noticeComment(jobs, admin.name, fake, new Date(), theirs, null, true);
    ok("not a guest whose share doesn't show the row", n === 0 && fakeSent.length === 0);
    await set(theirs, tick, true);
    ok("  but once it does, them", (await notices.noticeComment(jobs, admin.name, fake, new Date(), theirs, null, true)) === (inPlan ? 1 : 0));
    mailer.setTestPlatformMailer(null);

    section("The screens");
    const { renderHtml } = await import("./lib/render-html");
    type Page = (props: never) => Promise<unknown>;
    const raw = async (pg: Page, params: Record<string, unknown>, searchParams: Record<string, unknown> = {}) => renderHtml(pg({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) } as never));
    const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ");
    const ListPage = (await import("../src/app/(dashboard)/smart-lists/[id]/page")).default as Page;
    await publicForms.answerPublicForm({ slug: newSlug!, title: "On the screen", answers: { [qty]: 1 }, consent: true, elapsedMs: 5000, caller: "192.0.2.77" });
    const repAgain = await rows.saveListRepeat({ workbookId: jobs, fromRowId: service, title: "Again {month}", every: "year", startOn: addDays(today, 30) });
    const page = await raw(ListPage, { id: jobs }, { answers: "1" });
    ok("the list: Forms with the answers waiting, Repeats, Who can see", /answers? waiting/.test(page) && words(page).includes("Repeats") && words(page).includes("Forms"), words(page).slice(0, 300));
    ok("  a formula's money as money", words(page).includes("₹1,500"));
    const tlPage = words(await raw(ListPage, { id: jobs }, { view: tlId }));
    ok("the timeline: its rows, and where it ends", tlPage.includes("Paint the office") && tlPage.includes("Ends on"), tlPage.slice(0, 200));
    await team.saveListAccess({ workbookId: jobs, audience: "CHOSEN", everyoneRole: "EDIT", rowRule: "ANY", members: [{ userId: other.id, role: "VIEW" }] });
    as(other);
    const theirPage = words(await raw(ListPage, { id: jobs }));
    as(admin);
    ok("seen by somebody chosen to view: it says so, and offers no Forms", theirPage.includes("view only for you") && !theirPage.includes("Forms"), theirPage.slice(0, 300));
    const PublicPage = (await import("../src/app/(public)/list-forms/[slug]/page")).default as Page;
    const pub = words(await raw(PublicPage, { slug: newSlug }));
    ok("the public page: the form, its questions and what they agree to — not the list, not a Person question", pub.includes(`Book a job ${run}`) && pub.includes("Tell us what you need") && pub.includes("Quantity") && pub.includes(ourName) && !pub.includes(`Zz P4 ${run} Jobs`) && !pub.includes("Owner"), pub.slice(0, 300));
    ok("  a closed one says it isn't available", words(await raw(PublicPage, { slug: "zzzzzzzzzzzzzzzzzzzzzzzz" })).includes("This form isn't available"));
    if (repAgain.ok) await rows.deleteListRepeat({ workbookId: jobs, id: repAgain.data.id });
    const del = await team.deleteListForm(formId);
    ok("a form deleted takes its answers with it", del.ok && (await db.workbookFormSubmission.count({ where: { formId } })) === 0);
  } finally {
    as(admin);
    await db.notification.deleteMany({ where: { type: "SMART_LIST_SUBMISSION", createdAt: { gte: since }, OR: workbooks.map((id) => ({ link: { startsWith: `/smart-lists/${id}` } })) } });
    await db.automationEvent.deleteMany({ where: { recordType: "smart-list-row", OR: workbooks.map((id) => ({ recordId: { startsWith: `${id}:` } })) } });
    await db.workbookRowChange.deleteMany({ where: { workbookId: { in: workbooks } } });
    await db.workbookFormSubmission.deleteMany({ where: { workbookId: { in: workbooks } } });
    await db.connection.deleteMany({ where: { id: { in: connections } } });
    await db.workbook.deleteMany({ where: { id: { in: workbooks } } });
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
