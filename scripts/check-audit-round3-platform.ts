/**
 * check:audit-round3-platform — round three of the security audit (docs/reports/security-audit-2026-11-11.md §12),
 * group F: field rules, the storage box, the bulk merge and the features added since 11 Nov, each shown to hold the way
 * it was broken:
 *
 *   R3-01  a backtracking pattern can't hold the process: refused at save, the value capped, the match time-limited —
 *          a pattern that slips past the first layer returns in well under a second; the word filter too
 *   R3-24  a purged workspace's files leave the box; recordings are sealed; the bulk merge takes no name-only match,
 *          needs the workspace's name typed, is capped and refused while viewing as
 *   lows   stored-reference lookalikes, the unique rule's echo, renewal CC addresses, your own role's lead limit,
 *          reopening past the open-leads limit (app and trigger), role saves while viewing as
 *
 * Pure rules first, then a fixture of its own tagged ZZR3F (people, a company, leads, rules), removed in a finally.
 *
 *   npx tsx scripts/check-audit-round3-platform.ts
 */
import "dotenv/config";
import Module from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TAG = "zzr3f";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

// ─── Stubs: who is calling, and whether they are viewing as somebody ──────────────────────────────
type Actor = { id: string; name: string; email: string; role: string; sid?: string };
let actor: Actor | null = null;
let viewingAs = false;
const VIEW_AS = "You're viewing as somebody — do this as yourself.";
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => (viewingAs ? { user: {} } : null),
  refuseWhileViewingAs: async () => (viewingAs ? VIEW_AS : null),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

