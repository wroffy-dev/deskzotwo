/**
 * Merging duplicate companies — src/lib/companies/merge.ts, and the duplicates list that finds them.
 *
 *   · Without a database: what makes two companies look like one (the core of a name, a GSTIN and
 *     the PAN inside it, a domain, a phone), what never does (a vendor and a customer, a switchboard
 *     number half the book shares, a pair somebody dismissed), and which people count as the same
 *     person across the two.
 *   · Against the schema: every link to a company or a contact that can clash has a rule, and the
 *     only filtered unique indexes are the ones the merge knows about. A new link that could clash,
 *     or a new filtered index, fails here before it can fail a merge.
 *   · Through the real code: who may merge and between which companies; the preview; the merge
 *     itself — everything moving, people combined (consent, list places, preference links), the
 *     clashes settled, the issued invoice keeping its printed name, the suppression and the "new
 *     customer" win following, an earlier merge's chain, the field choices; the refusals (wrong
 *     name typed, different kinds, choices that need rights of their own); two merges at once; the
 *     duplicate's old links opening the company it became; the unsubscribe links sent to a person
 *     who was combined still working.
 *
 * Everything is named ZZMRG and removed in a finally. No mail is sent — the email module is stubbed.
 *
 *   npm run check:company-merge
 */
import "dotenv/config";
import Module from "node:module";
import { isValidElement, type ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";
import { coreName, domainOf, duplicatePairs, pairKey, panFromGstin, phoneKey, similarity, type DuplicateCandidate } from "../src/lib/companies/duplicates";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzmrg", email: `x${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), refuseWhileViewingAs: async () => null, viewAsContext: async () => null };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/companies",
    };
  }
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZMRG";
const MAIL = "@zzprobe-merge.invalid";
const RUN = Date.now().toString(36);
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const thrown = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({
    where: { OR: [{ name: { startsWith: TAG } }, { createdById: { in: userIds } }] },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  const contacts = await db.contact.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  const contactIds = contacts.map((c) => c.id);
  // The Zoho id the duplicate came in under — its import cascades it away.
  await db.legacyImport.deleteMany({ where: { id: { startsWith: "zzmrg" } } });
  const messages = await db.marketingMessage.findMany({ where: { OR: [{ companyId: { in: companyIds } }, { token: { startsWith: "zzmrg" } }] }, select: { id: true } });
  await db.messageEvent.deleteMany({ where: { messageId: { in: messages.map((m) => m.id) } } });
  await db.marketingMessage.deleteMany({ where: { id: { in: messages.map((m) => m.id) } } });
  await db.campaign.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.marketingTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.marketingList.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.suppression.deleteMany({
    where: { OR: [{ value: { in: [...companyIds, ...contactIds] } }, { value: { endsWith: MAIL } }, { note: { startsWith: TAG } }] },
  });
  await db.celebrationSeen.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { occasionKey: { startsWith: "first-order:" }, userId: { in: userIds } }] } });
  await db.celebration.deleteMany({ where: { title: { startsWith: TAG } } });
  await db.callLog.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.ticket.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.lead.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.payment.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.project.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.companyProduct.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { item: { sku: { startsWith: TAG } } }] } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.contactConsent.deleteMany({ where: { contactId: { in: contactIds } } });
  await db.contact.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.companyMerge.deleteMany({ where: { OR: [{ fromName: { startsWith: TAG } }, { intoCompanyId: { in: companyIds } }] } });
  await db.companyDuplicateDismissal.deleteMany({ where: { OR: [{ companyAId: { in: companyIds } }, { companyBId: { in: companyIds } }, { dismissedById: { in: userIds } }] } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.notification.deleteMany({ where: { userId: { in: userIds } } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: companyIds } }] } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  section("What makes two companies look like one");

  ok("the words every company has are set aside", coreName("Xyz Technologies Pvt. Ltd.") === "xyz" && coreName("XYZ Companies") === "xyz", coreName("XYZ Companies"));
  ok("  a name made only of them keeps them, rather than matching every other vague name", coreName("Tech Solutions Pvt Ltd") === "tech solutions pvt ltd");
  ok("  & is 'and', punctuation is space", coreName("R&D Labs") === coreName("R and D"), `${coreName("R&D Labs")} / ${coreName("R and D")}`);
  ok("a one-letter slip is nearly the same, a different word is not", similarity("sharma", "sharmaa") >= 0.85 && similarity("sharma", "verma") < 0.85);
  ok("the PAN inside a GSTIN", panFromGstin(" 27aaapl1234c1zv ") === "AAAPL1234C" && panFromGstin("27AAAPL1234C1Z") === null);
  ok("a phone is its last ten digits, +91 or not", phoneKey("+91 98765-43210") === "9876543210" && phoneKey("098765 43210") === "9876543210" && phoneKey("12345") === null);
  ok("a domain from a website or an address", domainOf("https://www.Acme.co.in/about") === "acme.co.in" && domainOf("Ravi@Acme.in") === "acme.in" && domainOf("not a site") === null);

  const cand = (id: string, name: string, over: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
    id,
    name,
    family: "client",
    managedByResellerId: null,
    gstins: [],
    pan: null,
    domains: [],
    phones: [],
    ...over,
  });
  const book = [
    cand("a", "Xyz Technologies Pvt Ltd", { gstins: ["27AAAPL1234C1ZV"] }),
    cand("b", "XYZ Companies"),
    cand("c", "Xyz Technologies", { family: "vendor", gstins: ["27AAAPL1234C1ZV"] }),
    cand("d", "Sharma Traders"),
    cand("e", "Sharmaa Traders"),
    cand("f", "Blue Ocean", { domains: ["blueocean.in"] }),
    cand("g", "Deep Sea Pvt Ltd", { domains: ["blueocean.in"] }),
    cand("h", "Pinnacle Infra", { gstins: ["29AAAPL1234C1ZX"] }),
    cand("i", "Xyz Technologies", { managedByResellerId: "r1" }),
    cand("j", "Mango Systems", { pan: "AAAPL1234C" }),
  ];
  const found = duplicatePairs(book);
  const pair = (x: string, y: string) => found.find((p) => p.aId === (x < y ? x : y) && p.bId === (x < y ? y : x));
  ok("the same core name is very likely", pair("a", "b")?.strength === "strong", pair("a", "b")?.reasons.join(" · "));
  ok("a vendor with the same name and GSTIN is not a customer's duplicate", !pair("a", "c") && !pair("b", "c"));
  ok("a reseller's end customer is not a direct customer's duplicate", !pair("a", "i") && !pair("b", "i"));
  ok("a typo is possibly the same", pair("d", "e")?.strength === "likely" && pair("d", "e")!.reasons.includes("Names nearly the same"));
  ok("a shared business domain is possibly the same", pair("f", "g")?.strength === "likely" && pair("f", "g")!.reasons[0] === "Same email domain blueocean.in");
  ok("the same PAN under two GSTINs (two states) is very likely", pair("a", "h")?.strength === "strong" && pair("a", "h")!.reasons.includes("Same PAN AAAPL1234C"));
  ok("  a PAN given by hand counts the same", pair("a", "j")?.strength === "strong" && pair("h", "j")?.strength === "strong");
  ok("very likely comes before possibly", found.findIndex((p) => p.strength === "likely") > found.findLastIndex((p) => p.strength === "strong"));
  ok("a dismissed pair isn't offered again", !duplicatePairs(book, new Set([pairKey("b", "a")])).some((p) => p.aId === "a" && p.bId === "b"));
  const office = Array.from({ length: 41 }, (_, i) => cand(`o${i}`, `Tenant ${String.fromCharCode(65 + (i % 26))}${i}`, { phones: ["2240000000"] }));
  ok("a phone half the book shares (a building's switchboard) identifies nobody", duplicatePairs(office).length === 0);
  ok("  a phone two share does", duplicatePairs(office.slice(0, 2))[0]?.reasons[0] === "Same phone number …0000");
  ok("a shared GSTIN doesn't also list its PAN", !pair("a", "b")?.reasons.some((r) => r.startsWith("Same PAN")) && found.every((p) => !(p.reasons.some((r) => r.startsWith("Same GSTIN")) && p.reasons.some((r) => r.startsWith("Same PAN")))));

  // ─────────────────────────────────────────────────────────────────────────────
  /* eslint-disable @typescript-eslint/no-require-imports */
  const merge = require("../src/lib/companies/merge") as typeof import("../src/lib/companies/merge");
  const actions = require("../src/actions/company-merge") as typeof import("../src/actions/company-merge");
  const unsubscribe = require("../src/lib/marketing/unsubscribe") as typeof import("../src/lib/marketing/unsubscribe");
  const CompanyPage = (require("../src/app/(dashboard)/companies/[id]/page") as {
    default: (p: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
  }).default;
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const MergePage = (require("../src/app/(dashboard)/companies/merge/page") as {
    default: (p: { searchParams: Promise<{ keep?: string; drop?: string }> }) => Promise<ReactElement>;
  }).default;
  const DuplicatesPage = (require("../src/app/(dashboard)/companies/duplicates/page") as { default: () => Promise<ReactElement> }).default;
  const { formatCompanyId } = require("../src/lib/order-id") as typeof import("../src/lib/order-id");

  // ─────────────────────────────────────────────────────────────────────────────
  section("Which people are the same person");

  const person = (id: string, name: string, email: string | null, phone: string | null) => ({ id, name, email, phone });
  const staying = [person("k1", "Ravi Kumar", "Ravi@Acme.in", null), person("k2", "Asha Rao", null, "+91 98111 00001"), person("k3", "Front Desk", "desk@acme.in", "022 4000 0000"), person("k4", "Meena", null, "9800000004")];
  const other = [person("d1", "R. Kumar", " ravi@acme.in ", "9800000009"), person("d2", "Asha  Rao", "asha@acme.in", "9811100001"), person("d3", "Neha Shah", "neha@acme.in", "02240000000"), person("d4", "Suresh", null, "9800000004"), person("d5", "Ravi K", "ravi@acme.in", null)];
  const matched = merge.contactPairs(staying, other);
  const partner = (d: string) => matched.find((p) => p.dropId === d)?.keepId;
  ok("the same address is the same person, whatever its case or spacing", partner("d1") === "k1" && matched.find((p) => p.dropId === "d1")!.reason === "Same email ravi@acme.in");
  ok("the same phone and name, even with an address on one side only", partner("d2") === "k2" && matched.find((p) => p.dropId === "d2")!.reason === "Same phone …0001 and name");
  ok("a switchboard with two different people's addresses behind it is not one person", partner("d3") === undefined);
  ok("the same phone with no address on one side is taken as the same person", partner("d4") === "k4");
  ok("each person is paired once — a second copy of Ravi doesn't take the first's partner", partner("d5") === undefined && matched.length === 3, matched.map((p) => merge.pairId(p)).join());

  const subject = (id: string, name: string, relationshipType: string, managedByResellerId: string | null = null) => ({ id, name, relationshipType, managedByResellerId });
  ok("two customers can be merged", merge.mergeBlockers(subject("a", "A", "CLIENT"), subject("b", "B", "CLIENT")).length === 0);
  ok("  a vendor and a distributor are both vendors", merge.mergeBlockers(subject("a", "A", "VENDOR"), subject("b", "B", "DISTRIBUTOR")).length === 0);
  ok("  a customer and a vendor are not, without the two-roles columns", merge.mergeBlockers(subject("a", "A", "CLIENT"), subject("b", "B", "VENDOR"))[0]?.includes("A is a customer and B is a vendor") === true);
  ok("  with them, a customer and a vendor can — one company, two roles", merge.mergeBlockers(subject("a", "A", "CLIENT"), subject("b", "B", "DISTRIBUTOR"), true).length === 0);
  ok("  but not a reseller's customer and a vendor", merge.mergeBlockers(subject("a", "A", "CLIENT", "r"), subject("b", "B", "VENDOR"), true).some((m) => m.includes("reseller")));
  ok("  nor a customer and a commission party", merge.mergeBlockers(subject("a", "A", "CLIENT"), subject("b", "B", "COMMISSION_PARTY"), true).length === 1);
  ok("  nor a reseller and its own end customer", merge.mergeBlockers(subject("a", "A", "RESELLER"), subject("b", "B", "RESELLER", "a")).some((m) => m.includes("reseller")));
  ok("  nor a company and itself", merge.mergeBlockers(subject("a", "A", "CLIENT"), subject("a", "A", "CLIENT")).length === 1);

  // ─────────────────────────────────────────────────────────────────────────────
  section("Every link that can clash has a rule");

  const allLinks = await merge.links();
  const companyLinks = allLinks.company.map(merge.linkKey);
  const contactLinks = allLinks.contact.map(merge.linkKey);
  ok("the links are read from the database's catalog — forty and more to a company", companyLinks.length >= 45 && companyLinks.includes("Lead.companyId") && companyLinks.includes("JournalLine.companyId"), companyLinks.length);
  ok("  a company's own reseller link and the merge record's are among them", companyLinks.includes("Company.managedByResellerId") && companyLinks.includes("CompanyMerge.intoCompanyId"));
  ok("  and the links to a contact", contactLinks.length >= 15 && contactLinks.includes("ContactConsent.contactId"), contactLinks.length);
  ok("no link that can clash is without a rule", merge.unsettledClashes(allLinks).length === 0, merge.unsettledClashes(allLinks).join(", "));
  const partial = await db.$queryRaw<{ indexname: string }[]>`
    SELECT indexname::text AS indexname FROM pg_indexes
    WHERE schemaname = current_schema() AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '% WHERE %'`;
  // branches_one_head_office and organisation_bank_accounts_one_primary: no company or contact link, so
  // a merge never moves a row under them — known, and nothing for the merge to settle.
  // company_bank_accounts_one_primary is settled as the primary address is (check:vendor-banking, 10).
  // card_templates_one_default and signature_templates_one_default: the workspace's one default card and
  // signature design — no company or contact link either (only who made it), so nothing for a merge.
  const known = new Set([
    "company_locations_one_primary_per_company",
    "users_one_super_admin",
    "branches_one_head_office",
    "company_bank_accounts_one_primary",
    "organisation_bank_accounts_one_primary",
    "card_templates_one_default",
    "signature_templates_one_default",
    // The one default print template per document type (1fbf2414) — no company or contact link either.
    "document_print_templates_one_default",
  ]);
  ok(
    "the only filtered unique indexes are ones the merge knows about (Prisma can't describe them)",
    partial.every((p) => known.has(p.indexname)),
    partial.map((p) => p.indexname).filter((n) => !known.has(n)).join(", ") || partial.length,
  );

  await cleanup();
  try {
    const make = (name: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `Zzmrg ${name}`,
          email: `${name.toLowerCase()}${MAIL}`,
          role: "SALES",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const everything = { "companies.merge": true, "companies.viewAll": true, "accounts.reassign": true, "credit.override": true, "contacts.view": true, "contacts.viewRestricted": true };
    const boss = await make("Boss", everything);
    const mgr = await make("Mgr", { ...everything, "accounts.reassign": false, "credit.override": false });
    const rep = await make("Rep", { "companies.merge": false, "companies.viewAll": false, "contacts.view": true });
    const other = await make("Other", { ...everything, "companies.viewAll": false });
    const as = (u: { id: string }) => {
      actorId = u.id;
    };

    const company = (name: string, data: Record<string, unknown> = {}) =>
      db.company.create({
        data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: boss.id, ...data },
      });
    const K = await company("Xyz Technologies Pvt Ltd", { ownerUserId: boss.id, stage: "PROSPECT", tags: ["alpha"], paymentTerms: "ADVANCE" });
    const D = await company("XYZ Companies", {
      ownerUserId: rep.id,
      stage: "CUSTOMER",
      website: "https://zzmrg-xyz.invalid",
      tags: ["beta"],
      paymentTerms: "NET_60",
      creditLimit: 500000,
    });
    const V = await company("Xyz Technologies Agents", { relationshipType: "COMMISSION_PARTY", ownerUserId: boss.id });
    const kRef = formatCompanyId(K.companySeq);
    const dRef = formatCompanyId(D.companySeq);

    await db.companyLocation.create({ data: { companyId: K.id, label: "Head office", city: "Pune", gstNumber: "27AAAPL1234C1ZV", isPrimary: true } });
    const dOffice = await db.companyLocation.create({ data: { companyId: D.id, label: "Registered office", city: "Mumbai", gstNumber: "27AAAPL1234C1ZV", isPrimary: true } });

    const contact = (companyId: string, name: string, data: Record<string, unknown> = {}) => db.contact.create({ data: { companyId, name, ...data } });
    const K1 = await contact(K.id, "Ravi Kumar", { email: `ravi${MAIL}`, isPrimary: true, preferenceToken: `zzmrg-pref-k1-${RUN}` });
    const K2 = await contact(K.id, "Asha Rao", { phone: "+91 98111 00001" });
    const K3 = await contact(K.id, "Front Desk", { phone: "022 4000 0000", email: `desk${MAIL}` });
    const D1 = await contact(D.id, "R. Kumar", { email: `RAVI${MAIL}`, isPrimary: true, designation: "IT_HEAD", preferenceToken: `zzmrg-pref-d1-${RUN}` });
    const D2 = await contact(D.id, "Asha  Rao", { phone: "9811100001", email: `asha${MAIL}`, preferenceToken: `zzmrg-pref-d2-${RUN}` });
    const D3 = await contact(D.id, "Neha Shah", { phone: "02240000000", email: `neha${MAIL}` });
    const D4 = await contact(D.id, "Vikram Das", { email: `vikram${MAIL}` });

    // Consent: the duplicate's copy of Ravi unsubscribed from offers; the staying copy subscribed.
    await db.contactConsent.create({ data: { contactId: K1.id, topic: "OFFERS", status: "SUBSCRIBED", source: "IMPORT" } });
    await db.contactConsent.create({ data: { contactId: D1.id, topic: "OFFERS", status: "UNSUBSCRIBED", source: "PREFERENCE_CENTRE", withdrawnAt: new Date() } });
    await db.contactConsent.create({ data: { contactId: D1.id, topic: "EVENTS", status: "SUBSCRIBED", source: "FORM" } });

    const list = await db.marketingList.create({ data: { name: `${TAG} List`, consentNote: TAG, topics: ["OFFERS"], createdById: boss.id } });
    await db.marketingListMember.createMany({ data: [{ listId: list.id, contactId: K1.id }, { listId: list.id, contactId: D1.id }, { listId: list.id, contactId: D4.id }] });

    const template = await db.marketingTemplate.create({ data: { name: `${TAG} Template`, body: "Hi", createdById: boss.id } });
    const campaign = await db.campaign.create({ data: { reference: `ZZMRG-${RUN}`, name: `${TAG} Campaign`, templateId: template.id, createdById: boss.id } });
    const message = (contactId: string, token: string, status: "SENT" | "QUEUED", toEmail: string) =>
      db.marketingMessage.create({ data: { token, companyId: contactId === K1.id ? K.id : D.id, contactId, campaignId: campaign.id, body: "Hi", scheduledFor: new Date(), status, toEmail } });
    const mK1 = await message(K1.id, `zzmrg-msg-k1-${RUN}`, "SENT", `ravi${MAIL}`);
    const mD1 = await message(D1.id, `zzmrg-msg-d1-${RUN}`, "QUEUED", `RAVI${MAIL}`);

    const lead = await db.lead.create({ data: { companyId: D.id, contactId: D1.id, title: `${TAG} Renewal` } });
    const ticket = await db.ticket.create({ data: { companyId: D.id, contactId: D2.id, title: `${TAG} Printer`, createdByUserId: boss.id } });
    const call = await db.callLog.create({ data: { companyId: D.id, contactId: D1.id, phoneNumber: "9811100002", outcome: "CONNECTED", startedAt: new Date(), userId: boss.id } });
    const issuedK = await db.tradeDocument.create({ data: { docNumber: `ZZMRG-${RUN}-1`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: K.id, createdById: boss.id } });
    const draftK = await db.tradeDocument.create({ data: { docNumber: `ZZMRG-${RUN}-2`, docType: "INVOICE", direction: "SALES", status: "DRAFT", companyId: K.id, createdById: boss.id } });
    const proposalD = await db.tradeDocument.create({ data: { docNumber: `ZZMRG-${RUN}-4`, docType: "PROPOSAL", direction: "SALES", status: "ISSUED", companyId: D.id, createdById: boss.id } });
    const project = await db.project.create({ data: { code: `ZZMRG-${RUN}`, name: `${TAG} Rollout`, companyId: D.id, createdById: boss.id } });
    const item = await db.item.create({ data: { name: `${TAG} M365 Business`, sku: `${TAG}-${RUN}`, type: "SUBSCRIPTION", sellingPrice: 1000, createdById: boss.id } });
    // A subscription with an end date is both an order and a renewal — renewals are read from these rows.
    const subscription = await db.companyProduct.create({
      data: { companyId: D.id, locationId: dOffice.id, itemId: item.id, addedByUserId: boss.id, startDate: new Date(), endDate: new Date(Date.now() + 30 * 86_400_000) },
    });
    const payment = await db.payment.create({ data: { companyId: D.id, amount: 1000, paidOn: new Date(), method: "BANK_TRANSFER", recordedByUserId: boss.id } });
    const issuedD = await db.tradeDocument.create({ data: { docNumber: `ZZMRG-${RUN}-3`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: D.id, createdById: boss.id } });

    await db.suppression.create({ data: { scope: "COMPANY", value: D.id, reason: "MANUAL", note: `${TAG} do not market` } });
    await db.suppression.create({ data: { scope: "CONTACT", value: D4.id, reason: "COMPLAINT", note: `${TAG} complained` } });
    const win = await db.celebration.create({
      data: {
        kind: "ACHIEVEMENT",
        title: `${TAG} New customer`,
        startsOn: new Date(),
        endsOn: new Date(Date.now() + 86_400_000),
        source: "FIRST_ORDER",
        occasionKey: `first-order:${D.id}`,
        details: { companyId: D.id, note: "kept" },
      },
    });
    await db.celebrationSeen.create({ data: { userId: rep.id, occasionKey: `first-order:${D.id}` } });
    // A company merged into the duplicate earlier: the chain has to end at the one that exists.
    const earlier = await db.companyMerge.create({
      data: { fromCompanyId: `zzmrg-earlier-${RUN}`, fromSeq: -Math.floor(Math.random() * 1e9) - 1, fromName: `${TAG} Earlier`, intoCompanyId: D.id, snapshot: {}, moved: {}, choices: {} },
    });

    // ───────────────────────────────────────────────────────────────────────────
    section("Who may merge, and what");

    as(rep);
    ok("somebody without the permission can't open the merge screen", !(await actions.getMergeScreen(kRef, dRef)).ok);
    ok("  nor merge", !(await actions.mergeCompanies({ keepId: K.id, dropId: D.id, confirmName: D.name })).ok);
    ok("  nor see the duplicates list, nor dismiss a pair", !(await actions.listDuplicates()).ok && !(await actions.dismissDuplicate(K.id, D.id)).ok);
    as(other);
    const hidden = await actions.getMergeScreen(kRef, dRef);
    ok("the permission alone doesn't reach a company the person can't see", !hidden.ok && hidden.error === "Company not found.", !hidden.ok ? hidden.error : "");
    ok("  nor merge it", !(await actions.mergeCompanies({ keepId: K.id, dropId: D.id, confirmName: D.name })).ok);

    as(boss);
    const blocked = await actions.getMergeScreen(kRef, formatCompanyId(V.companySeq));
    ok("a customer and a commission party can't be merged — the screen says why", blocked.ok && blocked.data.plan.blockers.some((b) => b.includes("is a commission party")), blocked.ok ? blocked.data.plan.blockers.join() : "");
    const refusedKind = await actions.mergeCompanies({ keepId: K.id, dropId: V.id, confirmName: V.name });
    ok("  and merging them anyway is refused", !refusedKind.ok && refusedKind.error.includes("commission party"), !refusedKind.ok ? refusedKind.error : "");
    ok("  nor a company into itself", !(await actions.mergeCompanies({ keepId: K.id, dropId: K.id, confirmName: K.name })).ok);

    // ───────────────────────────────────────────────────────────────────────────
    section("The preview");

    const screen = await actions.getMergeScreen(kRef, dRef);
    ok("the merge screen opens by COM number", screen.ok, !screen.ok ? screen.error : "");
    if (!screen.ok) throw new Error("no merge screen");
    const plan = screen.data.plan;
    const field = (k: string) => plan.fields.find((f) => f.key === k);
    ok("the details that differ, and only those", !!field("name") && !!field("stage") && !!field("website") && !field("industryId") && !field("companyType"), plan.fields.map((f) => f.key).join());
    ok("  the staying company's value is the default…", field("name")?.suggested === "keep" && field("ownerUserId")?.suggested === "keep" && field("paymentTerms")?.suggested === "keep");
    ok("  …and always for credit, even where it has none of its own", field("creditLimit")?.keep === null && field("creditLimit")?.suggested === "keep");
    ok("  …unless it has none, or the other is further along", field("website")?.suggested === "drop" && field("stage")?.suggested === "drop");
    ok("  names are shown, not ids", field("ownerUserId")?.keep === "Zzmrg Boss" && field("ownerUserId")?.drop === "Zzmrg Rep" && field("paymentTerms")?.drop === "Net 60");
    const pairs = plan.contactPairs.map((p) => `${p.keepId}:${p.dropId}`);
    ok("people in both are paired: the same address, whatever its case", pairs.includes(`${K1.id}:${D1.id}`), plan.contactPairs.map((p) => p.reason).join(" | "));
    ok("  the same phone and name", pairs.includes(`${K2.id}:${D2.id}`));
    ok("  but not a shared switchboard with two different people's addresses", !plan.contactPairs.some((p) => p.dropId === D3.id) && pairs.length === 2);
    const moves = Object.fromEntries(plan.moves.map((m) => [m.label, m.count]));
    ok("what moves, counted", moves["Contacts"] === 4 && moves["Leads"] === 1 && moves["Tickets"] === 1 && moves["Calls"] === 1 && moves["Quotes and invoices"] === 2 && moves["Projects"] === 1 && moves["Orders and subscriptions"] === 1 && moves["Payments"] === 1 && moves["Companies merged into it before"] === 1, JSON.stringify(moves));
    ok("the two primary addresses are called out", plan.clashes.some((c) => c.startsWith("Both have a primary address")), plan.clashes.join(" | "));
    ok("issued documents on each side are counted, for the name they keep", plan.keep.issuedDocuments === 1 && plan.drop.issuedDocuments === 2);
    ok("this person may reassign and override credit", screen.data.may.reassign && screen.data.may.overrideCredit);
    ok("nothing moved for a preview", (await db.company.count({ where: { id: D.id } })) === 1 && (await db.lead.findUnique({ where: { id: lead.id } }))?.companyId === D.id);

    const mergeHtml = renderToStaticMarkup(await MergePage({ searchParams: Promise.resolve({ keep: kRef, drop: dRef }) }));
    ok(
      "the merge screen shows both companies, the details to pick, the people in both and what moves",
      [K.name, D.name, "Details — pick which to keep", "Ravi Kumar", "People in both", `What moves to ${kRef}`, "Quotes and invoices"].every((t) => mergeHtml.includes(t)),
      mergeHtml.length,
    );
    ok("  the staying company's account manager is picked to start with", /<input[^>]*name="field-ownerUserId"[^>]*checked=""[^>]*>[\s\S]{0,80}Zzmrg Boss/.test(mergeHtml));
    ok("  and the merge button waits for the duplicate's name", /<button[^>]*disabled=""[^>]*>Merge into COM-/.test(mergeHtml));
    ok("  the invoice that keeps its printed name is mentioned", mergeHtml.includes("already issued"));
    const pickHtml = renderToStaticMarkup(await MergePage({ searchParams: Promise.resolve({ keep: kRef }) }));
    ok("with only the company that stays, it asks which is the duplicate", pickHtml.includes(`Which company is a duplicate of`) && pickHtml.includes(K.name));
    const blockedHtml = renderToStaticMarkup(await MergePage({ searchParams: Promise.resolve({ keep: kRef, drop: formatCompanyId(V.companySeq) }) }));
    ok("  a pair that can't be merged shows why, and no merge button", blockedHtml.includes("is a commission party") && !blockedHtml.includes("Merge into"));
    as(rep);
    // The 404 page (owner, 8 Oct 2026), as for an address the app doesn't have.
    ok("  somebody without the permission gets the 404 page", (await thrown(() => MergePage({ searchParams: Promise.resolve({ keep: kRef, drop: dRef }) }))) === "notFound");
    as(boss);

    // ───────────────────────────────────────────────────────────────────────────
    section("Refusals before anything moves");

    const wrongName = await actions.mergeCompanies({ keepId: K.id, dropId: D.id, confirmName: "XYZ" });
    ok("the duplicate's name has to be typed", !wrongName.ok && wrongName.error.includes(D.name), !wrongName.ok ? wrongName.error : "");
    ok("  in any case or spacing", (await db.company.count({ where: { id: D.id } })) === 1);
    as(mgr);
    const noReassign = await actions.mergeCompanies({ keepId: K.id, dropId: D.id, choices: { ownerUserId: "drop" }, confirmName: D.name });
    ok("keeping the duplicate's account manager needs the right to reassign", !noReassign.ok && noReassign.error.includes("reassign"), !noReassign.ok ? noReassign.error : "");
    const noLimit = await actions.mergeCompanies({ keepId: K.id, dropId: D.id, choices: { creditLimit: "drop" }, confirmName: D.name });
    ok("keeping its credit limit needs the right to set one", !noLimit.ok && noLimit.error.includes("credit limits"), !noLimit.ok ? noLimit.error : "");
    const noTerms = await actions.mergeCompanies({ keepId: K.id, dropId: D.id, choices: { paymentTerms: "drop" }, confirmName: D.name });
    ok("keeping longer payment terms than the record supports is checked as an edit would be", !noTerms.ok && noTerms.error.includes("longer than"), !noTerms.ok ? noTerms.error : "");
    ok("  and none of that moved anything", (await db.company.count({ where: { id: D.id } })) === 1 && (await db.contact.count({ where: { companyId: D.id } })) === 4);

    // ───────────────────────────────────────────────────────────────────────────
    section("The merge");

    as(boss);
    // The duplicate came in from Zoho under an id of its own (owner, 18 Nov 2026).
    await db.legacyImport.create({ data: { id: "zzmrg-import", source: "zoho", createdById: boss.id, records: { create: { kind: "zoho_contacts", oldId: "zzmrg-zoho-1", recordId: D.id, action: "CREATE" } } } });
    const done = await actions.mergeCompanies({
      keepId: K.id,
      dropId: D.id,
      choices: { name: "drop", ownerUserId: "drop", stage: "drop", website: "drop" },
      combine: plan.contactPairs.map((p) => p.id),
      confirmName: `  xyz   companies `.replace("xyz", `${TAG.toLowerCase()} xyz`),
    });
    ok("it merges", done.ok && done.data.ref === kRef, !done.ok ? done.error : done.data.ref);

    const after = await db.company.findUnique({ where: { id: K.id } });
    ok("the duplicate is gone", (await db.company.count({ where: { id: D.id } })) === 0);
    const zohoId = await db.legacyImportRecord.findUnique({ where: { kind_oldId: { kind: "zoho_contacts", oldId: "zzmrg-zoho-1" } }, select: { recordId: true } });
    ok("  the old system's id it came in under now names the one staying", zohoId?.recordId === K.id, zohoId?.recordId);
    ok("the staying company took the name picked, and its duplicate rule", after?.name === D.name && after?.normalizedName === D.name.toLowerCase(), after?.name);
    ok("  the account manager, stage and website picked", after?.ownerUserId === rep.id && after?.stage === "CUSTOMER" && after?.website === D.website);
    ok("  and kept its own for what wasn't", after?.paymentTerms === "ADVANCE" && after?.creditLimit === null);
    ok("  tags from both", after?.tags.sort().join() === "alpha,beta", after?.tags.join());

    const people = await db.contact.findMany({ where: { companyId: K.id }, orderBy: { createdAt: "asc" } });
    ok("people in both are one contact each; the rest moved as they were", people.map((p) => p.id).sort().join() === [K1.id, K2.id, K3.id, D3.id, D4.id].sort().join(), people.map((p) => p.name).join(", "));
    const k1 = people.find((p) => p.id === K1.id)!;
    const k2 = people.find((p) => p.id === K2.id)!;
    ok("  blanks filled from the other copy — an address, a designation", k2.email === `asha${MAIL}` && k1.designation === "IT_HEAD");
    ok("  a filled address arrives without somebody else's verdict on it", k2.emailStatus === "UNCHECKED");
    ok("  one primary contact — the staying company's", people.filter((p) => p.isPrimary).map((p) => p.id).join() === K1.id);
    ok("  the other copy's preference link kept as a former one, or taken over when there was none", k1.preferenceToken === `zzmrg-pref-k1-${RUN}` && k1.formerPreferenceTokens.includes(`zzmrg-pref-d1-${RUN}`) && k2.preferenceToken === `zzmrg-pref-d2-${RUN}`);
    const consents = await db.contactConsent.findMany({ where: { contactId: K1.id }, orderBy: { topic: "asc" } });
    ok("an unsubscribe on either side stands", consents.find((c) => c.topic === "OFFERS")?.status === "UNSUBSCRIBED" && consents.length === 2, consents.map((c) => `${c.topic}:${c.status}`).join());
    ok("  and a topic only the other had comes across", consents.find((c) => c.topic === "EVENTS")?.status === "SUBSCRIBED");
    const members = await db.marketingListMember.findMany({ where: { listId: list.id }, orderBy: { contactId: "asc" } });
    ok("a place on a mailing list both had is kept once", members.map((m) => m.contactId).sort().join() === [K1.id, D4.id].sort().join(), members.length);

    ok("the lead moved, with its contact", (await db.lead.findUnique({ where: { id: lead.id } }))?.companyId === K.id && (await db.lead.findUnique({ where: { id: lead.id } }))?.contactId === K1.id);
    ok("  the ticket and the call too", (await db.ticket.findUnique({ where: { id: ticket.id } }))?.contactId === K2.id && (await db.callLog.findUnique({ where: { id: call.id } }))?.companyId === K.id);
    ok("  the proposal", (await db.tradeDocument.findUnique({ where: { id: proposalD.id } }))?.companyId === K.id);
    ok("  the project", (await db.project.findUnique({ where: { id: project.id } }))?.companyId === K.id);
    const renewal = await db.companyProduct.findUnique({ where: { id: subscription.id } });
    ok("  the order — which is also the renewal — with the address it was for", renewal?.companyId === K.id && renewal?.locationId === dOffice.id && renewal?.endDate !== null);
    ok("  and the payment", (await db.payment.findUnique({ where: { id: payment.id } }))?.companyId === K.id);
    const locations = await db.companyLocation.findMany({ where: { companyId: K.id } });
    ok("both addresses under it, one primary — its own", locations.length === 2 && locations.filter((l) => l.isPrimary).map((l) => l.city).join() === "Pune");

    const docs = await db.tradeDocument.findMany({ where: { id: { in: [issuedK.id, draftK.id, issuedD.id] } } });
    const doc = (id: string) => docs.find((d) => d.id === id);
    ok("an invoice issued under the old name keeps printing it", doc(issuedK.id)?.partyName === K.name && doc(issuedK.id)?.companyId === K.id);
    ok("  a draft takes the new one", doc(draftK.id)?.partyName === null);
    ok("  and one issued under the name kept needs nothing", doc(issuedD.id)?.partyName === null && doc(issuedD.id)?.companyId === K.id);

    const messages = await db.marketingMessage.findMany({ where: { id: { in: [mK1.id, mD1.id] } } });
    const mk = messages.find((m) => m.id === mK1.id)!;
    const md = messages.find((m) => m.id === mD1.id)!;
    ok("a campaign both copies were getting goes to the person once", mk.contactId === K1.id && md.status === "SUPPRESSED" && md.contactId === null, `${md.status} ${md.contactId}`);
    ok("  the held-back copy says why", (md.suppressedReason ?? "").includes("already"));
    ok("  and stays in the history, under the company", md.companyId === K.id);

    const sup = await db.suppression.findMany({ where: { note: { startsWith: TAG } } });
    ok("the company's suppression follows it", sup.some((s) => s.scope === "COMPANY" && s.value === K.id) && !sup.some((s) => s.value === D.id));
    ok("  a contact's too", sup.some((s) => s.scope === "CONTACT" && s.value === D4.id));
    const moved = await db.celebration.findUnique({ where: { id: win.id } });
    ok("the 'new customer' win is the staying company's, so it isn't celebrated twice", moved?.occasionKey === `first-order:${K.id}` && (moved?.details as { companyId?: string; note?: string })?.companyId === K.id && (moved?.details as { note?: string })?.note === "kept");
    ok("  and whoever saw it has still seen it", (await db.celebrationSeen.count({ where: { userId: rep.id, occasionKey: `first-order:${K.id}` } })) === 1);
    ok("an earlier merge into the duplicate now ends at the company that exists", (await db.companyMerge.findUnique({ where: { id: earlier.id } }))?.intoCompanyId === K.id);

    const record = await db.companyMerge.findUnique({ where: { fromCompanyId: D.id } });
    const snap = record?.snapshot as { company?: { name?: string }; contacts?: unknown[]; locations?: unknown[] } | undefined;
    ok("the merge is recorded: what it was, what moved, what was kept", record?.fromSeq === D.companySeq && record?.intoCompanyId === K.id && snap?.company?.name === D.name && snap?.contacts?.length === 4 && snap?.locations?.length === 1);
    ok("  with each choice", (record?.choices as Record<string, string>)?.name === "drop" && (record?.choices as Record<string, string>)?.paymentTerms === "keep");
    const counts = (record?.moved as { counts?: Record<string, number> })?.counts ?? {};
    ok("  and the counts", counts["Contact.companyId"] === 2 && counts["Lead.companyId"] === 1, JSON.stringify(counts));
    ok("both sides are in the audit log", (await db.auditLog.count({ where: { userId: boss.id, entityId: { in: [K.id, D.id] } } })) === 2);
    const notes = await db.notification.findMany({ where: { userId: rep.id }, select: { title: true, link: true } });
    ok("the duplicate's account manager is told where it went, once", notes.length === 1 && notes[0]!.title.includes("was merged into") && notes[0]!.link === `/companies/${kRef}`, notes.map((n) => n.title).join(" | "));
    ok("the credit rating was worked out again from the whole history", after?.creditScoredAt !== null && after!.creditScoredAt! > record!.mergedAt, after?.creditScoredAt?.toISOString());

    // ───────────────────────────────────────────────────────────────────────────
    section("The duplicate's old links");

    const visit = async (id: string, query: Record<string, string> = {}) => thrown(() => CompanyPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(query) }));
    ok("its COM number opens the company it became", (await visit(dRef)) === `redirect /companies/${kRef}?merged=${dRef}`, await visit(dRef));
    ok("  its id too — bookmarks and notifications carry it — keeping the tab", (await visit(D.id, { tab: "leads" })) === `redirect /companies/${kRef}?tab=leads&merged=${dRef}`, await visit(D.id, { tab: "leads" }));
    as(other);
    ok("  not for somebody who can't see that company — it's simply not there", (await visit(dRef)) === "notFound");
    as(boss);
    const landed = await CompanyPage({ params: Promise.resolve({ id: kRef }), searchParams: Promise.resolve({ merged: dRef }) });
    const first = (landed.props as { children: unknown[] }).children[0];
    const html = isValidElement(first) ? renderToStaticMarkup(first) : "";
    ok("the company says what happened to the link that brought them", html.includes(`${dRef} ${D.name} was merged into this company`), html.slice(0, 160));
    const forged = await CompanyPage({ params: Promise.resolve({ id: kRef }), searchParams: Promise.resolve({ merged: formatCompanyId(V.companySeq) }) });
    ok("  and says nothing for a number that wasn't merged into it", !(forged.props as { children: unknown[] }).children[0]);
    const again = await actions.mergeCompanies({ keepId: K.id, dropId: D.id, confirmName: D.name });
    ok("merging the same pair again is refused — it's gone", !again.ok && again.error.includes("merged already"), !again.ok ? again.error : "");

    // ───────────────────────────────────────────────────────────────────────────
    section("Links sent to somebody who was combined");

    ok("the other copy's own preference link finds the person", (await unsubscribe.contactForToken(`zzmrg-pref-d1-${RUN}`))?.id === K1.id);
    ok("the campaign copy that lost its contact finds them by the address it went to", (await unsubscribe.contactForToken(`zzmrg-msg-d1-${RUN}`))?.id === K1.id);
    const orphan = await db.marketingMessage.create({
      data: { token: `zzmrg-msg-orphan-${RUN}`, companyId: K.id, body: "Hi", scheduledFor: new Date(), status: "SENT", toEmail: `gone${MAIL}` },
    });
    ok("an email whose person is nowhere any more still unsubscribes — the address itself", await unsubscribe.unsubscribeByToken(orphan.token, "ONE_CLICK"));
    ok("  suppressed", (await db.suppression.count({ where: { scope: "EMAIL", value: `gone${MAIL}`, reason: "UNSUBSCRIBED" } })) === 1);
    ok("  and counted against the email", (await db.messageEvent.count({ where: { messageId: orphan.id, type: "UNSUBSCRIBE" } })) === 1);
    ok("a token that is nobody's is still refused", !(await unsubscribe.unsubscribeByToken(`zzmrg-nobody-${RUN}`, "ONE_CLICK")));

    // ───────────────────────────────────────────────────────────────────────────
    section("Two merges at once");

    const E = await company("Evergreen Logistics", { ownerUserId: boss.id });
    const F = await company("Evergreen Logistic", { ownerUserId: boss.id });
    const G = await company("Evergreen Logistcs", { ownerUserId: boss.id });
    await contact(F.id, "Only In F");
    const results = await Promise.allSettled([
      merge.executeMerge({ keepId: E.id, dropId: F.id, choices: {}, combine: [], userId: boss.id }),
      merge.executeMerge({ keepId: G.id, dropId: F.id, choices: {}, combine: [], userId: boss.id }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    ok("the same duplicate merged into two companies at once: one merge, one refusal", won === 1 && refused?.reason instanceof merge.MergeRefused, refused?.reason?.message);
    ok("  its contact is in exactly one place", (await db.contact.count({ where: { name: "Only In F", companyId: { in: [E.id, G.id] } } })) === 1);

    // ───────────────────────────────────────────────────────────────────────────
    section("A customer and a vendor made one");

    // "Digitrock" the vendor and "Digitrock Infosystems Pvt. Ltd." the customer (owner, 29 Oct 2026).
    const asClient = await company("Digitrock Infosystems Pvt. Ltd.", { ownerUserId: boss.id });
    const asVendor = await company("Digitrock", { relationshipType: "VENDOR", ownerUserId: mgr.id, vendorCode: `ZZV-${RUN}`, vendorStatus: "ACTIVE" });
    await contact(asVendor.id, "Vendor Desk");
    const crossPlan = await actions.getMergeScreen(formatCompanyId(asClient.companySeq), formatCompanyId(asVendor.companySeq));
    ok("the screen lets them merge", crossPlan.ok && crossPlan.data.plan.blockers.length === 0, crossPlan.ok ? crossPlan.data.plan.blockers : crossPlan);
    const crossed = await merge.executeMerge({ keepId: asClient.id, dropId: asVendor.id, choices: {}, combine: [], userId: boss.id });
    const one = await db.company.findUnique({ where: { id: asClient.id }, select: { name: true, relationshipType: true, alsoVendor: true, alsoCustomer: true, sideOwnerUserId: true, vendorCode: true, vendorStatus: true } });
    ok("one customer that is also a vendor, the full name kept", one?.relationshipType === "CLIENT" && one.alsoVendor && !one.alsoCustomer && one.name.endsWith("Digitrock Infosystems Pvt. Ltd."), one);
    ok("  the vendor side managed by the vendor's manager, its code and status kept", one?.sideOwnerUserId === mgr.id && one.vendorCode === `ZZV-${RUN}` && one.vendorStatus === "ACTIVE", one);
    ok("  its contact moved, the vendor record gone, the merge says so", (await db.contact.count({ where: { companyId: asClient.id, name: "Vendor Desk" } })) === 1 && !(await db.company.findUnique({ where: { id: asVendor.id } })) && crossed.notes.some((n) => n.includes("also a vendor")), crossed.notes);
    // Former names (owner, 14 Nov 2026): the duplicate's name stays findable on the one kept.
    const fn = require("../src/lib/companies/former-names") as typeof import("../src/lib/companies/former-names");
    const keptRow = await db.company.findUnique({ where: { id: asClient.id }, select: { formerNames: true } });
    ok("  the duplicate's name is kept as a former name", fn.formerNamesList(keptRow?.formerNames).some((n) => n.endsWith("Digitrock")), keptRow);
    const foundByOld = await db.company.findMany({ where: { AND: [{ id: asClient.id }, { OR: await fn.formerNamesWhere("digitrock") }] }, select: { id: true } });
    ok("  and a search for it finds the company", foundByOld.length === 1);
    ok("former names: never the name now, nor one twice in another spelling", fn.withFormerNames("Acme Pvt. Ltd.", ["ACME PRIVATE LIMITED", "Acme Ltd", "Acme Pvt Ltd"], "Acme Limited") === "Acme Pvt. Ltd.");
    ok("  the newest kept, the oldest dropped past the limit", fn.formerNamesList(fn.withFormerNames(null, Array.from({ length: 25 }, (_, i) => `Zz Old ${i}`), "Zz Now")).length === fn.MAX_FORMER_NAMES);
    await fn.rememberFormerNames(db, asClient.id, ["Digitrock Infosystems Private Limited"], "Digitrock Infosystems Limited");
    ok("  a rename keeps the old name beside the merged one's", fn.formerNamesList((await db.company.findUnique({ where: { id: asClient.id }, select: { formerNames: true } }))?.formerNames).length === 2);

    // Pvt Ltd became Ltd (owner, 18 Nov 2026: "fix both gaps"): what was issued keeps the name it was issued to, and a
    // file or the Zoho archive naming the old name still finds the company.
    {
      const renamedCo = await company(`Zz Renamed ${RUN} Pvt Ltd`, { ownerUserId: boss.id });
      const oldName = renamedCo.name;
      const newName = oldName.replace(/ Pvt Ltd$/, " Ltd");
      const issued = await db.tradeDocument.create({ data: { docNumber: `ZZMRG-REN-${RUN}-1`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: renamedCo.id, createdById: boss.id } });
      const draft = await db.tradeDocument.create({ data: { docNumber: `ZZMRG-REN-${RUN}-2`, docType: "INVOICE", direction: "SALES", status: "DRAFT", companyId: renamedCo.id, createdById: boss.id } });
      const frozenBefore = await db.tradeDocument.create({ data: { docNumber: `ZZMRG-REN-${RUN}-3`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: renamedCo.id, createdById: boss.id, partyName: "Zz Earlier Name" } });
      const kept = await fn.keepIssuedNames(db, renamedCo.id, oldName);
      await db.company.update({ where: { id: renamedCo.id }, data: { name: newName, normalizedName: newName.toLowerCase() } });
      await fn.rememberFormerNames(db, renamedCo.id, [oldName], newName);
      const after = await db.tradeDocument.findMany({ where: { id: { in: [issued.id, draft.id, frozenBefore.id] } }, select: { id: true, partyName: true } });
      const nameOf = (id: string) => after.find((d) => d.id === id)?.partyName;
      ok(
        "a rename: the issued invoice keeps the name it was issued to, the draft takes the new one, a name already kept stays",
        kept === 1 && nameOf(issued.id) === oldName && nameOf(draft.id) === null && nameOf(frozenBefore.id) === "Zz Earlier Name",
        after,
      );
      const companySrc = (require("node:fs") as typeof import("node:fs")).readFileSync("src/actions/company.ts", "utf8");
      ok("  the company form's save keeps them before it renames", /if \(renamed\) await keepIssuedNames\(db, id, current\.name\);\s*await db\.company\.update/.test(companySrc));
      const byName = require("../src/lib/companies/by-name") as typeof import("../src/lib/companies/by-name");
      ok(
        "  an import naming the old name finds it — as written, or in another legal form",
        (await byName.companyIdByName(oldName)) === renamedCo.id && (await byName.companyIdByName(oldName.replace(/ Pvt Ltd$/, " PRIVATE LIMITED").toUpperCase())) === renamedCo.id,
      );
      ok("  and making a new company under the old name is warned of it", (await byName.companyNamedLike(oldName.replace(/ Pvt Ltd$/, " Private Limited")))?.id === renamedCo.id && (await byName.companyNamedLike(oldName, renamedCo.id)) === null);
      const twin = await company(`Zz Twin ${RUN} Ltd`, { ownerUserId: boss.id });
      await fn.rememberFormerNames(db, twin.id, [oldName], twin.name);
      ok("  two companies that once had the name: neither is taken", (await byName.companyIdByName(oldName)) === null);
      await db.tradeDocument.deleteMany({ where: { id: { in: [issued.id, draft.id, frozenBefore.id] } } });
      await db.company.deleteMany({ where: { id: { in: [renamedCo.id, twin.id] } } });
    }
    const roles = require("../src/lib/companies/roles") as typeof import("../src/lib/companies/roles");
    ok("  offered as a vendor and as a customer", (await roles.isVendorSide({ id: asClient.id, relationshipType: "CLIENT" })) && (await roles.isCustomerSide({ id: asClient.id, relationshipType: "CLIENT" })));

    // The vendor kept, the customer taken in: a vendor that is also a customer, the customer's manager on that side.
    const v2 = await company("Zz Supply House", { relationshipType: "DISTRIBUTOR", ownerUserId: boss.id });
    const c2 = await company("Zz Supply House Private Limited", { ownerUserId: mgr.id });
    await merge.executeMerge({ keepId: v2.id, dropId: c2.id, choices: {}, combine: [], userId: boss.id });
    const two = await db.company.findUnique({ where: { id: v2.id }, select: { relationshipType: true, alsoCustomer: true, alsoVendor: true, sideOwnerUserId: true, vendorCode: true } });
    ok("a distributor taking in a customer: also a customer, with a vendor code given", two?.relationshipType === "DISTRIBUTOR" && two.alsoCustomer && !two.alsoVendor && two.sideOwnerUserId === mgr.id && !!two.vendorCode, two);

    // ───────────────────────────────────────────────────────────────────────────
    section("The duplicates list");

    const H = await company("Monsoon Technologies Pvt Ltd", { ownerUserId: boss.id });
    const I = await company("MONSOON Solutions", { ownerUserId: boss.id });
    await db.companyLocation.create({ data: { companyId: H.id, label: "HQ", gstNumber: "07ZZMRG0000Z1ZA" } });
    await db.contact.create({ data: { companyId: H.id, name: "A", email: `a@zzmrg-monsoon-${RUN}.in` } });
    await db.contact.create({ data: { companyId: I.id, name: "B", email: `b@zzmrg-monsoon-${RUN}.in` } });
    const listed = await actions.listDuplicates();
    const row = listed.ok ? listed.data.rows.find((r) => r.companies.some((c) => c.id === H.id) && r.companies.some((c) => c.id === I.id)) : undefined;
    ok("a pair with the same core name and a shared domain is listed as very likely", row?.strength === "strong" && row.reasons.some((r) => r.startsWith("Same email domain")), row?.reasons.join(" · "));
    ok("  the one with more under it first", row?.companies[0]?.id === H.id);
    const dupHtml = renderToStaticMarkup(await DuplicatesPage({ searchParams: Promise.resolve({}) }));
    ok("the duplicates page lists the pair, with a way to merge it and a way to say it isn't one", dupHtml.includes(H.name) && dupHtml.includes(I.name) && dupHtml.includes("Review merge") && dupHtml.includes("Not duplicates") && dupHtml.includes(`/companies/merge?keep=${formatCompanyId(H.companySeq)}&amp;drop=${formatCompanyId(I.companySeq)}`));
    ok("  the merged-away company is on no row",listed.ok && !listed.data.rows.some((r) => r.companies.some((c) => c.id === D.id || c.id === F.id)));
    // Found by name or reference, and paged through — not cut off at 300 (owner, 13 Nov 2026).
    const searched = await actions.listDuplicates({ q: "monsoon" });
    ok("searched by name: the pair, and only pairs naming it", searched.ok && searched.data.rows.some((r) => r.companies.some((c) => c.id === H.id)) && searched.data.rows.every((r) => r.companies.some((c) => /monsoon/i.test(c.name))), searched.ok ? searched.data.total : searched);
    const iRef = row?.companies.find((c) => c.id === I.id)?.ref ?? "";
    const byRef = await actions.listDuplicates({ q: iRef });
    ok("  and by its reference", !!iRef && byRef.ok && byRef.data.rows.some((r) => r.companies.some((c) => c.id === I.id)), iRef);
    const none = await actions.listDuplicates({ q: "zz-no-such-company-anywhere" });
    ok("  a search naming nobody finds nothing, and says how many were checked", none.ok && none.data.total === 0 && none.data.rows.length === 0 && none.data.scanned > 0);
    if (listed.ok && listed.data.total >= 2) {
      const one = await actions.listDuplicates({ page: 1, pageSize: 1 });
      const two = await actions.listDuplicates({ page: 2, pageSize: 1 });
      const key = (x: typeof one) => (x.ok ? x.data.rows.map((r) => r.companies.map((c) => c.id).join()).join() : "");
      ok("paged: a page at a time, each its own pairs, the total every pair", one.ok && two.ok && one.data.rows.length === 1 && key(one) !== key(two) && one.data.total === listed.data.total, { total: listed.data.total });
      const past = await actions.listDuplicates({ page: 99999, pageSize: 1 });
      ok("  a page past the end shows the last one", past.ok && past.data.page === listed.data.total && past.data.rows.length === 1);
    }
    // Both with Zoho invoices (owner, 18 Nov 2026: "when both have Zoho invoices, show which to keep"): one is shown to keep,
    // and why; the other's say they move across. A pair that merges with the rest shows the one the bulk merge keeps.
    {
      const mig = await db.migration.create({ data: { source: "zoho-books", yearStart: new Date("2026-04-01"), switchDate: new Date("2026-07-01"), status: "UNDONE", createdById: boss.id }, select: { id: true } });
      const inv = (companyId: string, n: number) => ({ migrationId: mig.id, kind: "INVOICE", key: `INVOICE:zzmrg:${RUN}:${companyId}:${n}`, number: `ZZMRG-${RUN}-${companyId.slice(-4)}-${n}`, date: new Date("2025-06-01"), year: "2025-26", partyName: "Monsoon", companyId, status: "Paid", currency: "INR", total: 100, balance: 0 });
      await db.archivedDocument.createMany({ data: [inv(H.id, 1), inv(I.id, 1), inv(I.id, 2), inv(I.id, 3)] as never });
      const both = await actions.listDuplicates({ q: "monsoon" });
      const bothRow = both.ok ? both.data.rows.find((r) => r.companies.some((c) => c.id === H.id) && r.companies.some((c) => c.id === I.id)) : undefined;
      const expected = bothRow?.bulk === true ? H.id : I.id;
      ok(
        bothRow?.bulk === true ? "both with Zoho invoices, merging with the rest: the one the bulk merge keeps is first" : "both with Zoho invoices: the one with more of them is first",
        bothRow?.companies[0]?.id === expected && bothRow.companies[0]!.zohoInvoices > 0 && bothRow.companies[1]!.zohoInvoices > 0,
        bothRow?.companies.map((c) => [c.name, c.zohoInvoices, c.records]),
      );
      const bothHtml = renderToStaticMarkup(await DuplicatesPage({ searchParams: Promise.resolve({ q: "monsoon" }) }));
      ok(
        "  the page says which to keep and why, and the other's invoices move across",
        bothHtml.includes("Both have Zoho invoices. Keep") && bothHtml.includes("they move to the one kept") && (bothHtml.match(/keep this one/g) ?? []).length >= 1,
      );
      await db.migration.delete({ where: { id: mig.id } });
    }
    const searchHtml = renderToStaticMarkup(await DuplicatesPage({ searchParams: Promise.resolve({ q: "monsoon" }) }));
    ok("the page has a search box, and says what it found", searchHtml.includes("Find a company") && searchHtml.includes("naming &quot;monsoon&quot;"), searchHtml.match(/d[d,]* pairs?[^.]*/)?.[0]);
    // By group, and those with no orders, invoices or payments on either side (owner, 14 Nov 2026).
    const hasPair = (x: Awaited<ReturnType<typeof actions.listDuplicates>>) => x.ok && x.data.rows.some((r) => r.companies.some((c) => c.id === H.id) && r.companies.some((c) => c.id === I.id));
    const inC = await actions.listDuplicates({ q: "monsoon", group: "corroborated" });
    ok("group C (same name and more) has the pair", hasPair(inC) && inC.ok && inC.data.group === "corroborated", inC.ok ? inC.data.counts : inC);
    ok("  group A (same GSTIN) doesn't", !hasPair(await actions.listDuplicates({ q: "monsoon", group: "gstin" })));
    ok("  an unknown group shows every group", hasPair(await actions.listDuplicates({ q: "monsoon", group: "zz" })));
    ok("  neither has an order, invoice or payment, so it's under no orders too", hasPair(await actions.listDuplicates({ q: "monsoon", noOrders: true })));
    ok(
      "  the counts add up: every group's pairs make the whole, the no-order ones never more",
      listed.ok && Object.values(listed.data.counts).reduce((t, c) => t + c.all, 0) === listed.data.total && Object.values(listed.data.counts).every((c) => c.noOrders <= c.all),
      listed.ok ? listed.data.counts : listed,
    );
    const groupHtml = renderToStaticMarkup(await DuplicatesPage({ searchParams: Promise.resolve({ group: "corroborated", orders: "none" }) }));
    ok("the page shows the group chips and the no-orders filter, links keeping the other", groupHtml.includes("All groups") && groupHtml.includes("No orders, invoices or payments on either") && groupHtml.includes("group=weak&amp;orders=none"));
    as(other);
    const theirs = await actions.listDuplicates();
    ok("somebody who can't see those companies doesn't see the pair", theirs.ok && !theirs.data.rows.some((r) => r.companies.some((c) => c.id === H.id)));
    ok("  nor dismiss it", !(await actions.dismissDuplicate(H.id, I.id)).ok);
    as(boss);
    ok("'not duplicates' is remembered", (await actions.dismissDuplicate(I.id, H.id)).ok);
    const relisted = await actions.listDuplicates();
    ok("  and the pair isn't offered again", relisted.ok && !relisted.data.rows.some((r) => r.companies.some((c) => c.id === H.id) && r.companies.some((c) => c.id === I.id)));
    ok("  dismissing twice is harmless", (await actions.dismissDuplicate(H.id, I.id)).ok && (await db.companyDuplicateDismissal.count({ where: { companyAId: H.id < I.id ? H.id : I.id } })) === 1);

    // ───────────────────────────────────────────────────────────────────────────
    section("Merging the safe pairs in one go");
    // Owner, 13 Nov 2026: no orders or documents on either, merged together; any business, by hand.
    const bm = await import("../src/lib/companies/bulk-merge");
    const s = (id: string, business: number, records: number, companySeq: number) => ({ id, business, records, companySeq });
    // Security audit round three, 14 Nov 2026 (R3-24): only a shared GSTIN or PAN goes in bulk; the same name alone doesn't.
    const pan = ["Same PAN ZZ"];
    ok("a pair sharing a PAN with nothing on either goes in bulk", bm.bulkVerdict({ aId: "a", bId: "b", strength: "strong", reasons: pan }, s("a", 0, 3, 1), s("b", 0, 1, 2)).ok);
    ok("  a pair matched by name alone is a person's", bm.bulkVerdict({ aId: "a", bId: "b", strength: "strong", reasons: ["Same name once Pvt, Ltd and the like are set aside"] }, s("a", 0, 3, 1), s("b", 0, 1, 2)).ok === false);
    ok("  any business on either, and it's a person's", bm.bulkVerdict({ aId: "a", bId: "b", strength: "strong", reasons: pan }, s("a", 0, 3, 1), s("b", 1, 0, 2)).ok === false);
    ok("  a weaker match is a person's, even with nothing on it", bm.bulkVerdict({ aId: "a", bId: "b", strength: "likely" }, s("a", 0, 0, 1), s("b", 0, 0, 2)).ok === false);
    // Security review, 15 Nov 2026 (ADV-01): never by records, which anybody reaching the company can pad.
    ok("the older record stays, however much was added to the newer", bm.keeperOf(s("a", 0, 1, 5), s("b", 0, 400, 9)).keep.id === "a" && bm.keeperOf(s("a", 0, 2, 9), s("b", 0, 2, 5)).keep.id === "b");
    // Owner, 14 Nov 2026: "any record which has invoice done in Zoho wins".
    ok("  but the one with Zoho Books invoices stays, however little else is under it", bm.keeperOf({ ...s("a", 0, 9, 1), zohoInvoices: 0 }, { ...s("b", 0, 1, 9), zohoInvoices: 3 }).keep.id === "b");
    ok("  both with Zoho invoices: the older is kept", bm.keeperOf({ ...s("a", 0, 1, 5), zohoInvoices: 2 }, { ...s("b", 0, 4, 9), zohoInvoices: 7 }).keep.id === "a");
    const chain = new Map([["a", s("a", 0, 0, 1)], ["b", s("b", 0, 0, 2)], ["c", s("c", 0, 0, 3)]]);
    ok("  a company in two pairs is in one merge a run", bm.bulkBatch([{ aId: "a", bId: "b", strength: "strong", reasons: pan }, { aId: "b", bId: "c", strength: "strong", reasons: pan }], chain, 10).length === 1);
    const { currentTenant } = await import("../src/lib/tenancy/resolve");
    const confirm = (await currentTenant()).name;

    const sharedPan = `ZZ${RUN}`.toUpperCase().slice(0, 10);
    const P = await company("Kestrel Fabrications Pvt Ltd", { ownerUserId: boss.id, panNumber: sharedPan });
    const Q = await company("KESTREL Fabrications Limited", { ownerUserId: boss.id, website: "https://kestrel-zzmrg.example", panNumber: sharedPan });
    await db.contact.create({ data: { companyId: P.id, name: "Zz Kestrel One", email: `one@zzmrg-kestrel-${RUN}.in` } });
    await db.contact.create({ data: { companyId: P.id, name: "Zz Kestrel Two", email: `two@zzmrg-kestrel-${RUN}.in` } });
    await db.contact.create({ data: { companyId: Q.id, name: "Zz Kestrel Three", email: `three@zzmrg-kestrel-${RUN}.in` } });
    const R = await company("Osprey Traders Pvt Ltd", { ownerUserId: boss.id });
    const S = await company("OSPREY Traders", { ownerUserId: boss.id });
    await db.tradeDocument.create({ data: { docNumber: `ZZMRG-${RUN}-bulk`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: S.id, createdById: boss.id } });
    const T = await company("Heron Logistic", { ownerUserId: boss.id });
    const U = await company("Heron Logistix", { ownerUserId: boss.id });

    const listedBulk = await actions.listDuplicates({ q: "zzmrg" });
    const rowOf = (x: string, y: string) => (listedBulk.ok ? listedBulk.data.rows.find((r) => r.companies.some((c) => c.id === x) && r.companies.some((c) => c.id === y)) : undefined);
    ok("the list says which way each pair goes", rowOf(P.id, Q.id)?.bulk === true && rowOf(R.id, S.id)?.bulk === "business" && rowOf(T.id, U.id)?.bulk === "likely", [rowOf(P.id, Q.id)?.bulk, rowOf(R.id, S.id)?.bulk, rowOf(T.id, U.id)?.bulk]);
    ok("  and counts what the bulk merge would take", listedBulk.ok && listedBulk.data.bulk >= 1);

    as(other);
    const notTheirs = await actions.bulkMergeDuplicates({ among: [P.id, Q.id], confirm });
    ok("somebody who can't see these companies merges none of them", notTheirs.ok && notTheirs.data.merged === 0 && !!(await db.company.findUnique({ where: { id: Q.id } })), notTheirs);
    as(boss);
    const unconfirmed = await actions.bulkMergeDuplicates({ among: [P.id, Q.id] });
    ok("without the workspace's name typed, nothing is merged", !unconfirmed.ok && !!(await db.company.findUnique({ where: { id: Q.id } })), unconfirmed);
    const run = await actions.bulkMergeDuplicates({ among: [P.id, Q.id, R.id, S.id, T.id, U.id], confirm });
    ok("run over these six: one merged", run.ok && run.data.merged === 1, run);
    const [pAfter, qAfter] = await Promise.all([db.company.findUnique({ where: { id: P.id }, select: { id: true, website: true } }), db.company.findUnique({ where: { id: Q.id } })]);
    ok("  the one with more people stays; the other is gone", !!pAfter && !qAfter);
    ok("  its blank filled from the other", pAfter?.website === "https://kestrel-zzmrg.example", pAfter?.website);
    ok("  everyone is under the one kept", (await db.contact.count({ where: { companyId: P.id } })) === 3);
    ok("  the merge is written to the log", (await db.auditLog.count({ where: { entityId: Q.id, entityLabel: { contains: "bulk merge" } } })) === 1);
    ok("the pair with an invoice is left for a person", !!(await db.company.findUnique({ where: { id: R.id } })) && !!(await db.company.findUnique({ where: { id: S.id } })));
    ok("the weaker match is left for a person", !!(await db.company.findUnique({ where: { id: T.id } })) && !!(await db.company.findUnique({ where: { id: U.id } })));
    const rerun = await actions.bulkMergeDuplicates({ among: [P.id, R.id, S.id, T.id, U.id], confirm });
    ok("run again: nothing more to merge", rerun.ok && rerun.data.merged === 0 && rerun.data.left === 0, rerun);
  } finally {
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll company-merge checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
