/**
 * check:ai-quality — upgrading the AI teammates, step 2 (owner, 20 Nov 2026; src/lib/ai/drafts.ts, house-style.ts).
 *
 *   1. How much a person changed a draft, and what that makes it: as written, lightly edited, rewritten, set aside.
 *   2. Examples taken from the team's own answered emails: addresses, numbers, links and company names out.
 *   3. The house style as instructions — no sign-off for a chat or an HR answer — and nothing when nothing is set.
 *   4. Thumbs: only the person the work was for, changed or taken back; Arjun's chases set aside and answered, recorded.
 *   5. The scorecard, and the cards that show the style, the thumbs and the scores.
 *
 * Tara's own flow (an edited send, a reply, the next draft learning from it) is checked in check:nurture, section 15.
 * Local workspace, its own records (Zz Quality…), counted before and after.
 *
 *   npm run check:ai-quality
 */
import "dotenv/config";
import Module from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ refresh() {} }) };
  if (request === "@/lib/session" || request.endsWith("/lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const drafts = require("../src/lib/ai/drafts") as typeof import("../src/lib/ai/drafts");
  const style = require("../src/lib/ai/house-style") as typeof import("../src/lib/ai/house-style");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("1. What a person did with a draft");
  const body = "Hi Ravi, thanks for your time on the call today. Here is the quote for fifty seats as discussed. Let me know if anything needs changing. Regards, Asha";
  ok("sent untouched: as written", drafts.outcomeOf({ subject: "Quote", body }, { subject: "Quote", body: `  ${body}\n` }).outcome === "AS_WRITTEN");
  const light = drafts.outcomeOf({ subject: "Quote", body }, { subject: "Quote", body: body.replace("fifty", "sixty") });
  ok("  a word changed: lightly edited", light.outcome === "LIGHT_EDIT" && (light.changed ?? 0) > 0 && (light.changed ?? 1) <= drafts.LIGHT_EDIT_MAX, light);
  ok("  most of it new: rewritten", drafts.outcomeOf({ subject: "Quote", body }, { subject: "Pricing for your team", body: "Dear Mr Kumar, please find our revised commercial offer attached for your review." }).outcome === "REWRITTEN");
  ok("  set aside: skipped, nothing measured", drafts.outcomeOf({ subject: "Quote", body }, null).outcome === "SKIPPED" && drafts.outcomeOf({ subject: "Quote", body }, null).changed === null);
  ok("  the share is of words, either way round", drafts.changedShare("a b c d", "a b c d") === 0 && drafts.changedShare("a b c d", "") === 1 && drafts.changedShare("a b c d", "a x c d") === 0.25);

  section("2. Examples, cleaned");
  const cleaned = drafts.scrubExample("Hi, Acme Traders asked — call +91 98765 43210 or mail ravi@acme.test, see https://acme.test/x", ["Acme Traders"]);
  ok("company name, number, address and link out", !cleaned.includes("Acme Traders") && !cleaned.includes("98765") && !cleaned.includes("ravi@") && !cleaned.includes("https://") && cleaned.includes("[company]"), cleaned);
  ok("  as a prompt's lines — nothing when there are none", drafts.examplesBlock([]) === "" && drafts.examplesBlock([{ subject: "S", body: "B" }]).includes("customers answered"));

  section("3. The house style");
  const s1 = style.styleBlock({ tone: "Warm", signOff: "Regards, Team Zz", alwaysMention: "24x7 support", neverSay: "discounts", notes: "" });
  ok("its lines after the teammate's own rules, which win", s1.includes("they win where the two differ") && s1.includes("- Tone: Warm") && s1.includes("Sign off as: Regards, Team Zz") && s1.includes("Never say or promise: discounts") && !s1.includes("Also:"));
  ok("  no sign-off for a chat or an HR answer", !style.styleBlock({ tone: "Warm", signOff: "Regards", alwaysMention: "", neverSay: "", notes: "" }, { signOff: false }).includes("Sign off"));
  ok("  nothing set: nothing added", style.styleBlock(style.EMPTY_STYLE) === "");

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const quality = require("../src/actions/ai-quality") as typeof import("../src/actions/ai-quality");
  const chaseServer = require("../src/lib/collections/chase-server") as typeof import("../src/lib/collections/chase-server");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  const other = await db.user.findFirst({ where: { active: true, isSuperAdmin: false, kind: "MEMBER" }, select: { id: true, name: true, email: true, role: true } });
  if (!admin || !other) throw new Error("need a super admin and one other person");
  actor = admin;
  const tag = randomUUID().slice(0, 6);
  const NAME = `Zz Quality ${tag} Pvt Ltd`;
  const company = await db.company.create({ data: { name: NAME, normalizedName: NAME.toLowerCase(), createdById: admin.id }, select: { id: true } });
  const refs: string[] = [];
  const styleBefore = await style.houseStyle();
  try {
    section("4. Thumbs, and Arjun's chases");
    const chase = await db.collectionChase.create({ data: { companyId: company.id, createdById: admin.id, tone: "gentle", subject: `Zz ${tag} payment`, body: "Hi {{firstName}}, a reminder.", replyToken: randomBytes(12).toString("hex"), status: "WAITING" }, select: { id: true, replyToken: true } });
    refs.push(chase.id);
    const up = await quality.rateAiWork({ teammate: "arjun", kind: "collections.chase", ref: chase.id, good: true });
    ok("the person it was for: thumbs up kept", up.ok && (await drafts.feedbackOf("collections.chase", [chase.id], admin.id))[chase.id] === true);
    await quality.rateAiWork({ teammate: "arjun", kind: "collections.chase", ref: chase.id, good: false, reason: "Too  pushy\nfor a first reminder" });
    const row = await db.aiFeedback.findUnique({ where: { kind_ref_userId: { kind: "collections.chase", ref: chase.id, userId: admin.id } } });
    ok("  changed to down, the reason kept tidy", row?.good === false && row.reason === "Too pushy for a first reminder");
    await quality.rateAiWork({ teammate: "arjun", kind: "collections.chase", ref: chase.id, good: null });
    ok("  taken back", !(await db.aiFeedback.findUnique({ where: { kind_ref_userId: { kind: "collections.chase", ref: chase.id, userId: admin.id } } })));
    actor = other;
    ok("  somebody else can't rate it", !(await quality.rateAiWork({ teammate: "arjun", kind: "collections.chase", ref: chase.id, good: true })).ok);
    ok("  nor an unknown teammate or kind", !(await quality.rateAiWork({ teammate: "zz", kind: "collections.chase", ref: chase.id, good: true })).ok && !(await quality.rateAiWork({ teammate: "arjun", kind: "zz.kind", ref: chase.id, good: true })).ok);
    actor = admin;
    await chaseServer.discardChase(chase.id, admin.id);
    ok("Arjun's chase set aside: recorded as that", (await db.aiDraftRecord.findUnique({ where: { kind_ref: { kind: "collections.chase", ref: chase.id } } }))?.outcome === "SKIPPED");
    // One that went (recorded as sendChase records it), then answered.
    const sent = await db.collectionChase.create({ data: { companyId: company.id, createdById: admin.id, sentById: admin.id, tone: "gentle", subject: `Zz ${tag} sent`, body: "x", replyToken: randomBytes(12).toString("hex"), status: "SENT", sentAt: new Date() }, select: { id: true, replyToken: true } });
    refs.push(sent.id);
    await drafts.recordDraft({ teammate: "arjun", kind: "collections.chase", ref: sent.id, userId: admin.id, draft: { subject: "Payment due", body: "Hi, the invoice is due." }, sent: { subject: "Payment due", body: "Hi, the invoice is due." } });
    await chaseServer.receiveChaseReply(sent.replyToken, { from: { address: "pay@zzquality.example.com", name: "Zz Payer" }, to: [], cc: [], subject: "Re: Payment due", text: "Paying Friday.", messageId: null, inReplyTo: null, references: [], automated: null, attachments: [], senderVerified: true });
    ok("  a sent chase answered: marked", !!(await db.aiDraftRecord.findUnique({ where: { kind_ref: { kind: "collections.chase", ref: sent.id } } }))?.repliedAt);

    section("5. The scorecard, and the cards");
    const score = await quality.getTeamScorecard();
    const arjun = score?.find((s) => s.teammate === "arjun");
    ok("the scorecard: Arjun's drafts — one set aside, one sent and answered", !!arjun?.drafts && arjun.drafts.skipped >= 1 && arjun.drafts.replied >= 1 && arjun.drafts.sent >= 1, arjun?.drafts);
    ok("  Kabir and Priya scored by what they handed on", score?.find((s) => s.teammate === "kabir")?.handled !== null && score?.find((s) => s.teammate === "priya")?.handled !== null);
    actor = other;
    ok("  only for whoever may change the settings", (await quality.getTeamScorecard()) === null && (await quality.getHouseStyle()) === null && !(await quality.saveHouseStyleAction(style.EMPTY_STYLE)).ok);
    actor = admin;
    const saved = await quality.saveHouseStyleAction({ tone: "  Warm\n and brief ", signOff: "", alwaysMention: "", neverSay: "x".repeat(600), notes: "" });
    ok("the style saved tidy and within its length", saved.ok && saved.data.tone === "Warm and brief" && saved.data.neverSay.length === style.STYLE_LIMIT);
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createElement } = require("react") as typeof import("react");
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const { TeammatesProvider } = require("../src/components/ai/teammate-avatar") as typeof import("../src/components/ai/teammate-avatar");
    const { workspaceTeammates } = require("../src/lib/ai/teammates-server") as typeof import("../src/lib/ai/teammates-server");
    const { HouseStyleSettings } = require("../src/components/settings/house-style-settings") as typeof import("../src/components/settings/house-style-settings");
    const { TeamScorecard } = require("../src/components/ai/team-scorecard") as typeof import("../src/components/ai/team-scorecard");
    const { FeedbackButtons } = require("../src/components/ai/feedback-buttons") as typeof import("../src/components/ai/feedback-buttons");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const teammates = await workspaceTeammates();
    const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TeammatesProvider, { teammates }, el));
    ok("the House style card", wrap(createElement(HouseStyleSettings, { style: saved.ok ? saved.data : style.EMPTY_STYLE })).includes("House style"));
    const card = wrap(createElement(TeamScorecard, { scores: score ?? [] }));
    ok("  the scorecard card, Arjun's line in it", card.includes("How your AI team is doing") && card.includes(teammates.arjun.name) && card.includes("set aside"));
    const thumbs = wrap(createElement(FeedbackButtons, { teammate: "tara", kind: "nurture.email", refId: "x", initial: true }));
    ok("  the thumbs, the up one pressed", thumbs.includes('aria-pressed="true"') && thumbs.includes("Good — more like this"));
  } finally {
    await db.aiDraftRecord.deleteMany({ where: { ref: { in: refs } } }).catch(() => undefined);
    await db.aiFeedback.deleteMany({ where: { ref: { in: refs } } }).catch(() => undefined);
    await db.collectionReply.deleteMany({ where: { chase: { companyId: company.id } } }).catch(() => undefined);
    await db.collectionChase.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: company.id } }).catch(() => undefined);
    await db.aiHouseStyle.deleteMany({ where: { id: "global" } }).catch(() => undefined);
    if (styleBefore.tone || styleBefore.signOff || styleBefore.alwaysMention || styleBefore.neverSay || styleBefore.notes) await style.saveHouseStyle(styleBefore, admin.id);
    await db.$disconnect();
  }
  console.log(`\n${failures === 0 ? `All ${passes} AI quality checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
