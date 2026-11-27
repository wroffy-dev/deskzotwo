/**
 * seed:smart-list-templates — one Smart List from every template, with sample rows, for testing (owner, 20 Nov 2026:
 * "make smart list for all templates as seed data for testing"). Local demo data only.
 *
 *   · Each list is made the way the app makes it (createRowList, src/lib/smart-lists/own-rows.ts) — the template's
 *     columns, choices and views — then given 12 rows: Indian companies, people, cities and codes, dates around today,
 *     a value in most cells for its column's kind, the workspace's own people in Person columns.
 *   · Every list it makes says "Sample data for testing" at the start of its description; `clean` removes those and
 *     only those (their rows and values go with them). Re-running replaces them.
 *   · Addresses are @example.com and links are .example — nothing reaches a real mailbox or site.
 *
 *   npx tsx scripts/seed-smart-list-templates.ts          make them
 *   npx tsx scripts/seed-smart-list-templates.ts clean    remove them
 */
import "dotenv/config";
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { LIST_TEMPLATES, type ListTemplate } from "../src/lib/smart-lists/templates";
import { createRowList, ownRowsReady } from "../src/lib/smart-lists/own-rows";
import { optionsOf } from "../src/lib/smart-lists/values";

const MARK = "Sample data for testing";
const ROWS = 12;
const DAY = 86_400_000;

let seed = 4320;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const day = (from: number, to: number) => new Date(Date.now() + int(from, to) * DAY).toISOString().slice(0, 10);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const COMPANIES = ["Bluestone Solar Pvt Ltd", "Saraswati Infra Projects", "Apex Diagnostics LLP", "Greenfield Packaging Pvt Ltd", "Narmada Engineering", "Pink City Builders", "Vertex Retail Ltd", "Orion Fintech Pvt Ltd", "Crescent Foods Pvt Ltd", "Kamrup Plant Design LLP", "Ludhiana Tool Works", "Everest Chemicals Ltd", "Shree Ganesh Textiles", "Northstar Motors LLP", "Indus Healthcare Pvt Ltd"];
const PEOPLE = ["Aarav Sharma", "Priya Nair", "Rohan Mehta", "Ananya Bose", "Vikram Iyer", "Neha Kapoor", "Karan Malhotra", "Ishita Bansal", "Arjun Reddy", "Meera Joshi", "Siddharth Rao", "Pooja Arora", "Farhan Siddiqui", "Lakshmi Prasad", "Devika Menon"];
const CITIES = ["Mumbai", "Pune", "Delhi", "Gurugram", "Bengaluru", "Chennai", "Hyderabad", "Kolkata", "Ahmedabad", "Jaipur", "Lucknow", "Indore", "Kochi", "Chandigarh"];
const KEYWORDS = ["solar panel price in india", "best crm for small business", "gst invoice software", "iso 9001 certification cost", "2 bhk flats in pune", "autocad lt price", "warehouse management system", "employee attendance app", "rooftop solar subsidy", "tally to cloud migration", "site visit checklist", "cold storage near me"];
const SENTENCES = ["Good on price, slow on delivery.", "Strong local team; weak after-sales.", "Asked for a revised quote by Friday.", "Needs sign-off from their director.", "Matches the spec; packing to improve.", "Follow up after the festival week.", "Shared photos and a short report.", "Discussed on call; waiting for documents.", "Fixed and verified on site.", "Payment terms agreed at 30 days."];

