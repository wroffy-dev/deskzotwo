/**
 * check:smart-list-board — Smart Lists, Notion-style (owner, 20 Nov 2026; src/lib/smart-lists, src/actions/smart-list-board.ts).
 *
 *   · What each kind of column keeps: text, numbers, money, a real calendar day, a known choice, a web address, a person.
 *   · Columns and views are the list builder's to shape; somebody else is refused, and can't open a private list at all.
 *   · Values and row pages: only for a company that is in the list for that person — its filters, or added by hand.
 *   · A board needs a Select column, a calendar a Date column; deleting the column leaves the view a plain table.
 *   · A choice taken away reads as empty; a company added by hand is in the list's rows, and taken off again.
 *
 * Against the local database, as its super admin and one person who can't manage every list; everything made is removed.
 *
 *   npm run check:smart-list-board
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "ADMIN", name: "Zz Lists", email: "zz-lists@example.invalid" };
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
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

  section("What each kind of column keeps");
  ok("text is trimmed; empty is no value", JSON.stringify(v.parseValue("TEXT", "  hi  ")) === JSON.stringify({ ok: true, value: "hi" }) && (v.parseValue("TEXT", "") as { value: unknown }).value === null);
  ok("a number reads commas and ₹; words are refused", (v.parseValue("MONEY", "₹1,20,000.505") as { value: unknown }).value === 120000.51 && !v.parseValue("NUMBER", "twelve").ok);
  ok("a date must be a real calendar day", (v.parseValue("DATE", "2026-11-25") as { value: unknown }).value === "2026-11-25" && !v.parseValue("DATE", "2026-02-30").ok && !v.parseValue("DATE", "25/11/2026").ok);
  const opts = v.cleanOptions([{ name: "Visited" }, { name: "visited" }, { name: "Demo done", color: "green" }, { name: "  " }]);
  ok("choices: named once whatever the case, coloured", opts.length === 2 && opts[1]!.color === "green" && opts.every((o) => /^[a-z0-9]+$/.test(o.id)), opts);
  ok("a choice must be one of the column's", (v.parseValue("SELECT", opts[0]!.id, opts) as { value: unknown }).value === opts[0]!.id && !v.parseValue("SELECT", "nope", opts).ok && !v.parseValue("MULTI_SELECT", [opts[0]!.id, "nope"], opts).ok);
  ok("a link is a web address — never another scheme", (v.parseValue("LINK", "wroffy.com/x") as { value: unknown }).value === "https://wroffy.com/x" && !v.parseValue("LINK", "javascript:alert(1)").ok && !v.parseValue("LINK", "localhost").ok);
  ok("a checkbox keeps only true", (v.parseValue("CHECKBOX", true) as { value: unknown }).value === true && (v.parseValue("CHECKBOX", false) as { value: unknown }).value === null);
  const list = v.cleanChecklist([{ text: " Call " }, { text: "" }, { id: "x", text: "Visit", done: true }, { id: "x", text: "Again" }]);
  ok("a checklist keeps lines with words, ids once", list.length === 3 && list[0]!.text === "Call" && list[1]!.done && list[1]!.id === "x" && list[2]!.id !== "x", list);

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
  const city = `Zzcity${run}`;
  const companies: string[] = [];
  const workbooks: string[] = [];
  const b = await import("../src/actions/smart-list-board");
  const ws = await import("../src/actions/workspace");

  try {
    const mk = async (name: string, withCity: boolean) => {
      const c = await db.company.create({ data: { name: `Zz List ${run} ${name}`, normalizedName: `zz list ${run} ${name}`.toLowerCase(), createdById: admin.id, ownerUserId: other!.id }, select: { id: true } });
      companies.push(c.id);
      if (withCity) await db.companyLocation.create({ data: { companyId: c.id, label: "Head office", city, isPrimary: true } });
      return c.id;
    };
    const inList = await mk("Alpha", true);
    const outside = await mk("Beta", false);
    const wb = await db.workbook.create({ data: { name: `Zz List ${run}`, filters: { city: [city] }, ownerUserId: admin.id, shared: true }, select: { id: true } });
    workbooks.push(wb.id);

    section("Columns: the builder's to shape");
    const stage = await b.addListProperty({ workbookId: wb.id, name: "Outcome", kind: "SELECT", options: [{ name: "Visited" }, { name: "Demo done" }] });
    ok("a Select column added, with its choices", stage.ok);
    const visit = await b.addListProperty({ workbookId: wb.id, name: "Visit date", kind: "DATE" });
    const seats = await b.addListProperty({ workbookId: wb.id, name: "Seats", kind: "NUMBER" });
    ok("  a Date and a Number column too", visit.ok && seats.ok);
    ok("  a name once, whatever its case", !(await b.addListProperty({ workbookId: wb.id, name: "outcome", kind: "TEXT" })).ok);
    ok("  a kind it knows", !(await b.addListProperty({ workbookId: wb.id, name: "Weird", kind: "FORMULA" })).ok);
    as(other);
    const refused = await b.addListProperty({ workbookId: wb.id, name: "Mine", kind: "TEXT" });
    ok("somebody else can't add a column to it", !refused.ok && /Only whoever built/.test(refused.error), refused.ok ? "" : refused.error);
    as(admin);

    const shape = await b.getListBoard(wb.id, [inList, outside]);
    const outcome = shape?.properties.find((p) => p.name === "Outcome");
    ok("the board reads its columns in order", shape?.ready === true && shape.properties.map((p) => p.name).join() === "Outcome,Visit date,Seats", shape?.properties.map((p) => p.name));

    section("Values: only for a company in the list");
    const set = await b.setListValue({ propertyId: outcome!.id, companyId: inList, value: outcome!.options[0]!.id });
    ok("a value set for a company the filters bring", set.ok);
    const notIn = await b.setListValue({ propertyId: outcome!.id, companyId: outside, value: outcome!.options[0]!.id });
    ok("  refused for one that isn't in the list", !notIn.ok && /isn't in this list/.test(notIn.error), notIn.ok ? "" : notIn.error);
    ok("  a choice that isn't the column's is refused", !(await b.setListValue({ propertyId: outcome!.id, companyId: inList, value: "zzzz" })).ok);
    ok("  a date that isn't one is refused", !(await b.setListValue({ propertyId: visit.ok ? visit.data.id : "", companyId: inList, value: "2026-13-01" })).ok);
    await b.setListValue({ propertyId: seats.ok ? seats.data.id : "", companyId: inList, value: "1,200" });
    const read = await b.getListBoard(wb.id, [inList]);
    ok("  and read back as kept", read?.values[inList]?.[outcome!.id] === outcome!.options[0]!.id && read?.values[inList]?.[seats.ok ? seats.data.id : ""] === 1200, read?.values[inList]);
    await b.setListValue({ propertyId: seats.ok ? seats.data.id : "", companyId: inList, value: "" });
    ok("  emptied, it goes", (await db.workbookValue.count({ where: { propertyId: seats.ok ? seats.data.id : "", companyId: inList } })) === 0);
    await b.updateListProperty({ id: outcome!.id, options: [outcome!.options[1]] });
    ok("a choice taken away reads as empty", (await b.getListBoard(wb.id, [inList]))?.values[inList]?.[outcome!.id] === undefined);

    section("Added by hand");
    const pin = await b.pinListRow(wb.id, outside);
    ok("a company added by hand", pin.ok);
    const rows = await ws.runWorkbook({ filters: { city: [city] }, page: 1, pageSize: 50, workbookId: wb.id });
    ok("  is in the list's rows, beside the filters' one", rows.rows.some((r) => r.id === outside) && rows.rows.some((r) => r.id === inList), rows.rows.map((r) => r.name));
    ok("  and a builder's preview (no list id) is its filters alone", !(await ws.runWorkbook({ filters: { city: [city] }, page: 1, pageSize: 50 })).rows.some((r) => r.id === outside));
    ok("  now takes values", (await b.setListValue({ propertyId: visit.ok ? visit.data.id : "", companyId: outside, value: "2026-11-25" })).ok);
    ok("  and is marked as added by hand", (await b.getListValues(wb.id, [outside])).pinned.includes(outside));
    as(other);
    ok("somebody it isn't assigned to can't add companies", !(await b.pinListRow(wb.id, inList)).ok);
    as(admin);

    section("Views");
    const textOnly = await b.addListProperty({ workbookId: wb.id, name: "Note", kind: "TEXT" });
    ok("a board needs a Select column", !(await b.addListView({ workbookId: wb.id, name: "By note", kind: "BOARD", propertyId: textOnly.ok ? textOnly.data.id : "" })).ok);
    const board = await b.addListView({ workbookId: wb.id, name: "By outcome", kind: "BOARD", propertyId: outcome!.id });
    ok("  a board by Outcome added", board.ok);
    ok("a calendar needs a Date column", !(await b.addListView({ workbookId: wb.id, name: "Cal", kind: "CALENDAR", propertyId: outcome!.id })).ok && (await b.addListView({ workbookId: wb.id, name: "Visits", kind: "CALENDAR", propertyId: visit.ok ? visit.data.id : "" })).ok);
    await b.deleteListProperty(outcome!.id);
    const after = await db.workbookView.findUnique({ where: { id: board.ok ? board.data.id : "" }, select: { propertyId: true } });
    ok("deleting the column leaves the board a plain table — and its values go", after?.propertyId === null && (await db.workbookValue.count({ where: { propertyId: outcome!.id } })) === 0);

    section("Row pages");
    const saved = await b.saveRowPage({ workbookId: wb.id, companyId: inList, notes: "Plant head decides.", checklist: [{ text: "Call" }, { text: "" }] });
    ok("notes and a checklist saved", saved.ok && saved.data.checklist.length === 1);
    ok("  read back", (await b.getRowPage(wb.id, inList))?.notes === "Plant head decides.");
    await b.unpinListRow(wb.id, outside);
    ok("taken off the list, a company added by hand has no page there", (await b.getRowPage(wb.id, outside)) === null && !(await b.saveRowPage({ workbookId: wb.id, companyId: outside, notes: "x" })).ok);

    section("A private list");
    await db.workbook.update({ where: { id: wb.id }, data: { shared: false } });
    as(other);
    ok("somebody else can't open it, or write in it", (await b.getListBoard(wb.id, [inList])) === null && !(await b.setListValue({ propertyId: visit.ok ? visit.data.id : "", companyId: inList, value: "2026-11-26" })).ok);
    as(admin);
  } finally {
    await db.workbook.deleteMany({ where: { id: { in: workbooks } } });
    await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
  }

  console.log(failures === 0 ? `\nAll ${passes} Smart List board checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
