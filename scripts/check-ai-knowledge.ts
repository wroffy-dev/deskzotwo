/**
 * check:ai-knowledge — AI Knowledge (owner, 3 Nov 2026; src/lib/ai-knowledge): the company's own .md and .txt files
 * that Deskzo AI answers from.
 *
 * Without a database:
 *
 *   · cutting a file into chunks at its headings, about 800 characters each: the headings above a chunk kept with it;
 *     small sections put together, a new `#` topic never; a long section cut at paragraphs, lines, sentences, words —
 *     never inside a word; a `#` in a code fence isn't a heading; a .txt file has none; line endings, a byte-order
 *     mark and front matter tidied; every file in deskzo-knowledge/ cut with nothing lost and no chunk too big;
 *   · reading an upload: several files, a .zip with its folder's own name left off and the folders inside kept; what
 *     isn't text, is empty, too big, a repeat or outside the .zip left out and said so; a .zip that unpacks too far
 *     refused before it's inflated;
 *   · the 4,000 characters (qwen2.5:7b has 8k of context): the copilot's five chunks and the inbox's three, with the
 *     website's passages, never past it — the last one cut at a word, a scrap left out;
 *   · the copilot told to search AI Knowledge first for company, product and process questions, and to name the
 *     file — only while there's AI Knowledge to search; the inbox's brief given the chunks, told never to name files;
 *   · a channel's "Use AI Knowledge": off by default, kept when ticked, and enough on its own for the AI to go on;
 *   · Settings › AI Knowledge in the settings catalogue, for `settings.manage`.
 *
 * With the database (files named zzaik-probe/…, removed in a finally):
 *
 *   · the chunks' tsvector made by the database and GIN-indexed; a question finds the chunk that answers it first —
 *     its words in any form ("invoicing" finds "invoice"), Hinglish too, any of its words enough, the chunk with all
 *     of them first; nothing for a question of only small words; the limit kept;
 *   · uploading a file again, in another case, replaces it and its chunks; editing and renaming; a name clash
 *     refused; deleting takes its chunks;
 *   · only `settings.manage`, never while viewing as somebody: the page, every action and the upload route — which
 *     takes no upload from another site;
 *   · the copilot's search_knowledge: offered once there's a file, the best chunks with their files, at most 4,000
 *     characters; its input checked;
 *   · the inbox's bot on a channel with "Use AI Knowledge": the AI is told the 3 best chunks before it answers;
 *     a channel without it is told none.
 *
 *   npm run check:ai-knowledge
 */
import "dotenv/config";
import Module from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import JSZip from "jszip";
import { AI_KNOWLEDGE_LIMITS, chunkFile, fileTitle, normaliseText, splitText } from "../src/lib/ai-knowledge/chunk";
import { decodeText, knowledgeName, readKnowledgeUpload } from "../src/lib/ai-knowledge/upload";
import {
  COPILOT_KNOWLEDGE_CHUNKS,
  INBOX_KNOWLEDGE_CHUNKS,
  KNOWLEDGE_PROMPT_CHARS,
  copilotRender,
  cutAtWord,
  fitKnowledge,
  inboxFileRender,
  inboxPageRender,
  renderedLength,
} from "../src/lib/ai-knowledge/budget";
import { searchableText } from "../src/lib/ai-knowledge/search";
import { channelSettings, checkChannelSettings, defaultChannelSettings, type ChannelSettings } from "../src/lib/inbox/settings";
import { SETTINGS_ITEMS } from "../src/lib/settings/catalogue";

let actorId = "";
let viewingAs = false;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/settings/ai-knowledge",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => (actorId ? { id: actorId, role: "SALES", name: "Zzaik", email: `${actorId}${MAIL}` } : null);
    return {
      requireUser: async () => {
        const u = user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: async () => user(),
      viewAsContext: async () => (viewingAs ? { user: user(), actor: user() } : null),
      refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody." : null),
    };
  }
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const PREFIX = "zzaik-probe/";
const TAG = "ZZAIK";
const MAIL = "@zzprobe-ai-knowledge.invalid";
const HOST = "zz.localhost:3000";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

/** Every word of a text, for "nothing was lost". */
const wordsOf = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1));