const TITLES: Record<string, string[]> = {
  "Linking page": ["techbuzz.example/best-crm-2026", "startupdesk.example/tools-we-use", "indiabiz.example/solar-guide", "fintalk.example/gst-tips", "cadworld.example/autocad-vs-lt", "hrnotes.example/attendance-apps"],
  Title: ["10 ways to cut GST filing time", "Rooftop solar: a buyer's guide", "Why field teams need offline apps", "Case study: Pink City Builders", "ISO 9001 in plain words", "Monsoon checklist for sites", "How we onboard a dealer in a day", "Webinar recap: smart lists"],
  Keyword: KEYWORDS,
  Website: ["TechBuzz India", "StartupDesk", "IndiaBiz Weekly", "FinTalk", "CAD World", "HR Notes", "Solar Today", "Factory Floor"],
  Creator: ["@buildwithriya", "@techtalkstamil", "@solarsaathi", "@founderdiaries", "@cadguru", "@mumbaimakers"],
  Creative: ["Diwali offer banner", "Year-end sale reel", "Webinar invite carousel", "Product launch video", "Hoarding — Pune expressway", "Lead form ad — solar"],
  Deliverable: ["Brand guidelines", "Website home page", "Monthly SEO report", "Launch video", "Social calendar — December", "Brochure print files"],
  Competitor: ["Zenith Systems", "Prime Soft", "Unity Tech", "Spark Solutions", "Nova Infotech", "Quantum Works"],
  Deal: COMPANIES.map((c) => `${c.split(" ")[0]} — renewal`),
  Customer: COMPANIES,
  Tender: ["Supply of solar street lights", "AMC of network equipment", "School furniture — 40 schools", "CCTV for municipal markets", "Laptops for district offices", "Water treatment plant O&M"],
  Partner: ["Shah Brokers", "Om Sai Traders", "Metro Realty Partners", "Sunrise Channel Co", "Vishal Distributors", "Classic Agencies"],
  Item: ["Solar panel 540 W", "Inverter 5 kW", "Cat6 cable box", "Laptop i5 16 GB", "Office chair", "LED panel 2x2", "UPS 1 kVA", "Router dual band"],
  Vendor: ["Vardhman Supplies", "Sunrise Traders", "Metro Electricals", "Classic Office World", "Navyug Enterprises", "Prime Logistics"],
  Contract: ["Lift AMC", "DG set AMC", "Housekeeping contract", "Security services", "Pest control", "Air-conditioning AMC"],
  Tool: ["Zoom", "Canva", "Microsoft 365", "Google Workspace", "Slack", "Adobe Acrobat", "Figma", "Tally Prime"],
  "Asset tag": Array.from({ length: 12 }, (_, i) => `IT-${String(1001 + i)}`),
  Task: ["Book venue", "Confirm caterer", "Print standees", "Speaker travel", "Guest kits", "Thank-you mails", "AV check", "Photographer"],
  Guest: PEOPLE,
  Consignment: Array.from({ length: 12 }, (_, i) => `CN-2611-${String(40 + i)}`),
  Route: ["Delhi → Jaipur", "Mumbai → Pune", "Chennai → Bengaluru", "Ahmedabad → Surat", "Kolkata → Patna", "Hyderabad → Vijayawada"],
  "Vehicle number": ["HR 55 AB 1234", "MH 12 KL 4521", "DL 1C AA 9087", "KA 03 MN 7766", "GJ 01 BX 3310", "RJ 14 CD 2299"],
  Machine: ["CNC lathe 2", "Injection moulder 1", "Air compressor", "Packing line A", "Boiler", "Laser cutter"],
  Issue: ["Scratch on panel finish", "Wrong label on carton", "Weld porosity", "Short shipment", "Colour mismatch", "Loose fitting"],
  Supplier: ["Vardhman Supplies", "Sunrise Traders", "Metro Electricals", "Navyug Enterprises", "Bharat Castings", "Om Polymers"],
  Sample: ["Fabric swatch — navy", "Bracket prototype v2", "Label print proof", "Paint shade card", "Cable sample 2.5 mm", "Packaging box"],
  Unit: ["A-101", "A-302", "A-1203", "B-504", "B-907", "C-1102", "Villa 14", "Shop G-3"],
  Visitor: PEOPLE,
  Site: ["Bluestone factory roof", "Orion office — 4th floor", "Crescent warehouse", "Apex lab", "Greenfield plant", "Vertex store, Pune"],
  Snag: ["Seepage near window", "Loose switch board", "Door alignment", "Paint touch-up", "Drain slope", "Ceiling tile crack"],
  Material: ["Cement OPC 53", "TMT bars 12 mm", "Cat6 cable", "PVC conduit", "Floor tiles 2x2", "Plywood 18 mm"],
  Equipment: ["Inverter 5 kW", "UPS 10 kVA", "Water purifier", "Chiller unit", "DG set 62.5 kVA", "Solar plant 50 kW"],
  Client: COMPANIES,
  "Certificate number": Array.from({ length: 12 }, (_, i) => `QMS-26-${String(310 + i)}`),
  Filing: ["GSTR-3B", "GSTR-1", "TDS 24Q", "TDS 26Q", "ITR-6", "MGT-7", "AOC-4", "PF return"],
  Document: ["PAN copy", "GST certificate", "Bank statement", "Audited balance sheet", "Board resolution", "Address proof"],
  Candidate: PEOPLE,
  Role: ["Sales executive", "Site engineer", "Accountant", "Field technician", "HR executive", "Inside sales", "Store keeper"],
  Session: ["Negotiation skills", "Excel for managers", "Customer service", "Safety at site", "Leadership basics", "GST refresher"],
  Trainer: PEOPLE,
  Goal: ["New customers", "Renewals closed", "Site visits", "Demos done", "Collections (₹ lakh)", "Leads called"],
};

