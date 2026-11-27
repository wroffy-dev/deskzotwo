/**
 * check:sales-crm — Deskzo's own sales CRM (owner, 18 Nov 2026 — src/lib/platform/sales-crm.ts).
 *
 *   1. The setting: a workspace that isn't there is refused; the local `deskzo` one is taken.
 *   2. A deskzo.com enquiry becomes a lead in it, with the topic and message.
 *   3. A sign-up becomes a lead, remembered against its workspace; a change in its billing standing is a note on that
 *      lead once, and the same standing again adds nothing.
 *   4. Nothing set: nothing goes across, and nothing throws.
 *
 * It writes into the local `deskzo` workspace: probes are …@zzprobe-sales-crm.invalid, removed in a finally, and the
 * platform setting is put back as it was found.
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/notify" || request.endsWith("lib/notify")) return { notifyUser: async () => {}, notifyUsers: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const MAIL = "@zzprobe-sales-crm.invalid";
const FAKE_TENANT = "zzprobe-sales-crm-tenant";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const crm = require("../src/lib/platform/sales-crm") as typeof import("../src/lib/platform/sales-crm");
  const { controlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
  const { tenantBySlug } = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const control = controlDb();
  const tenant = await tenantBySlug("deskzo");
  if (!tenant) throw new Error("No local deskzo workspace to check against.");
  const db = directClient();
  const found = await control.platformSetting.findUnique({ where: { key: "sales.crm.workspace" } });

  const cleanup = async () => {
    const contacts = await db.contact.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true, companyId: true } });
    const leads = await db.lead.findMany({ where: { contactId: { in: contacts.map((c) => c.id) } }, select: { id: true } });
    await db.activity.deleteMany({ where: { leadId: { in: leads.map((l) => l.id) } } });
    await db.lead.deleteMany({ where: { id: { in: leads.map((l) => l.id) } } });
    await db.contact.deleteMany({ where: { id: { in: contacts.map((c) => c.id) } } });
    await db.company.deleteMany({ where: { name: { startsWith: "Zzprobe Sales" } } });
    await control.platformSetting.deleteMany({ where: { key: { in: [`sales.crm.lead:${FAKE_TENANT}`, `sales.crm.standing:${FAKE_TENANT}`] } } });
  };

  try {
    await cleanup();
    section("1. The setting");
    const refused = await crm.setSalesCrmWorkspace("zz-no-such-workspace", "check");
    ok("a workspace that isn't there is refused", !refused.ok, refused.ok ? "" : refused.error);
    const taken = await crm.setSalesCrmWorkspace("deskzo", "check");
    ok("the local deskzo is taken", taken.ok && (await crm.salesCrmWorkspace()) === "deskzo");

    section("2. An enquiry");
    await crm.enquiryToSalesCrm({ name: "Zz Enquirer", email: `enquirer${MAIL}`, company: "Zzprobe Sales Enquiry Pvt Ltd", topic: "demo", message: "We sell to schools and want a demo." });
    const enquiry = await db.lead.findFirst({ where: { contact: { email: `enquirer${MAIL}` } }, select: { title: true, description: true } });
    ok("it is a lead there, titled for the form", !!enquiry && enquiry.title.startsWith("deskzo.com — demo"), enquiry?.title);
    ok("  with the message", !!enquiry?.description?.includes("We sell to schools"), enquiry?.description?.slice(0, 80));

    section("3. A sign-up and its billing");
    await crm.signupToSalesCrm({
      tenantId: FAKE_TENANT,
      workspace: "Zzprobe Sales Signup",
      slug: "zzprobesignup",
      owner: { name: "Zz Owner", email: `owner${MAIL}` },
      product: null,
      plan: "one",
      trialEndsAt: new Date("2026-12-02T00:00:00Z"),
    });
    const signup = await db.lead.findFirst({ where: { contact: { email: `owner${MAIL}` } }, select: { id: true, title: true, description: true } });
    ok("a lead for the new workspace", signup?.title === "Sign-up — Zzprobe Sales Signup", signup?.title);
    ok("  with its plan and trial end", !!signup?.description?.includes("Plan: one") && !!signup.description.includes("Trial ends: 2026-12-02"));
    const remembered = await control.platformSetting.findUnique({ where: { key: `sales.crm.lead:${FAKE_TENANT}` } });
    ok("  remembered against the workspace", remembered?.value === signup?.id);

    const trial = { tenantId: FAKE_TENANT, standing: { kind: "trial" as const, endsAt: new Date("2026-12-02T00:00:00Z") } };
    ok("its first standing is a note", (await crm.standingsToSalesCrm([trial])) === 1);
    ok("  the same standing again adds nothing", (await crm.standingsToSalesCrm([trial])) === 0);
    ok("  paying is a new note", (await crm.standingsToSalesCrm([{ tenantId: FAKE_TENANT, standing: { kind: "paid" } }])) === 1);
    const notes = await db.activity.findMany({ where: { leadId: signup?.id ?? "" }, orderBy: { createdAt: "asc" }, select: { notes: true } });
    ok("  the notes read as they should", notes.map((n) => n.notes).join(" | ") === "Deskzo: On trial, to 2026-12-02 | Deskzo: Paying", notes.map((n) => n.notes).join(" | "));

    section("4. Nothing set");
    await crm.setSalesCrmWorkspace(null, "check");
    await crm.enquiryToSalesCrm({ name: "Zz Nobody", email: `nobody${MAIL}`, topic: "sales", message: "Hello there, a question." });
    ok("an enquiry goes nowhere, and nothing throws", (await db.contact.count({ where: { email: `nobody${MAIL}` } })) === 0);
    ok("  standings go nowhere", (await crm.standingsToSalesCrm([{ tenantId: FAKE_TENANT, standing: { kind: "lapsed", since: new Date() } }])) === 0);
  } finally {
    await cleanup();
    if (found) await control.platformSetting.upsert({ where: { key: found.key }, create: { key: found.key, value: found.value, updatedBy: found.updatedBy }, update: { value: found.value, updatedBy: found.updatedBy } });
    else await control.platformSetting.deleteMany({ where: { key: "sales.crm.workspace" } });
    await db.$disconnect();
  }
  const after = await control.platformSetting.findUnique({ where: { key: "sales.crm.workspace" } });
  ok("the platform's setting is as it was found", (after?.value ?? null) === (found?.value ?? null));
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll sales-crm checks passed.");
    process.exitCode = failures ? 1 : 0;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
