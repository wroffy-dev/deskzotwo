/**
 * check:audit-lows-ai — the security audit's remaining lows (13 Nov 2026, docs/reports/security-audit-2026-11-11.md
 * sections 5c and 11), group L2: AI, imports, unbounded lists, chat. Each fix shown to hold the way it was broken, by
 * calling the server's own code:
 *
 *   A4   the copilot's confirm card carries a task's whole description and its assignee ("This task is for …"), and a
 *        note's whole body — live, and when a conversation is shown again (read from the proposal row)
 *   A5   a person's daily AI cap defaults to 200 credits when the admin hasn't set one; 0 is no cap; the settings
 *        screen says which
 *   A6   /api/copilot/chat checks copilot.use before it reads the body, and reads it under 16 KB, chunked or not;
 *        the AI Knowledge upload reads its form under its 25 MB ceiling as it streams
 *   A7   copilot conversations untouched for 90 days are swept; a lookup older than 7 days goes back to the model as
 *        an "expired" note, still paired with its call
 *   low  an import area whose module isn't in the plan (or is switched off) is refused
 *   low  ten raw-list actions refuse a list that is too long or not strings
 *   low  somebody no longer in a chat can't delete their old message there
 *   low  everybody else with payments.manage is told when a payee's bank details change (SEC-17 follow-up)
 *
 * Its own fixture, tagged ZZL2 (people on @zzl2.invalid), removed in a finally; the copilot settings row is put back
 * exactly as found. No model is called, no mail is sent, no notification is written (the bell is stood in for).
 *
 *   npx tsx scripts/check-audit-lows-ai.ts
 */
import "dotenv/config";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";

process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
const modulesOff = new Set<string>();
const notified: { userId: string; type: string; title: string; message?: string }[] = [];

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") return { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      requireUser: async () => {
        if (!actor) throw new Error("Unauthorized");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      requireModuleAccess: async () => actor,
      requireModuleUser: async () => actor,
      moduleAvailableForTenant: async (key: string) => !modulesOff.has(key),
    };
  }
  if (request === "@/actions/module") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, isModuleEnabled: async (key: string) => !modulesOff.has(key) };
  }
  if (request === "@/lib/notify") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      notifyUser: async (n: { userId: string; type: string; title: string; message?: string }) => {
        notified.push(n);
      },
    };
  }
  if (request === "@/lib/chat/bus") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, publish: async () => undefined };
  }
  if (request === "@/lib/app/push") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, pushChatToPhones: async () => undefined };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const TAG = "ZZL2";
