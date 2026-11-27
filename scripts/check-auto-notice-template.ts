/**
 * check:auto-notice-template — the template the automatic renewal reminder goes in (owner, 13 Nov 2026 —
 * src/lib/marketing/auto-notice-template.ts).
 *
 * On this database's own subscriptions, through the preview (nothing is written or sent), with a template of its own
 * (ZZ_AUTO_TPL, removed in a finally) and the workspace's choice put back after:
 *   nothing chosen: the built-in wording; chosen: the reminder going by itself is in it; one sent by hand keeps the
 *   wording its sender picked; the template switched off: the built-in wording again; only a Renewals email template
 *   may be chosen.
 *
 *   npm run check:auto-notice-template
 */
import "dotenv/config";
import Module from "node:module";

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};

async function main() {
  const { db } = await import("../src/lib/db");
  const { previewCustomerNotice, resolveNoticeRecipients } = await import("../src/lib/marketing/order-notice");
  const auto = await import("../src/lib/marketing/auto-notice-template");

  const candidates = await db.companyProduct.findMany({
    where: { orderStatus: "FULFILLED", parentId: null, item: { type: "SUBSCRIPTION" }, endDate: { not: null }, company: { contacts: { some: { email: { not: null } } } } },
    select: { id: true },
    take: 40,
  });
  let order: string | null = null;
  let contact: string | null = null;
  for (const c of candidates) {
    const can = (await resolveNoticeRecipients(c.id, "RENEWAL"))?.contacts.find((x) => x.canReceive);
    if (can) {
      order = c.id;
      contact = can.id;
      break;
    }
  }
  if (!order || !contact) {
    console.log("  ..   no subscription here with somebody to write to — skipped");
    return;
  }

  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
  const before = await db.autoNoticeTemplate.findUnique({ where: { kind: "RENEWAL" } });
  const template = await db.marketingTemplate.create({
    data: { name: "ZZ_AUTO_TPL renewal", channel: "EMAIL", topic: "RENEWALS", subject: "ZZ_AUTO_TPL {{productName}} is due", body: "ZZ_AUTO_TPL body for {{productName}}", format: "TEXT", createdById: admin.id },
    select: { id: true },
  });
  const offTopic = await db.marketingTemplate.create({
    data: { name: "ZZ_AUTO_TPL offer", channel: "EMAIL", topic: "OFFERS", subject: "ZZ offer", body: "ZZ offer", format: "TEXT", createdById: admin.id },
    select: { id: true },
  });
  const messagesBefore = await db.marketingMessage.count();
  const byItself = () => previewCustomerNotice({ companyProductId: order!, contactIds: [contact!], kind: "RENEWAL", origin: "https://example.test" });
  try {
    await db.autoNoticeTemplate.deleteMany({ where: { kind: "RENEWAL" } });
    const plain = await byItself();
    ok("nothing chosen: the built-in wording", plain.ok && !plain.data.subject.includes("ZZ_AUTO_TPL"), plain.ok ? plain.data.subject : plain.error);

    ok("the list offers the Renewals email template, not an offer", (await auto.renewalTemplateOptions()).some((o) => o.id === template.id) && !(await auto.renewalTemplateOptions()).some((o) => o.id === offTopic.id));

    await auto.setAutoTemplate("RENEWAL", template.id, admin.id);
    const chosen = await byItself();
    ok("chosen: the reminder going by itself is in it", chosen.ok && chosen.data.subject.startsWith("ZZ_AUTO_TPL") && chosen.data.text.includes("ZZ_AUTO_TPL body"), chosen.ok ? chosen.data.subject : chosen.error);
    ok("  its fields filled in", chosen.ok && !chosen.data.subject.includes("{{") && !chosen.data.text.includes("{{"));

    const byHand = await previewCustomerNotice({ companyProductId: order, contactIds: [contact], kind: "RENEWAL", origin: "https://example.test", sentByUserId: admin.id });
    ok("sent by hand with no template picked: the built-in wording, as its sender chose", byHand.ok && !byHand.data.subject.includes("ZZ_AUTO_TPL"), byHand.ok ? byHand.data.subject : byHand.error);

    await db.marketingTemplate.update({ where: { id: template.id }, data: { active: false } });
    const switchedOff = await byItself();
    ok("the template switched off: the built-in wording again, not a failure", switchedOff.ok && !switchedOff.data.subject.includes("ZZ_AUTO_TPL"), switchedOff.ok ? switchedOff.data.subject : switchedOff.error);
    ok("  the choice is still there, for the page to say so", (await auto.chosenAutoTemplate("RENEWAL")) === template.id);

    ok("previews wrote and sent nothing", (await db.marketingMessage.count()) === messagesBefore);
  } finally {
    if (before) await db.autoNoticeTemplate.upsert({ where: { kind: "RENEWAL" }, create: before, update: { templateId: before.templateId, updatedById: before.updatedById } });
    else await db.autoNoticeTemplate.deleteMany({ where: { kind: "RENEWAL" } });
    await db.marketingTemplate.deleteMany({ where: { id: { in: [template.id, offTopic.id] } } });
  }
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
