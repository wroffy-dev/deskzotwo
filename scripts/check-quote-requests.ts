/**
 * check:quote-requests — a reseller asks for a quotation through their own link (owner, 26 Nov 2026; src/lib/quote-requests.ts).
 *
 *   · A link is one person at one reseller; only its hash is kept; switched off, or the person gone, it opens nothing.
 *   · The form: an end customer and at least one item, whole-number quantities, a day not passed, limits kept.
 *   · Sent: kept with its lines, numbered RFQ-…, the account manager told; twenty a day from one link at most.
 *   · A file: checked to be what its name says, kept, and served only to somebody who may work the request.
 *   · Each line matched to the catalogue — exactly by name or SKU, else the one item whose name holds it — and priced at
 *     the reseller's: their special price, else their tier discount, else the list price. Two candidates match neither.
 *   · On the reseller's page: new, quoted once a quotation names it, declined with a reason; links listed and switched off.
 *   · Create quote starts from the reseller, the request in the reference, and the lines at their prices.
 *   · Somebody who can't see the reseller gets none of it.
 *
 * Everything is made here and removed.
 *
 *   npm run check:quote-requests
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
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const ROLE = "ZZPROBE_RFQ";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function main() {
  const lib = await import("../src/lib/quote-requests");
  const pub = await import("../src/actions/quote-request-public");
  const run = Date.now().toString(36);
  const tag = `Zzrfq${run}`;
  const made = { companies: [] as string[], items: [] as string[], users: [] as string[] };
  const boss = (await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true } })).id;

  const clean = async () => {
    const requests = await db.quoteRequest.findMany({ where: { resellerId: { in: made.companies } }, select: { id: true } });
    await db.quoteRequest.deleteMany({ where: { id: { in: requests.map((r) => r.id) } } });
    await db.quoteRequestLink.deleteMany({ where: { resellerId: { in: made.companies } } });
    await db.notification.deleteMany({ where: { title: { contains: tag } } }).catch(() => {});
    await db.tradeDocument.deleteMany({ where: { companyId: { in: made.companies } } });
    await db.resellerItemPrice.deleteMany({ where: { resellerId: { in: made.companies } } });
    await db.resellerProfile.deleteMany({ where: { companyId: { in: made.companies } } });
    await db.contact.deleteMany({ where: { companyId: { in: made.companies } } });
    await db.company.deleteMany({ where: { id: { in: made.companies } } });
    await db.item.deleteMany({ where: { id: { in: made.items } } });
    await db.user.deleteMany({ where: { id: { in: made.users } } });
    await db.role.deleteMany({ where: { key: ROLE } });
  };

  try {
    const reseller = await db.company.create({ data: { name: `${tag} Distribution`, normalizedName: `${tag} distribution`.toLowerCase(), relationshipType: "RESELLER", ownerUserId: boss, createdById: boss }, select: { id: true } });
    const client = await db.company.create({ data: { name: `${tag} Plain Client`, normalizedName: `${tag} plain client`.toLowerCase(), relationshipType: "CLIENT", createdById: boss }, select: { id: true } });
    made.companies.push(reseller.id, client.id);
    await db.resellerProfile.create({ data: { companyId: reseller.id, discountPercent: 10 } });
    const riya = await db.contact.create({ data: { companyId: reseller.id, name: "Riya Probe", email: `riya-${run}@zzprobe-rfq.invalid` }, select: { id: true } });
    const gone = await db.contact.create({ data: { companyId: reseller.id, name: "Gone Probe", leftAt: new Date() }, select: { id: true } });
    const elsewhere = await db.contact.create({ data: { companyId: client.id, name: "Other Probe" }, select: { id: true } });
    const item = async (name: string, sku: string, price: number) => {
      const i = await db.item.create({ data: { name, sku, type: "SUBSCRIPTION", sellingPrice: price, createdById: boss }, select: { id: true } });
      made.items.push(i.id);
      return i.id;
    };
    const premium = await item(`${tag} Suite Premium`, `${tag}-SP`, 100);
    const endpoint = await item(`${tag} Endpoint Guard`, `${tag}-EG`, 50);
    await item(`${tag} Backup One`, `${tag}-B1`, 20);
    await item(`${tag} Backup Two`, `${tag}-B2`, 30);
    await db.resellerItemPrice.create({ data: { resellerId: reseller.id, itemId: premium, price: 72 } });

    section("1. The link");
    const link = await lib.createLink(boss, reseller.id, riya.id);
    ok("a link for a person at the reseller", link.ok && link.token.length >= 30);
    const token = link.ok ? link.token : "";
    const stored = await db.quoteRequestLink.findFirstOrThrow({ where: { resellerId: reseller.id } });
    ok("  only its hash is kept", stored.tokenHash === lib.hashToken(token) && !JSON.stringify(stored).includes(token));
    ok("  it opens their reseller and them", (await lib.linkForToken(token))?.contact.id === riya.id);
    ok("not for somebody who has left", !(await lib.createLink(boss, reseller.id, gone.id)).ok);
    ok("  nor somebody at another company", !(await lib.createLink(boss, reseller.id, elsewhere.id)).ok);
    ok("  nor for a company that isn't a reseller", !(await lib.createLink(boss, client.id, elsewhere.id)).ok);
    ok("a wrong token opens nothing", (await lib.linkForToken(`${token.slice(0, -2)}xx`)) === null && (await lib.linkForToken("short")) === null && (await lib.linkForToken(null)) === null);
    const page = await pub.getQuoteRequestPage(token);
    ok("the page names the reseller and the person", page?.resellerName === `${tag} Distribution` && page.contactName === "Riya Probe" && page.contactEmail.endsWith("@zzprobe-rfq.invalid"));

    section("2. The form");
    const today = "2026-11-26";
    const good = { endCustomerName: "Northwind Logistics", endCustomerCountry: "UAE", dealReference: "T-17", neededBy: "2026-12-15", deliveryLocation: "Dubai", budget: "", notes: "With onboarding", lines: [{ description: `${tag} Suite Premium`, quantity: "25", brand: "", notes: "1 year" }] };
    ok("a complete request passes", lib.checkRequest(good, today).ok);
    const bad = lib.checkRequest({ ...good, endCustomerName: " ", neededBy: "2026-11-01", lines: [{ description: "", quantity: "2.5", brand: "", notes: "" }] }, today);
    ok("  no end customer, a day passed, an item with no name: each said", !bad.ok && !!bad.errors.endCustomerName && !!bad.errors.neededBy && !!bad.errors["lines.0"]);
    const none = lib.checkRequest({ ...good, lines: [{ description: "", quantity: "", brand: "", notes: "" }] }, today);
    ok("  no items at all", !none.ok && !!none.errors.lines);
    const frac = lib.checkRequest({ ...good, lines: [{ description: "x", quantity: "2.5", brand: "", notes: "" }] }, today);
    ok("  a quantity is a whole number", !frac.ok && !!frac.errors["lines.0"]);
    const long = lib.checkRequest({ ...good, notes: "n".repeat(5000), lines: Array.from({ length: 51 }, () => ({ description: "x", quantity: "1", brand: "", notes: "" })) }, today);
    ok("  fifty items at most", !long.ok && !!long.errors.lines);

    section("3. Sending it");
    const form = new FormData();
    form.set("token", token);
    form.set(
      "request",
      JSON.stringify({
        ...good,
        neededBy: "",
        lines: [
          { description: `${tag} Suite Premium`, quantity: "25", brand: "", notes: "1 year" },
          { description: `${tag}-EG`, quantity: "25", brand: "", notes: "" },
          { description: `${tag} Backup`, quantity: "1", brand: "", notes: "" },
          { description: "Onboarding and migration", quantity: "", brand: "", notes: "" },
        ],
      }),
    );
    form.set("file", new File([PDF], "northwind-rfq.pdf", { type: "application/pdf" }));
    const sent = await pub.sendQuoteRequest(form);
    ok("sent, with a reference", sent.ok && /^RFQ-\d{6}$/.test(sent.reference), sent);
    const kept = await db.quoteRequest.findFirstOrThrow({ where: { resellerId: reseller.id }, include: { lines: { orderBy: { position: "asc" } } } });
    ok("  kept with its four lines in order, a blank quantity one", kept.lines.length === 4 && kept.lines[3]!.description === "Onboarding and migration" && kept.lines[3]!.quantity === 1);
    ok("  as the link's reseller and person", kept.contactId === riya.id && kept.endCustomerName === "Northwind Logistics");
    ok("  the file kept", kept.fileName === "northwind-rfq.pdf" && kept.fileMime === "application/pdf" && !!kept.fileDataUrl);
    const told = await db.notification.findFirst({ where: { userId: boss, title: { contains: `${tag} Distribution asked for a quotation` } } });
    ok("  the account manager told", !!told);
    const fake = new FormData();
    fake.set("token", token);
    fake.set("request", JSON.stringify(good));
    fake.set("file", new File([Buffer.from("MZ not a pdf")], "rfq.pdf", { type: "application/pdf" }));
    const refused = await pub.sendQuoteRequest(fake);
    ok("a file that isn't what its name says is refused, and nothing kept", !refused.ok && /isn't the kind of file/.test(refused.error) && (await db.quoteRequest.count({ where: { resellerId: reseller.id } })) === 1);
    const wrong = new FormData();
    wrong.set("token", "x".repeat(40));
    wrong.set("request", JSON.stringify(good));
    ok("a wrong link sends nothing", !(await pub.sendQuoteRequest(wrong)).ok);

    section("4. Matched, at the reseller's prices");
    const view = await lib.resellerRequests(boss, reseller.id);
    const r = view!.requests[0]!;
    ok("one request, new", view!.requests.length === 1 && r.state === "new" && r.reference === (sent.ok ? sent.reference : ""));
    ok("  by name: their special price", r.lines[0]!.item?.id === premium && r.lines[0]!.price?.unitPrice === 72 && r.lines[0]!.price.source === "special", r.lines[0]);
    ok("  by SKU: their tier's 10% off", r.lines[1]!.item?.id === endpoint && r.lines[1]!.price?.unitPrice === 45 && r.lines[1]!.price.source === "tier", r.lines[1]);
    ok("  two items it could be: neither", r.lines[2]!.item === null && r.lines[2]!.price === null);
    ok("  nothing like it: stays as typed", r.lines[3]!.item === null);
    ok("  their file, named", r.file?.name === "northwind-rfq.pdf");
    ok("  their live link listed", view!.links.length === 1 && view!.links[0]!.contactName === "Riya Probe" && !!view!.links[0]!.lastUsedAt);
    const file = await lib.requestFile(boss, r.id);
    ok("  the file comes back as it was sent", !!file && file.bytes.equals(PDF));

    section("5. Quoting it");
    const startQuote = await lib.quoteStart(boss, r.id);
    ok("Create quote starts from the reseller, naming the request", startQuote?.resellerId === reseller.id && startQuote.reference.startsWith(r.reference) && startQuote.reference.includes("Northwind"));
    ok("  with the end customer and their reference in the notes", /Northwind Logistics, UAE/.test(startQuote!.notes) && /T-17/.test(startQuote!.notes));
    ok("  and the lines at their prices", startQuote!.lines[0]!.price?.unitPrice === 72 && startQuote!.lines.length === 4);
    await db.tradeDocument.create({ data: { docNumber: `${tag}-Q1`, docType: "PROPOSAL", direction: "SALES", companyId: reseller.id, createdById: boss, reference: startQuote!.reference } });
    const quoted = (await lib.resellerRequests(boss, reseller.id))!.requests[0]!;
    ok("a quotation naming it marks it quoted, and links to it", quoted.state === "quoted" && quoted.quotes.some((q) => q.docNumber === `${tag}-Q1`));

    section("6. Assigned, declined, switched off");
    ok("assigned", (await lib.assignRequest(boss, r.id, boss)).ok && (await lib.resellerRequests(boss, reseller.id))!.requests[0]!.assignedTo?.id === boss);
    ok("declining needs a reason", !(await lib.declineRequest(boss, r.id, "  ")).ok);
    ok("  declined with one", (await lib.declineRequest(boss, r.id, "Not something we sell")).ok && (await lib.resellerRequests(boss, reseller.id))!.requests[0]!.state === "declined");
    ok("  and no quote starts from it", (await lib.quoteStart(boss, r.id)) === null);
    await lib.revokeLink(boss, stored.id);
    ok("switched off, the link opens nothing", (await lib.linkForToken(token)) === null && (await pub.getQuoteRequestPage(token)) === null);

    section("7. Twenty a day");
    const second = await lib.createLink(boss, reseller.id, riya.id);
    const found = await lib.linkForToken(second.ok ? second.token : "");
    const lots = { ...good, neededBy: "", lines: [{ description: "x", quantity: "1", brand: "", notes: "" }] };
    for (let i = 0; i < lib.LIMITS.perLinkPerDay; i++) await lib.submitRequest(found!.link, lots, null);
    ok("the twenty-first in a day from one link waits", !(await lib.submitRequest(found!.link, lots, null)).ok);

    section("8. Who may");
    await db.role.create({ data: { key: ROLE, name: "Zzprobe rfq" } });
    const outsider = await db.user.create({ data: { name: "Zzprobe outsider", email: `outsider-${run}@zzprobe-rfq.invalid`, role: ROLE, passwordHash: "x".repeat(60) }, select: { id: true } });
    made.users.push(outsider.id);
    ok("somebody who can't see the reseller: no requests, no file, no quote, no link", (await lib.resellerRequests(outsider.id, reseller.id)) === null && (await lib.requestFile(outsider.id, r.id)) === null && (await lib.quoteStart(outsider.id, r.id)) === null && !(await lib.createLink(outsider.id, reseller.id, riya.id)).ok);
    ok("  nor assign or decline", !(await lib.assignRequest(outsider.id, r.id, outsider.id)).ok && !(await lib.declineRequest(outsider.id, r.id, "no")).ok);
  } finally {
    await clean();
  }
}

main()
  .catch((err) => {
    failures += 1;
    console.error(err);
  })
  .finally(async () => {
    await db.$disconnect();
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
