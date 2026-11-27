/**
 * check:service-notices — a campaign on a Service notices template goes without an opt-in (owner, 2 Nov 2026: "service
 * news, opt-in doesn't require"), every other topic still needs one.
 *
 * A contact of its own (ZZPROBE_SN) on a customer, with no consent recorded: an Offers campaign holds them back for
 * consent, a Service one doesn't; turned off in the preference centre, a Service one holds them back too. Removed in
 * a finally.
 *
 *   npm run check:service-notices
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
const MAIL = "zzprobe-sn@example.com";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  await db.contact.deleteMany({ where: { email: MAIL } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { resolveRecipients, marketingSettings } = require("../src/lib/marketing/pipeline") as typeof import("../src/lib/marketing/pipeline");
  const { campaignEligibility } = require("../src/lib/marketing/topics") as typeof import("../src/lib/marketing/topics");

  ok("Service notices go as a reminder", campaignEligibility("SERVICE").messageClass === "TRANSACTIONAL" && campaignEligibility("SERVICE").optOuts === true);
  ok("every other topic is marketing", (["OFFERS", "PRODUCT_NEWS", "EVENTS", "NEWSLETTER", "RENEWALS"] as const).every((t) => campaignEligibility(t).messageClass === "MARKETING"));

  await cleanup();
  try {
    const company = await db.company.findFirstOrThrow({ where: { relationshipType: "CLIENT", managedByResellerId: null }, select: { id: true } });
    const contact = await db.contact.create({ data: { companyId: company.id, name: "Zzprobe Service", email: MAIL } });
    // A workspace that asks for an opt-in (Settings › Mail & messaging — off by default since 2 Nov 2026).
    const base = await marketingSettings();
    const settings = { ...base, limits: { ...base.limits, requireOptIn: true } };
    const verdict = async (topic: "OFFERS" | "SERVICE") =>
      (await resolveRecipients({ contactIds: [contact.id], channel: "EMAIL", topic, ...campaignEligibility(topic), settings }))[0]?.verdict;

    const offers = await verdict("OFFERS");
    ok("an offer is held back for consent", !!offers && !offers.ok && offers.findings.some((f) => f.key === "NO_CONSENT"), offers?.ok ? offers : offers?.findings.map((f) => f.key));
    const service = await verdict("SERVICE");
    ok("a service notice isn't held back for consent", !!service && (service.ok || service.reason !== "NO_CONSENT"), service);
    ok("…and goes", !!service?.ok, service);

    await db.contactConsent.create({ data: { contactId: contact.id, channel: "EMAIL", topic: "SERVICE", status: "UNSUBSCRIBED", source: "PREFERENCE_CENTRE", withdrawnAt: new Date() } });
    const off = await verdict("SERVICE");
    ok("turned off in the preference centre, a service notice is held back", !!off && !off.ok, off);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
