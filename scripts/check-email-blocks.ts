/**
 * check:email-blocks — the email builder's saved blocks and blocks kept to some people (owner, 1 Nov 2026 —
 * src/lib/marketing/saved-blocks.ts, src/actions/marketing-blocks.ts, src/lib/marketing/email-design.ts `show`).
 *
 *   1. Who sees a block: customers, prospects, cities, states — written into the email as dynamic content that
 *      survives cleaning and saving, shown to the right people only; a field in a hidden block never asked for;
 *      a place name that would break the tag refused.
 *   2. Saved blocks: saved under a name, listed, the same name replacing, text cleaned, an inline picture refused,
 *      nothing ticked refused, refused without marketing.manage, deleted.
 *
 * Saves against the dev workspace and removes what it made, and its audit rows, afterwards.
 *
 *   npm run check:email-blocks
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; role: string; name: string; email: string } | null = null;
let allowed = true;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/authz/resolve" || request.endsWith("lib/authz/resolve")) return { can: async () => allowed };
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) return { isModuleEntitled: async () => true };
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

async function main() {
  const { newBlock, renderDesign, blankDesign, designSchema, audienceLabel, blockSummary } = await import("../src/lib/marketing/email-design");
  const { fieldsUsed, render, previewValues } = await import("../src/lib/marketing/merge");
  const { sanitizeEmailHtml, escapeHtml } = await import("../src/lib/marketing/html");
  type B = ReturnType<typeof newBlock>;

  const brand = { name: "ZZ Brand Co", color: "#214c99", logo: null, email: "hello@zz-brand.invalid", phone: null };
  const heading = (text: string, show?: B["show"]) => ({ ...newBlock("heading"), text, show }) as B;

  section("1. Who sees a block");
  const design = {
    ...blankDesign(),
    blocks: [
      heading("ZZ-EVERYONE"),
      heading("ZZ-CUSTOMERS", { who: "customers", cities: "", states: "" }),
      heading("ZZ-PROSPECTS", { who: "prospects", cities: "", states: "" }),
      heading("ZZ-WEST", { who: "everyone", cities: " Pune , Mumbai,Pune", states: "" }),
      heading("ZZ-JK-CUSTOMERS", { who: "customers", cities: "", states: "Jammu & Kashmir" }),
      { ...newBlock("text"), html: "<p>ZZ-RENEWAL {{productName}}</p>", show: { who: "customers", cities: "", states: "" } } as B,
    ],
  };
  ok("the design reads, audiences and all", designSchema.safeParse(design).success);
  const html = sanitizeEmailHtml(renderDesign(design, brand));
  ok("written as dynamic content that the cleaner keeps", html.includes("{{#if customer}}") && html.includes("{{#if prospect}}") && html.includes("{{#if city=Pune,Mumbai}}") && html.includes("{{/if}}"));
  ok("  no condition read as a merge field", fieldsUsed(html).unknown.length === 0, fieldsUsed(html).unknown);
  const seen = (values: Record<string, string>) => {
    const r = render(html, { ...previewValues(), ...values }, { escape: escapeHtml });
    return r.ok ? ["ZZ-EVERYONE", "ZZ-CUSTOMERS", "ZZ-PROSPECTS", "ZZ-WEST", "ZZ-JK-CUSTOMERS", "ZZ-RENEWAL"].filter((t) => r.text.includes(t)) : r;
  };
  const csv = (v: unknown) => (Array.isArray(v) ? v.join(",") : JSON.stringify(v));
  ok("a customer in Pune sees the customers' and Pune's blocks", csv(seen({ isCustomer: "yes", city: "Pune", state: "Maharashtra" })) === "ZZ-EVERYONE,ZZ-CUSTOMERS,ZZ-WEST,ZZ-RENEWAL", seen({ isCustomer: "yes", city: "Pune", state: "Maharashtra" }));
  ok("a prospect in Delhi sees the prospects' only", csv(seen({ isCustomer: "", city: "Delhi", state: "Delhi" })) === "ZZ-EVERYONE,ZZ-PROSPECTS", seen({ isCustomer: "", city: "Delhi", state: "Delhi" }));
  ok("  a city matched whatever its case", csv(seen({ isCustomer: "", city: "mumbai", state: "" })) === "ZZ-EVERYONE,ZZ-PROSPECTS,ZZ-WEST", seen({ isCustomer: "", city: "mumbai", state: "" }));
  ok("  a state with & in its name, after cleaning, and only for customers", csv(seen({ isCustomer: "yes", city: "Srinagar", state: "Jammu & Kashmir" })).includes("ZZ-JK-CUSTOMERS") && !csv(seen({ isCustomer: "", city: "Srinagar", state: "Jammu & Kashmir" })).includes("ZZ-JK-CUSTOMERS"));
  const noProduct = render(html, { ...previewValues(), isCustomer: "", productName: "" }, { escape: escapeHtml });
  ok("a field in a block the person doesn't see isn't asked for", noProduct.ok, noProduct.ok ? "" : noProduct);
  ok("the canvas says who a block is for", audienceLabel(design.blocks[1]!.show) === "Customers only" && audienceLabel(design.blocks[3]!.show) === "Anyone in Pune, Mumbai" && audienceLabel(design.blocks[0]!.show) === null && audienceLabel({ who: "everyone", cities: " ", states: "" }) === null);
  const broken = designSchema.safeParse({ ...blankDesign(), blocks: [heading("x", { who: "everyone", cities: "Pune}}{{#if prospect", states: "" })] });
  ok("a place name that would break the tag refused", !broken.success);
  ok("a block's summary for the save list", blockSummary(heading("Renewal time")) === "Heading — Renewal time" && blockSummary({ ...newBlock("logo"), partner: { src: "https://example.com/p.png", alt: "", width: 100, link: "" } } as B) === "Logo — with a partner's logo");

  const { saveDesignedTemplate } = await import("../src/actions/marketing-library");
  const { saveBlocks, savedBlocks, deleteSavedBlock } = await import("../src/actions/marketing-blocks");
  const admin = await db.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true, role: true, name: true, email: true } });
  if (!admin) throw new Error("No admin to act as.");
  actor = admin;
  const templates: string[] = [];
  const blockIds = new Set<string>();
  try {
    const saved = await saveDesignedTemplate({ name: "ZZ Kept blocks", topic: "OFFERS", subject: "ZZ {{firstName|Hello}}", preheader: "", design: { ...design, blocks: design.blocks.slice(0, 4) } });
    if (saved.ok) templates.push(saved.data.id);
    const body = saved.ok ? (await db.marketingTemplate.findUnique({ where: { id: saved.data.id }, select: { body: true } }))?.body ?? "" : "";
    ok("saved as a template, the conditions in what is sent", saved.ok && body.includes("{{#if customer}}") && body.includes("{{#if city=Pune,Mumbai}}"), saved.ok ? saved.data.warnings : saved.error);

    section("2. Saved blocks");
    const header = { ...newBlock("logo"), partner: { src: "https://example.com/microsoft.png", alt: "Microsoft", width: 110, link: "" } } as B;
    const footer = [{ ...newBlock("social") } as B, { ...newBlock("text"), html: '<p>ZZ footer<script>alert(1)</script></p>' } as B, newBlock("signature")];
    const first = await saveBlocks({ name: "  ZZ   Header ", blocks: [header] });
    if (first.ok) blockIds.add(first.data.id);
    ok("a header saved under its name, spaces tidied", first.ok && first.data.name === "ZZ Header" && first.data.blocks.length === 1, first.ok ? first.data.name : first.error);
    const foot = await saveBlocks({ name: "ZZ Footer", blocks: footer });
    if (foot.ok) blockIds.add(foot.data.id);
    ok("a footer of three blocks saved, in order", foot.ok && foot.data.blocks.map((b) => b.type).join() === "social,text,signature", foot.ok ? "" : foot.error);
    const footText = foot.ok ? foot.data.blocks[1] : null;
    ok("  what runs is taken out of its text", !!footText && footText.type === "text" && footText.html.includes("ZZ footer") && !footText.html.includes("<script"));
    const list = await savedBlocks();
    ok("both listed, the newest first", list[0]?.name === "ZZ Footer" && list.some((s) => s.name === "ZZ Header"), list.map((s) => s.name).slice(0, 4));
    const again = await saveBlocks({ name: "zz header", blocks: [header, newBlock("divider")] });
    if (again.ok) blockIds.add(again.data.id);
    const headers = (await savedBlocks()).filter((s) => s.name.toLowerCase() === "zz header");
    ok("the same name, in any case, replaces it", again.ok && first.ok && again.data.id === first.data.id && headers.length === 1 && headers[0]!.blocks.length === 2, headers.map((h) => h.blocks.length));
    const inline = await saveBlocks({ name: "ZZ Inline", blocks: [{ ...newBlock("image"), src: "data:image/png;base64,iVBORw0KGgo=" } as B] });
    if (inline.ok) blockIds.add(inline.data.id);
    ok("a picture carried inside refused — upload it first", !inline.ok && inline.error.includes("upload"), inline.ok ? "saved" : inline.error);
    const none = await saveBlocks({ name: "ZZ None", blocks: [] });
    ok("nothing ticked refused", !none.ok && none.error.includes("Tick"), none.ok ? "saved" : none.error);
    const unnamed = await saveBlocks({ name: "  ", blocks: [header] });
    ok("no name refused", !unnamed.ok);
    const badLink = await saveBlocks({ name: "ZZ Bad", blocks: [{ ...newBlock("button"), link: "javascript:alert(1)" } as B] });
    if (badLink.ok) blockIds.add(badLink.data.id);
    ok("a button to javascript: refused", !badLink.ok);
    allowed = false;
    const refused = await saveBlocks({ name: "ZZ Refused", blocks: [header] });
    const hidden = await savedBlocks();
    ok("refused without marketing.manage, and none listed", !refused.ok && hidden.length === 0, refused.ok ? "saved" : refused.error);
    allowed = true;
    if (foot.ok) {
      const gone = await deleteSavedBlock(foot.data.id);
      ok("deleted", gone.ok && !(await savedBlocks()).some((s) => s.id === foot.data.id));
      const twice = await deleteSavedBlock(foot.data.id);
      ok("  deleting it again says it's gone", !twice.ok);
    }
  } finally {
    const ids = [...blockIds, ...templates];
    await db.marketingSavedBlock.deleteMany({ where: { OR: [{ id: { in: [...blockIds] } }, { name: { startsWith: "ZZ " } }] } });
    if (ids.length) await db.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    if (templates.length) {
      await db.marketingAsset.deleteMany({ where: { templateId: { in: templates } } });
      await db.marketingTemplate.deleteMany({ where: { id: { in: templates } } });
    }
  }

  console.log(failures === 0 ? `\nAll ${passes} saved and kept block checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
