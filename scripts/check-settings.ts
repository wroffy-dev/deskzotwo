/**
 * Whether the settings catalogue tells the truth.
 *
 * `src/lib/settings/catalogue.ts` is the only list of settings in the app: the index of grouped
 * cards and the sidebar are both renderings of it. That makes it load-bearing in a way a menu
 * usually is not, and it fails in ways nobody notices:
 *
 *   · **A key that does not exist.** `mayOpen` asks whether the person holds the named permission.
 *     An unheld key and a misspelt key are indistinguishable, so "accounting.manage" — which is not
 *     a permission in this app — hid the chart of accounts from everybody including a super admin,
 *     silently, and would have gone on doing so.
 *   · **A key the destination does not test.** Backups was listed under `settings.manage` while the
 *     page required `backups.manage`: offered to people it would refuse, hidden from the one person
 *     the key exists for. That is the invitation-to-a-locked-door problem, in both directions at
 *     once.
 *   · **A link to nothing**, after a route is renamed.
 *   · **A page reachable from nowhere**, after one is added — which is how the previous navigation
 *     ended up listing six of the fourteen settings screens.
 *
 *   npm run check:settings
 *
 * Pure: the catalogue, the permission registry and the page sources are all read off disk.
 */
import fs from "node:fs";
import path from "node:path";
import { SETTINGS, SETTINGS_ITEMS, mayOpen, activeSettingsKey, visibleSettings, visibleSettingsKeys, settingsForKeys } from "../src/lib/settings/catalogue";
import { firstMatch, searchSettings, searchWords } from "../src/lib/settings/search";
import { PERMISSIONS } from "../src/lib/permissions";
import { MODULE_REGISTRY } from "../src/lib/modules";
import { AC_NAV, AC_ROOT, AC_TOOLS } from "../src/lib/access-control/nav";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

const APP = "src/app/(dashboard)";

