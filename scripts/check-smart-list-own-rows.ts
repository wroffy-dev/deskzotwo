/**
 * check:smart-list-own-rows — Smart Lists with rows of their own (owner, 20 Nov 2026; src/lib/smart-lists/own-rows.ts,
 * src/actions/smart-list-rows.ts): "seo team can also use to store backlinks, article links" — records only — with
 * templates across industries, the workspace's own industry first, and a spreadsheet in and out.
 *
 *   · Templates: every view on a column that suits it, names once, real industry keys, every industry offered some,
 *     its own industry first; choices coloured by meaning.
 *   · The new kinds: a rating of one to five, an email, a phone number.
 *   · A spreadsheet read: quotes and line breaks, a byte-order mark, day-first dates, ₹ amounts, the kind each column
 *     looks like, where each column goes, a choice or a person matched by name.
 *   · A list made from a template, rows added, filled in, renamed, searched, summed up, with a page each.
 *   · Who may: anyone who opens the list fills it in; only its builder shapes it or imports; a row is deleted by
 *     whoever added it or the builder; a private list is closed to others.
 *   · Import and Excel out; a duplicate carries the rows; a column deleted takes its values.
 *   · Kept apart from company work: no companies, no guest sharing, no calling activity, no marketing audience.
 *
 * Against the local database, as its super admin and one person who can't manage every list; everything made is removed.
 *
 *   npm run check:smart-list-own-rows
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "ADMIN", name: "Zz Rows", email: "zz-rows@example.invalid" };
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  // The screens, rendered without a browser (scripts/lib/render-html.ts).
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
  const v = await import("../src/lib/smart-lists/values");
  const tpl = await import("../src/lib/smart-lists/templates");
  const imp = await import("../src/lib/smart-lists/own-rows-import");
  const { INDUSTRY_TEMPLATES } = await import("../src/lib/industry-templates/catalogue");

  section("Templates");
  const industryKeys = new Set(INDUSTRY_TEMPLATES.map((t) => t.key));
  const bad: string[] = [];
  for (const t of tpl.LIST_TEMPLATES) {
    const names = t.columns.map((c) => c.name.toLowerCase());
    if (new Set(names).size !== names.length) bad.push(`${t.key}: a column name twice`);
    if (names.includes(t.titleName.toLowerCase())) bad.push(`${t.key}: a column named like the title`);
    if (t.columns.length > v.LIMITS.properties || t.views.length > v.LIMITS.views) bad.push(`${t.key}: too many columns or views`);
    for (const c of t.columns) {
      if (!v.isPropertyKind(c.kind)) bad.push(`${t.key}: ${c.name} kind`);
      if ((c.kind === "SELECT" || c.kind === "MULTI_SELECT") !== !!c.options?.length) bad.push(`${t.key}: ${c.name} choices`);
      if (c.name.length > v.LIMITS.propertyName) bad.push(`${t.key}: ${c.name} too long`);
    }
    for (const view of t.views) {
      const by = t.columns.find((c) => c.name === view.by);
      if (view.kind === "BOARD" && by?.kind !== "SELECT") bad.push(`${t.key}: board ${view.name} not on a Select`);
      if (view.kind === "CALENDAR" && by?.kind !== "DATE") bad.push(`${t.key}: calendar ${view.name} not on a Date`);
    }
    for (const k of t.industries) if (!industryKeys.has(k)) bad.push(`${t.key}: unknown industry ${k}`);
    if (!t.industries.length && !t.everyone) bad.push(`${t.key}: suits nobody`);
  }
  ok("every template is well made — views on a suitable column, names once, real industry keys", bad.length === 0, bad);
  ok("keys are unique", new Set(tpl.LIST_TEMPLATES.map((t) => t.key)).size === tpl.LIST_TEMPLATES.length);
  const thin = INDUSTRY_TEMPLATES.filter((i) => tpl.LIST_TEMPLATES.filter((t) => t.industries.includes(i.key)).length < 2).map((i) => i.key);
  ok(`every one of the ${INDUSTRY_TEMPLATES.length} industries is offered at least two templates of its own`, thin.length === 0, thin);
  const solar = tpl.templatesFor("solar_epc");
  ok("the workspace's industry first: solar's own templates are the suggested ones", solar.suggested.length >= 2 && solar.suggested.every((t) => t.industries.includes("solar_epc")) && solar.suggested.some((t) => t.key === "net-metering"));
  ok("…and the others follow by group, none twice", solar.groups.flatMap((g) => g.templates).every((t) => !t.industries.includes("solar_epc")) && solar.groups.flatMap((g) => g.templates).length + solar.suggested.length === tpl.LIST_TEMPLATES.length);
  const none = tpl.templatesFor(null);
  ok("no industry chosen: the ones for any company first", none.suggested.length > 0 && none.suggested.every((t) => t.everyone) && none.suggested.some((t) => t.key === "backlinks"));
  const colours = tpl.templateOptions(["Pending", "Live", "Lost", "In progress", "Do-follow"]);
  ok("choices coloured by meaning: waiting amber, done green, lost red, under way blue", colours.map((c) => c.color).join() === "amber,green,red,blue,blue", colours);

  section("The new kinds");
  const val = (r: ReturnType<typeof v.parseValue>) => (r.ok ? r.value : `error: ${r.error}`);
  ok("a rating is one to five — stars typed count, 0 is none, 6 is refused", val(v.parseValue("RATING", 4)) === 4 && val(v.parseValue("RATING", "★★★")) === 3 && val(v.parseValue("RATING", "0")) === null && !v.parseValue("RATING", 6).ok);
  ok("an email is kept in lower case; a broken one is refused", val(v.parseValue("EMAIL", " Asha@Example.COM ")) === "asha@example.com" && !v.parseValue("EMAIL", "asha@").ok);
  ok("a phone number is kept as typed; letters are refused", val(v.parseValue("PHONE", "+91 98765 43210")) === "+91 98765 43210" && !v.parseValue("PHONE", "call me").ok && !v.parseValue("PHONE", "123").ok);
  ok("a rating reads as stars in words", v.valueText("RATING", 2, []) === "★★");

  section("Reading a spreadsheet");
  const bom = String.fromCharCode(0xfeff);
  const csv = imp.parseCsv(`${bom}Name,Notes,Amount\r\n"Acme, Pune","line one\nline two","₹1,200"\r\n\r\nBeta,"say ""hi""",300\n`);
  ok("CSV: quoted commas and line breaks, doubled quotes, a byte-order mark, blank lines gone", csv.length === 3 && csv[0]![0] === "Name" && csv[1]![0] === "Acme, Pune" && csv[1]![1] === "line one\nline two" && csv[2]![1] === 'say "hi"', csv);
  ok("CSV: a semicolon file is read by its semicolons", imp.parseCsv("a;b\n1;2").map((r) => r.join("|")).join() === "a|b,1|2");
  ok("dates: day first as in India, names of months, a date with a time", imp.toDay("05/11/2026") === "2026-11-05" && imp.toDay("5 Nov 2026") === "2026-11-05" && imp.toDay("Nov 5, 2026") === "2026-11-05" && imp.toDay("2026-11-05T10:00:00Z") === "2026-11-05" && imp.toDay("31/02/2026") === null);
  ok("numbers: ₹ and lakh commas, a percentage; words aren't", imp.toNumber("₹1,23,456.50") === 123456.5 && imp.toNumber("12%") === 12 && imp.toNumber("Rs. 500") === 500 && imp.toNumber("about 5") === null);
  ok("a column's kind from its values and header", imp.guessKind("Email", ["a@b.co", "c@d.in"]) === "EMAIL" && imp.guessKind("URL", ["https://x.com/a", "y.in"]) === "LINK" && imp.guessKind("Added", ["05/11/2026", "2026-11-06"]) === "DATE" && imp.guessKind("Cost", ["1,200", "300"]) === "MONEY" && imp.guessKind("DA", ["40", "52"]) === "NUMBER" && imp.guessKind("Mobile", ["98765 43210", "+91 99999 00000"]) === "PHONE" && imp.guessKind("Status", ["Live", "Lost", "Live", "Pending", "Live"]) === "SELECT" && imp.guessKind("Note", ["one thing", "another"]) === "TEXT");
  const mapping = imp.suggestMapping(["URL", "Status", "Linking page", ""], [["https://a.com", "Live", "A page", ""]], [{ id: "p1", name: "status" }], "Linking page");
  ok("where each column goes: the title by name, a column of the same name, a new one, a nameless one left out", mapping[2]!.to === "title" && mapping[1]!.to === "column" && mapping[0]!.to === "new" && mapping[3]!.to === "skip", mapping);
  const opts = v.cleanOptions([{ name: "Live" }, { name: "Lost" }]);
  ok(
    "a cell: a choice by name whatever the case, an unknown choice left out, yes as a tick, a person by email",
    imp.cellValue("SELECT", "live", { options: opts, people: [] }).value === opts[0]!.id &&
      imp.cellValue("SELECT", "Gone", { options: opts, people: [] }).skipped &&
      imp.cellValue("CHECKBOX", "Yes", { options: [], people: [] }).value === true &&
      imp.cellValue("PERSON", "asha@x.in", { options: [], people: [{ id: "abcdefgh12", name: "Asha", email: "Asha@x.in" }] }).value === "abcdefgh12",
  );

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
  const rows = await import("../src/actions/smart-list-rows");
  const board = await import("../src/actions/smart-list-board");
  const ws = await import("../src/actions/workspace");
  const own = await import("../src/lib/smart-lists/own-rows");

  try {
    section("A list from a template");
    const made = await rows.createOwnRowList({ name: `Zz Backlinks ${run}`, template: "backlinks" });
    ok("made", made.ok, made);
    if (!made.ok) return;
    const id = made.data.id;
    workbooks.push(id);
    const wb = await db.workbook.findUnique({ where: { id }, select: { mode: true, filters: true, description: true } });
    const props = await db.workbookProperty.findMany({ where: { workbookId: id }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true, kind: true, options: true } });
    const views = await db.workbookView.findMany({ where: { workbookId: id }, select: { kind: true, propertyId: true } });
    const template = tpl.templateByKey("backlinks")!;
    ok("a list of its own rows, no filters, the template's purpose", wb?.mode === "ROWS" && JSON.stringify(wb.filters) === "{}" && wb.description === template.description);
    ok("its title column is the template's", (await own.titleNameOf(id)) === "Linking page");
    ok("the template's columns, in order, with their kinds", props.map((p) => `${p.name}:${p.kind}`).join() === template.columns.map((c) => `${c.name}:${c.kind}`).join());
    const status = props.find((p) => p.name === "Status")!;
    const statusOpts = v.optionsOf(status.options);
    ok("its board groups by Status", views.length === 1 && views[0]!.kind === "BOARD" && views[0]!.propertyId === status.id);
    ok("Status's choices, coloured", statusOpts.map((o) => `${o.name}:${o.color}`).join() === "Pending:amber,Live:green,Lost:red,Rejected:red", statusOpts);
    ok("an unknown template is refused", !(await rows.createOwnRowList({ name: "x", template: "nope" })).ok);
    const industry = await own.workspaceIndustry();
    const lastApplied = await db.auditLog.findFirst({ where: { entityType: "IndustryTemplate" }, orderBy: { createdAt: "desc" }, select: { entityId: true } });
    ok("the workspace's industry is the last industry template applied", (industry?.key ?? null) === (INDUSTRY_TEMPLATES.some((t) => t.key === lastApplied?.entityId) ? lastApplied!.entityId : null), industry);

    section("Rows, filled in");
    const a = await rows.addOwnRow({ workbookId: id, title: "  example.com/best-crm  " });
    const b = await rows.addOwnRow({ workbookId: id, title: "blog.other.in/tools" });
    ok("rows added, titles tidied", a.ok && b.ok && a.data.title === "example.com/best-crm", a);
    ok("a row needs a title", !(await rows.addOwnRow({ workbookId: id, title: "   " })).ok);
    if (!a.ok || !b.ok) return;
    const link = props.find((p) => p.name === "Linking page URL")!;
    const da = props.find((p) => p.name === "Domain authority")!;
    const ownerCol = props.find((p) => p.name === "Owner")!;
    const live = statusOpts.find((o) => o.name === "Live")!.id;
    const setA = await Promise.all([
      rows.setOwnRowValue({ rowId: a.data.id, propertyId: link.id, value: "example.com/best-crm" }),
      rows.setOwnRowValue({ rowId: a.data.id, propertyId: status.id, value: live }),
      rows.setOwnRowValue({ rowId: a.data.id, propertyId: da.id, value: "52" }),
      rows.setOwnRowValue({ rowId: a.data.id, propertyId: ownerCol.id, value: admin.id }),
    ]);
    ok("cells kept as their columns keep them — a link as typed, a choice, a number, a person", setA.every((r) => r.ok) && setA[0]!.ok && setA[0]!.data.value === "https://example.com/best-crm", setA);
    ok("a value a column doesn't keep is refused", !(await rows.setOwnRowValue({ rowId: a.data.id, propertyId: status.id, value: "nope" })).ok && !(await rows.setOwnRowValue({ rowId: a.data.id, propertyId: da.id, value: "lots" })).ok);
    const otherList = await rows.createOwnRowList({ name: `Zz Other ${run}` });
    if (otherList.ok) workbooks.push(otherList.data.id);
    ok("a column of another list is refused", !(await rows.setOwnRowValue({ rowId: b.data.id, propertyId: link.id + "x", value: "a.com" })).ok);
    ok("renamed", (await rows.renameOwnRow({ rowId: b.data.id, title: "blog.other.in/crm-tools" })).ok && (await db.workbookRow.findUnique({ where: { id: b.data.id }, select: { title: true } }))?.title === "blog.other.in/crm-tools");
    const page = await rows.saveOwnRowPage({ rowId: a.data.id, notes: "Asked for a do-follow.", checklist: [{ text: "Thank them" }] });
    const back = await rows.getOwnRowPage(a.data.id);
    ok("a row's page: notes and a checklist, and who added it", page.ok && back?.notes === "Asked for a do-follow." && back.checklist.length === 1 && back.createdBy === admin.name, back);

    const props2 = await own.propsOf(id);
    const all = await own.ownRowsPage(id, props2, { skip: 0, take: 50 });
    ok("the rows in order, with their values", all.total === 2 && all.rows[0]!.id === a.data.id && all.values[a.data.id]?.[status.id] === live && all.values[a.data.id]?.[da.id] === 52);
    const byTitle = await own.ownRowsPage(id, props2, { search: "crm-tools", skip: 0, take: 50 });
    const byChoice = await own.ownRowsPage(id, props2, { search: "live", skip: 0, take: 50 });
    const byValue = await own.ownRowsPage(id, props2, { search: "best-crm", skip: 0, take: 50 });
    const byPerson = await own.ownRowsPage(id, props2, { search: admin.name.slice(0, 4), skip: 0, take: 50 });
    ok("search: a title, a choice by its name, a value, a person by name", byTitle.total === 1 && byTitle.rows[0]!.id === b.data.id && byChoice.total === 1 && byChoice.rows[0]!.id === a.data.id && byValue.total === 1 && byPerson.rows.some((r) => r.id === a.data.id), { byTitle: byTitle.total, byChoice: byChoice.total, byValue: byValue.total, byPerson: byPerson.total });
    const dash = await own.ownRowDashboard(id, "2026-11-20");
    const statusBars = dash.selects.find((s) => s.id === status.id);
    ok("the dashboard: rows, Status by choice, who added them", dash.total === 2 && dash.own?.rows === "Rows" && statusBars?.bars.find((x) => x.key === live)?.count === 1 && statusBars.notSet === 1 && dash.owners[0]?.count === 2 && dash.states === null, { total: dash.total, statusBars, owners: dash.owners });

    section("Who may");
    as(other);
    const theirs = await rows.addOwnRow({ workbookId: id, title: "their-site.in/post" });
    ok("somebody else adds a row to a shared list, and fills it in", theirs.ok && (theirs.ok ? (await rows.setOwnRowValue({ rowId: theirs.data.id, propertyId: da.id, value: 30 })).ok : false));
    ok("…but can't shape it: no new column, no import, no renaming the title column", !(await board.addListProperty({ workbookId: id, name: "Zz", kind: "TEXT" })).ok && !(await rows.renameTitleColumn({ workbookId: id, name: "Page" })).ok && !(await rows.importOwnRows({ workbookId: id, headers: ["Linking page"], rows: [["x"]], mapping: [{ to: "title" }] })).ok);
    ok("…can't delete the builder's row", !(await rows.deleteOwnRows({ workbookId: id, rowIds: [a.data.id] })).ok && !!(await db.workbookRow.findUnique({ where: { id: a.data.id }, select: { id: true } })));
    ok("…deletes their own", theirs.ok && (await rows.deleteOwnRows({ workbookId: id, rowIds: [theirs.data.id] })).ok && !(await db.workbookRow.findUnique({ where: { id: theirs.ok ? theirs.data.id : "" }, select: { id: true } })));
    as(admin);
    await db.workbook.update({ where: { id }, data: { shared: false } });
    as(other);
    ok("a private list is closed to others: no rows added, none read", !(await rows.addOwnRow({ workbookId: id, title: "x" })).ok && (await rows.getOwnRowPage(a.data.id)) === null && !(await rows.exportOwnRows(id)).ok);
    as(admin);
    await db.workbook.update({ where: { id }, data: { shared: true } });

    section("A spreadsheet in, Excel out");
    const file = new File([`Linking page,Status,Domain authority,Anchor text,Topic\nnews.site.in/a,Live,61,best crm,SEO\n,Live,10,no title,SEO\nmag.site.in/b,Waiting,forty,crm,Content\nhub.site.in/c,lost,35,tools,SEO\nzine.in/d,Live,22,deskzo,Content\n`], "links.csv", { type: "text/csv" });
    const form = new FormData();
    form.set("workbookId", id);
    form.set("file", file);
    const read = await rows.readImportFile(form);
    ok("read: 5 rows; the title, Status and Domain authority matched by name; Topic a new Select", read.ok && read.data.rows.length === 5 && read.data.mapping[0]!.to === "title" && read.data.mapping[1]!.to === "column" && read.data.mapping[2]!.to === "column" && read.data.mapping[3]!.to === "column" && read.data.mapping[4]!.to === "new" && (read.data.mapping[4] as { kind: string }).kind === "SELECT", read.ok ? read.data.mapping : read);
    if (read.ok) {
      const done = await rows.importOwnRows({ workbookId: id, headers: read.data.headers, rows: read.data.rows, mapping: read.data.mapping });
      ok("imported: 4 rows (one had no title), a new column, a word in a number column left empty", done.ok && done.data.rows === 4 && done.data.noTitle === 1 && done.data.columns === 1 && done.data.cellsLeftOut === 1, done);
      const after = v.optionsOf((await db.workbookProperty.findUnique({ where: { id: status.id }, select: { options: true } }))?.options);
      ok("a choice the file names that Status lacked is added; one in another case is matched", after.some((o) => o.name === "Waiting") && after.filter((o) => o.name.toLowerCase() === "lost").length === 1, after.map((o) => o.name));
      const topic = await db.workbookProperty.findFirst({ where: { workbookId: id, name: "Topic" }, select: { kind: true, options: true } });
      ok("the new Select's choices come from the file", topic?.kind === "SELECT" && v.optionsOf(topic.options).map((o) => o.name).join() === "SEO,Content");
      ok("the list now holds 6 rows", (await db.workbookRow.count({ where: { workbookId: id } })) === 6);
    }
    const pdf = new FormData();
    pdf.set("workbookId", id);
    pdf.set("file", new File(["%PDF-1.4"], "links.pdf", { type: "application/pdf" }));
    const refused = await rows.readImportFile(pdf);
    ok("a file that isn't CSV or Excel is refused", !refused.ok && /csv or .xlsx/i.test(refused.error), refused);
    const out = await rows.exportOwnRows(id);
    ok("Excel out: a file of every row", out.ok && out.data.rows === 6 && out.data.filename.endsWith(".xlsx"));
    if (out.ok) {
      const { loadWorkbook } = await import("../src/lib/portability/workbook");
      const book = await loadWorkbook(Buffer.from(out.data.base64, "base64"));
      const sheet = book.worksheets.find((w) => w.name !== "About this export")!;
      const head = (sheet.getRow(1).values as unknown[]).slice(1);
      ok("its header: the title column, every column, who added it and when", head[0] === "Linking page" && head.includes("Status") && head.includes("Topic") && head.includes("Added by") && sheet.rowCount === 7, head);
      const back = new FormData();
      back.set("workbookId", id);
      back.set("file", new File([Buffer.from(out.data.base64, "base64")], "again.xlsx"));
      const again = await rows.readImportFile(back);
      ok(
        "the download reads back in: every column matched by name, who-and-when left out",
        again.ok && again.data.rows.length === 6 && again.data.mapping.every((m, i) => (i === 0 ? m.to === "title" : m.to === "column" || (m.to === "skip" && /added|last changed/i.test(again.data.headers[i]!)))),
        again.ok ? again.data.mapping.map((m, i) => `${again.data.headers[i]}→${m.to}`) : again,
      );
    }

    section("Duplicate, delete a column");
    const copy = await ws.duplicateWorkbook(id);
    if (copy.ok) workbooks.push(copy.data.id);
    ok(
      "a duplicate is a list of its own rows, with the columns, views and rows",
      copy.ok &&
        (await db.workbook.findUnique({ where: { id: copy.data.id }, select: { mode: true } }))?.mode === "ROWS" &&
        (await db.workbookRow.count({ where: { workbookId: copy.data.id } })) === 6 &&
        (await db.workbookProperty.count({ where: { workbookId: copy.data.id } })) === (await db.workbookProperty.count({ where: { workbookId: id } })) &&
        (await db.workbookView.count({ where: { workbookId: copy.data.id, propertyId: { not: null } } })) === 1 &&
        (await db.workbookRowValue.count({ where: { workbookId: copy.data.id } })) === (await db.workbookRowValue.count({ where: { workbookId: id } })),
    );
    const before = await db.workbookRowValue.count({ where: { propertyId: da.id } });
    ok("a column deleted takes its values with it", before > 0 && (await board.deleteListProperty(da.id)).ok && (await db.workbookRowValue.count({ where: { propertyId: da.id } })) === 0);

    section("Kept apart from company work");
    const { listMembersWhere } = await import("../src/lib/smart-lists/membership");
    const anyCompany = await db.company.findFirst({ select: { id: true } });
    ok("it holds no companies", (await db.company.count({ where: await listMembersWhere(admin.id, id, {}) })) === 0);
    ok("a company's value can't be written into it", !!anyCompany && !(await board.setListValue({ propertyId: status.id, companyId: anyCompany.id, value: live })).ok);
    const connect = await import("../src/actions/connect");
    const shared = await connect.shareListWithGuest({ workbookId: id, guestId: "nobody" });
    // Since Smart Lists phase 3 a list of its own rows is shared with guests too (check:smart-lists-phase-3); here only the guest is unknown.
    ok("sharing it is refused for an unknown guest, not for being a list of its own rows", !shared.ok && !/rows of its own/.test(shared.error), shared);
    const calling = await import("../src/actions/calling-activity");
    const started = await calling.startCallingActivity({ workbookId: id, callerIds: [admin.id], method: "ROUND_ROBIN" });
    ok("no calling activity is started on it", !started.ok && /no companies to call/.test(started.error), started);
    const audience = await import("../src/lib/marketing/smart-list-audience");
    ok("it isn't offered as a marketing audience", !(await audience.smartListsFor(admin.id)).some((l) => l.id === id) && (await audience.smartListFor(admin.id, id)) === null);

    section("The screens");
    const { renderHtml } = await import("./lib/render-html");
    type Page = (props: never) => Promise<unknown>;
    const render = async (page: Page, params: Record<string, unknown>, searchParams: Record<string, unknown> = {}) => {
      const html = await renderHtml(page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) } as never));
      return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    };
    const NewPage = (await import("../src/app/(dashboard)/smart-lists/new/page")).default as Page;
    const ListPage = (await import("../src/app/(dashboard)/smart-lists/[id]/page")).default as Page;
    const EditPage = (await import("../src/app/(dashboard)/smart-lists/[id]/edit/page")).default as Page;
    const IndexPage = (await import("../src/app/(dashboard)/smart-lists/page")).default as Page;
    const chooser = await render(NewPage, {});
    ok("New list: companies, a blank list, and templates — the industry's own or any company's first", chooser.includes("Companies from your CRM") && chooser.includes("A blank list of its own rows") && chooser.includes("Start from a template") && chooser.includes("Backlink tracker") && (industry ? chooser.includes(`For ${industry.name.toLowerCase()}`) : chooser.includes("Useful to any company")));
    const companies = await render(NewPage, {}, { from: "companies" });
    ok("…and a list of companies is built from filters as before", companies.includes("A list of companies") && companies.includes("Save list"));
    const table = await render(ListPage, { id });
    ok("the list: its title column, its rows, who changed them, import and Excel", table.includes("Linking page") && table.includes("example.com/best-crm") && table.includes("Last changed") && table.includes("Import") && table.includes("Export Excel") && table.includes("6 rows") && !table.includes("Add company"));
    const boardView = await db.workbookView.findFirst({ where: { workbookId: id, kind: "BOARD" }, select: { id: true } });
    const kanban = await render(ListPage, { id }, { view: boardView?.id });
    ok("its board, grouped by Status", !!boardView && kanban.includes("Pending") && kanban.includes("Waiting") && kanban.includes("news.site.in/a"));
    const dashboard = await render(ListPage, { id }, { view: "dashboard" });
    ok("its dashboard: rows, not companies; by who added them", dashboard.includes("Rows") && dashboard.includes("By who added them") && !dashboard.includes("By account owner"));
    const searched = await render(ListPage, { id }, { q: "zine" });
    ok("searched: only the row that matches", searched.includes("zine.in/d") && !searched.includes("news.site.in/a") && searched.includes("1 row found"));
    const edit = await render(EditPage, { id });
    ok("editing it: its name and purpose, no filters", edit.includes("Save changes") && !edit.includes("Industry") && !/filter/i.test(edit.replace(/Smart Lists/g, "")));
    const index = await render(IndexPage, {});
    ok("the Smart Lists page counts its rows", index.includes(`Zz Backlinks ${run}`) && index.includes("Own rows") && /6 rows/.test(index));
  } finally {
    as(admin);
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
