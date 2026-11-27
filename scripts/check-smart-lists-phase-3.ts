/**
 * check:smart-lists-phase-3 — Smart Lists phase 3 (owner, 20 Nov 2026): working on a list together.
 *
 *   · A row's history: added, renamed, a column changed (in words), set with others, imported, from a form.
 *   · Comments on a row of a list of its own; "@Full Name" tells that person — only somebody who may open the list.
 *   · Count columns: how many rows of another list link here, how many with a choice, the sum of a column — never
 *     typed in, nothing for somebody who may not open the other list.
 *   · Deskzo Automate: "A row is added", "A column changes" — recorded with the save, in words; a workflow's owner
 *     who may not open the list learns nothing.
 *   · Forms that add rows, for teammates who can't open the list; required questions; closed forms.
 *   · The company's own templates; a gallery view; grouping; a spreadsheet's names matched to companies; a list of
 *     companies downloaded.
 *
 * Against the local database, as its super admin and one person who can't manage every list; everything made is removed.
 *
 *   npm run check:smart-lists-phase-3
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "ADMIN", name: "Zz Lists 3", email: "zz-lists3@example.invalid" };
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
  const companies: string[] = [];
  const templates: string[] = [];
  const connections: string[] = [];
  const rows = await import("../src/actions/smart-list-rows");
  const board = await import("../src/actions/smart-list-board");
  const links = await import("../src/actions/smart-list-links");
  const team = await import("../src/actions/smart-list-team");
  const vq = await import("../src/lib/smart-lists/view-query");
  const since = new Date();

  const list = async (name: string) => {
    const r = await rows.createOwnRowList({ name: `Zz P3 ${run} ${name}` });
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
  const optionId = async (propertyId: string, name: string) => ((await db.workbookProperty.findUnique({ where: { id: propertyId }, select: { options: true } }))!.options as { id: string; name: string }[]).find((o) => o.name === name)!.id;

  try {
    section("A row's history");
    const content = await list("Content");
    const backlinks = await list("Backlinks");
    const status = await col(backlinks, "Status", "SELECT", [{ name: "Live" }, { name: "Lost" }]);
    const cost = await col(backlinks, "Cost", "MONEY");
    const owner = await col(backlinks, "Owner", "PERSON");
    const article = await col(backlinks, "Article", "ROW", { listId: content });
    const live = await optionId(status, "Live");
    const lost = await optionId(status, "Lost");
    const a1 = await add(content, "Best CRM in India");
    const a2 = await add(content, "CRM for distributors");
    const b1 = await add(backlinks, "news.in/one");
    const b2 = await add(backlinks, "blog.in/two");
    const b3 = await add(backlinks, "mag.in/three");
    await rows.renameOwnRow({ rowId: b1, title: "news.in/1" });
    await rows.setOwnRowValue({ rowId: b1, propertyId: status, value: live });
    await rows.setOwnRowValue({ rowId: b1, propertyId: status, value: lost });
    await rows.setOwnRowValue({ rowId: b1, propertyId: owner, value: admin.id });
    await rows.setOwnRowValue({ rowId: b1, propertyId: owner, value: admin.id });
    const act = await team.rowActivity(backlinks, b1);
    const texts = act?.history.map((h) => h.text) ?? [];
    ok("added, renamed, each change in words — newest first, an unchanged save not recorded", texts.length === 5 && texts[0] === `Owner: empty → ${admin.name}` && texts[1] === "Status: Live → Lost" && texts[2] === "Status: empty → Live" && texts[3] === 'Renamed it from "news.in/one" to "news.in/1"' && texts[4] === "Added the row" && act!.history[0]!.by === admin.name, texts);
    await links.setManyValues({ workbookId: backlinks, propertyId: status, rowKeys: [b2, b3], value: live });
    ok("set with others: each row's history says so", (await team.rowActivity(backlinks, b2))?.history[0]?.text === "Status: empty → Live");

    section("Comments and mentions");
    const said = await team.commentOnRow({ workbookId: backlinks, rowId: b1, body: `@${other.name} can you check this one?` });
    const told = await db.notification.findMany({ where: { type: "SMART_LIST_MENTION", userId: other.id, createdAt: { gte: since } }, select: { title: true, link: true, message: true } });
    ok("a comment @mentioning somebody tells them — who and where, not the comment", said.ok && said.data.told === 1 && told.length === 1 && told[0]!.title === `${admin.name} mentioned you on "news.in/1"` && !told[0]!.message?.includes("check this"), told);
    ok("the row shows it, by whom", (await team.rowActivity(backlinks, b1))?.comments?.[0]?.body.startsWith(`@${other.name}`) === true);
    await db.workbook.update({ where: { id: backlinks }, data: { shared: false } });
    const quiet = await team.commentOnRow({ workbookId: backlinks, rowId: b1, body: `@${other.name} again` });
    const toldAfter = await db.notification.count({ where: { type: "SMART_LIST_MENTION", userId: other.id, createdAt: { gte: since } } });
    ok("…but nobody is mentioned into a list they can't open", quiet.ok && quiet.data.told === 0 && toldAfter === 1);
    await db.workbook.update({ where: { id: backlinks }, data: { shared: true } });
    as(other);
    ok("somebody else can't delete a comment that isn't theirs", said.ok && !(await team.deleteRowComment(said.data.comment.id)).ok);
    as(admin);
    ok("its author can", said.ok && (await team.deleteRowComment(said.data.comment.id)).ok);

    section("Count columns");
    await rows.setOwnRowValue({ rowId: b1, propertyId: article, value: [a1] });
    await rows.setOwnRowValue({ rowId: b2, propertyId: article, value: [a1] });
    await rows.setOwnRowValue({ rowId: b3, propertyId: article, value: [a2] });
    await rows.setOwnRowValue({ rowId: b1, propertyId: cost, value: 1000 });
    await rows.setOwnRowValue({ rowId: b2, propertyId: cost, value: 500 });
    const sources = await links.countSources(content);
    ok("the lists whose rows link here, with what to count", sources.length === 1 && sources[0]!.listId === backlinks && sources[0]!.via[0]!.id === article && sources[0]!.selects.some((s) => s.id === status) && sources[0]!.numbers.some((n) => n.id === cost && n.money));
    const count = await col(content, "Backlinks", "ROLLUP", { list: backlinks, via: article, fn: "count" });
    const liveCount = await col(content, "Live backlinks", "ROLLUP", { list: backlinks, via: article, fn: "count", where: { propertyId: status, optionId: live } });
    const spent = await col(content, "Spent", "ROLLUP", { list: backlinks, via: article, fn: "sum", field: cost });
    ok("a count through a column that doesn't link here is refused", !(await board.addListProperty({ workbookId: content, name: "Bad", kind: "ROLLUP", options: { list: backlinks, via: status, fn: "count" } })).ok);
    const { rollupValues } = await import("../src/lib/smart-lists/rollups");
    const props = (await board.getListBoard(content, []))!.properties;
    const rolled = await rollupValues(props, [a1, a2], admin.id);
    ok("how many link here, how many are Live, what they cost", rolled[a1]?.[count] === 2 && rolled[a2]?.[count] === 1 && rolled[a1]?.[liveCount] === 1 && rolled[a2]?.[liveCount] === 1 && rolled[a1]?.[spent] === 1500 && rolled[a2]?.[spent] === 0, rolled);
    ok("never typed in", !(await rows.setOwnRowValue({ rowId: a1, propertyId: count, value: 9 })).ok);
    ok("money shown as money", props.find((p) => p.id === spent)?.rollup?.money === true);
    await db.workbook.update({ where: { id: backlinks }, data: { shared: false } });
    const hidden = await rollupValues(props, [a1], other.id);
    await db.workbook.update({ where: { id: backlinks }, data: { shared: true } });
    ok("nothing for somebody who may not open the other list", !hidden[a1]);

    section("Deskzo Automate");
    const events = await db.automationEvent.findMany({ where: { recordType: "smart-list-row", occurredAt: { gte: since }, recordId: { startsWith: `${backlinks}:` } }, orderBy: { occurredAt: "asc" }, select: { type: true, recordId: true, payload: true } });
    const added = events.filter((e) => e.type === "smartlist.row_added");
    const changed = events.filter((e) => e.type === "smartlist.value_changed" && (e.payload as { column?: { id: string } }).column?.id === status);
    ok("a row added, recorded with the save", added.length === 3 && (added[0]!.payload as { row: { title: string }; addedVia: string }).addedVia === "hand");
    ok("a column changed, in words — from and to — one per row set together", changed.length === 4 && changed.some((e) => (e.payload as { from: string; to: string }).from === "Live" && (e.payload as { to: string }).to === "Lost"), changed.map((e) => e.payload));
    const { triggerByType, triggerPaths } = await import("../src/lib/automate/triggers");
    ok("both triggers in the catalogue, their fields offered to the builder", !!triggerByType("smartlist.row_added") && triggerPaths("smartlist.value_changed").some((p) => p.ref === "trigger.row.title") && triggerPaths("smartlist.value_changed").some((p) => p.ref === "trigger.to"));
    const { eventAsOwner } = await import("../src/lib/automate/trigger-reach");
    const sample = changed[0]!;
    await db.workbook.update({ where: { id: backlinks }, data: { shared: false } });
    const blind = await eventAsOwner(other.id, { recordType: "smart-list-row", recordId: sample.recordId, payload: sample.payload });
    const seeing = await eventAsOwner(admin.id, { recordType: "smart-list-row", recordId: sample.recordId, payload: sample.payload });
    await db.workbook.update({ where: { id: backlinks }, data: { shared: true } });
    ok("a workflow's owner who may not open the list learns nothing; one who may, everything", blind === null && !!seeing && (seeing.row as { title: string }).title.length > 0);
    const { sampleTrigger } = await import("../src/lib/automate/samples");
    ok("the builder has a sample to try", !!(await sampleTrigger(admin.id, "smartlist.row_added")));

    section("Forms that add rows");
    const form = await team.saveListForm({ workbookId: backlinks, name: "Report a backlink", intro: "Found a link to us?", fields: [{ propertyId: status, required: true }, { propertyId: cost, required: false }, { propertyId: article, required: true }] });
    ok("the builder makes one — a link column isn't asked", form.ok && (await team.listForms(backlinks))?.[0]?.fields.length === 2);
    as(other);
    ok("somebody else can't make one", !(await team.saveListForm({ workbookId: backlinks, name: "x", fields: [] })).ok);
    await db.workbook.update({ where: { id: backlinks }, data: { shared: false } });
    if (form.ok) {
      const toFill = await team.formForFilling(form.data.id);
      ok("filled in by somebody who can't open the list — the questions, not the list", !!toFill && toFill.questions.length === 2 && toFill.titleName === "Name" && toFill.listName === `Zz P3 ${run} Backlinks`);
      ok("a required question must be answered", !(await team.sendListForm({ formId: form.data.id, title: "from.form/one", answers: {} })).ok);
      const sent = await team.sendListForm({ formId: form.data.id, title: "from.form/one", answers: { [status]: live, [cost]: "250" } });
      const made = sent.ok ? await db.workbookRow.findUnique({ where: { id: sent.data.rowId }, select: { createdByUserId: true, values: { select: { propertyId: true, value: true } } } }) : null;
      ok("the answer is a row, added by whoever filled it in, with its values", sent.ok && made?.createdByUserId === other.id && made.values.length === 2 && made.values.some((v) => v.value === 250));
      as(admin);
      ok("…its history says it came from the form", sent.ok && (await team.rowActivity(backlinks, sent.data.rowId))?.history[0]?.text === 'Added the row from the form "Report a backlink"');
      ok("…and Automate hears of it", sent.ok && (await db.automationEvent.count({ where: { type: "smartlist.row_added", recordId: `${backlinks}:${sent.data.rowId}`, payload: { path: ["addedVia"], equals: "form" } } })) === 1);
      await team.saveListForm({ workbookId: backlinks, id: form.data.id, name: "Report a backlink", fields: [], active: false });
      as(other);
      ok("a closed form takes no answers", (await team.formForFilling(form.data.id)) === null && !(await team.sendListForm({ formId: form.data.id, title: "x", answers: {} })).ok);
    }
    as(admin);
    await db.workbook.update({ where: { id: backlinks }, data: { shared: true } });

    section("The company's own templates");
    const saved = await team.saveListAsTemplate({ workbookId: backlinks, name: `Zz P3 ${run} Backlinks template` });
    if (saved.ok) templates.push(saved.data.key.slice(7));
    const { companyTemplates } = await import("../src/lib/smart-lists/company-templates");
    const mine = (await companyTemplates(admin.id, true)).find((t) => saved.ok && t.key === saved.data.key);
    ok("saved: its columns — not the one tied to another list — and not its rows", !!mine && mine.columns.map((c) => c.name).join() === "Status,Cost,Owner", mine?.columns);
    const fromIt = saved.ok ? await rows.createOwnRowList({ name: `Zz P3 ${run} From template`, template: saved.data.key }) : null;
    if (fromIt?.ok) workbooks.push(fromIt.data.id);
    ok("a list made from it has its columns and no rows", !!fromIt?.ok && (await db.workbookProperty.count({ where: { workbookId: fromIt.data.id } })) === 3 && (await db.workbookRow.count({ where: { workbookId: fromIt.data.id } })) === 0);
    as(other);
    ok("somebody else can't delete it", saved.ok && !(await team.deleteListTemplate(saved.data.key)).ok);
    as(admin);

    section("Gallery, grouping");
    const gallery = await board.addListView({ workbookId: backlinks, name: "Cards", kind: "GALLERY" });
    ok("a gallery needs no column", gallery.ok && (await db.workbookView.findUnique({ where: { id: gallery.ok ? gallery.data.id : "" }, select: { kind: true, propertyId: true } }))?.kind === "GALLERY");
    const bprops = (await board.getListBoard(backlinks, []))!.properties;
    const grouped = vq.cleanQuery({ group: status, sort: [{ field: cost, dir: "desc" }] }, bprops, true);
    ok("grouped by a Select, its column sorted first; not by a Money column", grouped.group === status && vq.effectiveSort(grouped)[0]?.field === status && vq.cleanQuery({ group: cost }, bprops, true).group === null);

    section("A spreadsheet's names matched to companies");
    const city = `Zzcity3${run}`;
    for (const n of ["Acme", "Beta"]) {
      const c = await db.company.create({ data: { name: `Zz P3 ${run} ${n}`, normalizedName: `zz p3 ${run} ${n}`.toLowerCase(), createdById: admin.id, ownerUserId: admin.id }, select: { id: true } });
      companies.push(c.id);
      await db.companyLocation.create({ data: { companyId: c.id, label: "Head office", city, isPrimary: true } });
    }
    const csv = `Name,Customer\nRow one,zz p3 ${run} acme\nRow two,"Zz P3 ${run} Beta; Nobody Ltd"\n`;
    const form2 = new FormData();
    form2.set("workbookId", content);
    form2.set("file", new File([csv], "rows.csv", { type: "text/csv" }));
    const read = await rows.readImportFile(form2);
    if (read.ok) {
      const mapping = read.data.mapping.map((m, i) => (i === 1 ? { to: "new" as const, kind: "COMPANY" as const, name: "Customer" } : m));
      const done = await rows.importOwnRows({ workbookId: content, headers: read.data.headers, rows: read.data.rows, mapping });
      const customer = await db.workbookProperty.findFirst({ where: { workbookId: content, name: "Customer" }, select: { id: true, kind: true } });
      const vals = customer ? await db.workbookRowValue.findMany({ where: { propertyId: customer.id }, select: { value: true } }) : [];
      ok("a Company column matched by name, whatever the case; a name not found left out", done.ok && customer?.kind === "COMPANY" && vals.length === 2 && vals.some((v) => JSON.stringify(v.value) === JSON.stringify([companies[0]])) && done.data.cellsLeftOut === 1, { done, vals });
    } else ok("the file read", false, read);

    section("A list of companies as Excel");
    const wb = await db.workbook.create({ data: { name: `Zz P3 companies ${run}`, filters: { city: [city] }, ownerUserId: admin.id, shared: true }, select: { id: true } });
    workbooks.push(wb.id);
    const stage = await col(wb.id, "Stage", "SELECT", [{ name: "Hot" }]);
    await board.setListValue({ propertyId: stage, companyId: companies[0]!, value: await optionId(stage, "Hot") });
    ok("a company's value change has a history too", (await team.rowActivity(wb.id, companies[0]!))?.history[0]?.text === "Stage: empty → Hot");
    const out = await links.exportCompanyList(wb.id);
    ok("downloaded: every company in it, with its columns", out.ok && out.data.rows === 2);
    as(other);
    const { can } = await import("../src/lib/authz/resolve");
    const mayExport = await can(other.id, "data.exportCrm");
    const refused = await links.exportCompanyList(wb.id);
    ok(mayExport ? "somebody who may export CRM data downloads it too" : "somebody who may not export CRM data can't", mayExport ? refused.ok : !refused.ok);
    as(admin);

    section("Shared with guests (Deskzo Connect)");
    const connect = await import("../src/actions/connect");
    const guestLists = await import("../src/lib/connect/guest-lists");
    const working = await import("../src/lib/connect/working");
    const conn = await db.connection.create({ data: { name: `Zz P3 brand ${run}` }, select: { id: true } });
    connections.push(conn.id);
    const guest = await db.guest.create({ data: { connectionId: conn.id, name: "Zz P3 client", email: `zz.client.${run}@zz-p3-${run}.example`, status: "ACTIVE", inviteExpiresAt: new Date(Date.now() + 86_400_000) }, select: { id: true } });
    await board.updateListProperty({ id: status, guestVisible: true, guestEditable: true });
    await board.updateListProperty({ id: article, guestVisible: true });
    const sharedOut = await connect.shareListWithGuest({ workbookId: backlinks, guestId: guest.id });
    ok("a list of its own rows is shared with a guest", sharedOut.ok, sharedOut);
    const shareId = (await db.listShare.findUniqueOrThrow({ where: { workbookId_guestId: { workbookId: backlinks, guestId: guest.id } }, select: { id: true } })).id;
    const total = await db.workbookRow.count({ where: { workbookId: backlinks } });
    const gview = await guestLists.guestListView(guest.id, shareId);
    ok("the guest sees its rows by title, only the columns marked for them — never one linking elsewhere", gview?.own?.titleName === "Name" && gview.total === total && gview.columns.map((c) => c.id).join() === status && gview.rows.some((r) => r.name === "news.in/1"), gview?.columns.map((c) => c.name));
    const tick = await col(backlinks, "For the client", "CHECKBOX");
    await rows.setOwnRowValue({ rowId: b1, propertyId: tick, value: true });
    ok("narrowed to the rows ticked for them", (await connect.setShareRows(shareId, tick)).ok && (await guestLists.guestListView(guest.id, shareId))?.rows.map((r) => r.id).join() === b1);
    const gset = await guestLists.setGuestValue(guest.id, { shareId, propertyId: status, companyId: b1, value: live });
    const gbad = await guestLists.setGuestValue(guest.id, { shareId, propertyId: status, companyId: b2, value: live });
    const glink = await guestLists.setGuestValue(guest.id, { shareId, propertyId: article, companyId: b1, value: [a2] });
    ok("the guest changes a column marked editable on a row they see — not another row, not a link column", gset.ok && !gbad.ok && !glink.ok);
    const staffSaid = await team.commentOnRow({ workbookId: backlinks, rowId: b1, body: "Live since Monday", shared: true });
    await team.commentOnRow({ workbookId: backlinks, rowId: b1, body: "internal: their DA is low", shared: false });
    const gc = await working.guestAddComment(guest.id, { shareId, companyId: b1, body: "Thanks!" });
    const detail = await working.guestRowDetail(guest.id, shareId, b1);
    ok("comments: the guest reads the shared ones and their own — never an internal one", staffSaid.ok && gc.ok && !!detail?.own && detail.comments.map((c) => c.body).join("|") === "Live since Monday|Thanks!", detail?.comments.map((c) => c.body));
    ok("staff see the guest's comment, marked as a guest's", (await team.rowActivity(backlinks, b1))?.comments?.some((c) => c.body === "Thanks!" && c.byGuest) === true);
    ok("no companies to suggest or correct on it", !(await working.guestSuggestCompany(guest.id, { shareId, name: "Acme", note: "x" })).ok && !(await working.guestSuggestCorrection(guest.id, { shareId, companyId: b1, note: "x" })).ok);

    // A second team on the same list: a staff comment meant for one team, and each team's own comments.
    const conn2 = await db.connection.create({ data: { name: `Zz P3 other team ${run}` }, select: { id: true } });
    connections.push(conn2.id);
    const guest2 = await db.guest.create({ data: { connectionId: conn2.id, name: "Zz P3 other", email: `zz.other.${run}@zz-p3o-${run}.example`, status: "ACTIVE", inviteExpiresAt: new Date(Date.now() + 86_400_000) }, select: { id: true } });
    await connect.shareListWithGuest({ workbookId: backlinks, guestId: guest2.id });
    const share2 = (await db.listShare.findUniqueOrThrow({ where: { workbookId_guestId: { workbookId: backlinks, guestId: guest2.id } }, select: { id: true } })).id;
    const toFirst = await team.commentOnRow({ workbookId: backlinks, rowId: b1, body: "Only for the first team", to: conn.id });
    const otherSees = (await working.guestRowDetail(guest2.id, share2, b1))?.comments.map((c) => c.body) ?? [];
    const firstSees = (await working.guestRowDetail(guest.id, shareId, b1))?.comments.map((c) => c.body) ?? [];
    ok("a staff comment to one team reaches that team only; a guest's comment stays with their team", toFirst.ok && firstSees.includes("Only for the first team") && !otherSees.includes("Only for the first team") && !otherSees.includes("Thanks!") && otherSees.includes("Live since Monday"), { firstSees, otherSees });
    ok("staff see which team each went to", (await team.rowActivity(backlinks, b1))?.comments?.find((c) => c.body === "Only for the first team")?.team === `Zz P3 brand ${run}`);
    ok("a comment to a team the list isn't shared with is refused", !(await team.commentOnRow({ workbookId: backlinks, rowId: b1, body: "x", to: "cnotateam0000000000000000" })).ok);
    const previewed = await connect.previewGuestRow(guest.id, shareId, b1);
    ok("the admin's 'see their view' reads the row as the guest does", !!previewed?.own && previewed.comments.some((c) => c.body === "Thanks!") && !previewed.comments.some((c) => c.body.startsWith("internal")));
    const sharing = await connect.listSharing(backlinks);
    ok("the share dialog: a list of its own rows, and no link column to choose for guests", sharing.ownRows === true && !sharing.guestColumns.some((c) => c.id === article) && sharing.guestColumns.some((c) => c.id === status));
    ok("a company id never reads as a row of it", (await guestLists.setGuestValue(guest.id, { shareId, propertyId: status, companyId: companies[0] ?? "cnone", value: live })).ok === false);
    await board.deleteListProperty(tick);
    ok("its tick column deleted, the share shows nothing — never everything", (await guestLists.guestListView(guest.id, shareId))?.rows.length === 0 && (await working.guestRowDetail(guest.id, shareId, b1)) === null);

    section("The screens");
    const { renderHtml } = await import("./lib/render-html");
    type Page = (props: never) => Promise<unknown>;
    const render = async (pg: Page, params: Record<string, unknown>, searchParams: Record<string, unknown> = {}) => {
      const html = await renderHtml(pg({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) } as never));
      return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/\s+/g, " ");
    };
    const ListPage = (await import("../src/app/(dashboard)/smart-lists/[id]/page")).default as Page;
    const contentPage = await render(ListPage, { id: content });
    ok("own rows: Forms and Save as template; the count columns' numbers", contentPage.includes("Forms") && contentPage.includes("Save as template") && contentPage.includes("Live backlinks") && contentPage.includes("₹1,500"));
    const groupedPage = await render(ListPage, { id: backlinks }, { fq: vq.encodeQuery({ match: "all", rules: [], sort: [], group: status }) });
    const liveNow = await db.workbookRowValue.count({ where: { propertyId: status, value: { equals: live } } });
    ok("grouped: a heading for each choice, with how many", groupedPage.includes("Grouped by Status") && new RegExp(`Live\\s+${liveNow}\\b`).test(groupedPage), liveNow);
    const galleryPage = gallery.ok ? await render(ListPage, { id: backlinks }, { view: gallery.data.id }) : "";
    ok("a gallery of cards", galleryPage.includes("news.in/1") && galleryPage.includes("Cards"));
    const companyPage = await render(ListPage, { id: wb.id });
    ok("companies: Export Excel", companyPage.includes("Export Excel"));
    if (form.ok) {
      await team.saveListForm({ workbookId: backlinks, id: form.data.id, name: "Report a backlink", intro: "Found a link to us?", fields: [{ propertyId: status, required: true }], active: true });
      const FormPage = (await import("../src/app/(dashboard)/smart-lists/forms/[formId]/page")).default as Page;
      const formPage = await render(FormPage, { formId: form.data.id });
      ok("the form page: its name, what it's for, its questions", formPage.includes("Report a backlink") && formPage.includes("Found a link to us?") && formPage.includes("Status"));
    }
  } finally {
    as(admin);
    await db.notification.deleteMany({ where: { type: "SMART_LIST_MENTION", createdAt: { gte: since }, title: { contains: "news.in" } } });
    await db.automationEvent.deleteMany({ where: { recordType: "smart-list-row", OR: workbooks.map((id) => ({ recordId: { startsWith: `${id}:` } })) } });
    await db.workbookRowChange.deleteMany({ where: { workbookId: { in: workbooks } } });
    await db.workbookTemplate.deleteMany({ where: { id: { in: templates } } });
    await db.connection.deleteMany({ where: { id: { in: connections } } });
    await db.workbook.deleteMany({ where: { id: { in: workbooks } } });
    await db.workbookRowChange.deleteMany({ where: { rowKey: { in: companies } } });
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