/** The file that renders a route, or null when nothing does. */
function pageFor(href: string): string | null {
  const candidate = path.join(APP, href.replace(/^\//, ""), "page.tsx");
  return fs.existsSync(candidate) ? candidate : null;
}

/** Every permission key a page source tests, however it phrases the test. */
const AC_GUARD = "src/lib/access-control/guard.ts";
function gatesIn(source: string, nested = false): string[] {
  const keys = new Set<string>();
  for (const m of source.matchAll(/\bcan\(\s*[A-Za-z0-9_.?!]+\s*,\s*"([^"]+)"/g)) keys.add(m[1]!);
  for (const m of source.matchAll(/hasEffectivePermission\(\s*[A-Za-z0-9_.?!]+\s*,\s*"([^"]+)"/g)) keys.add(m[1]!);
  // A screen of Settings › Access Control asks through the area's own guard (src/lib/access-control/guard.ts),
  // so that every page tests for itself what its layout also tests — a layout isn't run again on navigation.
  // The guard's key is read from its source, not assumed.
  if (/\brequireAccessViewer\(/.test(source) && !nested) for (const key of gatesIn(fs.readFileSync(AC_GUARD, "utf8"), true)) keys.add(key);
  return [...keys];
}

function main() {
  const permissionKeys = new Set(PERMISSIONS.map((p) => p.key));
  const moduleKeys = new Set(MODULE_REGISTRY.map((m) => m.key));

  section("The catalogue is well formed");

  const keys = SETTINGS_ITEMS.map((i) => i.key);
  // Two entries with one key is not a cosmetic slip: the sidebar is rebuilt from keys (`visibleSettingsKeys` →
  // `settingsForKeys`), so each would be drawn for whoever may open the other. Moving Roles & Permissions into
  // Access Control briefly gave its entry the key "Devices, networks & sign-ins" already had; see "the sidebar's
  // keys rebuild exactly what the viewer may open" under Filtering.
  const repeated = [...new Set(keys.filter((k, n) => keys.indexOf(k) !== n))];
  ok("Every entry has a unique key", new Set(keys).size === keys.length, repeated.length ? `repeated: ${repeated.join(", ")}` : `${keys.length} entries`);

  const hrefs = SETTINGS_ITEMS.map((i) => i.href);
  ok("  and a unique destination", new Set(hrefs).size === hrefs.length, `${new Set(hrefs).size} routes`);

  ok(
    "  a label and a description each",
    SETTINGS_ITEMS.every((i) => i.label.trim().length > 0 && i.description.trim().length > 0),
  );

  // A description that just restates the label tells a reader nothing they did not already see.
  const lazy = SETTINGS_ITEMS.filter((i) => i.description.toLowerCase().trim() === i.label.toLowerCase().trim());
  ok("  and the description says something the label does not", lazy.length === 0, lazy.map((i) => i.key).join(", "));

  section("Every key is a real key");

  for (const item of SETTINGS_ITEMS) {
    if (item.permission === null) continue;
    const named = Array.isArray(item.permission) ? item.permission : [item.permission];
    for (const key of named) {
      /**
       * A prefix is checked against the registry too, by asking whether anything starts with it.
       * `data.` is not a key, but ten keys begin with it; a typo like `dta.` matches none and would
       * otherwise hide Import & export from everybody.
       */
      const real = item.permissionPrefix
        ? [...permissionKeys].some((k) => k.startsWith(key))
        : permissionKeys.has(key);
      ok(`${item.key} → ${key}`, real, real ? "" : "no such permission");
    }
  }

  section("Every module named is a real module");

  for (const item of SETTINGS_ITEMS.filter((i) => i.module)) {
    // One module, or several of which any will do.
    const named: readonly string[] = typeof item.module === "string" ? [item.module] : item.module!;
    ok(`${item.key} → ${named.join(" | ")}`, named.length > 0 && named.every((key) => moduleKeys.has(key)));
  }

  section("Every destination exists");

  for (const item of SETTINGS_ITEMS) {
    const file = pageFor(item.href);
    ok(`${item.key} → ${item.href}`, file !== null, file ?? "no page renders this route");
  }

  section("Every settings page is reachable");

  const settingsDir = path.join(APP, "settings");
  const routes = fs
    .readdirSync(settingsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(settingsDir, e.name, "page.tsx")))
    .map((e) => `/settings/${e.name}`);

  // Retired pages that only send an old link on to where it moved, and render nothing of their own:
  // Roles & Permissions and Unmasking logs both moved into Settings › Access Control (`/settings/access`,
  // which was itself the retired page here until it became that area's Overview — and is in the catalogue).
  const RETIRED = new Set(["/settings/roles", "/settings/unmasking-logs"]);
  ok("the retired pages are still there to send an old link on", [...RETIRED].every((r) => routes.includes(r)), [...RETIRED].filter((r) => !routes.includes(r)).join(", "));
  // The same for the retired pages a level down, which the loop below never reaches: the old permission
  // matrix, the older person-access page and the older Add staff page.
  for (const nested of ["roles/matrix", "access/users/[id]", "access/new"]) {
    const file = path.join(settingsDir, nested, "page.tsx");
    const source = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    ok(`/settings/${nested} is retired: it only redirects`, /\bredirect\(/.test(source) && !/return \(/.test(source));
  }
  for (const route of routes) {
    if (RETIRED.has(route)) {
      const source = fs.readFileSync(path.join(settingsDir, route.replace("/settings/", ""), "page.tsx"), "utf8");
      ok(`${route} is retired: it only redirects`, /\bredirect\(/.test(source) && !/return \(/.test(source) && !SETTINGS_ITEMS.some((i) => i.href === route));
      continue;
    }
    const listed = SETTINGS_ITEMS.some((i) => i.href === route);
    // The failure this catches: a feature adds a settings screen, links it from its own module, and
    // it never appears in Settings — which is how e-way bills was reachable only by typing the URL.
    ok(`${route} is in the catalogue`, listed, listed ? "" : "reachable only by typing the URL");
  }

  section("The link and the page agree");

  for (const item of SETTINGS_ITEMS) {
    if (!item.href.startsWith("/settings/")) continue;
    const file = pageFor(item.href);
    if (!file) continue;

    const source = fs.readFileSync(file, "utf8");
    const gates = gatesIn(source);

    /**
     * A page rendered through `<SettingsPage settingsKey=…>` takes its gate from this very
     * catalogue, so the two cannot disagree — there is nothing to compare. Only a page that states
     * its own gate has to be checked against what the link promises.
     */
    if (source.includes("settingsKey=")) {
      const declared = /settingsKey="([^"]+)"/.exec(source)?.[1];
      ok(`${item.key}: gate derived from the catalogue`, declared === item.key, declared ?? "none");
      continue;
    }

    if (gates.length === 0) {
      ok(`${item.key}: states a gate`, item.permission === null, item.permission === null ? "open by design" : "none found");
      continue;
    }

    const named = item.permission === null ? [] : Array.isArray(item.permission) ? item.permission : [item.permission];
    const agrees = item.permissionPrefix
      ? gates.some((g) => named.some((n) => g.startsWith(n)))
      : gates.some((g) => named.includes(g));

    ok(
      `${item.key}: the link names what the page tests`,
      agrees,
      agrees ? gates.join(", ") : `link says ${named.join("/") || "open"}, page tests ${gates.join(", ")}`,
    );
  }

  section("Filtering");

  const nobody = visibleSettings([], []);
  // The personal ones only: your own profile is not an administrator's to withhold.
  const openToAll = SETTINGS_ITEMS.filter((i) => i.permission === null && !i.module);
  ok(
    "Somebody with no permissions sees only what needs none",
    nobody.flatMap((s) => s.groups.flatMap((g) => g.items)).length === openToAll.length,
    openToAll.map((i) => i.key).join(", "),
  );

  // All of it that is out: an entry whose feature isn't released yet (the Deskzo app's) is nobody's.
  const unreleased = SETTINGS_ITEMS.filter((i) => i.released && !i.released()).map((i) => i.key);
  const owner = visibleSettings([...permissionKeys], [...moduleKeys], { superAdmin: true });
  const ownerKeys = owner.flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.key)));
  ok(
    "  and the super admin, holding everything, sees all of it that is out",
    ownerKeys.length === SETTINGS_ITEMS.length - unreleased.length && unreleased.every((k) => !ownerKeys.includes(k)),
    `${SETTINGS_ITEMS.length} entries${unreleased.length ? `, not yet out: ${unreleased.join(", ")}` : ""}`,
  );
  // What is the super admin's alone, whatever else one holds. (Unmasking logs used to be one of these
  // entries; the log is now a screen of Access Control — see "Access Control's own menu" below.)
  const admin = visibleSettings([...permissionKeys], [...moduleKeys]);
  const adminKeys = admin.flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.key)));
  const superOnly = SETTINGS_ITEMS.filter((i) => i.superAdminOnly).map((i) => i.key);
  ok(
    "  an admin holding every permission sees everything but what is the super admin's alone",
    superOnly.length > 0 && superOnly.every((k) => !adminKeys.includes(k)) && adminKeys.length === SETTINGS_ITEMS.length - superOnly.length - unreleased.length,
    superOnly.join(", "),
  );

  // The sidebar gets keys, not entries, and rebuilds the tree from them: a key two entries share would
  // draw both for whoever may open either. A reviewer who holds `permissions.view` and nothing else:
  const reviewerHolds = ["permissions.view"];
  const offered = visibleSettings(reviewerHolds, [...moduleKeys]).flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.href)));
  const rebuilt = settingsForKeys(visibleSettingsKeys(reviewerHolds, [...moduleKeys])).flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.href)));
  ok(
    "  the sidebar's keys rebuild exactly what the viewer may open",
    rebuilt.join() === offered.join(),
    rebuilt.filter((h) => !offered.includes(h)).map((h) => `${h} is drawn for somebody who may not open it`).join("; "),
  );
  ok("  a reviewer is offered Access Control", offered.includes(AC_ROOT));

  ok(
    "  an empty group is dropped rather than left as a heading with nothing under it",
    nobody.every((s) => s.groups.every((g) => g.items.length > 0)),
  );

  const backups = SETTINGS_ITEMS.find((i) => i.key === "backups")!;
  ok("  a settings.manage admin is not offered Backups", !mayOpen(backups, ["settings.manage"]));
  ok("    and a backups.manage holder is", mayOpen(backups, ["backups.manage"]));

  const data = SETTINGS_ITEMS.find((i) => i.key === "data")!;
  // An accountant who exports statements is not an administrator; the prefix is what lets them in.
  ok("  one export key opens Import & export", mayOpen(data, ["data.exportFinance"]));
  ok("    and an unrelated key does not", !mayOpen(data, ["orders.process"]));

  section("Access Control's own menu");

  // Settings › Access Control is one catalogue entry with a sidebar of its own (src/lib/access-control/nav.ts,
  // drawn by src/components/access-control/shell.tsx). The entries that used to stand for its screens here
  // — Roles & Permissions, Unmasking logs — are checked against that list instead.
  const acLinks = [...AC_NAV, ...AC_TOOLS].flatMap((i) => [i, ...(i.children ?? [])]);
  ok("neither retired entry is left in the catalogue", !SETTINGS_ITEMS.some((i) => i.key === "roles" || i.key === "unmasking-logs" || i.href === "/settings/roles" || i.href === "/settings/unmasking-logs"));
  const areaEntries = SETTINGS_ITEMS.filter((i) => i.href === AC_ROOT || i.href.startsWith(`${AC_ROOT}/`));
  ok("  one entry opens the area, on permissions.view", areaEntries.length === 1 && areaEntries[0]!.href === AC_ROOT && areaEntries[0]!.label === "Access Control" && areaEntries[0]!.permission === "permissions.view", areaEntries.map((i) => `${i.key}:${i.permission}`).join());
  // Every screen of the area tests that key for itself (through the guard, or in so many words): the retired
  // pages each did, and the layout that also asks is not run again when somebody moves between its pages.
  for (const link of acLinks) {
    const file = pageFor(link.href.split("?")[0]!);
    const gates = file ? gatesIn(fs.readFileSync(file, "utf8")) : [];
    // A page whose only reads are actions that ask `permissions.view` themselves and answer null is closed too.
    const viaLoader = file ? /if \(!(board|data|view)\) notFound\(\)/.test(fs.readFileSync(file, "utf8")) : false;
    ok(`  ${link.key}: its page asks permissions.view itself`, gates.includes("permissions.view") || viaLoader, gates.includes("permissions.view") ? "" : viaLoader ? "through its loader, which answers null without it" : `tests ${gates.join(", ") || "nothing"}`);
  }
  ok("  its menu lists Roles & Permissions and Unmasking Activity", acLinks.some((i) => i.label === "Roles & Permissions" && i.href === `${AC_ROOT}/roles`) && acLinks.some((i) => i.label === "Unmasking Activity" && i.href === `${AC_ROOT}/audit?category=pii`));
  for (const link of acLinks) {
    const file = pageFor(link.href.split("?")[0]!);
    ok(`  ${link.key} → ${link.href}`, file !== null, file ?? "no page renders this route");
  }
  const areaKey = SETTINGS_ITEMS.find((i) => i.href === AC_ROOT)?.key ?? null;
  ok("  and every path under the area lights its catalogue entry", areaKey !== null && acLinks.every((i) => activeSettingsKey(i.href.split("?")[0]!) === areaKey));
  // The catalogue hid "Unmasking logs" from everybody but the super admin (`superAdminOnly`), so nobody was
  // offered a door that would refuse them. Its replacement keeps that: the area's layout hands the sidebar the
  // entries this viewer may not open — "unmasking" unless they are acting as the super admin — and the sidebar
  // leaves them out. (Drawn for an admin and for the super admin in check:unmask, which has the people to ask.)
  const layoutSource = fs.readFileSync(path.join(APP, "settings/access/layout.tsx"), "utf8");
  const shellSource = fs.readFileSync("src/components/access-control/shell.tsx", "utf8");
  const hidesUnmasking =
    acLinks.some((i) => i.key === "unmasking") && /actingAsSuperAdmin\(/.test(layoutSource) && /hidden=\{\s*superAdmin\s*\?\s*\[\]\s*:\s*\[[^\]]*"unmasking"[^\]]*\]\s*\}/.test(layoutSource) && /\.filter\(\(c\) => !hidden\?\.includes\(c\.key\)\)/.test(shellSource);
  ok("  the unmasking log is offered to the super admin alone", hidesUnmasking, hidesUnmasking ? "" : "src/app/(dashboard)/settings/access/layout.tsx should hide \"unmasking\" from anybody not acting as the super admin");
  ok("  and the layout asks permissions.view before drawing the area", gatesIn(layoutSource).includes("permissions.view"), gatesIn(layoutSource).join(", ") || "tests nothing");

  section("Which entry a path is looking at");

  ok("/settings/data is Import & export", activeSettingsKey("/settings/data") === "data");
  ok("  /settings itself is nothing — it is the index", activeSettingsKey("/settings") === null);
  ok("  a nested route still highlights its parent", activeSettingsKey("/settings/users/new") === "users");
  ok("  an unrelated page highlights nothing", activeSettingsKey("/companies") === null);

  section("Search");

  // The menu and the All settings page both narrow by typing (owner, 16 Oct 2026). Every word must
  // appear in the setting, or the group or section it sits under; case, accents and endings don't count.
  const found = (term: string) => searchSettings(SETTINGS, term).flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.key)));
  const labelOf = (key: string) => SETTINGS_ITEMS.find((i) => i.key === key)?.label ?? key;
  const labelsFor = (term: string) => found(term).map(labelOf).join(" | ") || "nothing";
  const finds = (term: string, labels: string[]) => {
    const got = found(term).map(labelOf);
    ok(`"${term}" finds ${labels.join(", ")}`, labels.every((l) => got.includes(l)), labelsFor(term));
  };

  finds("mail", ["Document emails", "Mail & messaging", "Support email"]);
  finds("invoice", ["e-Invoicing"]);
  // Roles & Permissions became a screen of Access Control: "roles" finds the area by its description.
  finds("roles", ["Access Control"]);
  finds("access", ["Access Control"]);
  finds("unmasking", ["Access Control"]);
  // Word endings: neither name says "notifications" or "pipelines" — only the stem finds them.
  finds("notifications", ["Notification preferences"]);
  finds("pipelines", ["Pipeline"]);
  // Branches (under Staff) says GSTIN only in its description.
  finds("gstin", ["Branches"]);
  finds("MAIL", ["Mail & messaging"]);
  finds("  mail  ", ["Mail & messaging"]);
  ok("  an accent is folded away — \"máil\" is \"mail\"", found("m\u00e1il").join() === found("mail").join());
  ok("  every word must match — \"support mail\" is narrower than \"mail\"", found("support mail").length > 0 && found("support mail").length < found("mail").length, labelsFor("support mail"));
  ok("  nonsense finds nothing", found("zzqxv").length === 0);
  ok("  a blank search is everything, untouched", searchSettings(SETTINGS, "   ") === SETTINGS);
  ok("  punctuation alone is a blank search", searchWords("—, /").length === 0);

  const narrowed = searchSettings(SETTINGS, "mail");
  ok(
    "  no empty group or section is left behind",
    narrowed.every((s) => s.groups.length > 0 && s.groups.every((g) => g.items.length > 0)),
  );
  const order = SETTINGS_ITEMS.map((i) => i.key);
  const mailKeys = found("mail");
  ok(
    "  matches keep the catalogue's order",
    mailKeys.every((k, n) => n === 0 || order.indexOf(mailKeys[n - 1]!) < order.indexOf(k)),
  );
  ok("Enter opens the first match", firstMatch(narrowed)?.key === mailKeys[0], firstMatch(narrowed)?.label);
  ok("  and nothing when nothing matches", firstMatch(searchSettings(SETTINGS, "zzqxv")) === null);
  const hidden = visibleSettings(["settings.view"], [], {}).flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.key)));
  ok(
    "  a search never finds what the viewer can't open",
    searchSettings(visibleSettings(["settings.view"], [], {}), "mail")
      .flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.key)))
      .every((k) => hidden.includes(k)),
  );

  section("Coverage");

  const sections = SETTINGS.length;
  const groups = SETTINGS.reduce((n, s) => n + s.groups.length, 0);
  ok(
    "The catalogue covers every settings route and then some",
    SETTINGS_ITEMS.length >= routes.length,
    `${SETTINGS_ITEMS.length} entries · ${sections} sections · ${groups} groups · ${routes.length} routes under /settings`,
  );

  console.log(failures === 0 ? "\nAll settings checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

main();
