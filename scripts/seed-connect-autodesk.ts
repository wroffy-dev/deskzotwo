/**
 * seed:connect-autodesk — a demo of Deskzo Connect as Wroffy would run it with Autodesk (owner, 20 Nov 2026: "show me
 * the guest view … along with 20 guests from Autodesk team with assigned territories, Autodesk LC team, etc and like
 * working from last 3 months"). Local demo data only:
 *
 *   · Three Autodesk teams — Territory Sales (12), License Compliance (5), Partner Success (3) — 20 guests, each with
 *     a territory; one has left (stopped), one's access ended, one hasn't signed in yet.
 *   · 14 companies in UP, MP, Rajasthan, Punjab, Bihar and Assam beside the workspace's own.
 *   · "Autodesk accounts — joint pipeline", one sheet for every team (owner: "build per-share columns first, then move
 *     LC to pipeline"): the territory reps and partner team see the sales columns (Autodesk rep, Next step, Products,
 *     Seats, Joint visit) in their own states; the LC team sees only the accounts ticked "Nominated for LC" (a
 *     staff-only column) in their region, and only the LC columns (LC status, LC meeting). A board and a calendar.
 *   · Comments stay with their team: an LC thread is seen by the LC team and Wroffy, never by the sales reps.
 *   · Three months of it: sign-ins, cell changes, comment threads with Wroffy's account managers, suggestions decided.
 *
 * Addresses are @autodesk.example — never a real mailbox. Everything it makes is listed on the Territory Sales
 * connection's note and removed by `-- clean` (guests, shares and activity go with the connections).
 *
 *   npx tsx scripts/seed-connect-autodesk.ts          make it (cleans a previous run first)
 *   npx tsx scripts/seed-connect-autodesk.ts clean    remove it
 */
import "dotenv/config";
import { directClient } from "../src/lib/tenancy/direct-client";
import { normalizeCompanyName } from "../src/lib/company-name";

const db = directClient();
const DAY = 86_400_000;
const now = new Date();
const daysAgo = (d: number, hour = 11) => {
  const t = new Date(now.getTime() - d * DAY);
  t.setHours(hour, Math.floor(rand() * 60), 0, 0);
  return t;
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);

let seed = 20261120;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;
const some = <T,>(a: readonly T[], n: number) => [...a].sort(() => rand() - 0.5).slice(0, n);

const SALES = "Autodesk India — Territory Sales";
const LC = "Autodesk License Compliance";
const PARTNER = "Autodesk Partner Success";

type G = { name: string; conn: string; states: string[]; status?: "SUSPENDED" | "INVITED"; ended?: boolean; since: number; busy: number };
const GUESTS: G[] = [
  { name: "Rohan Mehta", conn: SALES, states: ["Uttar Pradesh", "Madhya Pradesh"], since: 92, busy: 0.55 },
  { name: "Ishita Bansal", conn: SALES, states: ["Delhi", "Haryana"], since: 90, busy: 0.6 },
  { name: "Karan Malhotra", conn: SALES, states: ["Punjab", "Rajasthan"], since: 88, busy: 0.4 },
  { name: "Aditi Kulkarni", conn: SALES, states: ["Maharashtra"], since: 91, busy: 0.5 },
  { name: "Nikhil Deshpande", conn: SALES, states: ["Maharashtra", "Gujarat"], status: "SUSPENDED", since: 90, busy: 0.35 },
  { name: "Priyanka Shah", conn: SALES, states: ["Gujarat"], since: 60, busy: 0.45 },
  { name: "Arvind Raghavan", conn: SALES, states: ["Karnataka"], since: 89, busy: 0.6 },
  { name: "Meera Nair", conn: SALES, states: ["Karnataka", "Tamil Nadu"], since: 85, busy: 0.45 },
  { name: "Srinivas Reddy", conn: SALES, states: ["Telangana"], since: 75, busy: 0.4 },
  { name: "Ananya Bose", conn: SALES, states: ["West Bengal"], since: 80, busy: 0.35 },
  { name: "Rahul Sinha", conn: SALES, states: ["Bihar", "Assam"], since: 70, busy: 0.3 },
  { name: "Tanvi Joshi", conn: SALES, states: ["Tamil Nadu"], status: "INVITED", since: 3, busy: 0 },
  { name: "Neha Kapoor", conn: LC, states: ["Delhi", "Haryana", "Punjab", "Rajasthan", "Uttar Pradesh"], since: 84, busy: 0.3 },
  { name: "Vikram Iyer", conn: LC, states: ["Karnataka", "Tamil Nadu", "Telangana"], since: 84, busy: 0.25 },
  { name: "Farah Siddiqui", conn: LC, states: ["Maharashtra", "Gujarat", "Madhya Pradesh"], since: 78, busy: 0.25 },
  { name: "Debashish Roy", conn: LC, states: ["West Bengal", "Bihar", "Assam"], since: 70, busy: 0.2 },
  { name: "Sunil Menon", conn: LC, states: [], since: 86, busy: 0.2 },
  { name: "Pooja Arora", conn: PARTNER, states: [], since: 93, busy: 0.35 },
  { name: "Aman Grover", conn: PARTNER, states: ["Delhi", "Haryana", "Uttar Pradesh"], ended: true, since: 88, busy: 0.3 },
  { name: "Lakshmi Prasad", conn: PARTNER, states: [], since: 50, busy: 0.2 },
];