/** How long `fn` took, in milliseconds, with what it returned. */
function timed<T>(fn: () => T): { ms: number; value: T } {
  const started = performance.now();
  const value = fn();
  return { ms: Math.round(performance.now() - started), value };
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const safety = require("../src/lib/field-rules/pattern-safety") as typeof import("../src/lib/field-rules/pattern-safety");
  const check = require("../src/lib/field-rules/check") as typeof import("../src/lib/field-rules/check");
  const guard = require("../src/lib/field-rules/regex-guard") as typeof import("../src/lib/field-rules/regex-guard");
  const wordFilter = require("../src/lib/word-filter/server") as typeof import("../src/lib/word-filter/server");
  const { PRESET_WORDS } = require("../src/lib/word-filter/preset") as typeof import("../src/lib/word-filter/preset");
  const bulk = require("../src/lib/companies/bulk-merge") as typeof import("../src/lib/companies/bulk-merge");
  /* eslint-enable @typescript-eslint/no-require-imports */

  // ─── R3-01, the rules ──────────────────────────────────────────────────────────────────────────
  section("R3-01: a pattern that backtracks is refused when it is saved");
  const refused = ["(a+)+b", "(a*)*", "(\\d+)*x", "(a|ab)+", "(\\d|[0-9])+", "(a|a?)+", "(.*a){3}", "((a|a))+", "(a)\\1", "(?<x>a)\\k<x>", "(?=a)a", "a(?!b)", "(?<=a)b", "(?<!a)b", "([a-z]+\\s?)*$"];
  const bad = refused.filter((p) => !safety.patternDanger(p));
  ok(`${refused.length} shapes that backtrack (nested repeats, overlapping choices, back-references, lookarounds) are refused`, bad.length === 0, bad);
  const fine = ["[A-Z]{3}-\\d{4}", "PO-\\d+", "(cat|dog)+", "\\p{L}+", "(?<code>[A-Z]{2})\\d{6}", "[A-Z]{5}[0-9]{4}[A-Z]", "\\d{2}[A-Z]{5}\\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]", "(\\+91)?[6-9]\\d{9}", "(abc)?\\d+"];
  const flagged = fine.filter((p) => safety.patternDanger(p));
  ok(`${fine.length} everyday formats (codes, PAN, GSTIN, phone) are still allowed`, flagged.length === 0, flagged.map((p) => [p, safety.patternDanger(p)]));
  ok("  the refusal says why, in words", /repeats something that already repeats/.test(String(safety.patternDanger("(a+)+b"))) && /start with the same character/.test(String(safety.patternDanger("(a|ab)+"))));
  ok("  and a rule with one can't be saved", typeof check.compilePattern("(a+)+b") === "string" && check.ruleRefusal({ entity: "LEAD", field: "title", kind: "PATTERN", pattern: "CUSTOM", patternValue: "(a+)+b" }, [{ key: "title", label: "Lead title", kind: "text" }]) !== null);

  section("R3-01: a pattern that slipped past (saved before) can't hold the process");
  const evil = check.compilePattern("(a+)+b", { safety: false });
  ok("the catastrophic pattern compiles when the save-time check is skipped (as a rule saved before it would)", evil instanceof RegExp);
  if (evil instanceof RegExp) {
    // Proof it is catastrophic: unguarded, 25 "a"s take a noticeable while (each extra "a" doubles it; 40 would be ~10 hours).
    const plain = timed(() => evil.test("a".repeat(25)));
    ok("  unguarded, 25 \"a\"s already take a while — it really backtracks", plain.ms > 30, `${plain.ms} ms`);
    const caught = timed(() => guard.guardedTest(evil, "a".repeat(40)));
    ok("  guarded, 40 \"a\"s: stopped, \"timeout\", and back in well under a second", caught.value === "timeout" && caught.ms < 1000, `${caught.value} in ${caught.ms} ms`);
    const caughtLong = timed(() => guard.guardedTest(evil, "a".repeat(5000)));
    ok("  5,000 \"a\"s too", caughtLong.value === "timeout" && caughtLong.ms < 1000, `${caughtLong.value} in ${caughtLong.ms} ms`);
    ok("  a sane pattern answers through the guard as it always did", guard.guardedTest(/^\d+$/u, "12345") === true && guard.guardedTest(/^\d+$/u, "12a") === false);
    ok("  and the regex is usable again after a timeout", guard.guardedTest(evil, "aab") === true);
  }
  const rule = { pattern: "CUSTOM" as const, patternValue: "(a+)+b" };
  const verdict = timed(() => check.patternVerdict(rule, "a".repeat(40), guard.guardedTest));
  ok("a field rule with it, checked on the server's runner: \"timeout\" — not a match — in under a second", verdict.value === "timeout" && verdict.ms < 1000, `${verdict.value} in ${verdict.ms} ms`);
  ok("  a value over 200 characters isn't tried at all: \"too long\"", check.patternVerdict(rule, "a".repeat(201), guard.guardedTest) === "too-long");
  const fields = [{ key: "title", label: "Lead title", kind: "text" as const }];
  const ruleRow = { id: "r", entity: "LEAD" as const, field: "title", kind: "PATTERN" as const, min: null, max: null, pattern: "CUSTOM" as const, patternValue: "(a+)+b", when: null, newOnly: false, message: null, active: true };
  const record = timed(() => check.checkRecord({ rules: [ruleRow], fields, record: { title: "a".repeat(40) }, isNew: true, touched: null, run: guard.guardedTest }));
  ok("  checkRecord refuses the save, saying it couldn't be checked in time", record.ms < 1000 && record.value.problems.length === 1 && /couldn't be checked against its format in time/.test(record.value.problems[0]!.message), record.value.problems.map((p) => p.message));

  section("R3-01: the word filter's pattern runs under a time limit too");
  const overlapping = wordFilter.filterFor({ enabled: true, usePreset: false, words: ["ilililililililil"], allowed: [] });
  const wf = timed(() => overlapping.find("1".repeat(40) + "q"));
  ok("an entry whose letters overlap (i and l both take 1), against 40 \"1\"s: back in under a second", wf.ms < 1000, `${wf.ms} ms`);
  const stars = wordFilter.filterFor({ enabled: true, usePreset: false, words: ["abcdefghijklmnop"], allowed: [] });
  const wf2 = timed(() => stars.mask("a" + "*".repeat(60) + "x"));
  ok("  an entry's inner \"*\" against a long run of stars: back in under a second", wf2.ms < 1000, `${wf2.ms} ms`);
  const preset = wordFilter.filterFor({ enabled: true, usePreset: true, words: [], allowed: [] });
  const email = `${"Dear team, please find the quotation attached and confirm the delivery schedule. ".repeat(1200)}What the fuck is this.`;
  const masked = timed(() => preset.mask(email));
  ok(`  a ${Math.round(email.length / 1000)} KB email against the whole preset is still filtered, inside its limit`, masked.value.endsWith("What the **** is this.") && masked.ms < wordFilter.wordFilterTimeLimit(email.length) + 500, `${masked.ms} ms, limit ${wordFilter.wordFilterTimeLimit(email.length)} ms`);
  const bigStars = wordFilter.filterFor({ enabled: true, usePreset: false, words: ["abcdefghijklmnop"], allowed: [] });
  const wf3 = timed(() => bigStars.mask("a" + "*".repeat(200_000) + "x"));
  ok("  a 200 KB crafted text: stopped at the cap, never longer than a second and a half", wf3.ms < 2000, `${wf3.ms} ms`);
  ok(`  (${PRESET_WORDS.length} preset words) and a short message as before`, preset.find("you are a fucking idiot").length > 0);

  // ─── Storage ───────────────────────────────────────────────────────────────────────────────────
  const storageVars = ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER", "STORAGE_AZURE_CONTAINER_URL", "STORAGE_AZURE_SAS", "STORAGE_DIR", "STORAGE_PREFIX", "RECORDINGS_AZURE_CONTAINER_URL", "RECORDINGS_AZURE_SAS", "RECORDINGS_DIR"];
  const savedEnv = Object.fromEntries(storageVars.map((k) => [k, process.env[k]]));
  for (const k of storageVars) delete process.env[k];
  const scratch = await mkdtemp(path.join(os.tmpdir(), "zzr3f-"));

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const files = require("../src/lib/storage/files") as typeof import("../src/lib/storage/files");
  const box = require("../src/lib/storage/box") as typeof import("../src/lib/storage/box");
  const recordings = require("../src/lib/calls/recordings") as typeof import("../src/lib/calls/recordings");
  const lifecycle = require("../src/lib/platform/lifecycle") as typeof import("../src/lib/platform/lifecycle");
  const { currentTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const fieldServer = require("../src/lib/field-rules/server") as typeof import("../src/lib/field-rules/server");
  const merge = require("../src/actions/company-merge") as typeof import("../src/actions/company-merge");
  const renewal = require("../src/actions/renewal-settings") as typeof import("../src/actions/renewal-settings");
  const leadLimits = require("../src/actions/lead-limits") as typeof import("../src/actions/lead-limits");
  const leadActions = require("../src/actions/lead") as typeof import("../src/actions/lead");
  const acm = require("../src/actions/access-control-modules") as typeof import("../src/actions/access-control-modules");
  const perms = require("../src/actions/permission") as typeof import("../src/actions/permission");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const started = new Date();
  const cleanup = async () => {
    const users = (await db.user.findMany({ where: { email: { endsWith: `@${TAG}.invalid` } }, select: { id: true } })).map((u) => u.id);
    const companies = (await db.company.findMany({ where: { name: { startsWith: "ZZR3F " } }, select: { id: true } })).map((c) => c.id);
    const quiet = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        console.error("  (cleanup)", err instanceof Error ? err.message.split("\n")[0] : err);
      }
    };
    await quiet(() => db.fieldRule.deleteMany({ where: { OR: [{ message: { startsWith: "ZZR3F" } }, { createdById: { in: users } }] } }));
    await quiet(() => db.leadLimitWarning.deleteMany({ where: { userId: { in: users } } }));
    await quiet(() => db.activity.deleteMany({ where: { lead: { companyId: { in: companies } } } }));
    await quiet(() => db.leadAssignment.deleteMany({ where: { userId: { in: users } } }));
    await quiet(() => db.lead.deleteMany({ where: { companyId: { in: companies } } }));
    await quiet(() => db.company.deleteMany({ where: { id: { in: companies } } }));
    await quiet(() => db.userLeadLimit.deleteMany({ where: { userId: { in: users } } }));
    await quiet(() => db.userPermission.deleteMany({ where: { userId: { in: users } } }));
    await quiet(() => db.notification.deleteMany({ where: { OR: [{ userId: { in: users } }, { title: { startsWith: "Who customer renewal reminders" }, createdAt: { gte: started } }] } }));
    await quiet(() => db.auditLog.deleteMany({ where: { userId: { in: users } } }));
    await quiet(() => db.user.deleteMany({ where: { id: { in: users } } }));
  };

  let ccBefore: string[] | null = null;
  let renewalRow: "restore" | "remove" | null = null;
  try {
    await cleanup();
    const tenant = await currentTenant();
    const safeId = tenant.id.replace(/[^A-Za-z0-9._-]/g, "-");

    section("Lows: an upload can't pose as a storage-box reference");
    const lookalikeText = `${files.TEXT_REF}user-photos/2026-11/${"a".repeat(24)}|image/png`;
    const lookalikeBytes = Buffer.concat([Buffer.from("\u0000DZBLOB\u0000", "latin1"), Buffer.from(lookalikeText, "utf8")]);
    const threw = async (fn: () => Promise<unknown>) => fn().then(() => null, (err: unknown) => (err instanceof Error ? err.name : "threw"));
    ok("the lookalikes really read as references (what made them dangerous)", files.isStoredRef(lookalikeText) && files.isStoredRef(lookalikeBytes));
    ok("  without a box, keepDataUrl refuses the text one", (await threw(() => files.keepDataUrl("chat-attachments", lookalikeText))) === "StoredRefRefused");
    ok("  and keepBytes the bytes one (chat and task uploads)", (await threw(() => files.keepBytes("chat-attachments", lookalikeBytes, "image/png"))) === "StoredRefRefused");
    process.env.STORAGE_DIR = path.join(scratch, "box");
    ok("  with a box, the same", (await threw(() => files.keepDataUrl("chat-attachments", lookalikeText))) === "StoredRefRefused" && (await threw(() => files.keepBytes("task-attachments", lookalikeBytes, "image/png"))) === "StoredRefRefused");
    const real = await files.keepBytes("task-attachments", Buffer.from("an ordinary file"), "text/plain");
    ok("  an ordinary upload still becomes a reference", files.isStoredRef(real));

    section("R3-24: recordings are sealed; a purged workspace's files leave the box");
    const store = await recordings.recordingStore();
    ok("with only a box set up, recordings go to it", !!store);
    const sound = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A zzr3f sound", "latin1")]);
    await store!.put("calls/2026/11/zzr3f.m4a", sound);
    const raw = await readFile(path.join(scratch, "box", "workspaces", safeId, "recordings", "calls", "2026", "11", "zzr3f.m4a"));
    ok("  a new recording is sealed in the box (not the sound's bytes)", raw.subarray(0, 8).toString("latin1") === "DZBKENC1" && !raw.includes(Buffer.from("zzr3f sound")), raw.subarray(0, 8).toString("latin1"));
    ok("  and plays back as it was", (await store!.get("calls/2026/11/zzr3f.m4a"))?.equals(sound) === true);
    await writeFile(path.join(scratch, "box", "workspaces", safeId, "recordings", "calls", "2026", "11", "old.m4a"), sound);
    ok("  one kept before sealing still plays", (await store!.get("calls/2026/11/old.m4a"))?.equals(sound) === true);

    const victim = "zzr3fclosed";
    const neighbour = "zzr3fclosedtoo";
    const plant = async (rel: string) => {
      const file = path.join(scratch, "box", ...rel.split("/"));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "x");
    };
    for (const rel of [`workspaces/${victim}/files/user-photos/2026-11/a`, `workspaces/${victim}/recordings/calls/2026/11/b.m4a`, `support/${victim}/req/att`, `workspaces/${neighbour}/files/user-photos/2026-11/c`, `support/${neighbour}/req/att`]) await plant(rel);
    process.env.RECORDINGS_DIR = path.join(scratch, "rec");
    const ownRec = path.join(scratch, "rec", `ws-${victim}`, "calls", "x.m4a");
    const otherRec = path.join(scratch, "rec", `ws-${neighbour}`, "calls", "y.m4a");
    await mkdir(path.dirname(ownRec), { recursive: true });
    await mkdir(path.dirname(otherRec), { recursive: true });
    await writeFile(ownRec, "x");
    await writeFile(otherRec, "x");
    const removed = await lifecycle.removeWorkspaceFiles(victim);
    const exists = async (rel: string) => readdir(path.join(scratch, ...rel.split("/"))).then((l) => l.length > 0, () => false);
    ok("purging a workspace removes its documents, recordings and support files from the box", removed.box === 2 && removed.support === 1 && !(await exists(`box/workspaces/${victim}/files/user-photos/2026-11`)) && !(await exists(`box/support/${victim}/req`)), removed);
    ok("  and its folder in a recordings store of its own", removed.recordings === 1 && !(await exists(`rec/ws-${victim}/calls`)));
    ok("  a workspace whose id starts the same is left alone", (await exists(`box/workspaces/${neighbour}/files/user-photos/2026-11`)) && (await exists(`box/support/${neighbour}/req`)) && (await exists(`rec/ws-${neighbour}/calls`)));
    const rootRefused = await box.removeBoxFolder((await box.storageBox())!, "workspaces").then(() => false, () => true);
    ok("  emptying a top-level folder (or the root) is refused", rootRefused && (await box.removeBoxFolder((await box.storageBox())!, "/").then(() => false, () => true)));
    delete process.env.RECORDINGS_DIR;
    delete process.env.STORAGE_DIR;

    // ─── Fixture ─────────────────────────────────────────────────────────────────────────────────
    const person = (name: string, role: string) => db.user.create({ data: { name: `ZZR3F ${name}`, email: `${name.toLowerCase()}@${TAG}.invalid`, passwordHash: "!", role }, select: { id: true, name: true, email: true, role: true } });
    const admin = await person("Admin", "ADMIN");
    const manager = await person("Manager", "SALES");
    const rep = await person("Rep", "SALES");
    await db.userPermission.create({ data: { userId: manager.id, permission: "permissions.manage", allowed: true, reason: "ZZR3F" } });
    const asActor = (u: { id: string; name: string; email: string | null; role: string }) => (actor = { id: u.id, name: u.name, email: u.email ?? "", role: u.role });
    const company = await db.company.create({ data: { name: "ZZR3F Probe Co", normalizedName: "zzr3f probe co", createdById: admin.id } });

    section("R3-01 on the server: fieldRuleRefusal with a rule saved before the check");
    asActor(admin);
    // A rule that only asks of a description no real save has, so nothing else in this database is touched by it.
    await db.fieldRule.create({ data: { entity: "LEAD", field: "title", kind: "PATTERN", pattern: "CUSTOM", patternValue: "(a+)+b", when: { field: "description", op: "EQUALS", value: "zzr3f-evil" }, message: "ZZR3F evil", createdById: admin.id } });
    const timedAll = performance.now();
    const serverRefusal = await fieldServer.fieldRuleRefusal("LEAD", { title: "a".repeat(40), description: "zzr3f-evil" });
    const serverMs = Math.round(performance.now() - timedAll);
    ok("a lead titled with 40 \"a\"s against (a+)+b: refused, the whole check (database included) back in under a second", typeof serverRefusal === "string" && /in time/.test(serverRefusal) && serverMs < 1000, `${serverRefusal} (${serverMs} ms)`);
    const importRow = performance.now();
    const imported = await fieldServer.importRuleRefusal("LEAD", null, { title: "a".repeat(40), description: "zzr3f-evil" });
    ok("  an import row, the same", typeof imported === "string" && performance.now() - importRow < 1000, `${Math.round(performance.now() - importRow)} ms`);
    const saveEvil = await fieldServer.saveFieldRule(admin.id, { entity: "LEAD", field: "title", kind: "PATTERN", pattern: "CUSTOM", patternValue: "(x+)+y", message: "ZZR3F refused" });
    ok("  saving a new rule with such a pattern is refused, saying why", !saveEvil.ok && /repeats/.test(saveEvil.ok ? "" : saveEvil.error), saveEvil);

    section("Lows: a unique rule doesn't echo the value, and slows down a person who probes");
    const secretTitle = "ZZR3F Secret Deal Title";
    await db.lead.create({ data: { title: secretTitle, companyId: company.id, ownerUserId: admin.id, status: "WON" } });
    // No message of its own, so the default words are what is shown (cleanup finds it by who made it).
    await db.fieldRule.create({ data: { entity: "LEAD", field: "title", kind: "UNIQUE", when: { field: "description", op: "EQUALS", value: "zzr3f-unique" }, message: null, createdById: admin.id } });
    const uniq = await fieldServer.fieldRuleRefusal("LEAD", { title: secretTitle.toLowerCase(), description: "zzr3f-unique" });
    ok("a taken value is refused without the value, and without saying what holds it", !!uniq && !uniq.includes(secretTitle) && !uniq.toLowerCase().includes("secret") && !/lead\b/.test(uniq.replace("Lead title", "")), uniq);
    let last: string | null = null;
    for (let i = 0; i < fieldServer.UNIQUE_ANSWERS_PER_WINDOW + 2; i++) last = await fieldServer.fieldRuleRefusal("LEAD", { title: `${secretTitle}`, description: "zzr3f-unique" });
    ok(`  after ${fieldServer.UNIQUE_ANSWERS_PER_WINDOW} "already used" answers in ten minutes, the person is asked to wait`, /Too many saves/.test(String(last)), last);
    await db.fieldRule.deleteMany({ where: { entity: "LEAD", kind: "UNIQUE", createdById: admin.id } });

    section("R3-24: the bulk merge");
    ok("a pair matched by name alone isn't for the bulk merge; one sharing a PAN or GSTIN is", !bulk.sharesTaxId({ aId: "a", bId: "b", strength: "strong", reasons: ["Same name once Pvt, Ltd and the like are set aside"] }) && bulk.sharesTaxId({ aId: "a", bId: "b", strength: "strong", reasons: ["Same GSTIN 27AAAAA0000A1Z5"] }) && bulk.sharesTaxId({ aId: "a", bId: "b", strength: "strong", reasons: ["Same PAN AAAAA0000A"] }));
    const s = (id: string) => ({ id, business: 0, records: 0, companySeq: 1 });
    ok("  bulkVerdict: name alone with nothing on either is a person's", !bulk.bulkVerdict({ aId: "a", bId: "b", strength: "strong", reasons: ["Same name once Pvt, Ltd and the like are set aside"] }, s("a"), s("b")).ok);
    ok("  the typed confirmation is the workspace's name, without case or extra spaces", bulk.bulkConfirmMatches("  ACME   corp ", "Acme Corp") && !bulk.bulkConfirmMatches("", "") && !bulk.bulkConfirmMatches("yes", "Acme Corp") && !bulk.bulkConfirmMatches(undefined, "Acme Corp"));
    ok(`  capped at ${bulk.BULK_PER_CALL} a press and ${bulk.BULK_PER_DAY} a day`, bulk.BULK_PER_CALL <= 25 && bulk.BULK_PER_DAY <= 200);
    const preview = await merge.bulkMergePreview();
    ok("the preview says how many and what to type, before anything is merged", preview.ok && preview.data.confirmWith === tenant.name && preview.data.leftToday <= bulk.BULK_PER_DAY, preview);
    const noConfirm = await merge.bulkMergeDuplicates({ among: [company.id] });
    ok("  without the workspace's name typed: refused", !noConfirm.ok && /Type the workspace's name/.test(noConfirm.ok ? "" : noConfirm.error));
    const wrongConfirm = await merge.bulkMergeDuplicates({ among: [company.id], confirm: "yes" });
    ok("  with something else typed: refused", !wrongConfirm.ok);
    viewingAs = true;
    const asOther = await merge.bulkMergeDuplicates({ among: [company.id], confirm: tenant.name });
    viewingAs = false;
    ok("  while viewing as somebody: refused", !asOther.ok && (asOther.ok ? "" : asOther.error) === VIEW_AS);
    const confirmed = await merge.bulkMergeDuplicates({ among: [company.id], confirm: tenant.name });
    ok("  with it typed, it runs (nothing of this fixture to merge)", confirmed.ok && confirmed.data.merged === 0, confirmed);

    section("Lows: renewal reminders are copied only inside the workspace");
    const before = await db.renewalSettings.findUnique({ where: { id: "default" }, select: { customerReminderCc: true } }).catch(() => null);
    ccBefore = before?.customerReminderCc ?? null;
    const outside = await renewal.saveRenewalSettings({ lapseLostAfterDays: null, customerReminderCc: ["someone@gmail.com"] });
    ok("an outside address (Gmail) is refused, naming it", !outside.ok && /someone@gmail\.com/.test(outside.ok ? "" : outside.error), outside);
    const stranger = await renewal.saveRenewalSettings({ lapseLostAfterDays: null, customerReminderCc: [`copies@zzr3f-elsewhere.example`] });
    ok("  so is a company domain nobody here uses", !stranger.ok);
    // Put back afterwards: the list as it was, or no row at all where there was none.
    renewalRow = before ? "restore" : "remove";
    const lapseBefore = (await db.renewalSettings.findUnique({ where: { id: "default" }, select: { lapseLostAfterDays: true } }))?.lapseLostAfterDays ?? null;
    const inside = await renewal.saveRenewalSettings({ lapseLostAfterDays: lapseBefore, customerReminderCc: [`copies@${TAG}.invalid`, manager.email!] });
    ok("  a person working here, and another address at the workspace's own domain: kept", inside.ok, inside);
    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true } });
    const told = superAdmin ? await db.notification.count({ where: { userId: superAdmin.id, title: { startsWith: "Who customer renewal reminders" }, createdAt: { gte: started } } }) : 0;
    ok("  and the super admin is told the list changed", !!superAdmin && told === 1, { superAdmin: !!superAdmin, told });

    section("Lows: lead limits — your own role, and reopening a closed lead");
    asActor(manager);
    const ownRole = await leadLimits.setRoleLeadLimit("SALES", { maxOpen: 500 });
    ok("a permissions.manage holder can't lift their own role's lead limit", !ownRole.ok && /your own role/.test(ownRole.ok ? "" : ownRole.error), ownRole);
    const view = await leadLimits.roleLeadLimit("SALES");
    ok("  and the screen says so", view !== null && view.editable === false && /your own role/.test(view.why ?? ""), view);

    await db.userLeadLimit.create({ data: { userId: rep.id, limited: true, maxOpen: 1, reason: "ZZR3F" } });
    const repCompany = await db.company.create({ data: { name: "ZZR3F Rep Co", normalizedName: "zzr3f rep co", createdById: rep.id, ownerUserId: rep.id } });
    await db.lead.create({ data: { title: "ZZR3F open one", companyId: repCompany.id, ownerUserId: rep.id, status: "NEW" } });
    const closed = await db.lead.create({ data: { title: "ZZR3F closed one", companyId: repCompany.id, ownerUserId: rep.id, status: "LOST", lostReason: "ZZR3F" }, select: { id: true } });
    asActor(rep);
    const visible = await leadActions.updateLeadStatus({ leadId: closed.id, status: "LOST", lostReason: "ZZR3F again" });
    ok("(the rep can move this lead at all — a lost reason changed)", visible.ok, visible);
    const reopen = await leadActions.updateLeadStatus({ leadId: closed.id, status: "NEW" });
    const still = await db.lead.findUnique({ where: { id: closed.id }, select: { status: true } });
    ok("reopening a lost lead for somebody already at their open-leads limit: refused for the limit, the lead stays lost", !reopen.ok && /open lead|leads open|at most|limit/i.test(reopen.error) && still?.status === "LOST", reopen.ok ? "reopened" : reopen.error);
    let triggerSaw = false;
    try {
      await db.lead.update({ where: { id: closed.id }, data: { status: "CONTACTED" } });
      triggerSaw = (await db.leadLimitWarning.count({ where: { leadId: closed.id, limitKind: "open" } })) === 1;
    } catch (err) {
      triggerSaw = /lead_limit_exceeded:open/.test(err instanceof Error ? err.message : String(err));
    }
    ok("  the database's backstop sees a reopen by any other path (warned, or refused when enforcing)", triggerSaw);

    section("Lows: role permissions aren't saved while viewing as somebody");
    asActor(admin);
    viewingAs = true;
    const answers = await acm.saveRoleAnswers("SALES" as never, [{ key: "leads.view", state: "allow" }]);
    const one = await perms.setRolePermission("SALES" as never, "leads.view", true);
    const many = await perms.setRolePermissions("SALES" as never, [{ key: "leads.view", allowed: true }]);
    const reset = await perms.resetRolePermission("SALES" as never, "leads.view");
    viewingAs = false;
    const refusedAll = [answers, one, many, reset].every((r) => !r.ok && r.error === VIEW_AS);
    ok("the module matrix, one permission, several, and a reset: each refused", refusedAll, [answers, one, many, reset].map((r) => (r.ok ? "saved" : r.error)));
  } finally {
    actor = null;
    viewingAs = false;
    if (renewalRow === "restore" && ccBefore !== null) await db.renewalSettings.updateMany({ where: { id: "default" }, data: { customerReminderCc: ccBefore } }).catch(() => {});
    if (renewalRow === "remove") await db.renewalSettings.deleteMany({ where: { id: "default" } }).catch(() => {});
    await cleanup();
    for (const k of storageVars) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await rm(scratch, { recursive: true, force: true });
    await db.$disconnect();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