const MAIL = "@zzl2.invalid";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)?.slice(0, 300)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const DAY = 86_400_000;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const tools = require("../src/lib/copilot/tools") as typeof import("../src/lib/copilot/tools");
  const copilot = require("../src/actions/copilot") as typeof import("../src/actions/copilot");
  const settingsLib = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
  const retention = require("../src/lib/copilot/retention") as typeof import("../src/lib/copilot/retention");
  const agent = require("../src/lib/copilot/agent") as typeof import("../src/lib/copilot/agent");
  const { ProposalCard } = require("../src/components/copilot/chat-blocks") as typeof import("../src/components/copilot/chat-blocks");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const dataImport = require("../src/actions/data-import") as typeof import("../src/actions/data-import");
  const dashboard = require("../src/actions/dashboard") as typeof import("../src/actions/dashboard");
  const department = require("../src/actions/department") as typeof import("../src/actions/department");
  const pageLayout = require("../src/actions/page-layout") as typeof import("../src/actions/page-layout");
  const tablePref = require("../src/actions/table-preference") as typeof import("../src/actions/table-preference");
  const inbox = require("../src/actions/inbox") as typeof import("../src/actions/inbox");
  const quick = require("../src/actions/quick-messages") as typeof import("../src/actions/quick-messages");
  const statements = require("../src/actions/statement-send") as typeof import("../src/actions/statement-send");
  const survey = require("../src/actions/survey") as typeof import("../src/actions/survey");
  const chat = require("../src/actions/chat") as typeof import("../src/actions/chat");
  const commission = require("../src/actions/commission-party") as typeof import("../src/actions/commission-party");
  /* eslint-enable @typescript-eslint/no-require-imports */
  type ProposalBlock = import("../src/lib/copilot/types").ProposalBlock;

  const originalSettings = await db.copilotSettings.findUnique({ where: { id: "global" } });
  const restoreSettings = async () => {
    if (originalSettings) await db.copilotSettings.upsert({ where: { id: originalSettings.id }, create: originalSettings, update: originalSettings });
    else await db.copilotSettings.deleteMany({ where: { id: "global" } });
  };

  const cleanup = async () => {
    const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
    await db.chat.deleteMany({ where: { name: { startsWith: TAG } } });
    await db.copilotConversation.deleteMany({ where: { userId: { in: ids } } });
    const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await db.commissionPartyAccount.deleteMany({ where: { commissionPartyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
    await db.department.deleteMany({ where: { name: { startsWith: TAG } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.activityLog.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await db.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: ids } } });
  };

  await cleanup();
  try {
    const make = async (name: string, grants: string[], deny: string[] = []) =>
      db.user.create({
        data: {
          name: `Zzl2 ${name}`,
          email: `${name}${MAIL}`,
          role: "SALES",
          passwordHash: "x".repeat(60),
          permissionGrants: {
            create: [...grants.map((permission) => ({ permission, allowed: true, reason: TAG })), ...deny.map((permission) => ({ permission, allowed: false, reason: TAG }))],
          },
        },
        select: { id: true, role: true, name: true, email: true },
      });

    // ─────────────────────────────────────────────────────────────────────────
    section("A4: the confirm card shows everything Create will save");
    const asker = await make("asker", ["copilot.use", "tasks.view", "notes.view"]);
    const colleague = await make("colleague", ["tasks.view"]);
    actor = asker;
    const conversation = await db.copilotConversation.create({ data: { userId: asker.id, title: `${TAG} card` }, select: { id: true } });
    const offered = await tools.toolsFor();
    const ctx = { userId: asker.id, conversationId: conversation.id };
    const longDescription = `${TAG} start. ${"Wire the refund to the new account. ".repeat(40)}end of the description.`;
    const forOther = await tools.runTool(offered, ctx, "propose_task", { title: `${TAG} Follow up`, description: longDescription, assigneeUserId: colleague.id });
    const otherBlock = forOther.blocks?.[0] as ProposalBlock | undefined;
    ok("a task for somebody else: the card carries the whole description", !forOther.isError && otherBlock?.details === longDescription, forOther.isError ? forOther.output : otherBlock?.details?.length);
    ok("  and says who it's for, as somebody else", otherBlock?.assignee?.name === colleague.name && otherBlock.assignee.other === true, otherBlock?.assignee);
    ok("  the one-line summary is still there", !!otherBlock?.summary.includes(`for ${colleague.name}`), otherBlock?.summary);
    const own = await tools.runTool(offered, ctx, "propose_task", { title: `${TAG} Mine` });
    const ownBlock = own.blocks?.[0] as ProposalBlock | undefined;
    ok("a task for the asker says so, not 'for somebody else'", ownBlock?.assignee?.other === false && ownBlock.assignee.name === asker.name, ownBlock?.assignee);
    const longBody = `${TAG} ${"A note longer than the old 140-character summary showed. ".repeat(8)}last words.`;
    const note = await tools.runTool(offered, ctx, "propose_note", { body: longBody });
    const noteBlock = note.blocks?.[0] as ProposalBlock | undefined;
    ok("a note: the card carries the whole body, past the summary's 140 characters", noteBlock?.details === longBody && !noteBlock.summary.includes("last words."), noteBlock?.summary);

    const html = renderToStaticMarkup(createElement(ProposalCard, { block: otherBlock!, onChange: () => {} }));
    const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");
    ok("the card, drawn: 'This task is for <name>' and the description's last words", text.includes(`This task is for ${colleague.name}`) && text.includes("end of the description."), text.slice(0, 200));
    const ownHtml = renderToStaticMarkup(createElement(ProposalCard, { block: ownBlock!, onChange: () => {} }));
    ok("  one's own task isn't flagged as somebody else's", !ownHtml.includes("This task is for") && ownHtml.includes("Assigned to you"));

    // Shown again later: a card stored before the fix (no details), filled from the proposal row itself.
    const bare = (b: ProposalBlock | undefined) => ({ type: "proposal", id: b!.id, kind: b!.kind, summary: b!.summary });
    await db.copilotMessage.create({ data: { conversationId: conversation.id, role: "user", content: { text: "draft it" } } });
    await db.copilotMessage.create({ data: { conversationId: conversation.id, role: "tool", content: { results: [], blocks: [bare(otherBlock), bare(noteBlock)] } } });
    const shown = await copilot.getCopilotConversation(conversation.id);
    const cards = (shown?.items ?? []).flatMap((i) => (i.role === "assistant" ? i.segments : [])).flatMap((s) => (s.kind === "block" && s.block.type === "proposal" ? [s.block] : []));
    const shownTask = cards.find((c) => c.id === otherBlock!.id);
    const shownNote = cards.find((c) => c.id === noteBlock!.id);
    ok("shown again, an old card is filled from the proposal: description and assignee", shownTask?.details === longDescription && shownTask.assignee?.name === colleague.name && shownTask.assignee.other === true, shownTask);
    ok("  and a note's whole body", shownNote?.details === longBody && shownNote.assignee === null, shownNote?.details?.length);

    // ─────────────────────────────────────────────────────────────────────────
    section("A5: a default daily cap per person");
    settingsLib.setTestSettings(null);
    ok("the default is 200 credits", settingsLib.DEFAULT_DAILY_CREDIT_LIMIT === 200);
    await db.copilotSettings.upsert({ where: { id: "global" }, create: { id: "global", enabled: true, dailyCreditLimit: null }, update: { dailyCreditLimit: null } });
    ok("not set: the cap that applies is the default", (await settingsLib.copilotConfig()).dailyCreditLimit === 200);
    await db.copilotSettings.update({ where: { id: "global" }, data: { dailyCreditLimit: settingsLib.NO_DAILY_CAP } });
    ok("'none' (kept as the old ceiling, the column holding it above 0): no cap", (await settingsLib.copilotConfig()).dailyCreditLimit === null && (await settingsLib.storedDailyLimit()) === 0);
    await db.copilotSettings.update({ where: { id: "global" }, data: { dailyCreditLimit: 35 } });
    ok("a number: that cap", (await settingsLib.copilotConfig()).dailyCreditLimit === 35);

    const admin = await make("admin", ["settings.manage", "copilot.use"]);
    actor = admin;
    let saved = await copilot.saveCopilotSettings({ enabled: true, draftingEnabled: false, dailyCreditLimit: null });
    ok("saving it blank stores 'not set', which is the default", saved.ok && (await db.copilotSettings.findUnique({ where: { id: "global" }, select: { dailyCreditLimit: true } }))?.dailyCreditLimit === null && (await settingsLib.copilotConfig()).dailyCreditLimit === 200, saved);
    saved = await copilot.saveCopilotSettings({ enabled: true, draftingEnabled: false, dailyCreditLimit: 0 });
    ok("saving 0 stores no cap — still editable", saved.ok && (await settingsLib.storedDailyLimit()) === 0 && (await settingsLib.copilotConfig()).dailyCreditLimit === null, saved);
    saved = await copilot.saveCopilotSettings({ enabled: true, draftingEnabled: false, dailyCreditLimit: 40 });
    ok("saving 40 stores 40", saved.ok && (await settingsLib.copilotConfig()).dailyCreditLimit === 40, saved);
    ok("a negative cap is refused, and one at the 'none' value", !(await copilot.saveCopilotSettings({ enabled: true, draftingEnabled: false, dailyCreditLimit: -1 })).ok && !(await copilot.saveCopilotSettings({ enabled: true, draftingEnabled: false, dailyCreditLimit: settingsLib.NO_DAILY_CAP })).ok);
    await db.copilotSettings.update({ where: { id: "global" }, data: { dailyCreditLimit: null } });
    try {
      const screen = await copilot.getCopilotSettings();
      ok("the settings screen gets the stored value and the default to show", screen?.dailyCreditLimit === null && screen.defaultDailyCreditLimit === 200, screen ? { cap: screen.dailyCreditLimit, def: screen.defaultDailyCreditLimit } : null);
    } catch (err) {
      ok("the settings screen gets the stored value and the default to show", false, err instanceof Error ? err.message : String(err));
    }
    await restoreSettings();

    // ─────────────────────────────────────────────────────────────────────────
    section("A6: the chat endpoint checks first, then reads under a ceiling");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { POST } = require("../src/app/api/copilot/chat/route") as typeof import("../src/app/api/copilot/chat/route");
    const appHeaders = { origin: "http://localhost:3000", host: "localhost:3000", "content-type": "application/json" };
    const outsider = await make("outsider", [], ["copilot.use"]);
    actor = outsider;
    const big = new Request("http://localhost:3000/api/copilot/chat", { method: "POST", headers: appHeaders, body: JSON.stringify({ message: "x".repeat(1_000_000) }) });
    let res = await POST(big);
    ok("without copilot.use: 403, before the body is read", res.status === 403 && big.bodyUsed === false, { status: res.status, bodyUsed: big.bodyUsed });
    actor = asker;
    res = await POST(new Request("http://localhost:3000/api/copilot/chat", { method: "POST", headers: appHeaders, body: JSON.stringify({ message: "x".repeat(20_000) }) }));
    ok("with it, a body past 16 KB: 413", res.status === 413, res.status);
    const chunks = (n: number) => {
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= n) return controller.close();
          sent += 1;
          controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
        },
      });
    };
    res = await POST(new Request("http://localhost:3000/api/copilot/chat", { method: "POST", headers: appHeaders, body: chunks(64), duplex: "half" } as RequestInit));
    ok("  and a chunked one with no length: 413 too", res.status === 413, res.status);
    settingsLib.setTestSettings({ enabled: false, draftingEnabled: false, dailyCreditLimit: null });
    res = await POST(new Request("http://localhost:3000/api/copilot/chat", { method: "POST", headers: appHeaders, body: JSON.stringify({ message: "hello" }) }));
    const lines = (await res.text()).trim().split("\n");
    ok("a small message is read and reaches the copilot (switched off here, so it says so)", res.status === 200 && lines.some((l) => l.includes("switched off")), lines);
    settingsLib.setTestSettings(null);
    res = await POST(new Request("http://localhost:3000/api/copilot/chat", { method: "POST", headers: appHeaders, body: "not json" }));
    ok("  and a body that isn't JSON is a 400", res.status === 400, res.status);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const upload = require("../src/app/api/ai-knowledge/upload/route") as typeof import("../src/app/api/ai-knowledge/upload/route");
    actor = admin;
    const huge = new Request("http://localhost:3000/api/ai-knowledge/upload", {
      method: "POST",
      headers: { origin: "http://localhost:3000", host: "localhost:3000", "content-type": "multipart/form-data; boundary=zzl2" },
      body: chunks(26 * 256 + 10), // a little over 26 MB, with no length declared
      duplex: "half",
    } as RequestInit);
    res = await upload.POST(huge);
    ok("AI Knowledge: an upload past 25 MB with no declared length is stopped while streaming (413)", res.status === 413, res.status);

    // ─────────────────────────────────────────────────────────────────────────
    section("A7: copilot conversations aren't kept, or replayed, for ever");
    const now = Date.now();
    const old = await db.copilotConversation.create({ data: { userId: asker.id, title: `${TAG} old` }, select: { id: true } });
    await db.copilotMessage.create({ data: { conversationId: old.id, role: "user", content: { text: "old" } } });
    await db.copilotConversation.update({ where: { id: old.id }, data: { updatedAt: new Date(now - 91 * DAY) } });
    const recent = await db.copilotConversation.create({ data: { userId: asker.id, title: `${TAG} recent` }, select: { id: true } });
    await db.copilotConversation.update({ where: { id: recent.id }, data: { updatedAt: new Date(now - 89 * DAY) } });
    const swept = await retention.sweepOldCopilotConversations(new Date(now), [asker.id]);
    ok("one untouched for 91 days is deleted, with its messages", swept === 1 && !(await db.copilotConversation.findUnique({ where: { id: old.id } })) && (await db.copilotMessage.count({ where: { conversationId: old.id } })) === 0, swept);
    ok("  one touched 89 days ago stays", !!(await db.copilotConversation.findUnique({ where: { id: recent.id } })));
    const heartbeat = readFileSync(join(__dirname, "../src/lib/marketing/heartbeat.ts"), "utf8");
    ok("  the sweep runs with the heartbeat's once-a-day part", /lastActivitySweep[\s\S]{0,1200}sweepOldCopilotConversations\(\)/.test(heartbeat));

    const replay = await db.copilotConversation.create({ data: { userId: asker.id, title: `${TAG} replay` }, select: { id: true } });
    const at = (daysAgo: number, minutes = 0) => new Date(now - daysAgo * DAY + minutes * 60_000);
    const secret = `${TAG}-customer-list-from-last-month`;
    await db.copilotMessage.createMany({
      data: [
        { conversationId: replay.id, role: "user", content: { text: "who owes us?" }, createdAt: at(10) },
        { conversationId: replay.id, role: "assistant", content: { text: "", toolCalls: [{ id: "c1", name: "search_companies", input: { query: "x" } }] }, createdAt: at(10, 1) },
        { conversationId: replay.id, role: "tool", content: { results: [{ id: "c1", name: "search_companies", output: secret }] }, createdAt: at(10, 2) },
        { conversationId: replay.id, role: "assistant", content: { text: "Here.", toolCalls: [] }, createdAt: at(10, 3) },
        { conversationId: replay.id, role: "user", content: { text: "and today?" }, createdAt: at(1) },
        { conversationId: replay.id, role: "assistant", content: { text: "", toolCalls: [{ id: "c2", name: "search_companies", input: { query: "y" } }] }, createdAt: at(1, 1) },
        { conversationId: replay.id, role: "tool", content: { results: [{ id: "c2", name: "search_companies", output: "fresh-result" }] }, createdAt: at(1, 2) },
      ],
    });
    const turns = await agent.history(replay.id, new Date(now));
    const toolTurns = turns.filter((t) => t.role === "tool") as Extract<(typeof turns)[number], { role: "tool" }>[];
    ok("a lookup from 10 days ago goes back as an 'expired' note, not its answer", toolTurns[0]?.results[0]?.output === retention.STALE_TOOL_RESULT && !JSON.stringify(turns).includes(secret), toolTurns[0]?.results[0]);
    ok("  still paired with its call (same id), as every provider needs", toolTurns[0]?.results[0]?.id === "c1" && turns.some((t) => t.role === "assistant" && t.toolCalls.some((c) => c.id === "c1")));
    ok("  yesterday's lookup goes back as it was", toolTurns[1]?.results[0]?.output === "fresh-result");

    // ─────────────────────────────────────────────────────────────────────────
    section("Imports: an area outside the plan is refused");
    const importer = await make("importer", ["data.importCrm", "data.exportCrm"]);
    actor = importer;
    const csv = Buffer.from("Subject,Company\nZZL2 ticket,ZZL2 nobody\n").toString("base64");
    modulesOff.add("helpdesk");
    let preview = await dataImport.previewImport({ area: "tickets", filename: "t.csv", base64: csv });
    ok("tickets with the helpdesk not in the plan: refused, saying why", !preview.ok && /plan/.test(preview.error), preview.ok ? "it previewed" : preview.error);
    const commit = await dataImport.commitImport({ area: "tickets", filename: "t.csv", base64: csv } as Parameters<typeof dataImport.commitImport>[0]);
    ok("  committing is refused the same way", !commit.ok && /plan/.test(commit.error), commit.ok ? "it imported" : commit.error);
    const template = await dataImport.importTemplate("tickets");
    ok("  and so is its template", !template.ok && /plan/.test(template.error), template.ok ? "it gave one" : template.error);
    modulesOff.delete("helpdesk");
    preview = await dataImport.previewImport({ area: "tickets", filename: "t.csv", base64: csv });
    ok("with the helpdesk in the plan, the same file isn't refused for the plan", preview.ok || !/plan/.test(preview.error), preview.ok ? "" : preview.error);
    modulesOff.add("accounting");
    actor = await make("financeimporter", ["data.importFinance", "ledger.manageAccounts"]);
    preview = await dataImport.previewImport({ area: "ledger", filename: "l.csv", base64: csv });
    ok("the chart of accounts with accounting off: refused", !preview.ok && /plan/.test(preview.error), preview.ok ? "it previewed" : preview.error);
    modulesOff.delete("accounting");

    // ─────────────────────────────────────────────────────────────────────────
    section("Raw lists: a count and a type on each");
    const lister = await make("lister", ["users.manage", "messages.send"]);
    actor = lister;
    const many = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);
    const refusedMany = (r: { ok: boolean; error?: string }) => !r.ok && /too many/i.test(r.error ?? "");
    const refusedBad = (r: { ok: boolean; error?: string }) => !r.ok && /isn't valid|aren't valid/i.test(r.error ?? "");
    const notStrings = [{ evil: true }, 1] as unknown as string[];
    const longOne = ["x".repeat(5000)];
    const dept = await db.department.create({ data: { name: `${TAG} dept` }, select: { id: true } });
    const listCalls: [string, (list: string[]) => Promise<{ ok: boolean; error?: string }>, number][] = [
      ["setDashboardPreferences", (l) => dashboard.setDashboardPreferences(l), 200],
      ["setDepartmentDashboardWidgets", (l) => department.setDepartmentDashboardWidgets(dept.id, l), 200],
      ["setPageLayout", (l) => pageLayout.setPageLayout("zz-any", l), 200],
      ["setTableColumns", (l) => tablePref.setTableColumns("zz-any", l), 200],
      ["inboxSetTags", (l) => inbox.inboxSetTags("zz", l), 50],
      ["createGroupChat", (l) => chat.createGroupChat({ name: `${TAG} group`, memberIds: l }), 500],
      ["addGroupMembers", (l) => chat.addGroupMembers("zz", l), 500],
      ["sendQuickMessageEmail", (l) => quick.sendQuickMessageEmail({ moment: "AFTER_CALL", companyId: "zz", contactIds: l, subject: "s", body: "b" } as unknown as Parameters<typeof quick.sendQuickMessageEmail>[0]), 50],
      ["sendStatement", (l) => statements.sendStatement({ side: "CUSTOMER", companyId: "zz", view: { from: null, to: null, show: null }, contactIds: l, subject: "s", body: "b" } as unknown as Parameters<typeof statements.sendStatement>[0]), 50],
    ];
    for (const [name, call, max] of listCalls) {
      const tooLongList = await call(many(max + 1));
      ok(`${name}: ${max + 1} entries refused as too many`, refusedMany(tooLongList), tooLongList);
      const wrongType = await call(notStrings);
      const tooLongEntry = await call(longOne);
      ok(`  non-strings and a 5,000-character entry refused`, refusedBad(wrongType) && refusedBad(tooLongEntry), { wrongType, tooLongEntry });
    }
    const atMax = await dashboard.setDashboardPreferences(many(200));
    ok("200 widgets (the most) still saves", atMax.ok, atMax);
    let splashThrew = "";
    try {
      await survey.pendingSplash({ includes: () => true, length: 1e9 } as unknown as string[]);
      await survey.pendingSplash([...many(10_000), "y".repeat(10_000)]);
    } catch (err) {
      splashThrew = err instanceof Error ? err.message : String(err);
    }
    ok("pendingSplash: a list that isn't one, or a huge one, is cut down, not trusted", !/includes/.test(splashThrew), splashThrew);

    // ─────────────────────────────────────────────────────────────────────────
    section("Chat: somebody removed can't delete their old message");
    const host = await make("host", []);
    const removed = await make("removed", []);
    const group = await db.chat.create({ data: { kind: "GROUP", name: `${TAG} room`, createdById: host.id }, select: { id: true } });
    await db.chatMember.create({ data: { chatId: group.id, userId: host.id, isAdmin: true } });
    await db.chatMember.create({ data: { chatId: group.id, userId: removed.id } });
    const said = await db.chatMessage.create({ data: { chatId: group.id, senderId: removed.id, body: `${TAG} said while a member` }, select: { id: true } });
    await db.chatMember.update({ where: { chatId_userId: { chatId: group.id, userId: removed.id } }, data: { leftAt: new Date() } });
    actor = removed;
    const del = await chat.deleteChatMessage(said.id);
    ok("deleting after being removed is refused", !del.ok && /no longer in this chat/.test(del.error), del);
    const still = await db.chatMessage.findUnique({ where: { id: said.id }, select: { body: true, deletedAt: true } });
    ok("  and the message is as it was", still?.body === `${TAG} said while a member` && !still.deletedAt, still);
    const edit = await chat.editChatMessage(said.id, `${TAG} rewritten`);
    ok("  editing was already refused, and still is", !edit.ok, edit);
    await db.chatMember.update({ where: { chatId_userId: { chatId: group.id, userId: removed.id } }, data: { leftAt: null } });
    const delBack = await chat.deleteChatMessage(said.id);
    ok("a current member still deletes their own message", delBack.ok, delBack);

    // ─────────────────────────────────────────────────────────────────────────
    section("SEC-17 follow-up: finance is told when payee bank details change");
    const changer = await make("changer", ["payments.manage", "companies.viewAll", "companies.edit", "companies.editAll"]);
    const otherFinance = await make("otherfinance", ["payments.manage"]);
    const party = await db.company.create({ data: { name: `${TAG} Referrer`, normalizedName: `${TAG.toLowerCase()} referrer`, relationshipType: "COMMISSION_PARTY", createdById: changer.id, ownerUserId: changer.id }, select: { id: true } });
    const account = await db.commissionPartyAccount.create({
      data: { commissionPartyId: party.id, label: `${TAG} Primary`, accountHolderName: "Zz Holder", bankAccountNumber: "000111222333", bankIfsc: "HDFC0000001", isDefault: true },
      select: { id: true },
    });
    actor = changer;
    notified.length = 0;
    const base = { label: `${TAG} Primary`, accountHolderName: "Zz Holder", panNumber: "", bankAccountNumber: "000111222333", bankIfsc: "HDFC0000001", bankName: "", upiId: "", isDefault: true };
    let changed = await commission.updateCommissionPartyAccount(account.id, { ...base, label: `${TAG} Main` });
    ok("a change of label only tells nobody", changed.ok && notified.length === 0, changed.ok ? notified : changed);
    changed = await commission.updateCommissionPartyAccount(account.id, { ...base, label: `${TAG} Main`, bankAccountNumber: "999888777666", bankIfsc: "ICIC0000002" });
    const toOther = notified.find((n) => n.userId === otherFinance.id);
    ok("a new account number and IFSC: the other payments.manage holder is told", changed.ok && !!toOther && /account number/.test(toOther.message ?? "") && /IFSC/.test(toOther.message ?? ""), changed.ok ? toOther : changed);
    ok("  the person who made the change isn't", !notified.some((n) => n.userId === changer.id));
    ok("  and the bell names the fields, never the number", !notified.some((n) => `${n.title} ${n.message}`.includes("999888777666")));
    notified.length = 0;
    const created = await commission.createCommissionPartyAccount(party.id, { ...base, label: `${TAG} Second`, upiId: "zz@upi", isDefault: false });
    ok("a new payee account tells them too", created.ok && notified.some((n) => n.userId === otherFinance.id && /UPI/.test(n.message ?? "")), created.ok ? notified.length : created);
  } finally {
    actor = null;
    settingsLib.setTestSettings(null);
    await restoreSettings().catch((err: unknown) => console.error("settings restore failed", err));
    await cleanup().catch((err: unknown) => console.error("cleanup failed", err));
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  await db.$disconnect().catch(() => undefined);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
