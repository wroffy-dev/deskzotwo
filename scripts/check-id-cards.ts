/**
 * check:id-cards — employee ID cards (owner, 31 Oct 2026 — src/lib/id-cards, People › ID cards).
 *
 *   1. The design: a colour must be hex, the ink reads on it, a hidden detail is dropped, print links carry only ids.
 *   2. A4 sheets: nine a sheet, each row's backs turned round so printing both sides puts every back behind its front.
 *   3. The QR address: it names its person, and one made up or changed by a character names nobody.
 *   4. The print page, rendered: the cards as the design says, only for somebody who manages people records.
 *   5. The check page: a card is good while its holder works here, and says it isn't from the day after they leave.
 *
 * Its own people and design row, removed afterwards; the design row there before is put back.
 *
 *   npm run check:id-cards
 */
import "dotenv/config";
import Module from "node:module";
import { createElement, isValidElement, cloneElement, type ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; role: string; name: string; email: string } | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
class NotFound extends Error {}
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new NotFound("not found");
      },
      useRouter: () => ({ push() {}, refresh() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
      redirect: () => {
        throw new Error("redirect");
      },
    };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return {
      requireUser: async () => {
        if (!actor) throw new Error("Unauthorized");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const MAIL = "@zz-idcard.in";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

/** Awaits any async component in the tree, so it renders to static markup (as check-item-import does). */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  const kids = el.props.children;
  if (kids === undefined) return el;
  const resolved = await resolveAsync(kids);
  return Array.isArray(resolved) ? cloneElement(el, undefined, ...(resolved as never[])) : cloneElement(el, undefined, resolved as never);
}

async function cleanup() {
  const users = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  if (users.length === 0) return;
  await db.auditLog.deleteMany({ where: { userId: { in: users } } });
  await db.activityLog.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
  await db.employeeProfile.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
}

async function main() {
  const design = await import("../src/lib/id-cards/design");
  const { idCardToken, userOfIdCardToken, idCardCheck } = await import("../src/lib/id-cards/cards");
  const { saveIdCardDesign } = await import("../src/actions/id-cards");
  const { renderToStaticMarkup } = await import("react-dom/server");

  section("1. The design");
  ok("a colour is six-digit hex or nothing", design.safeHex("#0249FE") === "#0249fe" && design.safeHex("red") === null && design.safeHex("#fff;}body{") === null);
  ok("  white ink on the brand blue, dark ink on yellow", design.inkOn("#0249fe") === "#ffffff" && design.inkOn("#facc15") === "#111111");
  const full = { userId: "u", name: "Asha Rao", photoDataUrl: null, initials: "AR", employeeCode: "E1", designation: "Head", department: "Sales", bloodGroup: "B+", joinedOn: "1 Jan 2024", workPhone: "98", email: "a@x.in", emergency: { name: "Ravi", phone: "99", relation: "Spouse" }, qrDataUrl: "data:," };
  const trimmed = design.applyDesign(full, { ...design.DEFAULT_DESIGN, showBloodGroup: false, showEmail: true });
  ok("  a detail the design hides is dropped, one it shows kept", trimmed.bloodGroup === null && trimmed.email === "a@x.in" && trimmed.department === "Sales" && trimmed.joinedOn === null, trimmed);
  ok("a print link carries only ids, once each", design.parseCardIds("abcdefghij12,abcdefghij12,../etc,<x>,klmnopqrst34").join() === "abcdefghij12,klmnopqrst34");
  ok("  and at most 200", design.parseCardIds(Array.from({ length: 250 }, (_, i) => `id${String(i).padStart(10, "0")}`).join(",")).length === design.MAX_CARDS);

  section("2. A4 sheets");
  const eleven = Array.from({ length: 11 }, (_, i) => i + 1);
  ok("nine a sheet: 9 then 2", design.sheetsOf(eleven).map((s) => s.length).join() === "9,2");
  ok("  a full sheet's backs: each row turned round", design.backsOrder(eleven.slice(0, 9)).join() === "3,2,1,6,5,4,9,8,7");
  ok("  a short row padded so its backs sit behind their fronts", JSON.stringify(design.backsOrder([10, 11])) === JSON.stringify([null, 11, 10]));
  ok("initials from a name", design.initialsOf("asha rao") === "AR" && design.initialsOf("Madonna") === "M");

  await cleanup();
  const priorDesign = await db.idCardSettings.findUnique({ where: { id: "global" } });
  try {
    const hr = await db.user.create({ data: { name: "Zz Hr Head", email: `hr${MAIL}`, passwordHash: "!", role: "ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    const rep = await db.user.create({ data: { name: "Zz Card Holder", email: `holder${MAIL}`, passwordHash: "!", role: "SALES" }, select: { id: true, name: true, email: true, role: true } });
    const plain = await db.user.create({ data: { name: "Zz Plain Rep", email: `plain${MAIL}`, passwordHash: "!", role: "SALES" }, select: { id: true, name: true, email: true, role: true } });
    await db.employeeProfile.create({
      data: { userId: rep.id, employeeCode: "ZZ-ID-7", designation: "Account Executive", bloodGroup: "O+", emergencyContactName: "Meena", emergencyContactPhone: "9000000001", emergencyContactRelation: "Mother" },
    });
    const as = (u: { id: string; name: string; email: string | null; role: string }) => (actor = { id: u.id, name: u.name, email: u.email!, role: u.role });

    section("3. The QR address");
    const token = await idCardToken(rep.id);
    ok("it names its person", (await userOfIdCardToken(token)) === rep.id);
    const last = token.slice(-1) === "A" ? "B" : "A";
    ok("  one character changed names nobody", (await userOfIdCardToken(token.slice(0, -1) + last)) === null);
    ok("  another person's id with this MAC names nobody", (await userOfIdCardToken(`${hr.id}.${token.split(".")[1]}`)) === null && (await userOfIdCardToken("x")) === null);

    section("4. The print page");
    as(hr);
    const saved = await saveIdCardDesign({ ...design.DEFAULT_DESIGN, accentColor: "#B91C1C", showEmergencyContact: true, showBloodGroup: true, backNote: "Return to Zz Front Desk." });
    ok("HR saves a design: a red card", saved.ok && (await db.idCardSettings.findUnique({ where: { id: "global" } }))?.accentColor === "#b91c1c", saved);
    as(rep);
    const refused = await saveIdCardDesign(design.DEFAULT_DESIGN);
    ok("  somebody who doesn't manage people records can't", !refused.ok, refused);
    as(hr);
    ok("  a colour that isn't hex is refused", !(await saveIdCardDesign({ ...design.DEFAULT_DESIGN, accentColor: "red" })).ok);

    const Print = (await import("../src/app/(print)/id-cards/print/page")).default;
    const render = async (ids: string, paper = "a4") => renderToStaticMarkup((await resolveAsync(await Print({ searchParams: Promise.resolve({ ids, paper }) }))) as ReactElement);
    const html = await render(`${rep.id},${plain.id}`);
    ok("the cards: name, employee ID, designation, blood group", ["Zz Card Holder", "ZZ-ID-7", "Account Executive", "O+"].every((s) => html.includes(s)));
    ok("  the back: the emergency contact, the saved line, a QR code", html.includes("Meena") && html.includes("9000000001") && html.includes("Return to Zz Front Desk.") && html.includes("data:image/png;base64"));
    ok("  in the saved colour", html.includes("#b91c1c"));
    ok("  somebody with no record still gets a card, with their initials", html.includes("Zz Plain Rep") && html.includes(">ZR<"));
    ok("  a front sheet and a back sheet", (html.match(/class="id-sheet/g) ?? []).length === 2);
    const card = await render(rep.id, "card");
    ok("an ID card printer: one side a page, at the card's size", (card.match(/class="id-side"/g) ?? []).length === 2 && card.includes("size: 54mm 85.6mm"));
    as(rep);
    let blocked = false;
    try {
      await render(rep.id);
    } catch (err) {
      blocked = err instanceof NotFound;
    }
    ok("  nobody else can print them", blocked);

    section("5. The check page");
    const good = await idCardCheck(rep.id);
    ok("still working here: valid, with their designation", good?.valid === true && good.designation === "Account Executive", good);
    const yesterday = new Date(Date.now() - 2 * 86_400_000);
    await db.employeeProfile.update({ where: { userId: rep.id }, data: { exitedOn: new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate())) } });
    const gone = await idCardCheck(rep.id);
    ok("  after their last day: not valid, the name only", gone?.valid === false && gone.designation === null && gone.photoDataUrl === null && gone.name === "Zz Card Holder", gone);
    await db.user.update({ where: { id: plain.id }, data: { active: false } });
    ok("  an account switched off: not valid", (await idCardCheck(plain.id))?.valid === false);
  } finally {
    await cleanup();
    await db.idCardSettings.deleteMany({ where: { id: "global" } });
    if (priorDesign) await db.idCardSettings.create({ data: priorDesign });
  }

  console.log(failures === 0 ? `\nAll ${passes} ID card checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});

void createElement;
