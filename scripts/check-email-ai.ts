/**
 * check:email-ai — the email builder's AI designer and its test send (owner, 1 Nov 2026 —
 * src/lib/marketing/ai-design.ts, src/actions/email-builder-tools.ts). The model and the mail provider are stand-ins:
 * nothing is charged and nothing leaves.
 *
 *   1. Designing: the model's email opened as a design — Deskzo's own block ids, "html" blocks dropped, subjects and
 *      notes cut to size, credits added up over turns; one with mistakes sent back once with them listed; one that
 *      never calls the tool, or is refused, said in words.
 *   2. What the model is told: the company's name and email, the merge fields — and, to change an email, its blocks
 *      without ids. Nothing about any customer.
 *   3. The test send: to the person asking only, "[Test]" before the subject, sample values or a contact's own —
 *      their company's next renewal included — its links tagged; a field with no value refused; an unsaved email,
 *      no permission, refused.
 *
 *   npm run check:email-ai
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

type Call = { system: string; history: unknown[] };
let actor: { id: string; role: string; name: string; email: string } | null = null;
let allowed = true;
const calls: Call[] = [];
let script: { toolInput?: unknown; text?: string; stop?: string; refuse?: string }[] = [];
const sent: { to: string; subject: string; html: string; text?: string }[] = [];

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  // The real resolver behind the stand-in's `can`: a test filled with a contact asks the contact's record level too
  // (src/lib/authz/contact-access.ts `contactScope`, Phase 2), which reads the actor's permissions — an admin's here.
  if (request === "@/lib/authz/resolve" || request.endsWith("lib/authz/resolve")) return { ...(originalLoad.call(this, request, parent, isMain) as object), can: async () => allowed };
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) return { isModuleEntitled: async () => true };
  if (request === "@/lib/ai/gateway" || request.endsWith("lib/ai/gateway")) {
    class AiRefusal extends Error {}
    return {
      AiRefusal,
      aiUnavailable: async () => null,
      aiService: async () => ({ model: "ZZ model", residency: "India", noTraining: true }),
      aiTurn: async (turn: Call) => {
        calls.push({ system: turn.system, history: JSON.parse(JSON.stringify(turn.history)) });
        const next = script.shift() ?? {};
        if (next.refuse) throw new AiRefusal(next.refuse);
        return {
          text: next.text ?? "",
          toolCalls: next.toolInput ? [{ id: `call-${calls.length}`, name: "propose_email", input: next.toolInput }] : [],
          native: null,
          usage: { input: 100, output: 200 },
          stop: next.stop ?? "end",
          model: "zz",
          family: "ANTHROPIC",
          modelKey: "zz",
          charge: { credits: 1500, fromAllowance: 1500, fromPacks: 0, overdraft: 0, left: null },
        };
      },
    };
  }
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (request === "@/lib/marketing/pipeline" || request.endsWith("lib/marketing/pipeline")) {
    return { ...(loaded as object), deliverNow: async (m: { to: string; subject: string; html: string; text?: string }) => (sent.push(m), { ok: true, provider: "zz", fromEmail: "zz@zz.invalid" }) };
  }
  return loaded;
} as typeof originalLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const goodEmail = {
  name: "ZZ Diwali greetings",
  subjects: ["Happy Diwali from all of us", "Diwali wishes, {{firstName|friend}}", "A festive note from {{ourName}}", "a fourth, cut"],
  preheader: "With a small festive offer inside",
  topic: "OFFERS",
  blocks: [
    { type: "logo", align: "left", bar: true, id: "model-made-id" },
    { type: "banner", eyebrow: "Festive offer", title: "Happy Diwali!", subtitle: "[10% off] till [date]", align: "center" },
    { type: "text", html: "<p>Dear {{firstName|friend}},</p><p>Thank you for being with us.</p>", align: "left", size: 15 },
    { type: "html", html: "<script>alert(1)</script>" },
    { type: "button", label: "Claim the offer", link: "mailto:{{ownerEmail|hello@zz-brand.invalid}}?subject=Offer", align: "left", full: false },
    { type: "signature", closing: "Warm regards,", contacts: true },
  ],
  notes: ["Fill in the offer and date in [brackets]."],
};

async function main() {
  const { designEmailWithAI, emailAiStatus, sendTemplateTest, searchTestContacts } = await import("../src/actions/email-builder-tools");
  const admin = await db.user.findFirst({ where: { role: "ADMIN", active: true, email: { not: "" } }, select: { id: true, role: true, name: true, email: true } });
  if (!admin) throw new Error("No admin to act as.");
  actor = admin;

  section("1. Designing");
  const status = await emailAiStatus();
  ok("available, and where the words go said", status.unavailable === null && status.provider.includes("India") && status.provider.includes("never used for training"), status);
  script = [{ toolInput: goodEmail }];
  const made = await designEmailWithAI({ description: "Diwali greetings with a 10% festive offer" });
  ok("designed", made.ok, made.ok ? "" : made.error);
  if (made.ok) {
    const d = made.data;
    ok("  the blocks opened, the html block dropped, every id Deskzo's own", d.design.blocks.length === 5 && !d.design.blocks.some((b) => (b.type as string) === "html") && d.design.blocks.every((b) => b.id !== "model-made-id" && /^b[a-z0-9]+$/.test(b.id)), d.design.blocks.map((b) => b.type));
    ok("  three subjects at most, the preview line and topic kept", d.subjects.length === 3 && d.preheader.startsWith("With") && d.topic === "OFFERS");
    ok("  the credits it used, in words", d.credits === "1.5", d.credits);
  }
  const first = calls[0];
  ok("the model told the company's name and email and the merge fields", !!first && first.system.includes("{{firstName}}") && first.system.includes("[square brackets]"));
  const askText = JSON.stringify(first?.history ?? []);
  ok("  and only the description — no customer", askText.includes("Diwali greetings with a 10% festive offer") && !askText.includes("@") , askText.slice(0, 200));

  calls.length = 0;
  const broken = { ...goodEmail, blocks: [{ type: "button", label: "Go", link: "javascript:alert(1)" }] };
  script = [{ toolInput: broken }, { toolInput: goodEmail }];
  const repaired = await designEmailWithAI({ description: "A simple announcement email" });
  const repairTurn = JSON.stringify(calls[1]?.history ?? []);
  ok("a design with a mistake sent back once with it listed, then taken", repaired.ok && calls.length === 2 && repairTurn.includes("A link starts with https://"), repaired.ok ? repairTurn.slice(-300) : repaired.error);
  ok("  the credits of both turns added up", repaired.ok && repaired.data.credits === "3", repaired.ok ? repaired.data.credits : "");

  calls.length = 0;
  if (made.ok) {
    script = [{ toolInput: { ...goodEmail, name: "ZZ changed" } }];
    const changed = await designEmailWithAI({ description: "Make it shorter", current: made.data.design });
    const ask = JSON.stringify(calls[0]?.history ?? []);
    ok("changing an email: it is sent as it is, without block ids", changed.ok && ask.includes("Here is the email as it is now") && ask.includes("Happy Diwali") && !/"id"/.test(ask.replace(/\\"/g, '"').split("Change it like this")[0]!), ask.slice(0, 160));
  }

  script = [{ text: "Here's a lovely email for you!" }, { text: "Still prose" }, { text: "And again" }];
  const prose = await designEmailWithAI({ description: "Something for our customers" });
  ok("a model that only talks: said in words, nothing opened", !prose.ok && prose.error.includes("didn't come back"), prose.ok ? "designed" : prose.error);
  script = [{ refuse: "This workspace has used all its Deskzo AI credits." }];
  const refused = await designEmailWithAI({ description: "Something for our customers" });
  ok("credits gone: the gateway's words passed on", !refused.ok && refused.error.includes("credits"), refused.ok ? "designed" : refused.error);
  const short = await designEmailWithAI({ description: "hi" });
  ok("too short a description asked for more", !short.ok && short.error.includes("more"));
  allowed = false;
  const notAllowed = await designEmailWithAI({ description: "A simple announcement email" });
  ok("refused without marketing.manage", !notAllowed.ok && notAllowed.error.includes("can't"));
  allowed = true;

  section("3. The test send");
  const template = await db.marketingTemplate.create({
    data: {
      name: "ZZ AI test template",
      channel: "EMAIL",
      topic: "RENEWALS",
      subject: "{{productName|Your subscription}} renews soon, {{firstName|there}}",
      body: '<p>Hi {{firstName|there}}, {{companyName}}\'s {{productName|subscription}} renews on {{expiryDate|soon}}.</p><p><a href="https://zz-brand.invalid/renew">Renew</a></p>',
      format: "HTML",
      createdById: admin.id,
    },
    select: { id: true },
  });
  const strict = await db.marketingTemplate.create({ data: { name: "ZZ strict", channel: "EMAIL", topic: "OFFERS", subject: "Hi", body: "<p>Hi {{companyNmae}}</p>", format: "HTML", createdById: admin.id }, select: { id: true } });
  try {
    const sample = await sendTemplateTest({ templateId: template.id });
    const mail = sent[sent.length - 1];
    ok("with sample values: to me only, [Test] before the subject", sample.ok && sent.length === 1 && mail!.to === admin.email && mail!.subject.startsWith("[Test] Microsoft 365 Business Basic renews soon, Rajesh"), sample.ok ? mail?.subject : sample.error);
    ok("  its link tagged as a test", !!mail?.html.includes("utm_campaign=test"), mail?.html.match(/href="[^"]+renew[^"]*"/)?.[0]);

    const contact = await db.contact.findFirst({ where: { email: { not: null }, leftAt: null, company: { products: { some: { parentId: null, item: { type: "SUBSCRIPTION" }, endDate: { gte: new Date() } } } } }, select: { id: true, name: true, company: { select: { name: true } } } });
    if (contact) {
      const found = await searchTestContacts(contact.name.slice(0, 4));
      ok("contacts found by name to fill a test with", found.some((c) => c.id === contact.id), found.length);
      const theirs = await sendTemplateTest({ templateId: template.id, contactId: contact.id });
      const m = sent[sent.length - 1];
      const first = contact.name.trim().split(/\s+/)[0]!;
      ok("with a contact's own values: their name and company, and their next renewal's product", theirs.ok && !!m && m.subject.includes(first) && m.html.includes(contact.company.name.replace(/&/g, "&amp;")) && !m.subject.includes("Microsoft 365 Business Basic renews soon, Rajesh"), theirs.ok ? m?.subject : theirs.error);
      ok("  sent to me, not to them", m?.to === admin.email);
    } else {
      ok("(no contact with a renewal in this database — the contact case skipped)", true);
    }
    const noValue = await sendTemplateTest({ templateId: strict.id });
    ok("a field that doesn't exist (a typo) refused, naming it", !noValue.ok && noValue.error.includes("no merge field {{companyNmae}}"), noValue.ok ? "sent" : noValue.error);
    const unsaved = await sendTemplateTest({ templateId: "" });
    ok("an email not saved yet refused", !unsaved.ok && unsaved.error.includes("Save"));
    allowed = false;
    const blocked = await sendTemplateTest({ templateId: template.id });
    ok("refused without marketing.manage", !blocked.ok);
    allowed = true;
  } finally {
    await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [template.id, strict.id] } }, { entityId: "ai-design", userId: admin.id, createdAt: { gte: new Date(Date.now() - 15 * 60_000) } }] } });
    await db.marketingTemplate.deleteMany({ where: { id: { in: [template.id, strict.id] } } });
  }

  console.log(failures === 0 ? `\nAll ${passes} email AI checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
