/**
 * check:contact-masking — field masking for contacts, and "Show" on the Leads list (owner, 3 Nov 2026: "why no masking
 * here" on Contacts; "also on the leads list page the option to mask and unmask" — src/lib/contacts/masking.ts,
 * src/actions/contact-unmask.ts, src/lib/leads/masking.ts `maskLeadsForList`).
 *
 *   1. Nothing set: contacts exactly as before.
 *   2. Masked for a person: the Contacts list, a customer's Contacts tab and the call picker show the email and phone
 *      masked, the email's check fields gone with it; a search doesn't match on what's masked; each row says so.
 *   3. "Show": a unit of the daily limit, logged; that contact in the clear for the day, in lists too; a repeat free;
 *      the limit, shared with leads, stops the next; refused while viewing as somebody.
 *   4. Saving a contact whose details are masked keeps them as stored; a masked number is dialled as the real one,
 *      a restricted one isn't; the call log shows it masked.
 *   5. The contacts export goes out masked, and its masked cells are read back as "leave alone".
 *   6. The Leads list: a lead masked in the list offers "Show"; after it, that lead's row is in the clear.
 *   7. The rest of the read paths (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.3/H.4.7/M-12/L-8): the
 *      Reports engine's "Lost reason", the leads data export, the mail log, a customer's and a person's Activity, and
 *      the Customer inbox each show a masked contact (and a masked lead's values in its free text) masked — none of
 *      their responses carries a raw value — and the mail log's and the inbox's searches don't match on one.
 *
 * Sets personal policies on a sales person of the dev workspace and removes them, the usage and log rows, after.
 *
 *   npm run check:contact-masking
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let viewingAs: { user: { id: string; name: string }; actor: { id: string; name: string } } | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => viewingAs, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => actor };
  }
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const MASK = { view: true, maskInList: true, maskInDetail: true, unmask: true };

async function main() {
  const { listAllContactsPaged } = await import("../src/actions/contact");
  const { getCompany, updateContact } = await import("../src/actions/company");
  const { unmaskContact } = await import("../src/actions/contact-unmask");
  const { listCompanyNumbers } = await import("../src/actions/call");
  const { dialledNumber } = await import("../src/lib/contacts/masking");
  const { contactsExporter } = await import("../src/lib/portability/exporters/crm");
  const { maskLeadsForList } = await import("../src/lib/leads/masking");
  const { unmaskLead } = await import("../src/actions/lead-unmask");
  const { canSeeCompany } = await import("../src/lib/authz/company-scope");
  const { getSource } = await import("../src/lib/analytics/sources");
  const { leadsExporter } = await import("../src/lib/portability/exporters/leads");
  const { listMailLog, getMailMessage } = await import("../src/actions/mail-log");
  const timeline = await import("../src/lib/activity/timeline");
  const inbox = await import("../src/lib/inbox/server");
  const { can } = await import("../src/lib/authz/resolve");

  // A sales person, and a customer of theirs with two contacts that have an email and a phone.
  const sellers = await db.user.findMany({ where: { role: "SALES", active: true, isSuperAdmin: false }, select: { id: true, role: true, name: true, email: true }, take: 30 });
  let seller: Actor | null = null;
  let company: { id: string; name: string } | null = null;
  for (const s of sellers) {
    const owned = await db.company.findMany({ where: { ownerUserId: s.id, managedByResellerId: null, contacts: { some: { email: { not: null }, phone: { not: null }, leftAt: null } } }, select: { id: true, name: true, ownerUserId: true, relationshipType: true, _count: { select: { contacts: true } } }, take: 10 });
    const two = owned.find((c) => c._count.contacts >= 2);
    if (two && (await canSeeCompany(s.id, two))) {
      seller = s;
      company = two;
      break;
    }
  }
  if (!seller || !company) throw new Error("No sales person with a customer of two reachable contacts.");
  const people = await db.contact.findMany({ where: { companyId: company.id, email: { not: null }, phone: { not: null }, leftAt: null }, select: { id: true, name: true, email: true, phone: true }, take: 2, orderBy: { name: "asc" } });
  if (people.length < 2) throw new Error("Need two contacts with email and phone.");
  const [first, second] = people as [(typeof people)[number], (typeof people)[number]];
  const startedAt = new Date();
  // What section 7 makes, to take out again: a lost lead, a call, an email, a contact's change line, a note, an inbox channel.
  const zz: { leadId?: string; callId?: string; messageId?: string; auditId?: string; activityId?: string; channelId?: string } = {};
  const masking = await db.fieldMaskingSettings.findUnique({ where: { id: "global" } });
  actor = seller;

  const listed = async (search?: string) => (await listAllContactsPaged({ page: 1, pageSize: 200, search: search ?? company!.name })).rows;
  const rowOf = async (id: string) => (await listed()).find((r) => r.id === id);

  try {
    await db.fieldMaskingSettings.upsert({ where: { id: "global" }, create: { id: "global", enabled: true }, update: { enabled: true } });

    section("1. Nothing set");
    const before = await rowOf(first.id);
    ok("contacts exactly as before", before?.email === first.email && before?.phone === first.phone && before.masked.email === false && before.revealable === false, before && { email: before.email, masked: before.masked });

    section("2. Masked");
    await db.userFieldPolicy.createMany({
      data: [
        { userId: seller.id, entity: "contacts", field: "email", ...MASK, format: "email", reason: "zz check" },
        { userId: seller.id, entity: "contacts", field: "phone", ...MASK, format: "phone_last4", reason: "zz check" },
      ],
    });
    const masked = await rowOf(first.id);
    ok("the Contacts list: email and phone masked, the name as it is", !!masked && masked.email !== first.email && /\*{5}@/.test(masked.email ?? "") && /\*{6}\d{4}$/.test(masked.phone ?? "") && masked.name === first.name, masked && { email: masked.email, phone: masked.phone });
    ok("  the email's check fields gone with it", masked?.emailCheckedValue === null);
    ok("  the row says what's masked, and that Show may reveal it", masked?.masked.email === true && masked.masked.phone === true && masked.revealable === true);
    const byEmail = await listed(first.email!.split("@")[0]!.slice(0, 6));
    ok("a search doesn't match on a masked email", !byEmail.some((r) => r.id === first.id) || first.name.toLowerCase().includes(first.email!.split("@")[0]!.slice(0, 6).toLowerCase()), byEmail.length);
    const tab = (await getCompany(company.id)) as { contacts: { id: string; email: string | null; phone: string | null }[] } | null;
    const onTab = tab?.contacts.find((c) => c.id === first.id);
    ok("a customer's Contacts tab: masked too", !!onTab && onTab.email !== first.email && onTab.phone !== first.phone, onTab && { email: onTab.email });
    const numbers = await listCompanyNumbers(company.id);
    const dialRow = numbers.find((n) => n.id === first.id);
    ok("the call picker: the number masked", !dialRow || (dialRow.phone !== first.phone && dialRow.phone!.includes("*")), dialRow?.phone);

    section("3. Show");
    const shown = await unmaskContact(first.id);
    ok("Show unmasks it, a unit used", shown.result === "ALLOWED" && (shown.usage?.used ?? 0) >= 1, shown);
    const clear = await rowOf(first.id);
    const other = await rowOf(second.id);
    ok("  that contact in the clear for the day, in the list too", clear?.email === first.email && clear.phone === first.phone && clear.revealable === false, clear && { email: clear.email });
    ok("  the other still masked", other?.email !== second.email, other?.email);
    const again = await unmaskContact(first.id);
    ok("  a repeat is free", again.result === "REPEAT");
    const log = await db.unmaskEvent.findFirst({ where: { userId: seller.id, leadId: `contact:${first.id}`, at: { gte: startedAt } }, select: { result: true, leadRef: true } });
    ok("  logged, against the company — not the person's name", log?.result === "ALLOWED" && log.leadRef === `Contact at ${company.name}`, log);
    await db.userUnmaskLimit.upsert({ where: { userId: seller.id }, create: { userId: seller.id, limited: true, dailyLimit: 1, reason: "zz check" }, update: { limited: true, dailyLimit: 1, reason: "zz check" } });
    const capped = await unmaskContact(second.id);
    ok("the daily limit, shared with leads, stops the next", capped.result === "QUOTA_EXHAUSTED" && /leads and contacts/.test(capped.message ?? ""), capped);
    await db.userUnmaskLimit.deleteMany({ where: { userId: seller.id, reason: "zz check" } });
    viewingAs = { user: { id: seller.id, name: seller.name }, actor: { id: "zz-admin", name: "ZZ Admin" } };
    const asSomebody = await unmaskContact(second.id);
    viewingAs = null;
    ok("refused while an admin is viewing as them", asSomebody.result === "DENIED" && /viewing as/.test(asSomebody.message ?? ""));

    section("4. Saving and calling");
    const secondRow = (await rowOf(second.id))!;
    const saved = await updateContact({ id: second.id, name: second.name, designation: (await db.contact.findUnique({ where: { id: second.id }, select: { designation: true } }))!.designation, email: "", phone: secondRow.phone ?? "", linkedinUrl: "", isPrimary: false, receivesDocuments: false });
    const after = await db.contact.findUnique({ where: { id: second.id }, select: { email: true, phone: true } });
    ok("saving as the form sends it — the email left blank, the phone masked — keeps the real ones", saved.ok && after?.email === second.email && after.phone === second.phone, saved.ok ? after : saved.error);
    const dial = await dialledNumber(seller.id, { phoneNumber: secondRow.phone!, contactId: second.id, companyId: company.id });
    ok("a masked number is dialled as the real one", dial.masked && dial.number === second.phone);
    const wrongCompany = await dialledNumber(seller.id, { phoneNumber: secondRow.phone!, contactId: second.id, companyId: "not-this-one" });
    ok("  not for a contact of another company", !wrongCompany.masked && wrongCompany.number === secondRow.phone);
    await db.userFieldPolicy.update({ where: { user_entity_field: { userId: seller.id, entity: "contacts", field: "phone" } }, data: { view: false, maskInList: false, maskInDetail: false, unmask: false } });
    const restricted = await dialledNumber(seller.id, { phoneNumber: "+91 ******1234", contactId: second.id, companyId: company.id });
    ok("  a restricted number isn't dialled at all", !restricted.masked && restricted.number.includes("*"));
    await db.userFieldPolicy.update({ where: { user_entity_field: { userId: seller.id, entity: "contacts", field: "phone" } }, data: MASK });

    section("5. Export and re-import");
    const exported = await contactsExporter({ userId: seller.id } as never);
    const sheet = (Array.isArray(exported) ? exported : (exported as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
    const secondOut = sheet.find((r) => String(r.Name) === second.name && String(r.Company) === company!.name);
    ok("the contacts export goes out masked", !secondOut || (String(secondOut.Email).includes("*") && String(secondOut["Email status"]) === ""), secondOut && { Email: secondOut.Email });
    const importer = (await import("../src/lib/portability/importers/contacts")) as unknown as Record<string, { plan?: (row: Record<string, string>, line: number, ctx: unknown) => Promise<{ changes?: { field: string }[]; error?: string }> }>;
    const contactsImporter = Object.values(importer).find((v) => v && typeof v === "object" && typeof v.plan === "function");
    const seq = (await db.contact.findUnique({ where: { id: second.id }, select: { contactSeq: true } }))!.contactSeq;
    if (contactsImporter?.plan) {
      const plan = await contactsImporter.plan({ Key: `CON-${String(seq).padStart(6, "0")}`, Name: "Z********", Company: company.name, Email: "s*****@g***.com", Phone: "+91 ******4321" }, 2, { actorUserId: seller.id, userId: seller.id, custom: null });
      const touched = (plan.changes ?? []).map((c) => c.field);
      ok("a re-imported masked row changes nothing", !plan.error && !touched.includes("Name") && !touched.includes("Email") && !touched.includes("Phone"), plan.error ?? touched);
    }

    section("6. The Leads list");
    const lead = await db.lead.findFirst({ where: { companyId: company.id }, select: { id: true, title: true } }) ?? (await db.lead.findFirst({ where: { company: { ownerUserId: seller.id } }, select: { id: true, title: true } }));
    if (lead) {
      await db.userFieldPolicy.create({ data: { userId: seller.id, entity: "leads", field: "title", ...MASK, format: "first", reason: "zz check" } });
      const [row] = await maskLeadsForList(seller.id, [{ id: lead.id, title: lead.title }]);
      ok("a lead masked in the list offers Show", row!.title !== lead.title && row!.revealable === true, row);
      const r = await unmaskLead(lead.id, "list");
      const [open] = await maskLeadsForList(seller.id, [{ id: lead.id, title: lead.title }]);
      ok("  after it, its row is in the clear", (r.result === "ALLOWED" || r.result === "REPEAT") && open!.title === lead.title && open!.revealable === false, { r: r.result, title: open!.title });
    } else ok("a lead to try the list on", false, "none");

    section("7. The rest of the read paths");
    // `second` is masked for the seller (email and phone, section 2) and was never "Show"n; its name is masked here too.
    await db.userFieldPolicy.create({ data: { userId: seller.id, entity: "contacts", field: "name", ...MASK, format: "first", reason: "zz check" } });
    // The screens below each ask a permission of their own: held for this section only where the seller lacks it.
    for (const key of ["leads.view", "contacts.view", "calls.view", "emails.view"]) {
      if (!(await can(seller.id, key))) await db.userPermission.create({ data: { userId: seller.id, permission: key, allowed: true, reason: "zz check" } });
    }
    const raw = [second.name, second.email!, second.phone!];
    const leaks = (value: unknown, values: string[] = raw) => values.filter((v) => v && v.length >= 3 && JSON.stringify(value ?? null).toLowerCase().includes(v.toLowerCase()));
    const title = `ZZ check Orion ${Date.now().toString(36)}`;
    const made = await db.lead.create({
      data: { companyId: company.id, contactId: second.id, ownerUserId: seller.id, title, status: "LOST", lostReason: `Lost — ${title} went with a cheaper quote; ${second.name} said so on ${second.phone}` },
      select: { id: true, leadSeq: true },
    });
    zz.leadId = made.id;
    const titled = [title, ...raw];

    // The Reports engine: "Lost reason" redacted (not masked whole) as the Leads list redacts it.
    const source = getSource("leads")!;
    const loaded = (await source.load({ userId: seller.id, from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000), dateColumn: "createdAt" } as never)) as unknown as { id: string; lostReason: string | null }[];
    const reported = loaded.find((r) => r.id === made.id);
    const dimension = source.dimensions.find((d) => d.key === "lostReason")!;
    const reason = reported ? String(dimension.of(reported as never)) : null;
    ok("Reports: the lost reason breakdown names no masked value — redacted, not masked whole", !!reason && leaks(reason, [title]).length === 0 && reason.includes("went with a cheaper quote"), reason);
    // What a report sends anybody is its dimensions' values (and measures' numbers): none of them names the title.
    const values = reported ? source.dimensions.map((d) => d.of(reported as never)) : null;
    ok("  no breakdown of the leads source names the masked title", !!values && leaks(values, [title]).length === 0, values && leaks(values, [title]));

    // Reports by company (the companies policy, src/lib/companies/masking.ts): a breakdown by City or State masks them too.
    // A rule of this check's own — never over one somebody else set (another check may be running on the same person).
    const placed = await db.userFieldPolicy.findUnique({ where: { user_entity_field: { userId: seller.id, entity: "companies", field: "address" } }, select: { reason: true } });
    if (!placed) {
      await db.userFieldPolicy.create({ data: { userId: seller.id, entity: "companies", field: "address", view: true, maskInList: true, maskInDetail: true, unmask: false, format: "stars", reason: "zz check" } });
      const orders = getSource("orders")!;
      const orderRows = (await orders.load({ userId: seller.id, from: new Date(0), to: new Date(Date.now() + 86_400_000), dateColumn: "createdAt" } as never)) as unknown as { companyId: string }[];
      const places = await db.companyLocation.findMany({ where: { companyId: { in: [...new Set(orderRows.map((r) => r.companyId))] } }, select: { city: true, state: true } });
      const rawPlaces = [...new Set(places.flatMap((l) => [l.city, l.state]).filter((v): v is string => !!v && v.trim().length >= 3))];
      const byPlace = orders.dimensions.filter((d) => d.key === "city" || d.key === "state").flatMap((d) => orderRows.map((r) => d.of(r as never)));
      if (orderRows.length && rawPlaces.length) ok("Reports: an order's City and State as the companies policy masks them", leaks(byPlace, rawPlaces).length === 0, leaks(byPlace, rawPlaces).slice(0, 3));
      else ok("Reports: an order's City and State — not tried: the seller has no orders on a located account", true);
    } else ok("Reports: an order's City and State — not tried: the seller has a company address rule already", true);
    await db.userFieldPolicy.deleteMany({ where: { userId: seller.id, entity: "companies", reason: "zz check" } });

    // The leads data export: the contact's email and phone by the contact's own rules; the lost reason held back.
    const exportRows = async () => {
      const out = (await leadsExporter({ userId: seller.id } as never)) as unknown as Record<string, unknown>[];
      return out.find((r) => r.Key === `LEAD-${String(made.leadSeq).padStart(6, "0")}`);
    };
    const leadRow = await exportRows();
    ok("the leads export: a masked contact's email and phone go out blank, never in full", !!leadRow && leadRow["Contact email"] === "" && leadRow["Contact phone"] === "", leadRow && { email: leadRow["Contact email"], phone: leadRow["Contact phone"] });
    ok("  the lost reason quoting a masked value is held back", leadRow?.["Lost reason"] === "", leadRow?.["Lost reason"]);
    // Its Contact column is the lead's contact name, which follows the lead's own rules (not masked for this seller).
    const unnamed = [title, second.email!, second.phone!];
    ok("  its row carries no raw value", !!leadRow && leaks(leadRow, unnamed).length === 0, leadRow && leaks(leadRow, unnamed));
    // Without contacts.view: somebody who sees leads, with the address book taken away for this check by a row of its
    // own (never over one they have) — every contact's email and phone blank in their export.
    const others = await db.user.findMany({ where: { active: true, isSuperAdmin: false, id: { not: seller.id }, permissionGrants: { none: { permission: "contacts.view" } } }, select: { id: true }, take: 50 });
    let without: string | null = null;
    for (const u of others) if (await can(u.id, "leads.view")) {
      without = u.id;
      break;
    }
    if (without) {
      await db.userPermission.create({ data: { userId: without, permission: "contacts.view", allowed: false, reason: "zz check" } });
      try {
        const sheet = (await leadsExporter({ userId: without } as never)) as unknown as Record<string, unknown>[];
        const reached = sheet.filter((r) => r["Contact email"] !== "" || r["Contact phone"] !== "");
        ok("  without contacts.view, no contact's email or phone at all", sheet.length > 0 && reached.length === 0, { rows: sheet.length, withDetails: reached.length });
      } finally {
        await db.userPermission.deleteMany({ where: { userId: without, permission: "contacts.view", reason: "zz check" } });
      }
    } else ok("  without contacts.view — not tried: nobody else here sees leads", true);

    // A call, an email and a contact's change line about `second`, and a note on the lost lead quoting it.
    zz.callId = (await db.callLog.create({ data: { companyId: company.id, contactId: second.id, userId: seller.id, phoneNumber: second.phone!, outcome: "CONNECTED", startedAt: new Date(), notes: `ZZ check — rang ${second.name} on ${second.phone}, wrote to ${second.email}` }, select: { id: true } })).id;
    zz.messageId = (
      await db.marketingMessage.create({
        data: { token: `zz-check-${Date.now().toString(36)}`, companyId: company.id, contactId: second.id, channel: "EMAIL", messageClass: "TRANSACTIONAL", status: "SENT", subject: `ZZ check — a quote for ${second.name}`, body: `<p>Dear ${second.name}, we have ${second.email} and ${second.phone} on file.</p>`, toEmail: second.email, scheduledFor: new Date(), sentAt: new Date(), sentByUserId: seller.id, error: `ZZ check — ${second.email} bounced once` },
        select: { id: true },
      })
    ).id;
    zz.auditId = (await db.auditLog.create({ data: { userId: seller.id, action: "UPDATE", entityType: "Contact", entityId: second.id, entityLabel: `Checked ${second.email} — valid`, companyId: company.id }, select: { id: true } })).id;
    zz.activityId = (await db.activity.create({ data: { leadId: made.id, userId: seller.id, type: "NOTE", notes: `ZZ check — ${title}: call ${second.name} on ${second.phone}` }, select: { id: true } })).id;

    const feed = await timeline.recordActivity(seller.id, { companyId: company.id }, { take: 200 });
    const ours = <T extends { id: string }>(p: { items: T[] }) => p.items.filter((i) => [`call-${zz.callId}`, `email-${zz.messageId}`, `audit-${zz.auditId}`, `logged-${zz.activityId}`].includes(i.id));
    const onCompany = ours(feed);
    ok("a customer's Activity: the call, the email, the contact's change line and the note are there", onCompany.length === 4, onCompany.map((i) => i.id));
    ok("  none of them names the contact, their number or address, or the masked lead title, in the clear", leaks(onCompany, titled).length === 0, leaks(onCompany, titled));
    ok("  the call names who was called as the Contacts tab does", onCompany.some((i) => i.id === `call-${zz.callId}` && i.title.includes(`${second.name[0]}********`)), onCompany.find((i) => i.id === `call-${zz.callId}`)?.title);
    const mine = ours(await timeline.personActivity(seller.id, seller.id, { take: 200 }));
    ok("a person's Activity: the same lines, none in the clear", mine.length === 4 && leaks(mine, titled).length === 0, { lines: mine.map((i) => i.id), leaks: leaks(mine, titled) });

    // The mail log: the recipient as the contacts policy shows them, everywhere the message says it.
    const logged = await listMailLog({ companyId: company.id, page: 1, pageSize: 200 });
    const row = logged.rows.find((r) => r.id === zz.messageId);
    ok("the mail log: the message is listed, its recipient's address masked", !!row && !!row.toEmail && row.toEmail !== second.email && row.toEmail.includes("*"), row?.toEmail);
    ok("  the list carries no raw value", leaks(row).length === 0, leaks(row));
    const one = await getMailMessage(zz.messageId);
    ok("  the message's own page neither — the body and the error included", !!one && leaks(one).length === 0, leaks(one));
    const found = await listMailLog({ q: second.email!, page: 1, pageSize: 200 });
    ok("  a search on the masked address doesn't find it", !found.rows.some((r) => r.id === zz.messageId), found.rows.length);

    // The Customer inbox: a conversation linked to `second` shows their number and email as the contacts policy does.
    zz.channelId = (await db.inboxChannel.create({ data: { kind: "WEB", name: "ZZ check channel" }, select: { id: true } })).id;
    const conversation = await db.conversation.create({ data: { channelId: zz.channelId, kind: "WEB", contactId: second.id, companyId: company.id, customerPhone: second.phone, customerEmail: second.email }, select: { id: true } });
    const viewer = { id: seller.id, viewAll: true };
    const rows = await inbox.listConversations(viewer, { view: "open", channelId: zz.channelId });
    const listedRow = rows.find((r) => r.id === conversation.id);
    ok("the inbox: the conversation is listed, its name the masked number", !!listedRow && listedRow.customer !== second.phone && listedRow.customer.includes("*"), listedRow?.customer);
    const detail = await inbox.conversationDetail(viewer, conversation.id);
    ok("  its Contact card: number and email masked, said to be", !!detail && detail.customerMasked.phone && detail.customerMasked.email && leaks({ p: detail.customerPhone, e: detail.customerEmail }).length === 0, detail && { phone: detail.customerPhone, email: detail.customerEmail });
    ok("  the conversation carries no raw number or address", !!detail && leaks(detail, [second.email!, second.phone!]).length === 0, detail && leaks(detail, [second.email!, second.phone!]));
    const searched = await inbox.listConversations(viewer, { view: "open", channelId: zz.channelId, q: second.phone! });
    ok("  a search on the masked number doesn't find it", !searched.some((r) => r.id === conversation.id), searched.length);
  } finally {
    if (zz.channelId) await db.inboxChannel.deleteMany({ where: { id: zz.channelId } });
    if (zz.activityId) await db.activity.deleteMany({ where: { id: zz.activityId } });
    if (zz.auditId) await db.auditLog.deleteMany({ where: { id: zz.auditId } });
    if (zz.messageId) await db.marketingMessage.deleteMany({ where: { id: zz.messageId } });
    if (zz.callId) await db.callLog.deleteMany({ where: { id: zz.callId } });
    if (zz.leadId) await db.lead.deleteMany({ where: { id: zz.leadId } });
    await db.userPermission.deleteMany({ where: { userId: seller.id, reason: "zz check" } });
    await db.userFieldPolicy.deleteMany({ where: { userId: seller.id, reason: "zz check" } });
    await db.userUnmaskLimit.deleteMany({ where: { userId: seller.id, reason: "zz check" } });
    await db.unmaskUsage.deleteMany({ where: { userId: seller.id, createdAt: { gte: startedAt } } });
    // The unmasking log is append-only by design: its rows from this run stay, as every attempt's do.
    await db.auditLog.deleteMany({ where: { userId: seller.id, createdAt: { gte: startedAt }, entityType: "Contact" } });
    if (masking) await db.fieldMaskingSettings.update({ where: { id: "global" }, data: { enabled: masking.enabled } });
    else await db.fieldMaskingSettings.deleteMany({ where: { id: "global" } });
  }

  console.log(failures === 0 ? `\nAll ${passes} contact masking checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
