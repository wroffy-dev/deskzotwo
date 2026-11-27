/**
 * check:template-library — the ready-made email templates (owner, 1 Nov 2026 — src/lib/marketing/template-library.ts,
 * src/actions/marketing-library.ts).
 *
 *   1. Every template: only merge fields that exist; none a recipient must have (each has a fallback), in the subject,
 *      preview line or body; nothing the HTML cleaner takes out; filled with sample values and with none at all.
 *   2. The workspace's look: its colour, name, email and phone written in; a colour that isn't a plain hex replaced.
 *   3. "Use this template": saved as an HTML template with its subject, preview line and topic, the logo — an SVG
 *      drawn to a PNG — hosted beside it; refused without marketing.manage, and for a key not in the library.
 *
 * Saves its templates against the dev workspace and removes them, their pictures and audit rows afterwards.
 *
 *   npm run check:template-library
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

// A small SVG logo, as a workspace's branding might hold one.
const SVG_LOGO = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="#214c99"/><text x="10" y="40" font-size="30" fill="#fff">ZZ</text></svg>').toString("base64")}`;

async function main() {
  const { TEMPLATE_LIBRARY, safeColor } = await import("../src/lib/marketing/template-library");
  const { fieldsUsed, requiredFields, render, previewValues } = await import("../src/lib/marketing/merge");
  const { sanitizeEmailHtml, removedInCleaning, escapeHtml } = await import("../src/lib/marketing/html");

  const brand = { name: "ZZ Brand Co", color: "#214c99", logo: null, email: "hello@zz-brand.invalid", phone: "+91 98100 00000" };

  section("1. Every template");
  ok("a dozen or more, one key each", TEMPLATE_LIBRARY.length >= 12 && new Set(TEMPLATE_LIBRARY.map((t) => t.key)).size === TEMPLATE_LIBRARY.length, TEMPLATE_LIBRARY.length);
  ok("a subscription renewal notice among them", TEMPLATE_LIBRARY.some((t) => t.key === "renewal-notice" && t.topic === "RENEWALS"));
  for (const t of TEMPLATE_LIBRARY) {
    const html = t.html(brand);
    const all = `${t.subject} ${t.preheader} ${html}`;
    const used = fieldsUsed(all);
    const required = requiredFields(all);
    const cleaned = sanitizeEmailHtml(html);
    const removed = removedInCleaning(html, cleaned);
    const sample = render(cleaned, previewValues(), { escape: escapeHtml });
    const bare = render(cleaned, { ourName: "ZZ Brand Co" }, { escape: escapeHtml });
    const subjectBare = render(t.subject, { ourName: "ZZ Brand Co" });
    const pass = used.unknown.length === 0 && required.filter((f) => f !== "ourName").length === 0 && removed.length === 0 && sample.ok && bare.ok && subjectBare.ok;
    ok(`${t.key}: known fields, none required, nothing cleaned out, fills with and without values`, pass, pass ? "" : { unknown: used.unknown, required, removed, sample: sample.ok, bare: bare.ok ? true : bare, subject: subjectBare.ok });
  }

  section("2. The workspace's look");
  const notice = TEMPLATE_LIBRARY.find((t) => t.key === "renewal-notice")!.html(brand);
  ok("its colour, name, email and phone are written in", notice.includes("#214c99") && notice.includes("ZZ Brand Co") && notice.includes("hello@zz-brand.invalid") && notice.includes("+91 98100 00000"));
  ok("  with no logo, the name in the header", /<p[^>]*>ZZ Brand Co<\/p>/.test(notice));
  ok("a colour that isn't a plain hex isn't written into the email", safeColor("red;background:url(x)") === "#1d4ed8" && safeColor("#ABCDEF") === "#abcdef");
  const filled = render(sanitizeEmailHtml(notice), previewValues(), { escape: escapeHtml });
  ok("the renewal notice shows the product, expiry, days and value", filled.ok && ["Microsoft 365 Business Basic", "9 Aug 2027", "58 days away", "₹1,20,000"].every((s) => filled.text.includes(s)), filled.ok ? "" : filled);

  const paying = TEMPLATE_LIBRARY.filter((t) => t.category === "Payments");
  const friendly = render(sanitizeEmailHtml(paying[0]!.html(brand)), previewValues(), { escape: escapeHtml });
  ok("payment reminders: under the topic the payment dialog offers, with the order, total, paid and due filled", paying.length >= 5 && paying.every((t) => t.topic === "SERVICE") && friendly.ok && ["ORD-0188", "₹1,18,000", "₹50,000", "₹68,000"].every((v) => friendly.text.includes(v)), friendly.ok ? paying.length : friendly);

  section("3. Use this template");
  const { addLibraryTemplate } = await import("../src/actions/marketing-library");
  const admin = await db.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true, role: true, name: true, email: true } });
  if (!admin) throw new Error("No admin to act as.");
  actor = admin;
  const branding = await db.brandingSettings.findUnique({ where: { id: "global" } });
  const made: string[] = [];
  try {
    await db.brandingSettings.upsert({ where: { id: "global" }, create: { id: "global", logoDataUrl: SVG_LOGO, primaryColor: "#214c99" }, update: { logoDataUrl: SVG_LOGO, primaryColor: "#214c99" } });
    const saved = await addLibraryTemplate("renewal-notice");
    if (saved.ok) made.push(saved.data.id);
    ok("saved", saved.ok, saved.ok ? saved.data.warnings : saved.error);
    if (saved.ok) {
      const row = await db.marketingTemplate.findUnique({ where: { id: saved.data.id }, select: { name: true, format: true, topic: true, subject: true, preheader: true, body: true, sourceFileName: true, assets: { select: { mimeType: true, data: true } } } });
      ok("  as an HTML template, with its subject, preview line and topic", row?.format === "HTML" && row.topic === "RENEWALS" && !!row.subject?.includes("{{productName|") && !!row.preheader && row.sourceFileName === "renewal-notice.html", row && { format: row.format, topic: row.topic });
      ok("  the SVG logo drawn to a PNG and hosted beside it", row?.assets.length === 1 && row.assets[0]!.mimeType === "image/png" && !!row.body.match(/\/api\/marketing\/assets\/[^"]+/), row?.assets.map((a) => a.mimeType));
      ok("  no picture left inline", !row?.body.includes("data:image"));
    }
    allowed = false;
    const refused = await addLibraryTemplate("special-offer");
    ok("refused without marketing.manage", !refused.ok && refused.error.includes("can't"), refused.ok ? "saved" : refused.error);
    allowed = true;
    const unknown = await addLibraryTemplate("no-such-template");
    ok("refused for a key not in the library", !unknown.ok, unknown.ok ? "saved" : unknown.error);
    if (saved.ok) {
      const { designOf, designedIds } = await import("../src/lib/marketing/design-store");
      const kept = await designOf(saved.data.id);
      ok("  its design kept, so it opens in the builder", !!kept && kept.blocks.some((b) => b.type === "details") && (await designedIds([saved.data.id])).has(saved.data.id));
    }

    section("4. The email builder");
    const { saveDesignedTemplate } = await import("../src/actions/marketing-library");
    const { newBlock, BLOCK_KINDS, renderDesign, blankDesign } = await import("../src/lib/marketing/email-design");
    const { designOf } = await import("../src/lib/marketing/design-store");
    const every = { version: 1 as const, settings: { font: "georgia" as const, brandColor: "#0f766e" }, blocks: BLOCK_KINDS.map((k) => newBlock(k.type)) };
    const everyHtml = renderDesign(every, brand);
    ok("every kind of block drawn, nothing the cleaner takes out", removedInCleaning(everyHtml, sanitizeEmailHtml(everyHtml)).length === 0 && fieldsUsed(everyHtml).unknown.length === 0, removedInCleaning(everyHtml, sanitizeEmailHtml(everyHtml)));
    ok("  its font and colour used", everyHtml.includes("Georgia") && everyHtml.includes("#0f766e"));

    // More controls (owner, 1 Nov 2026): logo size and a partner's logo on the right, each block's own background
    // and spacing, sizes, colours, the email's width and corners.
    const styled = {
      version: 1 as const,
      settings: { font: "arial" as const, headingColor: "#111111", linkColor: "#c2410c", width: 640, radius: 0 },
      blocks: [
        { ...newBlock("logo"), size: 200, barColor: "#16a34a", partner: { src: "https://example.com/microsoft.png", alt: "Microsoft Solutions Partner", width: 120, link: "https://microsoft.com" } },
        { ...newBlock("heading"), size: 36, bg: "#fef3c7", padTop: 24, padBottom: 16 },
        { ...newBlock("text"), size: 18, html: '<p>See <a href="https://wroffy.com">us</a></p>' },
        { ...newBlock("button"), radius: 20, fontSize: 18, shape: "large" as const },
        { ...newBlock("banner"), titleSize: 40 },
        { ...newBlock("details"), background: "#ffffff", labelColor: "#000000" },
        { ...newBlock("image"), src: "https://example.com/p.png", radius: 12 },
      ],
    };
    const styledHtml = renderDesign(styled, brand);
    const cleanedStyled = sanitizeEmailHtml(styledHtml);
    ok("the new controls drawn, nothing the cleaner takes out", removedInCleaning(styledHtml, cleanedStyled).length === 0, removedInCleaning(styledHtml, cleanedStyled));
    ok("  a partner's logo on the right, at its size, linked; ours beside it", cleanedStyled.includes('src="https://example.com/microsoft.png"') && /width="120"/.test(cleanedStyled) && cleanedStyled.includes('href="https://microsoft.com"') && /align="right"/.test(cleanedStyled) && cleanedStyled.includes("#16a34a"));
    ok("  a block's own background and spacing", cleanedStyled.includes("background:#fef3c7") && /padding:24px 0 16px/.test(cleanedStyled));
    ok("  sizes, heading and link colours, button shape, width and corners", ["36px", "font:18px/1.6", "border-radius:20px", "16px 32px", "font:bold 40px", "color:#111111", "color:#c2410c", 'width="640"', "max-width:640px", "border-radius:0px", "border-radius:12px"].every((s) => cleanedStyled.includes(s)), ["36px", "font:18px/1.6", "border-radius:20px", "16px 32px", "font:bold 40px", "color:#111111", "color:#c2410c", 'width="640"', "max-width:640px", "border-radius:0px", "border-radius:12px"].filter((s) => !cleanedStyled.includes(s)));
    const ownLogo = renderDesign({ ...styled, blocks: [{ ...newBlock("logo"), src: "https://example.com/other-logo.png", size: 90 } as ReturnType<typeof newBlock>] }, brand);
    ok("  a different logo for one email, at its size", ownLogo.includes('src="https://example.com/other-logo.png"') && ownLogo.includes('width="90"'));
    const tooBig = await saveDesignedTemplate({ name: "ZZ big", topic: "OFFERS", subject: "", preheader: "", design: { ...styled, settings: { ...styled.settings, width: 2000 } } });
    ok("  a width past what an inbox shows refused", !tooBig.ok);
    const badPartner = await saveDesignedTemplate({ name: "ZZ bad", topic: "OFFERS", subject: "", preheader: "", design: { ...styled, blocks: [{ ...newBlock("logo"), partner: { src: "javascript:alert(1)", alt: "", width: 100, link: "" } }] } });
    ok("  a partner logo that isn't a picture refused", !badPartner.ok);

    const fresh = await saveDesignedTemplate({ name: "ZZ Builder email", topic: "OFFERS", subject: "ZZ {{firstName|Hello}}", preheader: "ZZ line", design: every });
    if (fresh.ok) made.push(fresh.data.id);
    ok("a design saved as a new template", fresh.ok, fresh.ok ? fresh.data.warnings : fresh.error);
    if (fresh.ok) {
      const changed = { ...every, blocks: [...every.blocks.slice(0, 3), { ...newBlock("text"), html: '<p>Hi<script>alert(1)</script> <a href="javascript:alert(1)">x</a> <strong>there</strong></p>' }] };
      const again = await saveDesignedTemplate({ id: fresh.data.id, name: "ZZ Builder email", topic: "OFFERS", subject: "ZZ {{firstName|Hello}}", preheader: "", design: changed });
      ok("  changed and saved again, in the same template", again.ok && again.data.id === fresh.data.id, again.ok ? "" : again.error);
      const row = await db.marketingTemplate.findUnique({ where: { id: fresh.data.id }, select: { body: true, topic: true } });
      const kept = await designOf(fresh.data.id);
      const text = kept?.blocks.find((b) => b.type === "text" && b.html.includes("<strong>there"));
      ok("  what runs is taken out of the text, in the email and the design kept", !!row && !row.body.includes("<script") && !row.body.includes("javascript:") && !!text && text.type === "text" && !text.html.includes("<script") && !text.html.includes("javascript:"), text);
      ok("  the design reopens with four blocks", kept?.blocks.length === 4, kept?.blocks.length);
    }
    const badLink = await saveDesignedTemplate({ name: "ZZ bad", topic: "OFFERS", subject: "", preheader: "", design: { ...blankDesign(), blocks: [{ ...newBlock("button"), link: "javascript:alert(1)" }] } });
    ok("a button to javascript: refused", !badLink.ok, badLink.ok ? "saved" : badLink.error);
    const badPicture = await saveDesignedTemplate({ name: "ZZ bad", topic: "OFFERS", subject: "", preheader: "", design: { ...blankDesign(), blocks: [{ ...newBlock("image"), src: "data:text/html;base64,PHNjcmlwdD4=" }] } });
    ok("a picture that isn't one refused", !badPicture.ok, badPicture.ok ? "saved" : badPicture.error);
    const empty = await saveDesignedTemplate({ name: "ZZ empty", topic: "OFFERS", subject: "", preheader: "", design: { ...blankDesign(), blocks: [] } });
    ok("an empty email refused", !empty.ok, empty.ok ? "saved" : empty.error);
    const noTopic = await saveDesignedTemplate({ name: "ZZ", topic: "NOPE", subject: "", preheader: "", design: blankDesign() });
    ok("an unknown topic refused", !noTopic.ok);
    const notYours = await saveDesignedTemplate({ id: "no-such-id", name: "ZZ", topic: "OFFERS", subject: "", preheader: "", design: blankDesign() });
    ok("saving over a template that isn't there refused", !notYours.ok);
  } finally {
    if (made.length) {
      await db.marketingAsset.deleteMany({ where: { templateId: { in: made } } });
      await db.auditLog.deleteMany({ where: { entityId: { in: made } } });
      await db.marketingTemplate.deleteMany({ where: { id: { in: made } } });
    }
    if (branding) await db.brandingSettings.update({ where: { id: "global" }, data: { logoDataUrl: branding.logoDataUrl, primaryColor: branding.primaryColor } });
    else await db.brandingSettings.deleteMany({ where: { id: "global" } });
  }

  console.log(failures === 0 ? `\nAll ${passes} template library checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
