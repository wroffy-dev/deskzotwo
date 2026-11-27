/**
 * check:record-team — the AI team at the top of a lead or a customer (owner, 20 Nov 2026 — step 3;
 * src/lib/ai/record-team.ts, src/components/ai/record-team.tsx).
 *
 *   1. A lead: Ved's button until there's a plan, then how he read it; Tara's button once she may start, "Ved's plan first"
 *      before, then where the nurture stands — an email waiting for its owner, or for somebody else's eyes.
 *   2. A customer: Arjun's chase email waiting for this person; no Arjun for somebody who doesn't follow payments up.
 *   3. The row draws each teammate's name, words and button; nothing for no teammates.
 *
 * Local workspace; its own records (Zz Team…), removed after.
 *
 *   npm run check:record-team
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

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ refresh() {} }) };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const team = require("../src/lib/ai/record-team") as typeof import("../src/lib/ai/record-team");
  /* eslint-enable @typescript-eslint/no-require-imports */
  type PlanCard = import("../src/lib/research/plan-view").PlanCard;
  type NurtureCard = import("../src/lib/nurture/view").NurtureCard;

  section("1. A lead");
  const noPlan = { target: { kind: "lead", id: "l" }, plan: null, mayPlan: true, service: "", firstName: null, senderName: null } as PlanCard;
  const planned = { ...noPlan, plan: { id: "p", at: "", by: null, plan: { fit: "HOT", fitReasons: [], summary: "", steps: [{ kind: "CALL", title: "Call", why: "", dueInDays: 0 }, { kind: "EMAIL", title: "Email", why: "", dueInDays: 1 }], questions: [], email: null, tasks: {}, model: "", credits: 0 } } } as unknown as PlanCard;
  const card = (over: Partial<NurtureCard>): NurtureCard => ({ leadId: "l", nurture: null, enabled: true, mayStart: false, startNote: null, isOwner: true, mayStop: false, mayEdit: true, thumbs: {}, ...over }) as NurtureCard;
  const nurture = (touches: { status: string; step: number }[], sent: number) =>
    ({ status: "ACTIVE", stopReason: null, ownerId: "o", ownerName: "Asha", contactName: "Ravi", touchesSent: sent, nextAt: null, repliesCaught: true, replies: [], holdUntil: null, bookingLink: false, touches: touches.map((t, i) => ({ id: `t${i}`, subject: "s", body: "b", sentAt: null, sendAt: null, error: null, ...t })) }) as unknown as NurtureCard["nurture"];
  const first = team.leadTeam(noPlan, card({ startNote: "Make a Research & plan first" }));
  ok("no plan yet: Ved's button, and Tara waits for his plan", first[0]?.teammate === "ved" && first[0].action?.kind === "ved-plan" && first[1]?.teammate === "tara" && first[1].note === "Ved's plan first" && !first[1].action, first);
  const second = team.leadTeam(planned, card({ mayStart: true }));
  ok("  planned: how Ved read it, linked to the plan; Tara's button", second[0]?.status === "Read as Hot · 2 next steps" && second[0].href === "#research-plan" && !second[0].action && second[1]?.action?.kind === "tara-nurture", second);
  const waiting = team.leadTeam(planned, card({ nurture: nurture([{ status: "SENT", step: 0 }, { status: "WAITING", step: 1 }], 1) }));
  ok("  nurturing, an email waiting: said so to its owner", waiting[1]?.status === "Email 2 waiting for you" && waiting[1].href === "#nurture");
  const notOwner = team.leadTeam(planned, card({ isOwner: false, nurture: nurture([{ status: "WAITING", step: 0 }], 0) }));
  ok("  and to somebody else, whose turn it is", notOwner[1]?.status === "Email 1 waiting for Asha");
  ok("  between emails: how many went", team.leadTeam(planned, card({ nurture: nurture([{ status: "SENT", step: 0 }], 1) }))[1]?.status === "Nurturing · 1 of 4 sent");
  ok("  nobody may plan and nothing planned: no Ved", !team.leadTeam({ ...noPlan, mayPlan: false }, null).some((s) => s.teammate === "ved"));

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { mayLogFollowUps } = require("../src/lib/collections/load") as typeof import("../src/lib/collections/load");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true } });
  const other = await db.user.findFirst({ where: { active: true, isSuperAdmin: false, kind: "MEMBER" }, select: { id: true } });
  if (!admin || !other) throw new Error("need a super admin and one other person");
  const tag = randomUUID().slice(0, 6);
  const NAME = `Zz Team ${tag} Pvt Ltd`;
  const company = await db.company.create({ data: { name: NAME, normalizedName: NAME.toLowerCase(), createdById: admin.id }, select: { id: true } });
  try {
    section("2. A customer");
    await db.collectionChase.create({ data: { companyId: company.id, createdById: admin.id, tone: "gentle", subject: `Zz ${tag}`, body: "Hi", replyToken: randomBytes(12).toString("hex"), status: "WAITING" } });
    const mine = await team.companyTeam(admin.id, company.id, null);
    const adminChases = await mayLogFollowUps(admin.id);
    ok(
      `Arjun: the chase email waiting for them${adminChases ? "" : " — this admin doesn't follow payments up, so none"}`,
      adminChases ? mine.some((s) => s.teammate === "arjun" && s.status === "Chase email waiting for you" && s.href === "/collections") : !mine.some((s) => s.teammate === "arjun"),
      mine,
    );
    const theirs = await team.companyTeam(other.id, company.id, null);
    ok("  somebody else: not their draft — no waiting line for them", !theirs.some((s) => s.status === "Chase email waiting for you"));
    ok("  a customer's Ved links to its plan on the Details tab", (await team.companyTeam(admin.id, company.id, { target: { kind: "company", id: company.id }, plan: null, mayPlan: true, service: "", firstName: null, senderName: null } as PlanCard))[0]?.action?.label === "Research & plan");

    section("3. The row");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createElement } = require("react") as typeof import("react");
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const { TeammatesProvider } = require("../src/components/ai/teammate-avatar") as typeof import("../src/components/ai/teammate-avatar");
    const { workspaceTeammates } = require("../src/lib/ai/teammates-server") as typeof import("../src/lib/ai/teammates-server");
    const { RecordTeam } = require("../src/components/ai/record-team") as typeof import("../src/components/ai/record-team");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const names = await workspaceTeammates();
    const row = renderToStaticMarkup(createElement(TeammatesProvider, { teammates: names }, createElement(RecordTeam, { record: { kind: "lead", id: "l" }, slots: second })));
    ok("each teammate's name, words and button", row.includes(names.ved.name) && row.includes("Read as Hot") && row.includes(names.tara.name) && row.includes("Nurture this lead") && row.includes('href="#research-plan"'));
    ok("  no teammates: nothing drawn", renderToStaticMarkup(createElement(TeammatesProvider, { teammates: names }, createElement(RecordTeam, { record: { kind: "lead", id: "l" }, slots: [] }))) === "");
  } finally {
    await db.collectionChase.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: company.id } }).catch(() => undefined);
    await db.$disconnect();
  }
  console.log(`\n${failures === 0 ? `All ${passes} record-team checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
