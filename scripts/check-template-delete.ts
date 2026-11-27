/**
 * check:template-delete — retiring and deleting marketing templates (src/actions/marketing.ts:
 * setTemplateActive, deleteTemplate, and saveTemplate keeping a retired template retired).
 *
 * marketing.manage only; a template a campaign uses is refused, naming it, and stays; an unused one goes,
 * audited. A fixture of its own in the local database — names start ZZPROBE_TPL, removed in a finally.
 *
 *   npm run check:template-delete
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "ADMIN", name: "Zzprobe", email: `actor${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_TPL";
const MAIL = "@zzprobe-tpl.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  const ids = (await db.marketingTemplate.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((t) => t.id);
  await db.campaign.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.auditLog.deleteMany({ where: { OR: [{ entityLabel: { startsWith: TAG } }, { user: { email: { endsWith: MAIL } } }] } });
  await db.marketingTemplate.deleteMany({ where: { id: { in: ids } } });
  await db.user.deleteMany({ where: { email: { endsWith: MAIL } } });
}

async function main() {
  const { deleteTemplate, setTemplateActive, saveTemplate } = await import("../src/actions/marketing");
  const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!superAdmin) throw new Error("The local database has no super admin.");
  await cleanup();
  try {
    const nobody = await db.user.create({ data: { name: "Zzprobe Sales", email: `sales${MAIL}`, role: "SALES", passwordHash: "!" }, select: { id: true } });
    const tpl = (name: string) => db.marketingTemplate.create({ data: { name: `${TAG} ${name}`, body: "Hello", createdById: superAdmin.id }, select: { id: true } });
    const unused = await tpl("Unused");
    const used = await tpl("Used");
    await db.campaign.create({ data: { reference: `${TAG}-1`, name: `${TAG} Diwali`, templateId: used.id, createdById: superAdmin.id } });

    console.log("\n— Permission —\n");
    actorId = nobody.id;
    const refused = await deleteTemplate(unused.id).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
    ok("without marketing.manage: refused", !refused.ok, !refused.ok ? refused.error : "");
    const retireRefused = await setTemplateActive(unused.id, false).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
    ok("…and retiring too", !retireRefused.ok);
    ok("…the template is untouched", (await db.marketingTemplate.count({ where: { id: unused.id, active: true } })) === 1);

    actorId = superAdmin.id;
    console.log("\n— Retire —\n");
    const retired = await setTemplateActive(used.id, false);
    ok("retire", retired.ok && (await db.marketingTemplate.findUnique({ where: { id: used.id } }))?.active === false);
    const edited = await saveTemplate({ id: used.id, name: `${TAG} Used`, channel: "EMAIL", topic: "OFFERS", subject: "Hi", body: "Hello again {{unsubscribeUrl}}" });
    ok("an edit leaves it retired", edited.ok && (await db.marketingTemplate.findUnique({ where: { id: used.id } }))?.active === false, !edited.ok ? edited.error : "");
    const back = await setTemplateActive(used.id, true);
    ok("bring back", back.ok && (await db.marketingTemplate.findUnique({ where: { id: used.id } }))?.active === true);

    console.log("\n— Delete —\n");
    const inUse = await deleteTemplate(used.id);
    ok("a template a campaign uses is refused, naming it", !inUse.ok && inUse.error.includes(`${TAG} Diwali`) && inUse.error.includes("Retire"), !inUse.ok ? inUse.error : "");
    ok("…and it stays", (await db.marketingTemplate.count({ where: { id: used.id } })) === 1);
    const gone = await deleteTemplate(unused.id);
    ok("an unused template is deleted", gone.ok && (await db.marketingTemplate.count({ where: { id: unused.id } })) === 0, !gone.ok ? gone.error : "");
    ok("…audited", (await db.auditLog.count({ where: { userId: superAdmin.id, action: "DELETE", entityType: "MarketingTemplate", entityId: unused.id } })) === 1);
    const twice = await deleteTemplate(unused.id);
    ok("deleting it again says it's gone", !twice.ok && /no longer exists/.test(twice.error));
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