const NEW_COMPANIES: [string, string, string][] = [
  ["Saraswati Infra Projects Pvt Ltd", "Lucknow", "Uttar Pradesh"],
  ["Gomti Designs LLP", "Lucknow", "Uttar Pradesh"],
  ["Kanpur Precision Castings Ltd", "Kanpur", "Uttar Pradesh"],
  ["Noida Smart Structures Pvt Ltd", "Noida", "Uttar Pradesh"],
  ["Narmada Engineering Consultants", "Indore", "Madhya Pradesh"],
  ["Bhopal Urban Architects LLP", "Bhopal", "Madhya Pradesh"],
  ["Pink City Builders Pvt Ltd", "Jaipur", "Rajasthan"],
  ["Thar Solar EPC Ltd", "Jodhpur", "Rajasthan"],
  ["Ludhiana Tool Works Pvt Ltd", "Ludhiana", "Punjab"],
  ["Amritsar Heritage Interiors", "Amritsar", "Punjab"],
  ["Patliputra Constructions Pvt Ltd", "Patna", "Bihar"],
  ["Ganga Bridge Engineers", "Patna", "Bihar"],
  ["Brahmaputra Infra Developers", "Guwahati", "Assam"],
  ["Kamrup Plant Design LLP", "Guwahati", "Assam"],
];

const GUEST_COMMENTS = [
  "Spoke to their BIM head — they're moving two teams to Revit next quarter.",
  "Customer asked for a joint demo of the AEC Collection. Can we do Thursday?",
  "Their AutoCAD LT seats renew in February; worth bundling with Civil 3D.",
  "Met the MD at the Autodesk University roadshow. Warm — please follow up.",
  "They're evaluating a competitor for plant design. Let's get Plant 3D in front of them.",
  "Budget approved for 12 seats. Sharing the quote format they need.",
  "Procurement wants a single invoice for all sites — can Wroffy handle that?",
  "Their IT team asked about Autodesk Construction Cloud trials.",
  "Visited today. They need training for 8 new hires before the switch.",
  "Renewal confirmed verbally; PO expected next week.",
  "They want flexible tokens for the site engineers instead of named users.",
  "No response after two calls. Can your account manager try?",
];
const STAFF_REPLIES = [
  "Thanks — I'll set up the call and send you the invite.",
  "Quote shared with them today. Will update here once they come back.",
  "Done. Their purchase head will join the demo too.",
  "Yes, we can do one invoice; I've told their finance team.",
  "Training slots booked for the 2nd and 3rd.",
  "Following up tomorrow morning.",
  "PO received. Thanks for the push on this one!",
];
const INTERNAL = ["Keep the discount at 8% max — margin is thin here.", "Old dues pending; collect before the new order.", "Owner is price-sensitive, quote AEC Collection first."];
const LC_COMMENTS = [
  "Customer informed about the true-up conversation; they prefer a call over email.",
  "Seat summary shared with the customer — they'll confirm by Friday.",
  "Joint meeting fixed with their IT head.",
  "Customer chose to regularise with a 3-year AEC Collection.",
  "They've asked for time till quarter end — noting here.",
];