const NUMBER_RANGES: [RegExp, number, number][] = [
  [/domain authority|difficulty/i, 8, 92],
  [/followers/i, 2000, 480000],
  [/monthly searches/i, 50, 22000],
  [/position/i, 1, 80],
  [/floor/i, 1, 24],
  [/carpet area/i, 420, 2600],
  [/commission/i, 1, 6],
  [/score/i, 55, 99],
  [/capacity/i, 3, 450],
  [/days/i, 1, 21],
  [/experience/i, 0, 15],
  [/quantity/i, 5, 600],
  [/deals brought/i, 0, 18],
  [/target/i, 40, 400],
  [/achieved/i, 10, 380],
];
const MONEY_RANGES: [RegExp, number, number][] = [
  [/rate per post|fee|day rate|cost$|^cost|monthly cost/i, 2000, 150000],
  [/emd/i, 25000, 500000],
  [/price|value|budget|ctc|amount|subsidy/i, 50000, 5000000],
  [/freight|rate/i, 3000, 90000],
];
function textFor(name: string, i: number): string {
  const n = name.toLowerCase();
  if (/client|customer|company|buyer|end customer|vendor|supplier|transporter|discom|for$/.test(n)) return pick(COMPANIES);
  if (/contact name|contact person|driver$|trainer|approved by|done by|assigned to|from$|buyer/.test(n)) return pick(PEOPLE);
  if (/city|location|to$/.test(n)) return pick(CITIES);
  if (/project/.test(n)) return pick(["Skyline Residency", "Green Acres Phase 2", "Metro Heights", "Lake View Villas"]);
  if (/^site$/.test(n)) return pick(TITLES.Site!);
  if (/tower/.test(n)) return `Tower ${pick(["A", "B", "C"])}`;
  if (/number|serial|part/.test(n)) return `${name.split(" ")[0]!.slice(0, 3).toUpperCase()}-${int(10000, 99999)}`;
  if (/anchor|keyword/.test(n)) return pick(KEYWORDS);
  if (/phone/.test(n)) return `+91 9${int(100000000, 999999999)}`;
  if (/make and model/.test(n)) return pick(["Dell Latitude 5440", "HP ProBook 450", "Lenovo ThinkPad E14", "Apple MacBook Air", "Samsung 24\" monitor"]);
  if (/plan/.test(n)) return pick(["Business", "Pro", "Standard", "Enterprise"]);
  if (/period/.test(n)) return pick(["Oct 2026", "Q2 FY27", "FY 2025-26", "Nov 2026"]);
  if (/payment terms/.test(n)) return pick(["30 days", "50% advance", "45 days", "Against delivery"]);
  if (/products|covers|course|opening|client or|product, batch/.test(n)) return pick(["AutoCAD LT, 10 seats", "Lifts and escalators", "Sales basics", "Site engineer", "Batch 2611-B", "Annual plan"]);
  if (/address/.test(n)) return `${int(1, 220)}, ${pick(["MG Road", "Ring Road", "Station Road", "Industrial Area Phase 2"])}, ${pick(CITIES)}`;
  if (/line or location/.test(n)) return pick(["Line 1", "Line 2", "Packing hall", "Tool room"]);
  if (/strength|weakness|finding|root cause|action|notes|feedback/.test(n)) return pick(SENTENCES);
  return `${name} ${i + 1}`;
}