async function pure() {
  section("Cutting a file into chunks, at its headings");

  const faq = [
    "# Leads — Zz",
    "",
    "Leads is the sales pipeline.",
    "",
    "## Q: How do I add a lead?",
    "A: Go to Sales → Leads and click **New lead**.",
    "",
    "## Q: Who can see leads?",
    "A: Whoever has **View leads**.",
    "",
    "# Orders",
    "",
    "Orders are what customers bought.",
  ].join("\n");
  const small = chunkFile(faq);
  ok("small sections in a row are one chunk, each with its own heading line", small.length === 2 && small[0]!.text.includes("## Q: How do I add a lead?") && small[0]!.text.includes("## Q: Who can see leads?") && small[0]!.text.includes("Leads is the sales pipeline."), small);
  ok("  under the headings they share; a new # topic is a chunk of its own", small[0]!.heading === "Leads — Zz" && small[1]!.heading === "Orders" && small[1]!.text === "Orders are what customers bought.", small);

  const para = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ") + ".";
  const longSection = ["# Payroll", "", "## Q: How is PF worked out?", para(60, "alpha"), "", para(60, "beta"), "", para(60, "gamma"), "", "## Q: Next", "Short answer."].join("\n");
  const cut = chunkFile(longSection);
  const pf = cut.filter((c) => c.heading === "Payroll › Q: How is PF worked out?");
  ok("a long section is cut into pieces of at most 800 characters, each under the section's headings", pf.length >= 2 && pf.every((c) => c.text.length <= AI_KNOWLEDGE_LIMITS.chunkChars), cut.map((c) => [c.heading, c.text.length]));
  ok("  cut between paragraphs, never inside a word", pf.every((c) => /^(alpha|beta|gamma)0\b/.test(c.text) && /\.$/.test(c.text)), pf.map((c) => c.text.slice(0, 12) + "…" + c.text.slice(-6)));
  ok("  and the heading isn't repeated in the text (it's the chunk's heading)", !pf.some((c) => c.text.includes("## Q: How is PF")));
  ok("the section after it is its own chunk", cut[cut.length - 1]!.heading === "Payroll › Q: Next" && cut[cut.length - 1]!.text === "Short answer.");

  const oneParagraph = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} explains one more thing about the product.`).join(" ");
  const sentences = splitText(oneParagraph);
  ok("one long paragraph is cut at its sentences", sentences.length >= 3 && sentences.every((s) => s.length <= 800 && s.endsWith(".")), sentences.map((s) => s.length));
  const words = splitText(Array.from({ length: 400 }, (_, i) => `word${i}`).join(" "));
  ok("  a run without full stops at its words", words.length >= 3 && words.every((s) => s.length <= 800 && /^word\d+$/.test(s.split(" ")[0]!) && /word\d+$/.test(s)));
  ok("  only a word longer than a chunk is ever cut through", splitText("x".repeat(2000)).every((s) => s.length <= 800));
  const tail = chunkFile(["## Tail", "a".repeat(700), "", "b".repeat(700), "", "c".repeat(60)].join("\n"));
  ok("a short last piece stays with the one before it", tail.length === 2 && tail[1]!.text.endsWith("c".repeat(60)) && tail[1]!.text.length <= AI_KNOWLEDGE_LIMITS.chunkMaxChars, tail.map((c) => c.text.length));

  const fenced = chunkFile(["# Script", "", "```bash", "# not a heading", "echo hi", "```", "", "## Real heading", "Text."].join("\n"));
  ok("a # inside a code fence is code, not a heading", fenced.length === 1 && fenced[0]!.text.includes("# not a heading") && fenced[0]!.text.includes("## Real heading") && fenced[0]!.heading === "Script", fenced);
  ok("headings lose their Markdown: **bold**, `code`, [links](…)", chunkFile("## **Pricing** for `INR` and [GST](https://x.example)\nIt costs ₹1,499.")[0]!.heading === "Pricing for INR and GST");
  ok("a .txt file has no headings: cut at its paragraphs", chunkFile(`# not read as a heading\n\n${"p".repeat(500)}\n\n${"q".repeat(500)}`, { markdown: false }).every((c) => c.heading === ""));
  ok("Windows line endings, a byte-order mark and YAML front matter are tidied away", normaliseText("﻿---\ntitle: x\n---\r\n# Hi\r\n\r\n\r\n\r\nThere  \r\n") === "# Hi\n\nThere");
  ok("a file's title is its first heading", fileTitle("Intro\n\n## First one\n# Second", true) === "First one" && fileTitle("# Title", false) === "");
  ok("an empty file has no chunks", chunkFile("   \n\n ").length === 0);

  // The real thing: the knowledge base this feature was asked for (deskzo-knowledge/, 81 files).
  const dir = "deskzo-knowledge";
  const names = readdirSync(dir).filter((f) => f.endsWith(".md"));
  let all = 0;
  let biggest = 0;
  const lost: string[] = [];
  for (const name of names) {
    const content = readFileSync(`${dir}/${name}`, "utf8");
    const chunks = chunkFile(content);
    all += chunks.length;
    biggest = Math.max(biggest, ...chunks.map((c) => c.text.length));
    const kept = wordsOf(chunks.map((c) => `${c.heading} ${c.text}`).join(" "));
    const missing = [...wordsOf(content)].filter((w) => !kept.has(w));
    if (missing.length || chunks.some((c) => !c.text.trim())) lost.push(`${name}: ${missing.slice(0, 5).join(", ")}`);
  }
  ok(`every file of ${dir}/ cut: ${names.length} files, ${all} chunks, none over ${AI_KNOWLEDGE_LIMITS.chunkMaxChars} characters`, names.length >= 70 && all > names.length * 5 && biggest <= AI_KNOWLEDGE_LIMITS.chunkMaxChars, { biggest });
  ok("  every word of every file is in one of its chunks; none is empty", lost.length === 0, lost.slice(0, 3));

  section("Reading an upload: files, a .zip, and what's left out");

  const enc = (s: string) => Buffer.from(s, "utf8");
  const zip = new JSZip();
  zip.file("kb/leads.md", "# Leads\nAbout leads.");
  zip.file("kb/policies/refunds.txt", "Refunds in 7 days.");
  zip.file("kb/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  zip.file("kb/empty.md", "   ");
  zip.file("kb/.hidden.md", "secret");
  zip.file("__MACOSX/kb/._leads.md", "junk");
  zip.file("kb/big.md", "z".repeat(1024 * 1024 + 10));
  const zipped = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const read = await readKnowledgeUpload([
    { name: "faq.md", bytes: enc("# FAQ\nQuestions.") },
    { name: "notes.txt", bytes: enc("Plain notes.") },
    { name: "guides.zip", bytes: zipped },
    { name: "FAQ.md", bytes: enc("# Again") },
    { name: "picture.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff]) },
    { name: "binary.md", bytes: Buffer.from([0x41, 0x00, 0x42]) },
  ]);
  const names2 = read.files.map((f) => f.name).sort();
  ok("several files at once, and a .zip's files under their paths — the zipped folder's own name left off", names2.join() === "faq.md,leads.md,notes.txt,policies/refunds.txt", names2);
  const why = (name: string) => read.skipped.find((s) => s.name === name)?.reason ?? "";
  ok("  left out and said why: not text, empty, over 1 MB, not .md/.txt, a second file of one name", /isn't text/.test(why("binary.md")) && /empty/.test(why("empty.md")) && /over 1 MB/.test(why("big.md")) && /not a \.md/.test(why("picture.jpg")) && /not a \.md/.test(why("logo.png")) && /same name/.test(why("FAQ.md")), read.skipped);
  ok("  hidden files and the Mac's __MACOSX aren't anybody's knowledge", !read.files.some((f) => f.name.includes("hidden") || f.name.includes("MACOSX")) && !read.skipped.some((s) => s.name.includes("MACOSX") || s.name.includes("hidden")));
  ok("text as Windows' Notepad saves it (UTF-16) is read; a NUL is a program", decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("नमस्ते Hi", "utf16le")])) === "नमस्ते Hi" && decodeText(Buffer.from([0x41, 0, 0x42])) === null);
  ok("a name is kept safe: no climbing out, no control characters", knowledgeName("../../etc/passwd.md") === null && knowledgeName("a/./b/../c.md") === "a/c.md" && knowledgeName("we\u0007ird:name?.md") === "weirdname.md" && knowledgeName("x".repeat(300) + ".md") === null);
  const bomb = new JSZip();
  bomb.file("huge.md", "a".repeat(41 * 1024 * 1024));
  const bombRead = await readKnowledgeUpload([{ name: "bomb.zip", bytes: await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) }]);
  ok("a .zip that unpacks past 40 MB is refused before it's inflated", bombRead.files.length === 0 && /40 MB/.test(bombRead.skipped[0]?.reason ?? ""), bombRead.skipped);
  const broken = await readKnowledgeUpload([{ name: "broken.zip", bytes: enc("not a zip") }]);
  ok("  and one that isn't a .zip at all is said so", /couldn't be opened/.test(broken.skipped[0]?.reason ?? ""));

  section("At most 4,000 characters of knowledge in a prompt");

  const hit = (i: number, size: number) => ({ file: `file-${i}.md`, heading: `Topic ${i} › Q: question ${i}?`, text: `${"word ".repeat(Math.floor(size / 5)).trim()} end${i}.` });
  const five = Array.from({ length: COPILOT_KNOWLEDGE_CHUNKS }, (_, i) => hit(i, 1000));
  const fitted = fitKnowledge(five, copilotRender);
  ok("the copilot's five chunks, each of about 1,000 characters: never past 4,000 in all", renderedLength(fitted, copilotRender) <= KNOWLEDGE_PROMPT_CHARS && KNOWLEDGE_PROMPT_CHARS === 4000, renderedLength(fitted, copilotRender));
  ok("  the best ones whole, the last that fits cut at a word with “…”", fitted.length === 4 && fitted.slice(0, 3).every((h, i) => h.text === five[i]!.text) && fitted[3]!.text.endsWith("…") && !fitted[3]!.text.endsWith(" …"), fitted.map((h) => h.text.length));
  ok("  five small ones all fit", fitKnowledge(Array.from({ length: 5 }, (_, i) => hit(i, 500)), copilotRender).length === 5);
  ok("  a scrap isn't worth giving: too little room and it's left out", fitKnowledge([hit(0, 950), hit(1, 950)], copilotRender, 1100).length === 1);
  ok("a cut is at the end of a word", cutAtWord("alpha beta gamma delta", 14) === "alpha beta…" && cutAtWord("short", 10) === "short");

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const aiLib = require("../src/lib/inbox/ai") as typeof import("../src/lib/inbox/ai");
  const web = defaultChannelSettings("WEB");
  const withAi: ChannelSettings = { ...web, bot: { ...web.bot, ai: { on: true, about: "", chargedTo: "u", pages: ["https://zz.example/sitemap.xml"], knowledge: true } } };
  const three = Array.from({ length: INBOX_KNOWLEDGE_CHUNKS }, (_, i) => hit(i, 900));
  const pages = Array.from({ length: 4 }, (_, i) => ({ url: `https://zz.example/p${i}`, title: `Page ${i}`, text: `${"site ".repeat(210).trim()} page${i}.` }));
  const brief = aiLib.briefKnowledge(three, pages);
  ok("the inbox's three chunks and the website's passages: never past 4,000 together", renderedLength(brief.files, inboxFileRender) + renderedLength(brief.pages, inboxPageRender) <= KNOWLEDGE_PROMPT_CHARS, [renderedLength(brief.files, inboxFileRender), renderedLength(brief.pages, inboxPageRender)]);
  ok("  AI Knowledge first — the business wrote it for this — the website in the room left", brief.files.length === 3 && brief.files.every((h, i) => h.text === three[i]!.text) && brief.pages.length < pages.length, brief.pages.length);
  const prompt = aiLib.aiSystemPrompt(withAi, "Zz Traders", null, pages, three);
  ok("  the brief holds exactly those, under their headings", prompt.includes("From the business's own knowledge files:") && prompt.includes(inboxFileRender(three[0]!)) && brief.pages.every((p) => prompt.includes(p.text)) && !prompt.includes("page3."), prompt.length);
  ok("  and is told to answer in its own words, never naming the files", /never mention the files or their names/.test(prompt));
  ok("a brief without AI Knowledge says nothing of it", !aiLib.aiSystemPrompt(withAi, "Zz", null, [], []).includes("knowledge files"));

  section("The copilot is told to look in AI Knowledge first");

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { systemPrompt } = require("../src/lib/copilot/prompt") as typeof import("../src/lib/copilot/prompt");
  const base = { userName: "Asha", role: "SALES", today: "2026-11-03", timeZone: "Asia/Kolkata", appName: "Deskzo" };
  const told = systemPrompt({ ...base, knowledge: true });
  ok("for a company, product or process question: search_knowledge first, and the source file named", /company, its products or services, or a process/.test(told) && /run search_knowledge first/.test(told) && /\(Source: crm-leads\.md\)/.test(told));
  ok("  said only while there's AI Knowledge to search", !systemPrompt(base).includes("search_knowledge") && !systemPrompt({ ...base, knowledge: false }).includes("search_knowledge"));
  ok("a question's searchable words: letters and digits in any script, nothing else", searchableText("How do I add a 'lead' — & | ! :*?") === "How do I add a lead" && searchableText("लीड कैसे बनाएं?") === "लीड कैसे बनाएं" && searchableText("&|!") === "");

  section("A channel's “Use AI Knowledge”");

  ok("off on a new channel, and on a channel saved before it existed", web.bot.ai.knowledge === false && channelSettings({ bot: { ai: { on: true, about: "x" } } }, "WEB").bot.ai.knowledge === false);
  ok("  kept when ticked", channelSettings({ bot: { ai: { on: true, about: "x", knowledge: true } } }, "WHATSAPP").bot.ai.knowledge === true && channelSettings({ bot: { ai: { knowledge: "yes" } } }, "WEB").bot.ai.knowledge === false);
  ok("  enough on its own for the AI to go on; without it, something else is needed", checkChannelSettings({ bot: { ai: { on: true, about: "", knowledge: true } } }, "WHATSAPP").ok && !checkChannelSettings({ bot: { ai: { on: true, about: "" } } }, "WHATSAPP").ok);

  section("Settings › AI Knowledge");

  const item = SETTINGS_ITEMS.find((i) => i.key === "ai-knowledge");
  ok("in the settings catalogue, for whoever may change the workspace's settings", item?.href === "/settings/ai-knowledge" && item.permission === "settings.manage" && !item.module);
}

