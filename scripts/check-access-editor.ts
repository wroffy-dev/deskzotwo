/**
 * check:access-editor — the role editor's record grid (src/actions/access-levels.ts), phase 2 of
 * docs/permission-redesign.md. The grid is drawn by Settings › Access Control › Data Scope
 * (src/app/(dashboard)/settings/access/scope/page.tsx), rendered here for the role as each of them sees it.
 *
 * A probe role with one member, and three people to drive the editor: an admin who reaches every
 * record and may change roles, a manager who may change roles but reaches only their team's accounts,
 * and a reviewer who may only look. It proves:
 *
 *   · the grid reads every record type, every cell following its permissions until somebody chooses;
 *   · a saved level is what the role's members then reach, and "back to its permissions" removes it;
 *   · the grid's own rules — a level the record type doesn't offer, and Edit, Delete or Assign wider
 *     than the cell above — refuse the whole save, with nothing written;
 *   · the role rules — nobody but a super admin edits Admin, platform support's read-only role is
 *     fixed, a reviewer can't save, and nobody gives a role more than they reach themselves — putting a
 *     cell back to its permissions included, measured on the level that gives (audit M-4);
 *   · every change lands in the permission history, and a member's My access says where it came from.
 *
 *   npm run check:access-editor
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "SALES" };
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actor.id, role: actor.role, name: "Zzprobe Editor", email: `actor${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  // The Data Scope screen is rendered below, with nobody signed in to look: its router does nothing, a refused
  // page says so, and a redirect names where it went.
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/settings/access/scope",
      useSearchParams: () => new URLSearchParams(),
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const ROLE = "ZZPROBE_ED";
const MAIL = "@zzprobe-editor.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const userIds = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.permissionChange.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { subjectRole: ROLE }] } });
  await db.roleAccessLevel.deleteMany({ where: { role: ROLE } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.rolePermission.deleteMany({ where: { role: ROLE } });
  await db.role.deleteMany({ where: { key: ROLE } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const editor = require("../src/actions/access-levels") as typeof import("../src/actions/access-levels");
  const { explainAccess, derivedLevel } = require("../src/lib/authz/access") as typeof import("../src/lib/authz/access");
  // The grid is drawn by Settings › Access Control › Data Scope (src/app/(dashboard)/settings/access/scope/page.tsx
  // → src/components/access-control/scope/data-scope.tsx), which replaced the role dialog's record grid.
  const SCOPE = require("../src/app/(dashboard)/settings/access/scope/page") as typeof import("../src/app/(dashboard)/settings/access/scope/page");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  type Markup = Parameters<typeof renderToStaticMarkup>[0];
  const scopeScreen = async (sp: { role?: string; user?: string; record?: string }) => {
    try {
      return renderToStaticMarkup((await SCOPE.default({ searchParams: Promise.resolve(sp) })) as Markup);
    } catch (err) {
      return `threw: ${(err as Error).message}`;
    }
  };
  /** What a person reads: the markup without its tags, React's text separators or entities. */
  const words = (markup: string) => markup.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
  /** Every reach chip of the "All record types" table, by record and action: its tag, aria-label and all. */
  const chips = (markup: string) => markup.match(/<button[^>]*aria-label="[^"]*, (?:View|Edit|Delete|Assign): [^"]*"[^>]*>/g) ?? [];
  const esc = (t: string) => t.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");
  const chipOf = (markup: string, record: string, action: string) => chips(markup).find((tag) => tag.includes(`aria-label="${esc(record)}, ${action}: `)) ?? "";
  /** The scope tiles of the record and action open on the screen — one per level on offer, and "As its permissions". */
  const tiles = (markup: string) => {
    const group = markup.slice(markup.indexOf('role="radiogroup"'));
    return (group.slice(0, group.indexOf("</div>", group.lastIndexOf('role="radio"'))).match(/<button[^>]*role="radio"[\s\S]*?<\/button>/g) ?? []).map((tile) => ({ tile, label: words(tile.match(/<span class="flex-1[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? ""), on: tile.includes('aria-checked="true"'), disabled: tile.includes('aria-disabled="true"') }));
  };
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    section("The fixture");
    await db.role.create({ data: { key: ROLE, name: "Zzprobe editor role" } });
    const person = (key: string, role: string) =>
      db.user.create({ data: { name: `Zzprobe ${key}`, email: `${key.toLowerCase()}${MAIL}`, role, passwordHash: "x".repeat(60) } });
    const member = await person("Member", ROLE);
    const admin = await person("Admin", "SALES");
    const narrow = await person("Narrow", "SALES");
    const reviewer = await person("Reviewer", "SALES");
    const grant = (userId: string, permission: string, allowed = true) =>
      db.userPermission.create({ data: { userId, permission, allowed, reason: ROLE } });
    // What each needs, by name, whatever this database's SALES role holds.
    for (const key of ["permissions.manage", "permissions.view", "companies.viewAll", "contacts.view", "leads.view", "orders.view", "documents.view", "payments.view"]) {
      await grant(admin.id, key);
    }
    for (const key of ["permissions.manage", "permissions.view", "contacts.view", "leads.view", "orders.view", "documents.view", "payments.view"]) await grant(narrow.id, key);
    await grant(narrow.id, "companies.viewAll", false);
    await grant(reviewer.id, "permissions.view");
    await grant(reviewer.id, "permissions.manage", false);
    // The probe role holds "View documents" and nothing that widens accounts.
    await db.rolePermission.create({ data: { role: ROLE, permission: "documents.view", allowed: true } });
    await db.rolePermission.create({ data: { role: ROLE, permission: "companies.viewAll", allowed: false } });
    ok("a probe role with a member, an admin, a narrow manager and a reviewer", true);

    section("Reading the grid");
    actor = { id: admin.id, role: "SALES" };
    const grid = await editor.roleAccessLevels(ROLE);
    ok("every record type is a row", grid?.rows.length === 13, grid?.rows.map((r) => r.key).join(", "));
    ok("nothing is stored until somebody chooses", !!grid && grid.rows.every((r) => Object.values(r.cells).every((c) => c.stored === null)));
    const docs = grid?.rows.find((r) => r.key === "documents");
    ok("documents follow the account, from \"View documents\"", docs?.cells.view.derived === "FOLLOW" && docs.cells.view.derivedFrom.held === true, docs?.cells.view.derived);
    const accounts = grid?.rows.find((r) => r.key === "companies");
    ok("customers are the team's, without \"See all companies\"", accounts?.cells.view.derived === "TEAM", accounts?.cells.view.derived);
    ok("contacts offer none, as the account, or all", JSON.stringify(grid?.rows.find((r) => r.key === "contacts")?.levels) === JSON.stringify(["NONE", "FOLLOW", "ALL"]));
    ok("the admin may edit it", grid?.editable === true, grid?.why ?? "");
    // The grid as Data Scope draws it for the role — nobody signs in to look, so the HTML is the proof.
    const html = await scopeScreen({ role: ROLE, record: "companies" });
    ok("the grid draws a choice for every cell (vendors and tickets have no delete scope)", chips(html).length === 44, chips(html).length || html.slice(0, 200));
    const accountsView = chipOf(html, accounts?.label ?? "companies", "View");
    const docsView = chipOf(html, grid?.rows.find((r) => r.key === "documents")?.label ?? "documents", "View");
    ok(
      "...each starting at its permissions, saying what that is",
      chips(html).every((tag) => tag.includes("border-dashed")) &&
        accountsView.includes(': Team"') && /Doesn&#x27;t hold &quot;.+?&quot;, so team\./.test(accountsView) &&
        docsView.includes(': As the account"') && /Holds &quot;.+?&quot;, so as the account\./.test(docsView) &&
        tiles(html).some((t) => t.label === "As its permissions" && t.on && words(t.tile).includes("Team")),
      `${accountsView.match(/title="[^"]*"/)?.[0] ?? "no Customers chip"} | ${tiles(html).map((t) => `${t.label}${t.on ? "*" : ""}`).join(", ")}`,
    );
    const contactTiles = tiles(await scopeScreen({ role: ROLE, record: "contacts" })).map((t) => t.label);
    ok("...and contacts offer only none, as the account, or all", contactTiles.join() === "As its permissions,None,As the account,All", contactTiles.join(", "));
    ok("...with Save changes for the admin, and nothing staged yet", /<button[^>]*disabled=""[^>]*>(?:<svg[\s\S]*?<\/svg>)?Save changes<\/button>/.test(html) && !html.includes("unsaved change") && !html.includes("review"), words(html).match(/.{0,60}Save changes.{0,20}/)?.[0] ?? "no Save changes");

    section("Saving");
    const saved = await editor.setRoleAccessLevels(ROLE, [{ record: "documents", action: "view", level: "OWN" }, { record: "documents", action: "edit", level: "OWN" }]);
    ok("documents: View and Edit set to Own", saved.ok && saved.data.changed === 2, saved.ok ? saved.data.changed : saved.error);
    ok("...and the member now reaches their own documents only", (await explainAccess(member.id, "documents", "view")).level === "OWN");
    ok("...set on their role", (await explainAccess(member.id, "documents", "view")).source.via === "roleLevel");
    const history = await db.permissionChange.findMany({ where: { subjectRole: ROLE, permission: { startsWith: "access:documents" } } });
    ok("both changes are in the permission history", history.length === 2, history.map((h) => h.detail).join(" | "));
    const again = await editor.setRoleAccessLevels(ROLE, [{ record: "documents", action: "view", level: "OWN" }]);
    ok("saving what is already saved writes nothing", again.ok && again.data.changed === 0);
    const narrower = await editor.setRoleAccessLevels(ROLE, [{ record: "documents", action: "edit", level: "FOLLOW" }]);
    ok("Edit \"as the account\" under View \"Own\" is a narrowing, and allowed", narrower.ok, narrower.ok ? "" : narrower.error);
    const reset = await editor.setRoleAccessLevels(ROLE, [{ record: "documents", action: "view", level: null }, { record: "documents", action: "edit", level: null }]);
    ok("both back to following its permissions", reset.ok && reset.data.changed === 2, reset.ok ? "" : reset.error);
    ok("...the rows are gone", (await db.roleAccessLevel.count({ where: { role: ROLE } })) === 0);
    ok("...and the member follows the account again", (await explainAccess(member.id, "documents", "view")).level === "FOLLOW");
    ok("...which the history records as a reset", (await db.permissionChange.count({ where: { subjectRole: ROLE, changeKind: "RESET_TO_DEFAULT" } })) === 2);

    section("One switch for deleting payments");
    const holds = (...keys: string[]) => (k: string) => keys.includes(k);
    ok("with \"Delete payments\", the Delete row starts as the account", derivedLevel("payments", "delete", holds("payments.view", "payments.delete")).level === "FOLLOW");
    ok("...without it, none — viewing payments alone deletes nothing", derivedLevel("payments", "delete", holds("payments.view")).level === "NONE");
    ok("...and View still follows the account either way", derivedLevel("payments", "view", holds("payments.view")).level === "FOLLOW");

    section("The grid's own rules, all or nothing");
    const offered = await editor.setRoleAccessLevels(ROLE, [{ record: "leads", action: "view", level: "ALL" }, { record: "contacts", action: "view", level: "OWN" }]);
    ok("a level contacts don't offer is refused", !offered.ok && offered.error.includes("Contacts"), offered.ok ? "it saved" : offered.error);
    ok("...and the leads change beside it wasn't written either", (await db.roleAccessLevel.count({ where: { role: ROLE } })) === 0);
    const tooWide = await editor.setRoleAccessLevels(ROLE, [{ record: "companies", action: "edit", level: "ALL" }]);
    ok("Edit All over View Team is refused", !tooWide.ok && tooWide.error.includes("can't be wider than View"), tooWide.ok ? "it saved" : tooWide.error);
    const overFollow = await editor.setRoleAccessLevels(ROLE, [{ record: "orders", action: "delete", level: "ALL" }]);
    ok("Delete All over Edit \"as the account\" is refused", !overFollow.ok && overFollow.error.includes("can't be wider than Edit"), overFollow.ok ? "it saved" : overFollow.error);
    const unknown = await editor.setRoleAccessLevels(ROLE, [{ record: "notes", action: "view", level: "ALL" }]);
    ok("a record type the grid doesn't have is refused", !unknown.ok);
    const absent = await editor.setRoleAccessLevels(ROLE, [{ record: "projects", action: "delete", level: "OWN" }]);
    ok("an action a record doesn't have is refused — projects have no delete", !absent.ok && absent.error.includes("has no delete"), absent.ok ? "it saved" : absent.error);

    section("Who may save what");
    actor = { id: reviewer.id, role: "SALES" };
    const asReviewer = await editor.roleAccessLevels(ROLE);
    ok("a reviewer reads the grid", (asReviewer?.rows.length ?? 0) === 13);
    ok("...not editable, and says why", asReviewer?.editable === false && (asReviewer.why ?? "").includes("review"), asReviewer?.why);
    const reviewerScreen = await scopeScreen({ role: ROLE, record: "companies" });
    ok(
      "...which Data Scope shows them: the reason, every scope tile off, no Save",
      words(reviewerScreen).includes(asReviewer?.why ?? "no reason") && tiles(reviewerScreen).length > 0 && tiles(reviewerScreen).every((t) => t.disabled) && !reviewerScreen.includes("Save changes") && !reviewerScreen.includes("Save scope") && chips(reviewerScreen).length === 44,
      `${tiles(reviewerScreen).filter((t) => !t.disabled).map((t) => t.label).join(", ") || "tiles off"} · ${reviewerScreen.includes("Save") ? "a Save is drawn" : "no Save"}`,
    );
    const reviewerSave = await editor.setRoleAccessLevels(ROLE, [{ record: "leads", action: "view", level: "NONE" }]);
    ok("...and can't save", !reviewerSave.ok);
    actor = { id: member.id, role: ROLE };
    ok("somebody who may not review access is refused the screen itself", (await scopeScreen({ role: ROLE })) === "threw: NEXT_NOT_FOUND", (await scopeScreen({ role: ROLE })).slice(0, 80));
    actor = { id: narrow.id, role: "SALES" };
    const beyond = await editor.setRoleAccessLevels(ROLE, [{ record: "companies", action: "view", level: "ALL" }]);
    ok("a manager who reaches their team's accounts can't give a role all of them", !beyond.ok && beyond.error.includes("yourself"), beyond.ok ? "it saved" : beyond.error);
    const viewOnly = await editor.setRoleAccessLevels(ROLE, [{ record: "companies", action: "view", level: "OWN" }]);
    ok("...narrowing View alone, with Edit still the team's, is refused", !viewOnly.ok && viewOnly.error.includes("can't be wider than View"), viewOnly.ok ? "it saved" : viewOnly.error);
    const own = (["view", "edit", "delete", "assign"] as const).map((action) => ({ record: "companies", action, level: "OWN" as const }));
    const within = await editor.setRoleAccessLevels(ROLE, own);
    ok("...all four to Own — what the grid sends when View is narrowed — goes through", within.ok, within.ok ? "" : within.error);
    const adminRole = await editor.setRoleAccessLevels("ADMIN", [{ record: "leads", action: "view", level: "OWN" }]);
    ok("nobody but a super admin edits Admin", !adminRole.ok && adminRole.error.includes("super admin"), adminRole.ok ? "it saved" : adminRole.error);
    const support = await editor.setRoleAccessLevels("SUPPORT_READONLY", [{ record: "leads", action: "view", level: "NONE" }]);
    ok("platform support's read-only role is fixed", !support.ok, support.ok ? "it saved" : support.error);
    ok("no Admin or support row was written", (await db.roleAccessLevel.count({ where: { role: { in: ["ADMIN", "SUPPORT_READONLY"] } } })) === 0);

    section("What the member is told");
    actor = { id: member.id, role: ROLE };
    const mine = await editor.personAccessLevels(member.id);
    const companiesRow = mine?.find((r) => r.key === "companies");
    ok("My access shows the level set on their role", companiesRow?.cells.view.level === "OWN" && companiesRow.cells.view.why.includes("role"), companiesRow?.cells.view.why);
    ok("...and where the rest comes from", mine?.find((r) => r.key === "documents")?.cells.view.why.includes("which they hold") === true, mine?.find((r) => r.key === "documents")?.cells.view.why);
    ok("somebody else's is not theirs to read", (await editor.personAccessLevels(admin.id)) === null);

    section("Putting a cell back is held to the same reach");
    // Audit M-4 (2 Nov 2026): "back to its permissions" gives the role its derived level, which can be wider
    // than the admin's own reach — so a reset is measured on what the role reaches afterwards, like a save.
    // The probe role's customers are all four Own (above); with "See all companies" its permissions say All.
    await db.rolePermission.update({ where: { role_permission: { role: ROLE, permission: "companies.viewAll" } }, data: { allowed: true } });
    const backToAll = (["view", "edit", "delete", "assign"] as const).map((action) => ({ record: "companies", action, level: null }));
    actor = { id: narrow.id, role: "SALES" };
    const narrowReset = await editor.setRoleAccessLevels(ROLE, backToAll);
    ok("a manager who reaches their team's accounts can't put the role back to its permissions, which say All", !narrowReset.ok && narrowReset.error.includes("yourself"), narrowReset.ok ? "it saved" : narrowReset.error);
    ok("...nothing was written: the role still reaches its own accounts", (await db.roleAccessLevel.count({ where: { role: ROLE, record: "companies", level: "OWN" } })) === 4 && (await explainAccess(member.id, "companies", "view")).level === "OWN");
    actor = { id: admin.id, role: "SALES" };
    const adminReset = await editor.setRoleAccessLevels(ROLE, backToAll);
    ok("an admin who reaches every account may", adminReset.ok && adminReset.data.changed === 4 && (await explainAccess(member.id, "companies", "view")).level === "ALL", adminReset.ok ? adminReset.data.changed : adminReset.error);
    await db.rolePermission.update({ where: { role_permission: { role: ROLE, permission: "companies.viewAll" } }, data: { allowed: false } });
    actor = { id: narrow.id, role: "SALES" };
    const toOwn = await editor.setRoleAccessLevels(ROLE, (["view", "edit", "delete", "assign"] as const).map((action) => ({ record: "companies", action, level: "OWN" as const })));
    const withinReset = toOwn.ok ? await editor.setRoleAccessLevels(ROLE, backToAll) : toOwn;
    ok("...and the manager may put it back where its permissions say Team, which they reach", withinReset.ok && withinReset.data.changed === 4 && (await explainAccess(member.id, "companies", "view")).level === "TEAM", withinReset.ok ? withinReset.data.changed : withinReset.error);
  } finally {
    await cleanup();
    const left = (await db.user.count({ where: { email: { endsWith: MAIL } } })) + (await db.role.count({ where: { key: ROLE } })) + (await db.roleAccessLevel.count({ where: { role: ROLE } }));
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll access-editor checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