async function clean() {
  const sales = await db.connection.findFirst({ where: { name: SALES }, select: { note: true } });
  const made = sales?.note?.startsWith("{") ? (JSON.parse(sales.note) as { companies: string[]; workbooks: string[] }) : { companies: [], workbooks: [] };
  await db.connection.deleteMany({ where: { name: { in: [SALES, LC, PARTNER] } } });
  if (made.workbooks.length) await db.workbook.deleteMany({ where: { id: { in: made.workbooks } } });
  if (made.companies.length) {
    await db.companyLocation.deleteMany({ where: { companyId: { in: made.companies } } });
    await db.company.deleteMany({ where: { id: { in: made.companies } } });
  }
  return made;
}

async function main() {
  const removed = await clean();
  if (process.argv.includes("clean")) {
    console.log(`Removed the Autodesk demo (${removed.workbooks.length} lists, ${removed.companies.length} companies, its guests and activity).`);
    return;
  }
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true } });
  const staff = await db.user.findMany({ where: { active: true, isSuperAdmin: false }, take: 12, orderBy: { name: "asc" }, select: { id: true, name: true } });

  // Companies in the new territories.
  const companyIds: string[] = [];
  for (const [name, city, state] of NEW_COMPANIES) {
    const c = await db.company.create({ data: { name, normalizedName: normalizeCompanyName(name), createdById: admin.id, ownerUserId: pick(staff).id, createdAt: daysAgo(100) }, select: { id: true } });
    await db.companyLocation.create({ data: { companyId: c.id, label: "Head office", city, state, country: "India", isPrimary: true } });
    companyIds.push(c.id);
  }
  const companies = await db.company.findMany({ select: { id: true, name: true, ownerUserId: true, locations: { orderBy: { isPrimary: "desc" }, take: 1, select: { state: true } } } });
  const stateOf = (c: (typeof companies)[number]) => c.locations[0]?.state ?? "";

  const sales = await db.connection.create({ data: { name: SALES, kind: "BRAND", note: "", createdById: admin.id, createdAt: daysAgo(95) }, select: { id: true } });
  const lc = await db.connection.create({ data: { name: LC, kind: "BRAND", createdById: admin.id, createdAt: daysAgo(90) }, select: { id: true } });
  const partner = await db.connection.create({ data: { name: PARTNER, kind: "BRAND", createdById: admin.id, createdAt: daysAgo(95) }, select: { id: true } });
  const connId = { [SALES]: sales.id, [LC]: lc.id, [PARTNER]: partner.id };

  // ── The one list ──
  const opt = (names: string[], colors: string[]) => names.map((n, i) => ({ id: `o${i + 1}`, name: n, color: colors[i % colors.length] }));
  const pipe = await db.workbook.create({
    data: { name: "Autodesk accounts — joint pipeline", description: "Every Autodesk account with Wroffy, worked together with Autodesk's territory, LC and partner teams. Each sees their own states and their own columns.", filters: {}, ownerUserId: admin.id, createdAt: daysAgo(96), lastOpenedAt: daysAgo(0, 9) },
    select: { id: true },
  });
  const STEPS = opt(["Intro call", "Demo booked", "Proposal shared", "Renewal due", "Won", "Lost"], ["gray", "blue", "purple", "amber", "green", "red"]);
  const PRODUCTS = opt(["AutoCAD", "AutoCAD LT", "Revit", "Civil 3D", "AEC Collection", "Fusion", "Inventor", "Plant 3D"], ["blue", "gray", "purple", "green", "amber", "pink", "red", "blue"]);
  const prop = (workbookId: string, name: string, kind: string, sortOrder: number, extra: object = {}) =>
    db.workbookProperty.create({ data: { workbookId, name, kind: kind as never, sortOrder, ...extra }, select: { id: true } });
  const rep = await prop(pipe.id, "Autodesk rep", "TEXT", 0, { guestVisible: true });
  const step = await prop(pipe.id, "Next step", "SELECT", 1, { options: STEPS, guestVisible: true, guestEditable: true });
  const products = await prop(pipe.id, "Products", "MULTI_SELECT", 2, { options: PRODUCTS, guestVisible: true, guestEditable: true });
  const seats = await prop(pipe.id, "Seats (est.)", "NUMBER", 3, { guestVisible: true, guestEditable: true });
  const visit = await prop(pipe.id, "Joint visit", "DATE", 4, { guestVisible: true, guestEditable: true });
  const value = await prop(pipe.id, "Deal value", "MONEY", 5);
  const notes = await prop(pipe.id, "Wroffy notes", "TEXT", 6);
  await db.workbookView.createMany({
    data: [
      { workbookId: pipe.id, name: "By next step", kind: "BOARD", propertyId: step.id, sortOrder: 1 },
      { workbookId: pipe.id, name: "Joint visits", kind: "CALENDAR", propertyId: visit.id, sortOrder: 2 },
    ],
  });
  const LC_STATUS = opt(["Nominated", "Customer informed", "Meeting set", "Resolved — purchase", "Resolved — no purchase"], ["gray", "blue", "amber", "green", "purple"]);
  const nominated = await prop(pipe.id, "Nominated for LC", "CHECKBOX", 7);
  const nominatedBy = await prop(pipe.id, "Nominated by", "PERSON", 8);
  const lcStatus = await prop(pipe.id, "LC status", "SELECT", 9, { options: LC_STATUS, guestVisible: true, guestEditable: true });
  const lcMeeting = await prop(pipe.id, "LC meeting", "DATE", 10, { guestVisible: true, guestEditable: true });
  const SALES_COLUMNS = [rep.id, step.id, products.id, seats.id, visit.id];
  const LC_COLUMNS = [lcStatus.id, lcMeeting.id];

  const repFor = (state: string) => GUESTS.find((g) => g.conn === SALES && g.status !== "SUSPENDED" && g.states.includes(state))?.name ?? "";
  const values: { workbookId: string; propertyId: string; companyId: string; value: object; updatedAt: Date }[] = [];
  const put = (workbookId: string, propertyId: string, companyId: string, v: unknown, d = rand() * 80) => values.push({ workbookId, propertyId, companyId, value: v as object, updatedAt: daysAgo(Math.floor(d)) });
  const nominatedIds: string[] = [];
  for (const c of companies) {
    const st = stateOf(c);
    if (repFor(st)) put(pipe.id, rep.id, c.id, repFor(st));
    const s = pick(STEPS);
    put(pipe.id, step.id, c.id, s.id);
    put(pipe.id, products.id, c.id, some(PRODUCTS, 1 + Math.floor(rand() * 3)).map((p) => p.id));
    put(pipe.id, seats.id, c.id, 2 + Math.floor(rand() * 40));
    if (rand() < 0.45) put(pipe.id, visit.id, c.id, ymd(new Date(now.getTime() + (Math.floor(rand() * 50) - 20) * DAY)));
    put(pipe.id, value.id, c.id, Math.round((1 + rand() * 30) * 100000));
    if (rand() < 0.3) put(pipe.id, notes.id, c.id, pick(INTERNAL));
    if (rand() < 0.3 && st) {
      nominatedIds.push(c.id);
      put(pipe.id, nominated.id, c.id, true);
      put(pipe.id, nominatedBy.id, c.id, c.ownerUserId ?? pick(staff).id);
      put(pipe.id, lcStatus.id, c.id, pick(LC_STATUS).id);
      if (rand() < 0.5) put(pipe.id, lcMeeting.id, c.id, ymd(new Date(now.getTime() + (Math.floor(rand() * 30) - 10) * DAY)));
    }
  }
  for (const v of values) await db.workbookValue.create({ data: { ...v, updatedByUserId: rand() < 0.6 ? null : admin.id } });

  // ── The guests, their territories and shares ──
  const activity: { guestId: string; kind: "SIGN_IN" | "EDIT" | "COMMENT" | "SUGGEST"; workbookId: string | null; at: Date }[] = [];
  // `to`: a staff reply meant for one team only (the LC team's threads).
  const comments: { workbookId: string; companyId: string; body: string; authorUserId: string | null; authorGuestId: string | null; shared: boolean; createdAt: Date; to?: string }[] = [];
  const guestIds: Record<string, string> = {};
  let suggestions = 0;
  for (const g of GUESTS) {
    const local = g.name.toLowerCase().replace(/\s+/g, ".");
    const invitedAt = daysAgo(g.since, 10);
    const signedIn = g.status !== "INVITED";
    const lastDay = g.status === "SUSPENDED" ? 21 : g.ended ? 7 : Math.floor(rand() * 3);
    const guest = await db.guest.create({
      data: {
        connectionId: connId[g.conn]!,
        name: g.name,
        email: `${local}@autodesk.example`,
        status: g.status ?? "ACTIVE",
        invitedById: admin.id,
        invitedAt,
        inviteExpiresAt: new Date(invitedAt.getTime() + 7 * DAY),
        accessUntil: g.ended ? daysAgo(6, 23) : g.conn === PARTNER && g.name === "Lakshmi Prasad" ? new Date(now.getTime() + 40 * DAY) : null,
        lastSignInAt: signedIn ? daysAgo(lastDay, 10) : null,
        createdAt: invitedAt,
      },
      select: { id: true },
    });
    guestIds[g.name] = guest.id;
    if (g.states.length) await db.guestTerritory.create({ data: { guestId: guest.id, states: g.states, updatedById: admin.id } });
    const list = pipe.id;
    const share = await db.listShare.create({ data: { workbookId: list, guestId: guest.id, sharedById: admin.id, createdAt: invitedAt }, select: { id: true } });
    if (g.conn === LC) await db.listShareScope.create({ data: { shareId: share.id, onlyPropertyId: nominated.id, updatedById: admin.id } });
    await db.listShareColumns.create({ data: { shareId: share.id, columnIds: g.conn === LC ? LC_COLUMNS : SALES_COLUMNS, updatedById: admin.id } });
    if (!signedIn) continue;

    // Their companies: the list's, in their territory (and for LC, nominated).
    const theirs = companies.filter((c) => (!g.states.length || g.states.includes(stateOf(c))) && (g.conn !== LC || nominatedIds.includes(c.id)));
    for (let d = g.since - 1; d >= lastDay; d--) {
      const day = new Date(now.getTime() - d * DAY).getDay();
      if (day === 0 || day === 6 || rand() > g.busy) continue;
      const hour = 9 + Math.floor(rand() * 9);
      activity.push({ guestId: guest.id, kind: "SIGN_IN", workbookId: null, at: daysAgo(d, hour) });
      const edits = Math.floor(rand() * 4);
      for (let i = 0; i < edits && theirs.length; i++) activity.push({ guestId: guest.id, kind: "EDIT", workbookId: list, at: daysAgo(d, hour) });
      if (theirs.length && rand() < 0.22) {
        const c = pick(theirs);
        const at = daysAgo(d, hour);
        comments.push({ workbookId: list, companyId: c.id, body: pick(g.conn === LC ? LC_COMMENTS : GUEST_COMMENTS), authorUserId: null, authorGuestId: guest.id, shared: true, createdAt: at });
        activity.push({ guestId: guest.id, kind: "COMMENT", workbookId: list, at });
        if (rand() < 0.7 && d > 0) comments.push({ workbookId: list, companyId: c.id, body: pick(STAFF_REPLIES), authorUserId: c.ownerUserId ?? admin.id, authorGuestId: null, shared: true, createdAt: daysAgo(d - (rand() < 0.5 ? 0 : 1), Math.min(20, hour + 2)), to: g.conn === LC ? lc.id : undefined });
        if (rand() < 0.2) comments.push({ workbookId: list, companyId: c.id, body: pick(INTERNAL), authorUserId: c.ownerUserId ?? admin.id, authorGuestId: null, shared: false, createdAt: daysAgo(d, Math.min(20, hour + 3)) });
      }
      if (g.conn === SALES && rand() < 0.04) {
        const at = daysAgo(d, hour);
        const decided = d > 5;
        const r = rand();
        const suggestedCity = pick(["Lucknow", "Pune", "Chennai", "Hyderabad", "Gurugram", "Kolkata", "Indore", "Patna"]);
        if (r < 0.6) {
          const status = !decided ? "PENDING" : rand() < 0.6 ? "LINKED" : "DECLINED";
          const linkTo = status === "LINKED" ? pick(theirs.length ? theirs : companies) : null;
          await db.listSuggestion.create({
            data: {
              workbookId: list,
              guestId: guest.id,
              kind: "NEW_COMPANY",
              name: linkTo?.name ?? `${pick(["Shree", "Om", "Vardhman", "Sunrise", "Apex", "Navyug"])} ${pick(["Designs", "Infratech", "Engineers", "Consultants", "Structures"])} ${pick(["Pvt Ltd", "LLP", "Ltd"])}`,
              city: suggestedCity,
              note: pick(["Big Revit user, renewing in March.", "They called Autodesk directly — please take it.", "New AEC firm, 25 designers.", "Expanding to a second office."]),
              status,
              companyId: linkTo?.id ?? null,
              decidedById: decided ? admin.id : null,
              decidedAt: decided ? daysAgo(d - 2) : null,
              declineReason: status === "DECLINED" ? pick(["Already a customer of another partner.", "Outside our service area for now."]) : null,
              createdAt: at,
            },
          });
        } else if (theirs.length) {
          const c = pick(theirs);
          await db.listSuggestion.create({
            data: { workbookId: list, guestId: guest.id, kind: "CORRECTION", companyId: c.id, note: pick(["Their GSTIN changed after the merger.", "They moved to a new office in the same city.", "IT head is now Mr. Verma, not Mr. Rao."]), status: decided ? "ACCEPTED" : "PENDING", decidedById: decided ? admin.id : null, decidedAt: decided ? daysAgo(d - 1) : null, createdAt: at },
          });
        }
        activity.push({ guestId: guest.id, kind: "SUGGEST", workbookId: list, at });
        suggestions += 1;
      }
    }
  }
  // A staff comment shared with the guests, now and then, unprompted.
  for (let i = 0; i < 25; i++) {
    const c = pick(companies);
    comments.push({ workbookId: pipe.id, companyId: c.id, body: pick(["Their renewal is 45 days out — Autodesk rep, can you join the call?", "Customer asked for a Fusion trial; sharing for visibility.", "Quote sent for AEC Collection, 10 seats."]), authorUserId: c.ownerUserId ?? admin.id, authorGuestId: null, shared: true, createdAt: daysAgo(Math.floor(rand() * 85), 15) });
  }
  await db.guestActivity.createMany({ data: activity });
  for (const { to, ...c } of comments) {
    const row = await db.listRowComment.create({ data: c, select: { id: true } });
    if (to) await db.listRowCommentAudience.create({ data: { commentId: row.id, connectionId: to } });
  }
  await db.connection.update({ where: { id: sales.id }, data: { note: JSON.stringify({ companies: companyIds, workbooks: [pipe.id] }) } });

  console.log(`Autodesk demo made: 20 guests in 3 teams on one list (${nominatedIds.length} accounts nominated for LC), ${companyIds.length} new companies, ${activity.length} guest actions, ${comments.length} comments, ${suggestions} suggestions over 3 months.`);
  console.log(`Rohan Mehta (UP and MP): ${guestIds["Rohan Mehta"]} · Neha Kapoor (LC North): ${guestIds["Neha Kapoor"]} · pipeline list ${pipe.id}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
