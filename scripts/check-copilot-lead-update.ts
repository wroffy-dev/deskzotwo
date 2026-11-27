/**
 * check:copilot-lead-update — Deskzo AI changes one lead, through a card the person confirms (src/lib/copilot/lead-update.ts,
 * `propose_lead_update` in tools.ts, `confirmCopilotProposal` in src/actions/copilot.ts).
 *
 *   · drafting: one lead, by its LEAD- reference alone; several products that fit are listed, never chosen between;
 *     somebody else's lead, one they may only see, a masked title, a won lead's value, no products.edit — refused with
 *     why; one lead a question; nothing is written but the card;
 *   · the card: every field's old value and new one, as drawn and when the chat is opened again;
 *   · confirming: through the lead's own actions, once, by its owner alone; what wasn't asked about stays as it is;
 *     refused — with nothing saved — when a value changed, the lead was won, or access went since the card was drawn;
 *
 * No model is called. Everything is named ZZLUP and removed in a finally.
 *
 *   npm run check:copilot-lead-update
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";

process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let viewingAs = false;

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
      viewAsContext: async () => (viewingAs ? { user: actor, actor } : null),
      refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody." : null),
    };
  }
  if (request === "@/lib/notify") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, notifyUser: async () => undefined };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const TAG = "ZZLUP";
const MAIL = "@zzlup.invalid";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)?.slice(0, 400)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const tools = require("../src/lib/copilot/tools") as typeof import("../src/lib/copilot/tools");
  const lib = require("../src/lib/copilot/lead-update") as typeof import("../src/lib/copilot/lead-update");
  const copilot = require("../src/actions/copilot") as typeof import("../src/actions/copilot");
  const { history } = require("../src/lib/copilot/agent") as typeof import("../src/lib/copilot/agent");
  const { ProposalCard, ProposalChanges } = require("../src/components/copilot/chat-blocks") as typeof import("../src/components/copilot/chat-blocks");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const { formatLeadId, formatOrderId } = require("../src/lib/order-id") as typeof import("../src/lib/order-id");
  /* eslint-enable @typescript-eslint/no-require-imports */
  type ProposalBlock = import("../src/lib/copilot/types").ProposalBlock;

  const cleanup = async () => {
    const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
    const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await db.copilotConversation.deleteMany({ where: { userId: { in: ids } } });
    await db.lead.deleteMany({ where: { companyId: { in: companies } } });
    await db.contact.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
    await db.item.deleteMany({ where: { name: { startsWith: TAG } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.activityLog.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await db.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await db.userAccessLevel.deleteMany({ where: { userId: { in: ids } } });
    await db.userFieldPolicy.deleteMany({ where: { userId: { in: ids } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  };

  await cleanup();
  try {
    const make = async (name: string, grants: Record<string, boolean>): Promise<Actor> =>
      db.user.create({
        data: {
          name: `Zzlup ${name}`,
          email: `${name}${MAIL}`,
          role: "SALES",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries({ "copilot.use": true, "leads.view": true, "contacts.view": true, "companies.viewAll": false, ...grants }).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
        select: { id: true, role: true, name: true, email: true },
      });
    const rep = await make("rep", { "products.edit": true });
    const other = await make("other", { "products.edit": true });
    const noProducts = await make("noproducts", { "products.edit": false });

    const item = (name: string) => db.item.create({ data: { name: `${TAG} ${name}`, sku: `${TAG}-${name}`, type: "GOOD", sellingPrice: 50000, createdById: rep.id }, select: { id: true, name: true } });
    const laptop = await item("Laptop");
    const proLaptop = await item("Pro Laptop");
    const dock = await item("Dock");
    const company = async (name: string, owner: Actor) => db.company.create({ data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: owner.id, ownerUserId: owner.id }, select: { id: true, name: true } });
    const acme = await company("Acme", rep);
    const beta = await company("Beta", other);
    const gamma = await company("Gamma", noProducts);
    const contact = await db.contact.create({ data: { companyId: acme.id, name: `${TAG} Person`, phone: "9876500000" }, select: { id: true } });
    type Line = { itemId: string; quantity: number; notes?: string; renewalDate?: Date };
    const lead = async (title: string, owner: Actor, companyId: string, lines: Line[], more: object = {}) => {
      const l = await db.lead.create({ data: { title: `${TAG} ${title}`, companyId, ownerUserId: owner.id, requirements: { create: lines }, ...more }, select: { id: true, leadSeq: true } });
      return { id: l.id, ref: formatLeadId(l.leadSeq), seq: l.leadSeq };
    };
    const read = (id: string) =>
      db.lead.findUniqueOrThrow({
        where: { id },
        select: { title: true, description: true, estimatedValue: true, expectedCloseDate: true, contactId: true, ownerUserId: true, status: true, requirements: { orderBy: { createdAt: "asc" }, select: { id: true, quantity: true, notes: true, renewalDate: true, itemId: true } } },
      });

    const renewal = new Date("2027-03-31T00:00:00Z");
    const main = await lead("50 laptops", rep, acme.id, [{ itemId: laptop.id, quantity: 50, notes: "VIP: ZZ-9", renewalDate: renewal }], {
      description: "Wants them by Diwali",
      estimatedValue: 2500000,
      expectedCloseDate: new Date("2026-12-15T00:00:00Z"),
      contactId: contact.id,
    });
    const several = await lead("Mixed hardware", rep, acme.id, [
      { itemId: proLaptop.id, quantity: 20 },
      { itemId: laptop.id, quantity: 50 },
      { itemId: dock.id, quantity: 50 },
    ]);
    const bare = await lead("50 laptops, no lines", rep, acme.id, []);
    const won = await lead("Won deal", rep, acme.id, [{ itemId: laptop.id, quantity: 5 }], { status: "WON", estimatedValue: 100000 });
    const theirs = await lead("Beta laptops", other, beta.id, [{ itemId: laptop.id, quantity: 50 }]);
    const noEdit = await lead("Gamma laptops", noProducts, gamma.id, [{ itemId: laptop.id, quantity: 50 }]);

    const start = async (as: Actor) => {
      actor = as;
      const conversation = await db.copilotConversation.create({ data: { userId: as.id, title: `${TAG} chat` }, select: { id: true } });
      const offered = await tools.toolsFor();
      // A question's calls share one context; a new one is a new question.
      const ask = () => {
        const ctx = { userId: as.id, conversationId: conversation.id };
        return async (input: Record<string, unknown>) => {
          const out = await tools.runTool(offered, ctx, "propose_lead_update", input);
          return { ...out, text: JSON.stringify(out.output), block: out.blocks?.[0] as ProposalBlock | undefined };
        };
      };
      return { conversation, offered, ask, once: (input: Record<string, unknown>) => ask()(input) };
    };

    // ─────────────────────────────────────────────────────────────────────────
    section("Finding the lead");
    const chat = await start(rep);
    const { once } = chat;
    ok("the tool is offered beside propose_lead", chat.offered.some((t) => t.name === "propose_lead_update") && tools.TOOL_NAMES.indexOf("propose_lead_update") === tools.TOOL_NAMES.indexOf("propose_lead") + 1);
    ok("references: LEAD-000123, in any case; never a bare number, another record's, or words", lib.leadSeqOf("lead-000123") === 123 && lib.leadSeqOf("LEAD 123") === 123 && [String(main.seq), formatOrderId(main.seq), "COM-000123", "50 laptop leads", "LEAD-12, LEAD-13", ""].every((r) => lib.leadSeqOf(r) === null));
    const byNumber = await once({ leadRef: String(main.seq), quantity: 60 });
    ok("a bare number is refused, and the AI told to list and ask", byNumber.isError && byNumber.text.includes("ask which"), byNumber.text);
    const listed = await tools.runTool(chat.offered, { userId: rep.id, conversationId: chat.conversation.id }, "list_leads", { search: TAG });
    const rows = (listed.output as { leads: { ref: string; products: { product: string; quantity: number }[] }[] }).leads;
    ok("list_leads says what each lead is for", JSON.stringify(rows.find((l) => l.ref === main.ref)?.products) === JSON.stringify([{ product: laptop.name, quantity: 50 }]) && rows.find((l) => l.ref === several.ref)?.products.length === 3 && rows.find((l) => l.ref === bare.ref)?.products.length === 0, rows);
    ok("  and only of leads the person may see", !rows.some((l) => l.ref === theirs.ref));
    const foreign = await once({ leadRef: theirs.ref, quantity: 60 });
    const missing = await once({ leadRef: "LEAD-999999999", quantity: 60 });
    ok("a colleague's lead and one that isn't there are refused alike", foreign.isError && missing.isError && foreign.text.replace(theirs.ref, "X") === missing.text.replace("LEAD-999999999", "X"), foreign.text);
    ok("a list of references isn't one", (await once({ leadRef: `${main.ref}, ${several.ref}`, quantity: 60 })).isError);

    section("Which product");
    const ambiguous = await once({ leadRef: several.ref, quantity: 60 });
    ok("several products, none named: listed with their quantities, none drafted", ambiguous.isError && ambiguous.text.includes(dock.name) && ambiguous.text.includes('"quantity":20') && !ambiguous.block, ambiguous.text);
    ok("  a number two of them hold doesn't choose either", (await once({ leadRef: several.ref, quantity: 60, quantityNow: 50 })).isError);
    ok("  a name both laptops fit doesn't either", (await once({ leadRef: several.ref, product: "laptops", quantity: 60 })).isError);
    const picked = await once({ leadRef: several.ref, product: "laptops", quantityNow: 50, quantity: 60 });
    ok("  the name and the number it has now pick one", !picked.isError && picked.block?.changes?.[0]?.label === `Quantity — ${laptop.name}`, picked.block?.changes);
    const exact = await once({ leadRef: several.ref, product: laptop.name, quantity: 70 });
    ok("  a product's whole name picks it over a longer one", !exact.isError && exact.block?.changes?.[0]?.label === `Quantity — ${laptop.name}`, exact.block?.changes);
    const wrongNow = await once({ leadRef: main.ref, quantityNow: 45, quantity: 60 });
    ok("the number the person said isn't what it holds: asked, not drafted", wrongNow.isError && wrongNow.text.includes('"quantity":50'), wrongNow.text);
    const noLines = await once({ leadRef: bare.ref, quantity: 60 });
    ok("no products on it: says so, and to ask about the title", noLines.isError && noLines.text.includes("title"), noLines.text);

    section("What can't be drafted");
    ok("nothing asked for", (await once({ leadRef: main.ref })).isError);
    ok("what it already holds", (await once({ leadRef: main.ref, quantity: 50 })).text.includes("already holds"));
    ok("a date that isn't one", (await once({ leadRef: main.ref, expectedCloseDate: "2026-02-30" })).isError && (await once({ leadRef: main.ref, expectedCloseDate: "2026-13-01" })).isError);
    ok("a quantity of none, half or less", (await once({ leadRef: main.ref, quantity: 0 })).isError && (await once({ leadRef: main.ref, quantity: 1.5 })).isError && (await once({ leadRef: main.ref, quantity: -5 })).isError);
    ok("a placeholder that stands for nothing", (await once({ leadRef: main.ref, title: "60 laptops for COMPANY_K7F3Q" })).text.includes("placeholder"));
    const wonValue = await once({ leadRef: won.ref, estimatedValue: 5 });
    ok("a won lead's value", wonValue.isError && wonValue.text.includes("locked"), wonValue.text);
    ok("an owner, a stage, a contact: not fields it has", (await once({ leadRef: main.ref, ownerUserId: other.id, status: "WON", contactId: "x" })).text.includes("Say what to change"));
    const gammaChat = await start(noProducts);
    const refusedQty = await gammaChat.once({ leadRef: noEdit.ref, quantity: 60 });
    ok("a quantity without Edit products", refusedQty.isError && refusedQty.text.includes("Edit products"), refusedQty.text);
    ok("  though they may change its title", !(await gammaChat.once({ leadRef: noEdit.ref, title: `${TAG} Gamma 60` })).isError);
    actor = rep;
    await db.userAccessLevel.create({ data: { userId: rep.id, record: "leads", action: "edit", level: "NONE" } });
    const readOnly = await once({ leadRef: main.ref, quantity: 60 });
    ok("a lead they may only see", readOnly.isError && readOnly.text.includes("can't change it"), readOnly.text);
    await db.userAccessLevel.deleteMany({ where: { userId: rep.id } });
    const mask = (field: string) => db.userFieldPolicy.create({ data: { userId: rep.id, entity: "leads", field, view: true, maskInList: true, maskInDetail: true, unmask: false, format: "first" } });
    await mask("title");
    const maskedTitle = await once({ leadRef: main.ref, title: `${TAG} New` });
    ok("a title they see masked", maskedTitle.isError && maskedTitle.text.includes("in full") && !maskedTitle.text.includes("50 laptops"), maskedTitle.text);
    const maskedQty = await once({ leadRef: main.ref, quantity: 61 });
    ok("  its quantity they may — and the card and the model's copy don't name it", !maskedQty.isError && !JSON.stringify(maskedQty.blocks).includes("50 laptops"), maskedQty.block?.summary);
    await db.userFieldPolicy.deleteMany({ where: { userId: rep.id } });
    await mask("phone");
    await db.lead.update({ where: { id: bare.id }, data: { contactId: contact.id, description: "call 9876500000 first" } });
    const quoted = await once({ leadRef: bare.ref, description: "call first" });
    ok("a description with a masked phone inside it", quoted.isError && quoted.text.includes("in full"), quoted.text);
    await db.userFieldPolicy.deleteMany({ where: { userId: rep.id } });

    section("One lead a question");
    const sameQuestion = chat.ask();
    const both = await Promise.all([sameQuestion({ leadRef: main.ref, quantity: 62 }), sameQuestion({ leadRef: several.ref, title: `${TAG} X` }), sameQuestion({ leadRef: won.ref, title: `${TAG} Y` })]);
    ok("three leads in one answer: one card", both.filter((r) => !r.isError).length === 1 && both.filter((r) => r.text.includes("One lead at a time")).length === 2, both.map((r) => r.text));
    ok("nothing has changed on any lead: only cards were drawn", (await read(main.id)).requirements[0]!.quantity === 50 && (await read(several.id)).requirements.every((r) => [20, 50].includes(r.quantity)) && (await read(won.id)).title === `${TAG} Won deal`);

    // ─────────────────────────────────────────────────────────────────────────
    section("The card");
    const drawn = await once({ leadRef: main.ref, quantity: 60, quantityNow: 50, title: `${TAG} 60 laptops`, estimatedValue: 3000000.5, expectedCloseDate: "2027-01-05", description: "Wants them in January" });
    const changes = drawn.block?.changes ?? [];
    ok("the model is told nothing has changed, and no values", !drawn.isError && drawn.text.includes("NOTHING has changed") && !drawn.text.includes("3000000"), drawn.text);
    const row = (label: string) => changes.find((c) => c.label === label);
    ok("each field, old to new", changes.length === 5 && row(`Quantity — ${laptop.name}`)?.from === "50" && row(`Quantity — ${laptop.name}`)?.to === "60" && row("Title")?.from === `${TAG} 50 laptops` && row("Title")?.to === `${TAG} 60 laptops` && row("Description")?.from === "Wants them by Diwali", changes);
    ok("  money and dates as the app writes them", /25,00,000|2,500,000/.test(row("Estimated value")?.from ?? "") && /30,00,000\.50|3,000,000\.50/.test(row("Estimated value")?.to ?? "") && row("Expected close date")?.from === "15 Dec 2026" && row("Expected close date")?.to === "5 Jan 2027", changes);
    ok("  the lead by its reference, title and company", !!drawn.block?.summary.includes(main.ref) && drawn.block.summary.includes(`${TAG} 50 laptops`) && drawn.block.summary.includes(acme.name), drawn.block?.summary);
    const text = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el).replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");
    const card = text(createElement(ProposalCard, { block: drawn.block!, onChange: () => {} }));
    ok("drawn: what it is, from 50 to 60, and Save changes", card.includes("Change a lead") && /From 50 to 60/.test(card) && card.includes("Save changes") && !card.includes("Create"), card.slice(0, 260));
    ok("  done, it says the lead was changed", text(createElement(ProposalCard, { block: { ...drawn.block!, status: "DONE" }, onChange: () => {} })).includes("Lead changed"));
    ok("  the admin's read-only view draws the same rows", /From 50 to 60/.test(text(createElement(ProposalChanges, { changes }))));
    const stored = await db.copilotProposal.findUniqueOrThrow({ where: { id: drawn.block!.id } });
    ok("the proposal is the person's own and waits", stored.kind === "LEAD_UPDATE" && stored.status === "PENDING" && stored.userId === rep.id);
    // Shown again later, from the proposal row itself — whatever the saved block says.
    await db.copilotMessage.create({ data: { conversationId: chat.conversation.id, role: "user", content: { text: "edit it" } } });
    await db.copilotMessage.create({ data: { conversationId: chat.conversation.id, role: "tool", content: { results: [], blocks: [{ type: "proposal", id: drawn.block!.id, kind: "LEAD_UPDATE", summary: drawn.block!.summary, changes: [{ label: "Title", from: "a", to: "b" }] }] } } });
    const cardNow = async () => {
      const shown = await copilot.getCopilotConversation(chat.conversation.id);
      return (shown?.items ?? []).flatMap((i) => (i.role === "assistant" ? i.segments : [])).flatMap((s) => (s.kind === "block" && s.block.type === "proposal" ? [s.block] : []))[0];
    };
    ok("opened again: the rows confirming will act on", JSON.stringify((await cardNow())?.changes) === JSON.stringify(changes), (await cardNow())?.changes);

    // ─────────────────────────────────────────────────────────────────────────
    section("Confirming");
    const error = (r: { ok: boolean; error?: string }) => ("error" in r ? r.error : "");
    actor = other;
    ok("somebody else can't", !(await copilot.confirmCopilotProposal(drawn.block!.id)).ok);
    actor = rep;
    viewingAs = true;
    ok("nor while viewing as somebody", !(await copilot.confirmCopilotProposal(drawn.block!.id)).ok);
    viewingAs = false;
    const before = await read(main.id);
    const done = await copilot.confirmCopilotProposal(drawn.block!.id);
    const after = await read(main.id);
    ok("its owner does: every field on the card is saved", done.ok && after.title === `${TAG} 60 laptops` && after.description === "Wants them in January" && Number(after.estimatedValue) === 3000000.5 && after.expectedCloseDate?.toISOString() === "2027-01-05T00:00:00.000Z" && after.requirements[0]?.quantity === 60, done.ok ? after : done.error);
    ok("  the rest is as it was: contact, owner, stage, the line's remarks, renewal date and product", after.contactId === contact.id && after.ownerUserId === before.ownerUserId && after.status === before.status && after.requirements[0]?.notes === "VIP: ZZ-9" && after.requirements[0]?.renewalDate?.getTime() === renewal.getTime() && after.requirements[0]?.itemId === laptop.id, after);
    const audit = await db.auditLog.findFirst({ where: { userId: rep.id, entityType: "Lead", entityId: main.id }, orderBy: { createdAt: "desc" } });
    ok("  by the lead's own action: audited as an edit on its page is", !!audit?.entityLabel?.includes("title") && audit.entityLabel.includes("value"), audit?.entityLabel);
    ok("  the card says so, and points at the lead", (await cardNow())?.status === "DONE" && (await db.copilotProposal.findUniqueOrThrow({ where: { id: drawn.block!.id } })).recordId === main.id);
    ok("  the model is told it was saved", (await history(chat.conversation.id)).some((t) => t.role === "note" && t.text.includes("confirmed the change to a lead") && t.text.includes("saved")));
    ok("pressed twice, it is saved once", !(await copilot.confirmCopilotProposal(drawn.block!.id)).ok);

    const qtyOnly = await once({ leadRef: main.ref, quantity: 65 });
    const heldBefore = await read(main.id);
    ok("a quantity alone changes the quantity alone", (await copilot.confirmCopilotProposal(qtyOnly.block!.id)).ok && JSON.stringify({ ...(await read(main.id)), requirements: 0 }) === JSON.stringify({ ...heldBefore, requirements: 0 }) && (await read(main.id)).requirements[0]!.quantity === 65);
    const titleOnly = await once({ leadRef: several.ref, title: `${TAG} Office hardware` });
    const severalBefore = await read(several.id);
    ok("a title alone changes the title alone — an empty value, date and contact stay empty", (await copilot.confirmCopilotProposal(titleOnly.block!.id)).ok && JSON.stringify(await read(several.id)) === JSON.stringify({ ...severalBefore, title: `${TAG} Office hardware` }), await read(several.id));
    const wonTitle = await once({ leadRef: won.ref, title: `${TAG} Won deal, renamed` });
    ok("a won lead may still be renamed, its value as it was", (await copilot.confirmCopilotProposal(wonTitle.block!.id)).ok && Number((await read(won.id)).estimatedValue) === 100000);

    section("Changed since the card was drawn");
    const first = await once({ leadRef: main.ref, quantity: 70 });
    const second = await once({ leadRef: main.ref, quantity: 80 });
    const withTitle = await once({ leadRef: main.ref, quantity: 90, title: `${TAG} 90 laptops` });
    ok("the first of two cards is saved", (await copilot.confirmCopilotProposal(first.block!.id)).ok);
    const stale = await copilot.confirmCopilotProposal(second.block!.id);
    ok("  the second is refused: it showed a value that is gone", !stale.ok && error(stale)!.includes("changed since") && (await read(main.id)).requirements[0]!.quantity === 70, error(stale));
    ok("  and its card says so, and the model is told", (await db.copilotProposal.findUniqueOrThrow({ where: { id: second.block!.id } })).status === "FAILED" && (await history(chat.conversation.id)).some((t) => t.role === "note" && t.text.includes("couldn't be saved")));
    ok("one changed field of two: neither is saved", !(await copilot.confirmCopilotProposal(withTitle.block!.id)).ok && (await read(main.id)).title === `${TAG} 60 laptops`);
    const staleValue = await once({ leadRef: main.ref, estimatedValue: 10 });
    await db.lead.update({ where: { id: main.id }, data: { estimatedValue: 42 } });
    ok("a value changed on its page meanwhile", !(await copilot.confirmCopilotProposal(staleValue.block!.id)).ok && Number((await read(main.id)).estimatedValue) === 42);
    const staleDate = await once({ leadRef: main.ref, expectedCloseDate: "2027-05-05" });
    await db.lead.update({ where: { id: main.id }, data: { expectedCloseDate: null } });
    ok("  a date cleared meanwhile", !(await copilot.confirmCopilotProposal(staleDate.block!.id)).ok && (await read(main.id)).expectedCloseDate === null);
    const keptFresh = await once({ leadRef: main.ref, title: `${TAG} 70 laptops` });
    await db.lead.update({ where: { id: main.id }, data: { description: "Rewritten meanwhile" } });
    ok("a field the card doesn't change, changed meanwhile, keeps its new value", (await copilot.confirmCopilotProposal(keptFresh.block!.id)).ok && (await read(main.id)).description === "Rewritten meanwhile" && (await read(main.id)).title === `${TAG} 70 laptops`);
    const goneLine = await once({ leadRef: several.ref, product: "Dock", quantity: 5 });
    await db.leadRequirement.deleteMany({ where: { leadId: several.id, itemId: dock.id } });
    ok("a product taken off it meanwhile", !(await copilot.confirmCopilotProposal(goneLine.block!.id)).ok);

    section("The lead's own rules, at the click");
    const open = await lead("Open deal", rep, acme.id, [{ itemId: laptop.id, quantity: 5 }], { estimatedValue: 100 });
    const value = await once({ leadRef: open.ref, estimatedValue: 200 });
    await db.lead.update({ where: { id: open.id }, data: { status: "WON" } });
    const locked = await copilot.confirmCopilotProposal(value.block!.id);
    ok("won since: its value is locked", !locked.ok && error(locked)!.includes("locked") && Number((await read(open.id)).estimatedValue) === 100, error(locked));
    const permitted = await once({ leadRef: main.ref, quantity: 71, title: `${TAG} 71 laptops` });
    await db.userPermission.updateMany({ where: { userId: rep.id, permission: "products.edit" }, data: { allowed: false } });
    const unpermitted = await copilot.confirmCopilotProposal(permitted.block!.id);
    ok("Edit products taken away since: nothing saved, the title neither", !unpermitted.ok && (await read(main.id)).requirements[0]!.quantity === 70 && (await read(main.id)).title === `${TAG} 70 laptops`, error(unpermitted));
    await db.userPermission.updateMany({ where: { userId: rep.id, permission: "products.edit" }, data: { allowed: true } });
    const maskedLater = await once({ leadRef: main.ref, title: `${TAG} Masked` });
    await mask("title");
    const nowMasked = await copilot.confirmCopilotProposal(maskedLater.block!.id);
    ok("the title masked from them since", !nowMasked.ok && (await read(main.id)).title === `${TAG} 70 laptops`, error(nowMasked));
    const underMask = await once({ leadRef: main.ref, quantity: 72, expectedCloseDate: "2027-06-30" });
    ok("a masked title stays what it is when another field is saved", (await copilot.confirmCopilotProposal(underMask.block!.id)).ok && (await read(main.id)).title === `${TAG} 70 laptops` && (await read(main.id)).requirements[0]!.quantity === 72);
    await db.userFieldPolicy.deleteMany({ where: { userId: rep.id } });
    const demoted = await once({ leadRef: main.ref, quantity: 73 });
    await db.userAccessLevel.create({ data: { userId: rep.id, record: "leads", action: "edit", level: "NONE" } });
    ok("edit taken away since", !(await copilot.confirmCopilotProposal(demoted.block!.id)).ok && (await read(main.id)).requirements[0]!.quantity === 72);
    await db.userAccessLevel.deleteMany({ where: { userId: rep.id } });
    const moved = await once({ leadRef: main.ref, quantity: 74 });
    await db.company.update({ where: { id: acme.id }, data: { ownerUserId: other.id } });
    await db.lead.update({ where: { id: main.id }, data: { ownerUserId: other.id } });
    ok("the account moved to somebody else since", !(await copilot.confirmCopilotProposal(moved.block!.id)).ok && (await read(main.id)).requirements[0]!.quantity === 72);
    await db.company.update({ where: { id: acme.id }, data: { ownerUserId: rep.id } });
    await db.lead.update({ where: { id: main.id }, data: { ownerUserId: rep.id } });
    const dropped = await once({ leadRef: main.ref, quantity: 75 });
    await copilot.cancelCopilotProposal(dropped.block!.id);
    ok("cancelled, it can't be confirmed", !(await copilot.confirmCopilotProposal(dropped.block!.id)).ok && (await read(main.id)).requirements[0]!.quantity === 72);
    const tampered = await once({ leadRef: main.ref, quantity: 76 });
    await db.copilotProposal.update({ where: { id: tampered.block!.id }, data: { payload: { leadId: main.id, changes: [{ field: "ownerUserId", from: rep.id, to: other.id }] } } });
    ok("a payload naming a field it may not change is refused", !(await copilot.confirmCopilotProposal(tampered.block!.id)).ok && (await read(main.id)).ownerUserId === rep.id);
  } finally {
    actor = null;
    await cleanup().catch((err: unknown) => console.error("cleanup failed", err));
  }

  console.log(`\n${failures ? `${failures} of ${passes + failures} lead update checks FAILED.` : `All ${passes} lead update checks passed.`}`);
  await db.$disconnect().catch(() => undefined);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