function valueFor(col: { name: string; kind: string; options: unknown }, i: number, people: string[]): unknown {
  const opts = optionsOf(col.options);
  switch (col.kind) {
    case "TEXT":
      return textFor(col.name, i);
    case "NUMBER": {
      const r = NUMBER_RANGES.find(([re]) => re.test(col.name));
      return r ? int(r[1], r[2]) : int(1, 60);
    }
    case "MONEY": {
      const r = MONEY_RANGES.find(([re]) => re.test(col.name));
      return Math.round((r ? int(r[1], r[2]) : int(5000, 500000)) / 100) * 100;
    }
    case "DATE":
      return /due|till|renews|expires|next|ends|needed by|fix by|valid|publish|go-live|post date|interview|starts|inspection|bid|pre-bid/i.test(col.name) ? day(-10, 75) : day(-80, 0);
    case "SELECT":
      return opts.length ? pick(opts).id : null;
    case "MULTI_SELECT":
      return opts.length ? [...new Set([pick(opts).id, pick(opts).id])] : null;
    case "CHECKBOX":
      return rand() < 0.5 ? true : null;
    case "LINK":
      return `https://${slug(pick(COMPANIES)).slice(0, 18)}.example/${slug(col.name)}-${i + 1}`;
    case "PERSON":
      return people.length ? pick(people) : null;
    case "RATING":
      return int(1, 5);
    case "EMAIL":
      return `${slug(pick(PEOPLE)).replace(/-/g, ".")}@example.com`;
    case "PHONE":
      return `+91 9${int(100000000, 999999999)}`;
    default:
      return null;
  }
}

async function clean(): Promise<number> {
  const old = await db.workbook.findMany({ where: { mode: "ROWS", description: { startsWith: MARK } }, select: { id: true } });
  if (old.length) await db.workbook.deleteMany({ where: { id: { in: old.map((w) => w.id) } } });
  return old.length;
}

async function make(t: ListTemplate, ownerId: string, people: string[]): Promise<number> {
  const id = await createRowList({ userId: ownerId, name: t.name, description: `${MARK} — ${t.description}`, shared: true, template: t });
  const props = await db.workbookProperty.findMany({ where: { workbookId: id }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true, kind: true, options: true } });
  const pool = TITLES[t.titleName] ?? Array.from({ length: ROWS }, (_, i) => `${t.titleName} ${i + 1}`);
  const values: Prisma.WorkbookRowValueCreateManyInput[] = [];
  for (let i = 0; i < ROWS; i++) {
    const title = pool.length >= ROWS ? pool[i]! : `${pool[i % pool.length]}${i >= pool.length ? ` (${Math.floor(i / pool.length) + 1})` : ""}`;
    const row = await db.workbookRow.create({ data: { workbookId: id, title, sortOrder: (i + 1) * 10, createdByUserId: ownerId, createdAt: new Date(Date.now() - int(1, 80) * DAY) }, select: { id: true } });
    for (const p of props) {
      if (rand() < 0.12) continue; // a few cells left empty, as real lists have
      const v = valueFor(p, i, people);
      if (v !== null && v !== undefined) values.push({ workbookId: id, rowId: row.id, propertyId: p.id, value: v as Prisma.InputJsonValue, updatedByUserId: ownerId });
    }
  }
  if (values.length) await db.workbookRowValue.createMany({ data: values });
  return values.length;
}

async function main() {
  if (!(await ownRowsReady())) throw new Error("This workspace doesn't have lists with rows of their own yet — run the migrations first.");
  const removed = await clean();
  if (process.argv.includes("clean")) {
    console.log(`Removed ${removed} sample lists.`);
    return;
  }
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true } });
  const people = (await db.user.findMany({ where: { active: true }, take: 15, orderBy: { name: "asc" }, select: { id: true } })).map((u) => u.id);
  let cells = 0;
  for (const t of LIST_TEMPLATES) cells += await make(t, admin.id, people);
  console.log(`Made ${LIST_TEMPLATES.length} sample lists (one per template), ${LIST_TEMPLATES.length * ROWS} rows, ${cells} cells${removed ? `, replacing ${removed}` : ""}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
