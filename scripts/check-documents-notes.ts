/**
 * check:documents-notes — "Raise credit and debit notes" as its own permission (owner, 2 Nov 2026).
 *
 * Accounts and Management hold it by default, sales doesn't; the accounts presets carry it, the sales ones don't;
 * every write of a note asks it (documentWriteKey) while quotes and invoices still ask "Raise and issue"; the
 * migration copied a stored "Raise and issue" grant only where "Record payments" sat beside it, and every denial;
 * Convert to credit note refuses a sales person before anything else; and the Credit Notes and Debit Notes menu
 * links ask it (or the books). A fixture of its own in the local database, accounts on @zzprobe-dn.invalid,
 * removed in a finally.
 *
 *   npm run check:documents-notes
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
    const user = () => ({ id: actorId, role: "SALES", name: "Zzprobe", email: `actor${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const MAIL = "@zzprobe-dn.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  const { getPermissionDefinition } = await import("../src/lib/permissions");
  const { documentWriteKey, documentWriteRefusal } = await import("../src/lib/documents/write-permission");
  const { can } = await import("../src/lib/authz/resolve");
  const { getPreset } = await import("../src/lib/authz/presets");
  const { MODULE_REGISTRY, navPermissionKeys } = await import("../src/lib/modules");
  const { convertTradeDocument } = await import("../src/actions/trade-document");

  console.log("\n— Defaults and presets —\n");
  // Since 9 Nov 2026 a note's writes are "Create / Edit / Issue credit notes" and the same for debit notes
  // (src/lib/documents/permission-keys.ts), still accounts' by default.
  const NOTE_KEYS = ["docs.createCreditNote", "docs.editCreditNote", "docs.issueCreditNote", "docs.createDebitNote", "docs.editDebitNote", "docs.issueDebitNote"];
  const defs = NOTE_KEYS.map((k) => getPermissionDefinition(k)!);
  ok("Accounts and Management hold them by default", defs.every((d) => ["ACCOUNTS", "MANAGEMENT"].every((r) => (d.defaultRoles as readonly string[]).includes(r))));
  ok("Sales doesn't", defs.every((d) => !(d.defaultRoles as readonly string[]).includes("SALES")));
  ok("the accounts and operations presets carry them", ["accounts-executive", "accounts-manager", "operations-manager"].every((k) => NOTE_KEYS.every((n) => getPreset(k)?.permissions.includes(n as never))));
  ok("the sales presets don't", ["sales-executive", "sales-manager", "renewal-specialist"].every((k) => NOTE_KEYS.every((n) => !getPreset(k)?.permissions.includes(n as never))));

  console.log("\n— Which writes ask it —\n");
  ok("a credit note's and a debit note's writes", documentWriteKey("CREDIT_NOTE", "create") === "docs.createCreditNote" && documentWriteKey("DEBIT_NOTE", "issue") === "docs.issueDebitNote");
  ok("  cancelling one is its own", documentWriteKey("CREDIT_NOTE", "cancel") === "docs.cancelCreditNote");
  ok("  the refusal names the note", /credit note/.test(documentWriteRefusal("CREDIT_NOTE", "create")));
  const links = MODULE_REGISTRY.flatMap((m) => m.navItems).filter((i) => i.href === "/sales/credit-notes" || i.href === "/sales/debit-notes");
  ok("the Credit Notes and Debit Notes links ask for creating one, or the books", links.length === 2 && links.every((i) => navPermissionKeys(i).includes("docs.createCreditNote") && navPermissionKeys(i).includes("ledger.viewReports")));

  console.log("\n— The migration —\n");
  const [old, copied] = await Promise.all([
    db.rolePermission.findMany({ where: { permission: "documents.notes" }, select: { role: true, allowed: true } }),
    db.rolePermission.findMany({ where: { permission: { in: NOTE_KEYS } }, select: { role: true, permission: true, allowed: true } }),
  ]);
  const wrong = old.filter((r) => !NOTE_KEYS.every((k) => copied.some((c) => c.role === r.role && c.permission === k && c.allowed === r.allowed)));
  ok("every stored grant and denial of the old notes permission was copied onto all six", wrong.length === 0, wrong.map((r) => r.role).join(", "));

  await cleanup();
  try {
    const mk = (local: string, role: "SALES" | "ACCOUNTS") => db.user.create({ data: { name: `Zzprobe ${local}`, email: `${local}${MAIL}`, role, passwordHash: "!" }, select: { id: true } });
    const seller = await mk("seller", "SALES");
    const accountant = await mk("accountant", "ACCOUNTS");
    // Built-in roles' stored rows vary by workspace; the person's own grants settle it here.
    await db.userPermission.createMany({
      data: [
        { userId: seller.id, permission: "docs.createInvoice", allowed: true, reason: "check:documents-notes" },
        { userId: seller.id, permission: "docs.createCreditNote", allowed: false, reason: "check:documents-notes" },
        { userId: seller.id, permission: "docs.createDebitNote", allowed: false, reason: "check:documents-notes" },
        { userId: accountant.id, permission: "docs.createCreditNote", allowed: true, reason: "check:documents-notes" },
      ],
    });

    console.log("\n— Who may —\n");
    ok("a seller raises invoices but not notes", (await can(seller.id, "docs.createInvoice")) && !(await can(seller.id, "docs.createCreditNote")));
    ok("an accountant raises notes", await can(accountant.id, "docs.createCreditNote"));

    actorId = seller.id;
    const refused = await convertTradeDocument({ id: "zz-none", target: "CREDIT_NOTE" });
    ok("Convert to credit note refuses the seller, before looking at the invoice", !refused.ok && refused.error === documentWriteRefusal("CREDIT_NOTE", "create"), !refused.ok ? refused.error : "");
    const debit = await convertTradeDocument({ id: "zz-none", target: "DEBIT_NOTE" });
    ok("  and Convert to debit note", !debit.ok && debit.error === documentWriteRefusal("DEBIT_NOTE", "create"), !debit.ok ? debit.error : "");
    const invoice = await convertTradeDocument({ id: "zz-none", target: "INVOICE" });
    ok("  while converting to an invoice gets past the permission (the made-up quote stops it)", !invoice.ok && invoice.error !== documentWriteRefusal("INVOICE", "create"), !invoice.ok ? invoice.error : "");
    actorId = accountant.id;
    const passed = await convertTradeDocument({ id: "zz-none", target: "CREDIT_NOTE" });
    ok("the accountant gets past the permission", !passed.ok && passed.error !== documentWriteRefusal("CREDIT_NOTE", "create"), !passed.ok ? passed.error : "");
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
