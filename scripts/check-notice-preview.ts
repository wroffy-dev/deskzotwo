/**
 * check:notice-preview — a renewal reminder's Preview (owner, 3 Nov 2026: "mail preview option here").
 *
 * On this database's own subscriptions: the preview is the email Send would write the first person ticked — its
 * subject, words, address, the line of your own on top and the copies — and nothing is written or sent.
 *
 *   npm run check:notice-preview
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function main() {
  const { previewCustomerNotice, resolveNoticeRecipients } = await import("../src/lib/marketing/order-notice");

  // A live subscription whose customer has somebody who can be written to.
  const candidates = await db.companyProduct.findMany({
    where: { orderStatus: "FULFILLED", parentId: null, item: { type: "SUBSCRIPTION" }, endDate: { not: null }, company: { contacts: { some: { email: { not: null } } } } },
    select: { id: true },
    take: 40,
  });
  let order: string | null = null;
  let contact: { id: string; name: string; email: string | null } | null = null;
  for (const c of candidates) {
    const r = await resolveNoticeRecipients(c.id, "RENEWAL");
    const can = r?.contacts.find((x) => x.canReceive);
    if (can) {
      order = c.id;
      contact = can;
      break;
    }
  }
  if (!order || !contact) {
    console.log("  ..   no subscription here with somebody to write to");
    process.exit(0);
  }

  const before = await db.marketingMessage.count();
  const shown = await previewCustomerNotice({ companyProductId: order, contactIds: [contact.id], kind: "RENEWAL", note: "ZZ A line of my own.", origin: "https://example.test", cc: ["zz-copy@example.com"] });
  ok("a preview of the renewal reminder", shown.ok, shown.ok ? "" : shown.error);
  if (shown.ok) {
    ok("to the person ticked, at their address", shown.data.to.name === contact.name && shown.data.to.email === (contact.email ?? ""), shown.data.to);
    ok("with a subject, filled in", shown.data.subject.length > 0 && !shown.data.subject.includes("{{"), shown.data.subject);
    ok("the line of your own on top of the standard wording", shown.data.text.startsWith("ZZ A line of my own.") && shown.data.text.length > 30);
    ok("nothing left unfilled", !shown.data.text.includes("{{"));
    ok("the copies named", shown.data.cc.includes("zz-copy@example.com"));
  }
  ok("nothing written, nothing sent", (await db.marketingMessage.count()) === before);

  const nobody = await previewCustomerNotice({ companyProductId: order, contactIds: [], origin: "https://example.test" });
  ok("nobody ticked: says so", !nobody.ok, nobody);

  // A template designed in the builder (owner, 3 Nov 2026 — "html templates for this, editable from builder").
  const owner = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
  const designed = await db.marketingTemplate.create({
    data: {
      name: "ZZPROBE designed renewal",
      channel: "EMAIL",
      topic: "RENEWALS",
      format: "HTML",
      subject: "ZZ {{productName}} renews {{expiryDate}}",
      preheader: "ZZ before {{expiryDate}}",
      body: '<table role="presentation"><tr><td><h1 style="color:#0249FE">ZZ Renewal</h1><p>{{productName}} &mdash; {{quantity}} seats</p></td></tr></table>',
      createdById: owner.id,
    },
  });
  try {
    const html = await previewCustomerNotice({ companyProductId: order, contactIds: [contact.id], kind: "RENEWAL", templateId: designed.id, note: "ZZ <b>mine</b> & yours", origin: "https://example.test" });
    ok("a designed template previews as its HTML", html.ok && !!html.data.html && html.data.html.includes('<h1 style="color:#0249FE">ZZ Renewal</h1>'), html.ok ? "" : html.error);
    if (html.ok && html.data.html) {
      ok("…filled in, nothing left over", !html.data.html.includes("{{") && html.data.subject.startsWith("ZZ ") && !html.data.subject.includes("{{"), html.data.subject);
      ok("…the line of your own above it, escaped", html.data.html.includes("ZZ &lt;b&gt;mine&lt;/b&gt; &amp; yours"));
      ok("…with a plain-text part beside it", html.data.text.includes("ZZ Renewal") && !html.data.text.includes("<h1"), html.data.text.slice(0, 80));
      ok("…and the preheader", html.data.html.includes("ZZ before"));
    }
    const plain = await previewCustomerNotice({ companyProductId: order, contactIds: [contact.id], kind: "RENEWAL", origin: "https://example.test" });
    ok("the standard wording is still text", plain.ok && plain.data.html === null);
    ok("still nothing written", (await db.marketingMessage.count()) === before);
  } finally {
    await db.marketingTemplate.delete({ where: { id: designed.id } });
  }

  await db.$disconnect();
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
