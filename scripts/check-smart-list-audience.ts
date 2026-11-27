/**
 * check:smart-list-audience — a Smart List as a marketing audience, and mailing a Smart List (owner, 16 Nov 2026: "in
 * marketing audience can we use created smart list as audience also? also mail button in created smart list where user
 * can mail also by selecting a template"; src/lib/marketing/smart-list-audience.ts).
 *
 *   1. An audience can follow a Smart List: it takes the list's filters, and takes them again whenever the list is saved.
 *   2. Only a list the person could open on the Smart Lists page — a private one of somebody else's is refused.
 *   3. Mailing a Smart List: the preview makes nothing; the send goes to the audience that follows the list, made the
 *      first time and reused after.
 *   4. Unfollowing, and deleting the list, leave the audience with the filters it had.
 *
 * Nothing is sent: `marketing.send` is held back, so a send stays a draft, and the lists match no company. Own fixture
 * tagged ZZSLA, removed in a finally.
 *
 *   npm run check:smart-list-audience
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let manageAny = true;

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/navigation") return { useRouter: () => ({ refresh() {}, push() {}, replace() {} }), notFound: () => { throw new Error("NOT_FOUND"); }, redirect: () => { throw new Error("REDIRECT"); } };
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => actor, requireModuleAccess: async () => actor };
  }
  if (request === "@/lib/authz/resolve" || request.endsWith("lib/authz/resolve")) {
    const real = originalLoad.call(this, request, parent, isMain) as { can: (u: string, k: string) => Promise<boolean> };
    return { ...real, can: async (u: string, k: string) => (k === "workspace.manageAny" ? manageAny : real.can(u, k)) };
  }
  if (request === "@/actions/permission" || request.endsWith("actions/permission")) {
    const real = originalLoad.call(this, request, parent, isMain) as { hasEffectivePermission: (u: string, k: string) => Promise<boolean> };
    // Never sends: whoever runs the check may build a campaign but not send one, so it stays a draft.
    return {
      ...real,
      hasEffectivePermission: async (u: string, k: string) => (k === "marketing.send" ? false : k === "workspace.manageAny" ? manageAny : real.hasEffectivePermission(u, k)),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const TAG = "ZZSLA";
const tagsOf = (filters: unknown) => ((filters ?? {}) as { tags?: string[] }).tags ?? [];

async function cleanup() {
  const audiences = await db.audience.findMany({ where: { OR: [{ name: { startsWith: TAG } }, { name: { startsWith: `Smart List: ${TAG}` } }] }, select: { id: true } });
  const ids = audiences.map((a) => a.id);
  await db.campaign.deleteMany({ where: { OR: [{ name: { startsWith: TAG } }, { audienceId: { in: ids } }] } });
  await db.audience.deleteMany({ where: { id: { in: ids } } });
  await db.workbook.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.marketingTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
}

async function main() {
  await cleanup();
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true, role: true, name: true, email: true } });
  const other = await db.user.findFirstOrThrow({ where: { active: true, id: { not: admin.id } }, select: { id: true } });
  actor = admin;
  const marketing = await import("../src/actions/marketing");
  const workspace = await import("../src/actions/workspace");

  try {
    // Tags nobody has, so no company matches and nothing could ever be mailed.
    const list = await db.workbook.create({ data: { name: `${TAG} renewals`, filters: { tags: ["zzsla-none-a"] }, ownerUserId: admin.id, shared: true }, select: { id: true } });
    const hidden = await db.workbook.create({ data: { name: `${TAG} private`, filters: { tags: ["zzsla-none-p"] }, ownerUserId: other.id, shared: false }, select: { id: true } });
    const template = await db.marketingTemplate.create({ data: { name: `${TAG} offer`, channel: "EMAIL", topic: "OFFERS", subject: "Hello {{firstName}}", body: "Hi {{firstName}}. {{unsubscribeUrl}}", createdById: admin.id }, select: { id: true } });

    section("1. An audience that follows a Smart List");
    const saved = await marketing.saveAudience({ name: `${TAG} follows`, companyFilters: { tags: ["typed-here"] }, contactFilters: {}, smartListId: list.id });
    const row = saved.ok ? await db.audience.findUnique({ where: { id: saved.data.id }, select: { smartListId: true, companyFilters: true } }) : null;
    ok("saved, following the list, with the list's filters — not the ones sent", saved.ok && row?.smartListId === list.id && tagsOf(row?.companyFilters).join() === "zzsla-none-a", { saved, row });
    const listed = (await marketing.listAudiences()).find((a) => saved.ok && a.id === saved.data.id);
    ok("  the Audiences page names the list", listed?.smartList?.name === `${TAG} renewals`, listed?.smartList);
    const choices = await marketing.smartListChoices();
    ok("  the list is among the choices", choices.some((c) => c.id === list.id));

    const resaved = await workspace.saveWorkbook({ id: list.id, name: `${TAG} renewals`, filters: { tags: ["zzsla-none-b"] } });
    const after = saved.ok ? await db.audience.findUnique({ where: { id: saved.data.id }, select: { companyFilters: true } }) : null;
    ok("saving the list carries its new filters to the audience", resaved.ok && tagsOf(after?.companyFilters).join() === "zzsla-none-b", after?.companyFilters);

    section("2. Only a list the person could open");
    manageAny = false;
    const refused = await marketing.saveAudience({ name: `${TAG} sneaky`, companyFilters: {}, contactFilters: {}, smartListId: hidden.id });
    ok("somebody else's private list is refused", !refused.ok, refused);
    ok("  and isn't offered", !(await marketing.smartListChoices()).some((c) => c.id === hidden.id));
    ok("  nor previewed", (await marketing.previewRecipients({ templateId: template.id, smartListId: hidden.id })) === null);
    const sentHidden = await marketing.sendMassMail({ name: `${TAG} sneaky send`, templateId: template.id, smartListId: hidden.id });
    ok("  nor mailed", !sentHidden.ok, sentHidden);
    manageAny = true;
    ok("with workspace.manageAny it's offered, as on the Smart Lists page", (await marketing.smartListChoices()).some((c) => c.id === hidden.id));

    section("3. Mailing a Smart List");
    const mailList = await db.workbook.create({ data: { name: `${TAG} to mail`, filters: { tags: ["zzsla-none-m"] }, ownerUserId: admin.id }, select: { id: true } });
    const preview = await marketing.previewRecipients({ templateId: template.id, smartListId: mailList.id });
    const madeByPreview = await db.audience.count({ where: { smartListId: mailList.id } });
    ok("the preview counts it and makes nothing", !!preview && preview.willReceive === 0 && madeByPreview === 0, { preview: preview?.willReceive, madeByPreview });
    const first = await marketing.sendMassMail({ name: `${TAG} first`, templateId: template.id, smartListId: mailList.id });
    const following = await db.audience.findMany({ where: { smartListId: mailList.id }, select: { id: true, name: true, companyFilters: true } });
    const firstCampaign = first.ok ? await db.campaign.findUnique({ where: { id: first.data.id }, select: { audienceId: true, status: true } }) : null;
    ok("the send makes the audience that follows it, named for the list", first.ok && following.length === 1 && following[0].name === `Smart List: ${TAG} to mail` && tagsOf(following[0].companyFilters).join() === "zzsla-none-m", { first, following });
    ok("  and the campaign goes to it, a draft here (no send permission)", firstCampaign?.audienceId === following[0]?.id && first.ok && first.data.outcome === "DRAFT", firstCampaign);
    await db.workbook.update({ where: { id: mailList.id }, data: { filters: { tags: ["zzsla-none-m2"] } } });
    const second = await marketing.sendMassMail({ name: `${TAG} second`, templateId: template.id, smartListId: mailList.id });
    const secondCampaign = second.ok ? await db.campaign.findUnique({ where: { id: second.data.id }, select: { audienceId: true } }) : null;
    const reread = await db.audience.findMany({ where: { smartListId: mailList.id }, select: { companyFilters: true } });
    ok("a second send reuses it, with the list's filters as they are now", reread.length === 1 && secondCampaign?.audienceId === following[0]?.id && tagsOf(reread[0].companyFilters).join() === "zzsla-none-m2", { reread, secondCampaign });
    const both = await marketing.sendMassMail({ name: `${TAG} both`, templateId: template.id, audienceId: saved.ok ? saved.data.id : null, smartListId: mailList.id });
    const bothCampaign = both.ok ? await db.campaign.findUnique({ where: { id: both.data.id }, select: { audienceId: true } }) : null;
    ok("an audience named outright wins over a Smart List", saved.ok && bothCampaign?.audienceId === saved.data.id, bothCampaign);

    section("4. Unfollowing, and a list deleted");
    if (saved.ok) {
      const unlinked = await marketing.saveAudience({ id: saved.data.id, name: `${TAG} follows`, companyFilters: { tags: ["zzsla-own"] }, contactFilters: {}, smartListId: null });
      const mine = await db.audience.findUnique({ where: { id: saved.data.id }, select: { smartListId: true, companyFilters: true } });
      ok("unfollowed, it keeps the filters it is given", unlinked.ok && mine?.smartListId === null && tagsOf(mine?.companyFilters).join() === "zzsla-own", mine);
      await workspace.saveWorkbook({ id: list.id, name: `${TAG} renewals`, filters: { tags: ["zzsla-none-c"] } });
      const untouched = await db.audience.findUnique({ where: { id: saved.data.id }, select: { companyFilters: true } });
      ok("  and the list saved again no longer changes it", tagsOf(untouched?.companyFilters).join() === "zzsla-own", untouched?.companyFilters);
    }
    await workspace.deleteWorkbook(mailList.id);
    const orphan = following[0] ? await db.audience.findUnique({ where: { id: following[0].id }, select: { smartListId: true, companyFilters: true } }) : null;
    ok("a deleted list leaves its audience, with the filters it last had", !!orphan && orphan.smartListId === null && tagsOf(orphan.companyFilters).join() === "zzsla-none-m2", orphan);

    section("5. The screens, rendered");
    const { MassMailWizard } = await import("../src/components/marketing/mass-mail-wizard");
    const wizard = renderToStaticMarkup(createElement(MassMailWizard, {
      templates: [], audiences: [{ id: "a1", name: "Renewal buyers" }], lists: [], canSend: true,
      smartLists: [{ id: "sl1", name: "ZZSLA Gurugram IT", calling: false }, { id: "sl2", name: "ZZSLA Calling", calling: true }],
      initialSmartListId: "sl1",
    }));
    ok("the mass-mail picker offers Smart Lists beside the audiences", /<optgroup label="Smart Lists">/.test(wizard) && /value="sl:sl1"/.test(wizard) && wizard.includes("ZZSLA Calling (calling activity)"));
    ok("  arriving from a list's Mail button, that list is already chosen", /value="sl:sl1" selected=""/.test(wizard) && /verified addresses, two people at most/.test(wizard));
    const unknown = renderToStaticMarkup(createElement(MassMailWizard, { templates: [], audiences: [], lists: [], canSend: true, smartLists: [{ id: "sl1", name: "x", calling: false }], initialSmartListId: "not-offered" }));
    ok("  a list not offered to this person is not chosen", !/value="sl:sl1" selected/.test(unknown));
    const { AudienceList } = await import("../src/components/marketing/audience-list");
    const audienceRow = { id: "x", name: "Follows", description: null, companyFilters: { tags: ["a"] }, contactFilters: {}, createdById: admin.id, createdAt: new Date(), updatedAt: new Date(), createdBy: { name: "A" }, _count: { campaigns: 0, journeys: 0 }, smartList: { id: "sl1", name: "ZZSLA Gurugram IT" } };
    const listHtml = renderToStaticMarkup(createElement(AudienceList, { audiences: [audienceRow] as never, canManage: true, options: {} as never, smartLists: [] }));
    ok("the Audiences page marks an audience that follows a list", /Smart List: <!-- -->ZZSLA Gurugram IT/.test(listHtml) || /Smart List: ZZSLA Gurugram IT/.test(listHtml));

    // Each record's own Mail, beside Call (owner, 16 Nov 2026: "mail button side of call button on each record").
    const { WorkbookResults } = await import("../src/components/workspace/workbook-results");
    const fakeRow = { id: "c1", companySeq: 7, name: "ZZSLA Acme", relationshipType: "CLIENT", stage: "CUSTOMER", employeeCount: null, website: null, tags: [], createdAt: new Date(), industry: null, owner: null, assignedTo: null, locations: [], domainProfile: null, _count: { contacts: 1, products: 0, leads: 0, locations: 0 }, calls: [] };
    const rowsWith = renderToStaticMarkup(await WorkbookResults({ rows: [fakeRow] as never, canMessage: true }));
    const rowsWithout = renderToStaticMarkup(await WorkbookResults({ rows: [fakeRow] as never, canMessage: false }));
    // Call draws itself only once the browser has asked whether calls are allowed, so a static render shows Mail alone.
    ok("each row of a Smart List has Mail, in the cell Call sits in", /<td class="px-4 py-2.5 text-right"><div class="flex items-center justify-end gap-1"><button[^>]*>.*?Mail<\/button>/.test(rowsWith));
    ok("  and none for somebody who may not send messages", !rowsWithout.includes("Mail</button>"));
    const { CallingStation } = await import("../src/components/workspace/calling-station");
    const queue = {
      workbook: { id: "w1", name: "ZZSLA calling", description: null, dueAt: null },
      progress: { total: 1, done: 0, remaining: 1, averageHandleSeconds: null, averageGapSeconds: null, talkSeconds: 0 },
      records: [{ id: "r1", status: "PENDING", outcomeNote: null, openedAt: null, company: { id: "c1", companySeq: 7, name: "ZZSLA Acme", website: null, employeeCount: null, stage: "CUSTOMER", industry: null, locations: [], contacts: [{ id: "p1", name: "Ravi", designation: "IT_HEAD", isPrimary: true, phone: "+919800000000", email: "ravi@example.com", emailStatus: null, emailCheckedValue: null, phoneStatus: null, phoneCheckedValue: null, emailCheckedAt: null, phoneCheckedAt: null, masked: { email: false, phone: false, name: false } }] } }],
    };
    let station = "";
    try {
      station = renderToStaticMarkup(createElement(CallingStation, { queue: queue as never, canMessage: true }));
    } catch (err) {
      station = `render failed: ${(err as Error).message}`;
    }
    ok("the calling queue has Mail beside each person's Call", station.includes(">Mail<"), station.startsWith("render failed") ? station : "");
  } finally {
    await cleanup();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  await db.$disconnect();
  if (failures) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
