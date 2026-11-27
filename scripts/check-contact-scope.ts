/**
 * check:contact-scope — the people at an account are read at the Contacts record level as well as with
 * `contacts.view` (owner, 3 Nov 2026 — Phase 2 permission fixes; DESKZO_PERMISSION_SYSTEM_AUDIT.md H-4).
 *
 * The role editor's advice for a role whose leads hide their contact's email and phone is "Set Contacts to None"
 * (src/actions/field-access.ts `roleWarnings`). These paths asked only the permission, so it closed nothing there:
 *
 *   · the company page's Contacts tab and `getCompany`'s contacts;
 *   · the public API's company and contact reads (src/lib/api/v1/companies.ts `readCompany`, `getContactApi`);
 *   · the app's company (src/lib/app/sales.ts `appCompany`);
 *   · the dialler's numbers (src/actions/call.ts `listCompanyNumbers`), which asked `calls.view` alone;
 *   · a document's recipients (src/lib/documents/send-email.ts `recipientsFor`, `prepareDocumentSend`), which
 *     asked nothing.
 *
 * Each is driven at None, at Own and Team (which contacts don't offer, so a stored one answers None), and at the
 * wider levels — "as far as the account" and All — through the real role editor where the editor can set it, and
 * with the permission taken away under a wide level. The company itself is still the company rule's: a level
 * on contacts never opens an account the person can't see.
 *
 * The real actions with the session, `next/cache` and mail stood in for. Fixtures are ZZCSCOPE /
 * @zzcscope-check.invalid and removed before and after, pass or fail; the super admin is borrowed as the role
 * editor's actor and never changed.
 *
 *   npm run check:contact-scope
 */
import "dotenv/config";
import Module from "node:module";
import type { ReactElement } from "react";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";

const TAG = "ZZCSCOPE";
const MAIL = "@zzcscope-check.invalid";
const ROLE = `${TAG}_REP`;
const NOT_A_CONTACT = "One of those people isn't a contact of this customer.";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