async function withDatabase() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { directClient } = require("../src/lib/tenancy/direct-client") as typeof import("../src/lib/tenancy/direct-client");
  const db = directClient();
  const store = require("../src/lib/ai-knowledge/store") as typeof import("../src/lib/ai-knowledge/store");
  const search = require("../src/lib/ai-knowledge/search") as typeof import("../src/lib/ai-knowledge/search");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const cleanup = async () => {
    await db.aiKnowledgeFile.deleteMany({ where: { name: { startsWith: PREFIX, mode: "insensitive" } } });
    const channels = await db.inboxChannel.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    await db.conversation.deleteMany({ where: { channelId: { in: channels.map((c) => c.id) } } });
    await db.inboxChannel.deleteMany({ where: { id: { in: channels.map((c) => c.id) } } });
    const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length) {
      await db.notification.deleteMany({ where: { userId: { in: ids } } });
      await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
      await db.activityLog.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
      await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
    }
  };

  try {
    await db.$queryRaw`SELECT 1`;
  } catch (err) {
    console.log(`\n(no database — ${err instanceof Error ? err.message.split("\n")[0] : err}; the rest needs one)`);
    failures += 1;
    return;
  }

  await cleanup();
  try {
    const make = async (name: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `Zzaik ${name}`,
          email: `${name.toLowerCase()}${MAIL}`,
          role: "SALES",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const admin = await make("Admin", { "settings.manage": true, "copilot.use": true });
    const staff = await make("Staff", { "settings.manage": false, "copilot.use": true });

    section("Stored in the workspace's database, searched with Postgres full-text search");

    const doc = (title: string, sections: [string, string][]) => [`# ${title}`, "", ...sections.flatMap(([h, b]) => [`## ${h}`, b, ""])].join("\n");
    const saved = await store.saveKnowledgeTexts(admin.id, [
      {
        name: `${PREFIX}zorble.md`,
        content: doc("Zorbleflux — the product", [
          ["Q: What is Zorbleflux?", "Zorbleflux is our flagship quixotron for warehouses."],
          ["Q: How do I start invoicing a Zorbleflux order?", "Open the order and choose Raise invoice. Invoices go out by email."],
          ["Q: Zorbleflux kaise lagaye?", "Pehle quixotron ko plug karein, phir app kholein."],
        ]),
      },
      { name: `${PREFIX}other.txt`, content: "The quixotron warranty is two years. Zorbleflux has none of its own." },
    ]);
    ok("an upload's files saved, each in chunks", saved.added.length === 2 && saved.replaced.length === 0, saved);
    const rows = await db.aiKnowledgeChunk.findMany({ where: { file: { name: { startsWith: PREFIX } } }, select: { heading: true, text: true } });
    ok("  the chunks keep their headings", rows.some((r) => r.heading === "Zorbleflux — the product") && rows.length >= 2, rows);
    const vector = await db.$queryRaw<{ v: string }[]>`SELECT search::text AS v FROM ai_knowledge_chunks c JOIN ai_knowledge_files f ON f.id = c."fileId" WHERE f.name = ${`${PREFIX}other.txt`}`;
    ok("  each chunk's tsvector is made by the database — stemmed, the small words left out", /'zorbleflux'/.test(vector[0]?.v ?? "") && /'warranti'/.test(vector[0]?.v ?? "") && !/'the'/.test(vector[0]?.v ?? ""), vector[0]?.v);
    const index = await db.$queryRaw<{ def: string }[]>`SELECT indexdef AS def FROM pg_indexes WHERE tablename = 'ai_knowledge_chunks' AND indexname = 'ai_knowledge_chunks_search_idx'`;
    ok("  and GIN-indexed", /USING gin \(search\)/i.test(index[0]?.def ?? ""), index);

    const first = async (q: string) => (await search.searchKnowledge(q, 5))[0];
    const invoicing = await first("how can I invoice a zorbleflux order?");
    ok("a question finds the chunk that answers it, first — “invoice” finds “invoicing”", invoicing?.file === `${PREFIX}zorble.md` && /Raise invoice/.test(invoicing.text), invoicing);
    const warranty = await first("zorbleflux warranty");
    ok("  the chunk with all of the question's words comes before one with only some", warranty?.file === `${PREFIX}other.txt`, warranty);
    const hinglish = await first("zorbleflux kaise lagaye");
    ok("  Hinglish too", /Pehle quixotron/.test(hinglish?.text ?? ""), hinglish);
    const anyWord = await search.searchKnowledge("does the quixotron glow purple?", 5);
    ok("  any one of its words is enough to be found", anyWord.some((h) => h.file.startsWith(PREFIX)), anyWord.map((h) => h.file));
    ok("  nothing for a question of only small words, or none at all", (await search.searchKnowledge("how do I do it?", 5)).length === 0 && (await search.searchKnowledge("?!", 5)).length === 0);
    ok("  the limit kept", (await search.searchKnowledge("zorbleflux quixotron", 1)).length === 1);

    const again = await store.saveKnowledgeTexts(admin.id, [{ name: `${PREFIX}ZORBLE.md`, content: "# Zorbleflux\n\nZorbleflux is retired; ask about Gloptron instead." }]);
    const zorble = await db.aiKnowledgeFile.findMany({ where: { name: { startsWith: `${PREFIX}zorble`, mode: "insensitive" } }, include: { chunks: true } });
    ok("uploading a file of the same name again — in another case — replaces it and its chunks", again.replaced.join() === `${PREFIX}zorble.md` && zorble.length === 1 && zorble[0]!.name === `${PREFIX}zorble.md` && zorble[0]!.chunks.length === 1, { again, zorble: zorble.map((z) => [z.name, z.chunks.length]) });
    ok("  the old words aren't found any more, the new ones are", !(await search.searchKnowledge("zorbleflux invoicing", 5)).some((h) => /Raise invoice/.test(h.text)) && (await first("gloptron"))?.file === `${PREFIX}zorble.md`);

    section("Only for whoever may change the workspace's settings");

    /* eslint-disable @typescript-eslint/no-require-imports */
    const actions = require("../src/actions/ai-knowledge") as typeof import("../src/actions/ai-knowledge");
    const route = require("../src/app/api/ai-knowledge/upload/route") as typeof import("../src/app/api/ai-knowledge/upload/route");
    const page = (require("../src/app/(dashboard)/settings/ai-knowledge/page") as { default: () => Promise<unknown> }).default;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const id = zorble[0]!.id;
    const post = (files: { name: string; text: string }[], origin = `http://${HOST}`) => {
      const form = new FormData();
      for (const f of files) form.append("files", new File([f.text], f.name, { type: "text/markdown" }));
      return route.POST(new Request(`http://${HOST}/api/ai-knowledge/upload`, { method: "POST", headers: { origin, host: HOST }, body: form }));
    };

    actorId = staff.id;
    const refusedPage = await page().then(
      () => "",
      (e: Error) => e.message,
    );
    ok("somebody without it: the page isn't there for them", refusedPage === "notFound", refusedPage);
    const tries = [
      await actions.getAiKnowledgeFile(id),
      await actions.saveAiKnowledgeFile({ id, name: `${PREFIX}zorble.md`, content: "Taken over." }),
      await actions.deleteAiKnowledgeFile(id),
      await actions.tryAiKnowledgeSearch("zorbleflux"),
    ];
    ok("  and every action refuses them", tries.every((r) => !r.ok && /change the workspace's settings/.test(r.error)), tries);
    const staffUpload = await post([{ name: `${PREFIX}sneaky.md`, text: "# Sneaky" }]);
    ok("  so does the upload", staffUpload.status === 403 && !(await db.aiKnowledgeFile.findFirst({ where: { name: `${PREFIX}sneaky.md` } })));
    actorId = admin.id;
    viewingAs = true;
    const asSomebody = await actions.saveAiKnowledgeFile({ id, name: `${PREFIX}zorble.md`, content: "Viewing as." });
    const uploadAsSomebody = await post([{ name: `${PREFIX}viewing.md`, text: "# Viewing" }]);
    ok("an admin viewing as somebody can change nothing", !asSomebody.ok && uploadAsSomebody.status === 403);
    viewingAs = false;
    const crossSite = await post([{ name: `${PREFIX}csrf.md`, text: "# From elsewhere" }], "https://evil.example");
    ok("the upload takes nothing from another site's page", crossSite.status === 403 && !(await db.aiKnowledgeFile.findFirst({ where: { name: `${PREFIX}csrf.md` } })));

    const zip = new JSZip();
    zip.file("handbook/hr/leave.md", "# Leave\n\n## Q: How many casual leaves?\nTwelve casual leaves a year, said the Zorbleflux handbook.");
    zip.file("handbook/readme.txt", "Read me.");
    const zipForm = new FormData();
    zipForm.append("files", new File([await zip.generateAsync({ type: "arraybuffer" })], "handbook.zip", { type: "application/zip" }));
    zipForm.append("files", new File(["# Notes\nZorbleflux notes."], `notes.md`, { type: "text/markdown" }));
    const uploaded = await route.POST(new Request(`http://${HOST}/api/ai-knowledge/upload`, { method: "POST", headers: { origin: `http://${HOST}`, host: HOST }, body: zipForm }));
    const body = (await uploaded.json()) as { ok: boolean; data?: { added: string[]; replaced: string[] } };
    ok("an admin uploads a .zip and a file together", uploaded.status === 200 && body.ok && ["hr/leave.md", "readme.txt", "notes.md"].every((n) => body.data!.added.includes(n)), body);
    // Those three are outside the probe's folder: renamed into it, so the finally removes them whatever happens next.
    for (const n of ["hr/leave.md", "readme.txt", "notes.md"]) await db.aiKnowledgeFile.updateMany({ where: { name: n, updatedById: admin.id }, data: { name: `${PREFIX}${n}` } });
    ok("  and every upload is in the audit trail", (await db.auditLog.count({ where: { userId: admin.id, entityType: "AiKnowledgeFile" } })) >= 1);

    const opened = await actions.getAiKnowledgeFile(id);
    ok("an admin opens a file to edit", opened.ok && opened.data.content.includes("Gloptron"));
    const edited = await actions.saveAiKnowledgeFile({ id, name: `${PREFIX}zorble-renamed.md`, content: "# Zorbleflux\r\n\r\nNow sold as Plinkotron." });
    ok("  edits and renames it: cut into chunks again, found by its new words", edited.ok && (await first("plinkotron"))?.file === `${PREFIX}zorble-renamed.md` && !(await search.searchKnowledge("gloptron", 5)).some((h) => h.file.startsWith(PREFIX)), edited);
    const clash = await actions.saveAiKnowledgeFile({ id, name: `${PREFIX}OTHER.txt`, content: "x" });
    ok("  a name another file has is refused, whatever its case", !clash.ok && /already a file/.test(clash.error), clash);
    ok("  so are an empty file and a name that isn't .md or .txt", !(await actions.saveAiKnowledgeFile({ id, name: `${PREFIX}z.md`, content: "  " })).ok && !(await actions.saveAiKnowledgeFile({ id, name: `${PREFIX}z.pdf`, content: "x" })).ok);
    const tried = await actions.tryAiKnowledgeSearch("plinkotron");
    ok("“What would the AI find?” shows the copilot's own chunks", tried.ok && tried.data[0]?.file === `${PREFIX}zorble-renamed.md`, tried);
    const deleted = await actions.deleteAiKnowledgeFile(id);
    ok("deleting a file takes its chunks with it", deleted.ok && (await db.aiKnowledgeChunk.count({ where: { fileId: id } })) === 0 && (await search.searchKnowledge("plinkotron", 5)).every((h) => !h.file.startsWith(PREFIX)));

    section("The copilot's search_knowledge");

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tools = require("../src/lib/copilot/tools") as typeof import("../src/lib/copilot/tools");
    const offered = await tools.toolsFor();
    ok("offered once AI Knowledge has a file — first, so it's the first thought", offered[0]?.name === "search_knowledge", offered.map((t) => t.name));
    const big = Array.from({ length: 6 }, (_, i) => [`Q: Zorbleflux part ${i}?`, `Zorbleflux part ${i}: ${"detail ".repeat(110).trim()}.`] as [string, string]);
    await store.saveKnowledgeTexts(admin.id, [{ name: `${PREFIX}parts.md`, content: doc("Zorbleflux parts", big) }]);
    const ran = await tools.runTool(offered, { userId: staff.id, conversationId: "zz" }, "search_knowledge", { query: "zorbleflux part" });
    const out = ran.output as { results: { file: string; section: string; text: string }[]; note: string };
    const chars = out.results.reduce((sum, r) => sum + r.file.length + r.section.length + r.text.length + 2, 0) + Math.max(0, out.results.length - 1) * 2;
    ok("the best chunks with the file each came from, five at most", !ran.isError && out.results.length >= 1 && out.results.length <= 5 && out.results.every((r) => r.file.startsWith(PREFIX)), out.results.map((r) => [r.file, r.text.length]));
    ok("  never more than 4,000 characters of them", chars <= KNOWLEDGE_PROMPT_CHARS, chars);
    ok("  told to name the file it used; the activity line says which", /name the file/.test(out.note) && ran.activity.includes(`${PREFIX}parts.md`), ran.activity);
    const nothing = await tools.runTool(offered, { userId: staff.id, conversationId: "zz" }, "search_knowledge", { query: "xqzzvlorp nonesuch" });
    ok("  nothing found is said, so it doesn't answer from memory", !nothing.isError && (nothing.output as { results: unknown[] }).results.length === 0 && /don't answer from memory/.test((nothing.output as { note: string }).note));
    const bad = await tools.runTool(offered, { userId: staff.id, conversationId: "zz" }, "search_knowledge", { query: "x" });
    ok("  its input checked, whatever the model sends", bad.isError);

    section("The inbox's bot with “Use AI Knowledge”");

    /* eslint-disable @typescript-eslint/no-require-imports */
    const aiLib = require("../src/lib/inbox/ai") as typeof import("../src/lib/inbox/ai");
    const server = require("../src/lib/inbox/server") as typeof import("../src/lib/inbox/server");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const asked: string[] = [];
    aiLib.setTestInboxAi(async ({ system }) => {
      asked.push(system);
      return "Twelve casual leaves a year.";
    });
    try {
      const web = defaultChannelSettings("WEB");
      const settings = (knowledge: boolean): ChannelSettings => ({ ...web, bot: { ...web.bot, askDetails: false, ai: { on: true, about: knowledge ? "" : "We sell things.", chargedTo: admin.id, pages: [], knowledge } } });
      const withIt = await db.inboxChannel.create({ data: { kind: "WEB", name: `${TAG} with`, publicKey: `zzaikwith${Date.now()}`, settings: settings(true) as object, createdById: admin.id } });
      const without = await db.inboxChannel.create({ data: { kind: "WEB", name: `${TAG} without`, publicKey: `zzaikwithout${Date.now()}`, settings: settings(false) as object, createdById: admin.id } });
      // The bot answers customers only from files ticked "Website chat may use this" (security audit, 11 Nov 2026 —
      // SEC-46): this check's files are ticked here, and un-ticked again further down.
      await db.aiKnowledgeFile.updateMany({ where: { name: { startsWith: PREFIX, mode: "insensitive" } }, data: { forCustomers: true } });
      await server.receiveWebMessage(withIt, { text: "How many casual leaves does the Zorbleflux handbook give?" });
      const told = asked[0] ?? "";
      ok("a channel with it ticked: the AI is told the chunks that answer the question before it answers", asked.length === 1 && told.includes("From the business's own knowledge files:") && told.includes("Twelve casual leaves a year") && told.includes(`${PREFIX}hr/leave.md`), told.slice(-600));
      const given = (told.split("From the business's own knowledge files:\n")[1] ?? "").split(/\n\[/).length;
      ok("  three of them at most", given <= INBOX_KNOWLEDGE_CHUNKS, given);
      await server.receiveWebMessage(without, { text: "How many casual leaves does the Zorbleflux handbook give?" });
      ok("a channel without it is told none of them", asked.length === 2 && !asked[1]!.includes("knowledge files") && !asked[1]!.includes("Twelve casual leaves"));
      // SEC-46: ticked on the channel, but no file marked "Website chat may use this" — nothing internal reaches a customer.
      await db.aiKnowledgeFile.updateMany({ where: { name: { startsWith: PREFIX, mode: "insensitive" } }, data: { forCustomers: false } });
      const unmarked = await db.inboxChannel.create({ data: { kind: "WEB", name: `${TAG} unmarked`, publicKey: `zzaikunmarked${Date.now()}`, settings: settings(true) as object, createdById: admin.id } });
      await server.receiveWebMessage(unmarked, { text: "How many casual leaves does the Zorbleflux handbook give?" });
      ok("a channel with it ticked, the files not marked for the website chat: told none of them", asked.length === 3 && !asked[2]!.includes("knowledge files") && !asked[2]!.includes("Twelve casual leaves"), (asked[2] ?? "").slice(-300));
    } finally {
      aiLib.setTestInboxAi(null);
    }
  } finally {
    actorId = "";
    viewingAs = false;
    await cleanup();
    await db.$disconnect();
  }
}

async function main() {
  await pure();
  await withDatabase();
  console.log(failures ? `\n${failures} failed` : "\nAll AI Knowledge checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