// ─── Stand-ins ───────────────────────────────────────────────────────────────────────────────────
type Person = { id: string; name: string; email: string; role: string };
let actor: Person | null = null;
const stubHits = { session: 0 };
const requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:contact-scope", "x-forwarded-for": "198.51.100.83" });
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") return { headers: async () => requestHeaders, cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("NOT_FOUND_CALLED");
      },
      redirect: (to: string) => {
        throw new Error(`REDIRECT_CALLED ${to}`);
      },
      permanentRedirect: (to: string) => {
        throw new Error(`REDIRECT_CALLED ${to}`);
      },
      useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} }),
      usePathname: () => "/companies",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    stubHits.session += 1;
    class UnauthorizedError extends Error {}
    return {
      UnauthorizedError,
      requireUser: async () => {
        if (!actor) throw new UnauthorizedError("signed out");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  if (request === "@/lib/auth") {
    return { auth: async () => (actor ? { user: actor, expires: "" } : null), signIn: async () => {}, signOut: async () => {}, handlers: {} };
  }
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  if (request === "@/actions/view-mode") return { getViewMode: async () => "list" as const, setViewMode: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const COMPANY = require("../src/actions/company") as typeof import("../src/actions/company");
  const CALL = require("../src/actions/call") as typeof import("../src/actions/call");
  const API = require("../src/lib/api/v1/companies") as typeof import("../src/lib/api/v1/companies");
  const APP = require("../src/lib/app/sales") as typeof import("../src/lib/app/sales");
  const SEND = require("../src/lib/documents/send-email") as typeof import("../src/lib/documents/send-email");
  const LEVELS = require("../src/actions/access-levels") as typeof import("../src/actions/access-levels");
  const { ApiError } = require("../src/lib/api/handler") as typeof import("../src/lib/api/handler");
  const { findTradeDocumentFor } = require("../src/lib/documents/load") as typeof import("../src/lib/documents/load");
  const { accessLevel } = require("../src/lib/authz/access") as typeof import("../src/lib/authz/access");
  const { CompanyDetail } = require("../src/components/companies/company-detail") as typeof import("../src/components/companies/company-detail");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup(db);
  try {
    section("Set-up");
    ok("the session stand-in is the one the actions load", stubHits.session > 0);
    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true, role: true, active: true, managerId: true } });
    ok("there is a super admin to borrow as the role editor's actor (never changed)", superAdmin !== null);
    if (!superAdmin) return;

    // A role of the suite's own, holding nothing but the sections, so the role editor's levels on it are the only ones
    // in play and no built-in role is touched. What each person may do is granted to them by name below.
    await db.role.create({ data: { key: ROLE, name: `${TAG} Rep`, isSystem: false } });
    const mk = async (name: string, grants: Record<string, boolean>) => {
      const u = await db.user.create({
        data: {
          name: `${TAG} ${name}`,
          email: `${name.toLowerCase()}${MAIL}`,
          role: ROLE,
          passwordHash: "zz-fixture-placeholder",
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
        select: { id: true, name: true, email: true, role: true },
      });
      return u;
    };
    // Works the people at their own accounts: sees contacts, dials them, mails them documents.
    const works = { "contacts.view": true, "contacts.directory": true, "calls.view": true, "documents.view": true, "documents.send": true };
    const rep = await mk("Rep", works);
    // The same, but without `contacts.view` — the permission is still asked under a wide level.
    const nokey = await mk("Nokey", { ...works, "contacts.view": false });
    // Whose account the other one is: in nobody's book here but their own.
    const other = await mk("Other", {});

    const account = (name: string, ownerUserId: string) =>
      db.company.create({
        data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: superAdmin.id, ownerUserId, relationshipType: "CLIENT", stage: "CUSTOMER" },
        select: { id: true, name: true, companySeq: true },
      });
    // Their own account (the company rule lets them in), and somebody else's (it doesn't).
    const mine = await account("Mine", rep.id);
    const theirs = await account("Theirs", other.id);
    // Nokey reaches Rep's account too, as Rep's manager: Companies is Team for both (no "See all companies").
    await db.user.update({ where: { id: rep.id }, data: { managerId: nokey.id } });
    const person = (companyId: string, name: string, extra: Record<string, unknown> = {}) =>
      db.contact.create({ data: { companyId, name: `${TAG} ${name}`, email: `${name.toLowerCase()}${MAIL}`, phone: "+919800000000", ...extra }, select: { id: true, name: true } });
    const asha = await person(mine.id, "Asha", { isPrimary: true, receivesDocuments: true });
    const ravi = await person(mine.id, "Ravi");
    const bina = await person(theirs.id, "Bina", { isPrimary: true });
    const invoice = await db.tradeDocument.create({
      data: { docNumber: `${TAG}-INV-${Date.now().toString(36)}`, docType: "INVOICE", direction: "SALES", status: "ISSUED", approvalStatus: "APPROVED", companyId: mine.id, createdById: rep.id, issueDate: new Date("2026-10-01T00:00:00Z") },
      select: { id: true },
    });
    ok("an account of Rep's with two people and an issued invoice, and somebody else's account with one", !!asha.id && !!ravi.id && !!bina.id && !!invoice.id);

    // ── How each path answers, for one person ──────────────────────────────────────────────────────────────────
    const as = (u: Person) => {
      actor = u;
    };
    const idsOf = (rows: unknown): string[] => (Array.isArray(rows) ? rows.map((r) => String((r as { id: unknown }).id)).sort() : []);
    const apiCall = (u: Person, ref: string) => {
      const url = new URL(`http://deskzo.localhost:3000/api/v1/x/${ref}`);
      return {
        req: new Request(url),
        url,
        params: { ref },
        actor: { userId: u.id, name: u.name, email: u.email, role: u.role, keyId: `${TAG}-key`, keyName: `${TAG} key`, scopes: [] },
        body: async () => ({}),
      };
    };
    const status = (err: unknown) => (err instanceof ApiError ? err.status : `threw: ${err instanceof Error ? err.message : String(err)}`);
    const page = async (companyId: string) => {
      try {
        const html = renderToStaticMarkup((await CompanyDetail({ id: companyId, tab: "contacts" })) as ReactElement);
        return { tab: html.includes("tab=contacts"), names: [asha, ravi].filter((c) => html.includes(c.name)).length, error: null as string | null };
      } catch (err) {
        return { tab: false, names: 0, error: err instanceof Error ? err.message : String(err) };
      }
    };
    const observe = async (u: Person) => {
      as(u);
      const company = (await COMPANY.getCompany(mine.id)) as { contacts?: unknown } | null;
      const tab = await page(mine.id);
      const api = await API.readCompany(u.id, mine.id).then(
        (r) => ({ found: true, contacts: idsOf(r.contacts) }),
        (err: unknown) => ({ found: false, contacts: [] as string[], status: status(err) }),
      );
      const apiContact = await API.getContactApi(apiCall(u, asha.id) as never).then(
        () => 200,
        (err: unknown) => status(err),
      );
      const app = await APP.appCompany({ ...apiCall(u, mine.id), device: {} } as never).then(
        (r) => ({ found: true, contacts: idsOf((r.data as { contacts?: unknown }).contacts) }),
        (err: unknown) => ({ found: false, contacts: [] as string[], status: status(err) }),
      );
      const dialler = idsOf(await CALL.listCompanyNumbers(mine.id));
      const recipients = idsOf(await SEND.recipientsFor(mine.id, u.id));
      const doc = await findTradeDocumentFor(u.id, invoice.id);
      const send = doc ? await SEND.prepareDocumentSend(u, doc, { contactIds: [asha.id], subject: "Your invoice", body: "Attached." }) : null;
      return {
        company: company === null ? null : idsOf(company.contacts),
        tab,
        api,
        apiContact,
        app,
        dialler,
        recipients,
        sendRefusedAsStranger: send !== null && !send.ok && send.error === NOT_A_CONTACT,
        sendError: send === null ? "no document" : send.ok ? "ok" : send.error,
      };
    };
    const both = [asha.id, ravi.id].sort();
    const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

    /** Every path serves exactly the account's two people. */
    const serves = (label: string, seen: Awaited<ReturnType<typeof observe>>) => {
      ok(`${label}: getCompany carries the account's people`, seen.company !== null && same(seen.company, both), seen.company);
      ok(`${label}:   the company page has its Contacts tab, naming them`, seen.tab.tab && seen.tab.names === 2, seen.tab);
      ok(`${label}:   the API's company carries them`, seen.api.found && same(seen.api.contacts, both), seen.api);
      ok(`${label}:   the API reads one of them`, seen.apiContact === 200, seen.apiContact);
      ok(`${label}:   the app's company carries them`, seen.app.found && same(seen.app.contacts, both), seen.app);
      ok(`${label}:   the dialler offers their numbers`, same(seen.dialler, both), seen.dialler);
      ok(`${label}:   a document's recipients are them`, same(seen.recipients, both), seen.recipients);
      ok(`${label}:   and sending it to one gets past who it goes to`, !seen.sendRefusedAsStranger && seen.sendError !== "no document", seen.sendError);
    };
    /** Every path leaves the people out, while the company itself still opens. */
    const withholds = (label: string, seen: Awaited<ReturnType<typeof observe>>) => {
      ok(`${label}: getCompany still opens the account, with nobody in it`, seen.company !== null && seen.company.length === 0, seen.company);
      ok(`${label}:   the company page has no Contacts tab and names nobody`, seen.tab.error === null && !seen.tab.tab && seen.tab.names === 0, seen.tab);
      ok(`${label}:   the API's company opens with no contacts`, seen.api.found && seen.api.contacts.length === 0, seen.api);
      ok(`${label}:   the API answers one of them as not found`, seen.apiContact === 404, seen.apiContact);
      ok(`${label}:   the app's company opens with no contacts`, seen.app.found && seen.app.contacts.length === 0, seen.app);
      ok(`${label}:   the dialler offers no numbers`, seen.dialler.length === 0, seen.dialler);
      ok(`${label}:   a document's recipients are nobody`, seen.recipients.length === 0, seen.recipients);
      ok(`${label}:   and sending it to one is refused as somebody else's contact`, seen.sendRefusedAsStranger, seen.sendError);
    };

    // The role editor, as the super admin uses it: every action of the Contacts row at once, since edit can't be
    // wider than view.
    const editor = async (level: "NONE" | "OWN" | "TEAM" | "FOLLOW" | "ALL" | null) => {
      as(superAdmin);
      return LEVELS.setRoleAccessLevels(ROLE, (["view", "edit", "delete", "assign"] as const).map((action) => ({ record: "contacts", action, level })) as never);
    };
    const personal = async (userId: string, level: "OWN" | "TEAM" | null) => {
      await db.userAccessLevel.deleteMany({ where: { userId, record: "contacts" } });
      if (level) await db.userAccessLevel.createMany({ data: (["view", "edit", "delete", "assign"] as const).map((action) => ({ userId, record: "contacts", action, level, reason: TAG })) });
    };

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("Nothing stored — Contacts follows `contacts.view`: as far as the account");
    ok("Rep's Contacts level is derived: as far as the account", (await accessLevel(rep.id, "contacts", "view")) === "FOLLOW");
    serves("as far as the account", await observe(rep));
    as(rep);
    ok("  and none of somebody else's account's people are a document's recipients", (await SEND.recipientsFor(theirs.id, rep.id)).length === 0);
    ok("  nor its numbers in the dialler", (await CALL.listCompanyNumbers(theirs.id)).length === 0);

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("Contacts = None, set in the role editor");
    const toNone = await editor("NONE");
    ok("the role editor sets the role's Contacts to None", toNone.ok, toNone);
    ok("  and Rep resolves None", (await accessLevel(rep.id, "contacts", "view")) === "NONE");
    withholds("None", await observe(rep));

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("Own and Team — not levels contacts offer");
    const toOwn = await editor("OWN");
    ok("the role editor refuses Own for Contacts", !toOwn.ok && /can't be set to/.test(toOwn.error), toOwn);
    const toTeam = await editor("TEAM");
    ok("  and Team", !toTeam.ok && /can't be set to/.test(toTeam.error), toTeam);
    // Back to nothing stored on the role, so only the person's row is in play.
    const reset = await editor(null);
    ok("  (the role put back to following its permissions)", reset.ok && (await accessLevel(rep.id, "contacts", "view")) === "FOLLOW", reset);
    // A row the editor would never write, stored for the person straight: it fails closed.
    await personal(rep.id, "OWN");
    ok("Own stored for Rep straight in the table answers None", (await accessLevel(rep.id, "contacts", "view")) === "NONE");
    withholds("Own", await observe(rep));
    await personal(rep.id, "TEAM");
    ok("Team stored the same way answers None", (await accessLevel(rep.id, "contacts", "view")) === "NONE");
    withholds("Team", await observe(rep));
    await personal(rep.id, null);

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("Wider levels, set in the role editor");
    const toFollow = await editor("FOLLOW");
    ok("the role editor sets Contacts to as far as the account", toFollow.ok, toFollow);
    serves("as far as the account (stored)", await observe(rep));
    as(rep);
    ok("  still none of somebody else's account's people", (await SEND.recipientsFor(theirs.id, rep.id)).length === 0);

    const toAll = await editor("ALL");
    ok("the role editor sets Contacts to All", toAll.ok, toAll);
    serves("All", await observe(rep));
    as(rep);
    ok("  a document's recipients at somebody else's account are its people now", same(idsOf(await SEND.recipientsFor(theirs.id, rep.id)), [bina.id]));
    ok("  but that account's numbers stay the company rule's: the dialler offers none", (await CALL.listCompanyNumbers(theirs.id)).length === 0);
    ok("  nor does its page open", (await COMPANY.getCompany(theirs.id)) === null);

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("Contacts = All, but without `contacts.view`");
    ok("Nokey resolves All from the role", (await accessLevel(nokey.id, "contacts", "view")) === "ALL");
    const nokeySees = await observe(nokey);
    ok("Nokey reaches the account itself", nokeySees.company !== null, nokeySees.company);
    withholds("All without contacts.view", nokeySees);

    const back = await editor(null);
    ok("the role is put back to following its permissions", back.ok, back);
    actor = null;
    ok("the super admin is exactly as found", JSON.stringify(await db.user.findUniqueOrThrow({ where: { id: superAdmin.id }, select: { id: true, name: true, email: true, role: true, active: true, managerId: true } })) === JSON.stringify(superAdmin));
  } finally {
    actor = null;
    await cleanup(db);
    const left = await Promise.all([
      db.user.count({ where: { email: { endsWith: MAIL } } }),
      db.company.count({ where: { name: { startsWith: TAG } } }),
      db.contact.count({ where: { name: { startsWith: TAG } } }),
      db.tradeDocument.count({ where: { docNumber: { startsWith: TAG } } }),
      db.role.count({ where: { key: ROLE } }),
      db.permissionChange.count({ where: { subjectRole: ROLE } }),
    ]);
    ok("nothing of the suite's is left behind", left.every((n) => n === 0), left);
    await db.$disconnect?.();
  }
  console.log(failures === 0 ? `\nAll ${passes} contact-scope checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  if (failures) process.exitCode = 1;
}

async function cleanup(db: typeof import("../src/lib/db").db) {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.user.updateMany({ where: { id: { in: ids } }, data: { managerId: null } });
  await db.tradeDocument.deleteMany({ where: { OR: [{ docNumber: { startsWith: TAG } }, { companyId: { in: companies } }] } });
  await db.contact.deleteMany({ where: { companyId: { in: companies } } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: companies } }] } });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.permissionChange.deleteMany({ where: { OR: [{ subjectRole: ROLE }, { actorUserId: { in: ids } }, { subjectUserId: { in: ids } }] } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.userAccessLevel.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.roleAccessLevel.deleteMany({ where: { role: ROLE } });
  await db.rolePermission.deleteMany({ where: { role: ROLE } });
  await db.role.deleteMany({ where: { key: ROLE } });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
