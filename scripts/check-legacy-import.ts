/**
 * check:legacy-import — the old CRM migration (owner, 26 Oct 2026; src/lib/legacy-import):
 *
 *   · reading the export: a ZIP or CSVs, a byte-order mark, quoted fields across lines, the MySQL NULL; each file taken
 *     for its table by its headings (billing and shipping addresses by name); values — days, instants in India time,
 *     "INR 1250.0", "HR" as Haryana, employee bands, statuses;
 *   · on a scratch workspace database (<db>_legacy_check, built from the migrations and dropped at the end), with the
 *     old CRM's columns exactly as its export has them:
 *       – the super admin alone may use it;
 *       – the preview: counts, rows deleted in the old CRM, a row pointing at a customer that isn't there, rows that
 *         meet Deskzo's own company and SKU — which must be decided before importing — and old users matched by email;
 *       – no backup, no import;
 *       – the import: users (matched, or made switched off), products, customers with their head office and custom
 *         fields, addresses, contacts, profilings on prospect companies, leads in their stages, the renewals book with
 *         add-ons and renewals linked, tickets, replies, visits and call logs; Deskzo's own company used, not changed;
 *       – the same files again: nothing twice; "Update existing records" updates, and its undo puts things back;
 *       – undo keeps a company somebody has built on since, and takes back the rest; Replace undoes, then imports;
 *       – the error report and the page.
 *
 *   npm run check:legacy-import
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import Module from "node:module";
import JSZip from "jszip";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

let actorId = "";
let backupOk = true;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { notFound: () => { throw new Error("NOT_FOUND"); }, useRouter: () => ({ push() {}, refresh() {} }) };
  if (request === "@/lib/backup/run" || request.endsWith("lib/backup/run")) {
    return { runBackup: async () => (backupOk ? { ok: true, id: "zz-backup" } : { ok: false, id: null, error: "pg_dump could not be found" }) };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: "ADMIN", name: "Zz Admin", email: `${actorId}@zzlegacy.invalid` } : null);
    return {
      requireUser: async () => {
        const u = await user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: user,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

/** A CSV the way the old CRM writes one: a byte-order mark, its headings, values quoted where they need it. */
const BOM = String.fromCharCode(0xfeff);
function csv(header: string, rows: (string | number)[][]): string {
  const quote = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${BOM}${header}\n${rows.map((r) => r.map(quote).join(",")).join("\n")}\n`;
}

const H = {
  users: `"id","company_id","name","email","phone","avatar","status","verification_code","is_verified","department_id","designation_id","verifiedAt","is_super_admin","createdAt","updatedAt","deletedAt","country_code"`,
  user_role: "user_id,role_id",
  roles: "id,parent_id,label,name,createdAt,updatedAt,deletedAt",
  departments: "id,name,description,status,createdAt,updatedAt,deletedAt",
  designations: "id,department_id,name,description,status,visibility,createdAt,updatedAt,deletedAt",
  brands: "id,name,label,description,status,createdAt,updatedAt,deletedAt",
  categories: "id,name,description,status,createdAt,updatedAt,slug,type,deletedAt,image",
  custom_categories: "id,name,parent_id,icon,type,status,createdAt,updatedAt,deletedAt",
  tags: "id,name,description,createdAt,updatedAt,deletedAt",
  entity_tags: "id,tag_id,entity_id,entity_type,createdAt,updatedAt,deletedAt",
  products: "id,category_id,name,quantity,sku,type,identification_code,display_price,selling_price,image,weight,description,tags,in_stock,status,createdAt,updatedAt,deletedAt,brand_id",
  customers: "id,cust_cat_id,company,customer_type,gst_no,phone,official_email,website,industry_type,specify_other,employee_count,currency,is_admin_company,address,city,state,zipcode,country,source,status,created_by,createdAt,updatedAt,deletedAt,company_type,linkedin_url,anniversary,country_code,tags,cin_number",
  billing: "id,customer_id,address,city,state,country,zipcode,gst_no,status,createdAt,updatedAt,deletedAt",
  shipping: "id,customer_id,address,city,state,country,zipcode,status,gst_no,createdAt,updatedAt,deletedAt",
  employees: "id,customer_id,designation_id,department_id,first_name,last_name,email,phone,is_contact_person,avatar,gender,createdAt,updatedAt,deletedAt,dob,country_code,status",
  profilings: "id,product_id,name,email,phone,mobile_no,address,city,state,country,zipcode,industry_type,specify_other,employee_count,company,department,designation,source,status,assigned_to,assigned_by,fv_assigned_to,fv_assigned_by,created_by,createdAt,updatedAt,deletedAt,company_type,linkedin_url,country_code",
  leads: "id,product_id,name,email,phone,company,address,city,state,country,zipcode,employee_count,value,tags,status,source,designation,department,website,lastContact,assigned_to,assigned_by,fv_assigned_to,fv_assigned_by,created_by,createdAt,updatedAt,deletedAt,company_type,description,reason,bom,linkedin_url,country_code",
  customer_product: "id,parent_id,customer_id,billing_address_id,product_id,quantity,status,start_date,expiry_date,invoice_no,product_type,createdAt,updatedAt,deletedAt,domain_tenant,vendor,description,renewal_id,stage,created_by,reason,payment_terms",
  product_tickets: "id,customer_product_id,customer_id,ticket_no,title,description,reference_ticket,document,status,priority,assigned_to,assigned_by,created_by,creator,createdAt,updatedAt,deletedAt,contact_person_id",
  anonymous_tickets: "id,ticket_no,customer_id,product_id,title,description,document,status,priority,type,assigned_to,assigned_by,created_by,createdAt,updatedAt,deletedAt,contact_person_id",
  replies: "id,ticket_type,ticket_id,replier_type,replier_id,reply,createdAt,updatedAt,deletedAt",
  field_visits: "id,customer_id,lead_id,visit_date,origin,destination,purpose,status,remarks,contact_person_name,contact_person_number,contact_person_email,image,created_by,updated_by,assigned_to,assigned_by,createdAt,updatedAt,deletedAt,coworker_id,country_code,origin_lat,origin_long,destination_lat,destination_long,source",
  call_logs: "id,type,type_id,status,feedback_type,response,remarks,rescheduled_at,reminder_at,reminder_type,called_by,createdAt,updatedAt,deletedAt",
  feedback_links: "id,customer_id,product_id,type,link,status,createdAt,updatedAt,deletedAt",
};

const T = "2025-07-03 15:12:42";

/** The export, as files — customer 1901's website changeable for the update check. */
function exportFiles(website1901 = "https://www.burdaluxury.com/"): Record<string, string> {
  return {
    "users.csv": csv(H.users, [
      [1, 1, "Zz Owner", "owner@zzlegacy.invalid", "9654343424", "", "active", "", 0, 1, 1, "", 1, T, T, "", "+91"],
      [23, 1, "Abhijeet Chaudhary", "abhijeet@oldcrm.invalid", "9000000023", "", "inactive", "", 0, 2, 7, "", 0, T, T, "", "+91"],
      [25, 1, "Abhijeet Singh", "abhijeet.singh@oldcrm.invalid", "9000000025", "", "active", "", 0, 1, 3, "", 0, T, T, "", "+91"],
    ]),
    "user_role.csv": csv(H.user_role, [[23, 6], [25, 9], [23, 6]]),
    "roles.csv": csv(H.roles, [[6, "", "Support Executive", "Support Executive", T, T, ""], [9, "", "Field Sales Manager", "Field Sales Manager", T, T, ""]]),
    "departments.csv": csv(H.departments, [[1, "Sales", "Sales Department", "active", T, T, ""], [2, "Tech Support", "Tech Support", "active", T, T, ""]]),
    "designations.csv": csv(H.designations, [[9, "", "IT Manager", "", "active", "", T, T, ""]]),
    "brands.csv": csv(H.brands, [[1, "Microsoft", "Microsoft", "", "active", T, T, ""]]),
    "categories.csv": csv(H.categories, [[2, "Subscription Software", "Subscription Software", "active", T, T, "", "subscription", "", ""], [13, "Hardware", "Hardware", "active", T, T, "", "regular", "", ""]]),
    "custom_categories.csv": csv(H.custom_categories, [[3, "VIP", "", "", "customer", "active", T, T, ""]]),
    "tags.csv": csv(H.tags, [[3, "Microsoft", "", T, T, ""], [140, "Azure", "", T, T, ""], [7, "Microsoft 365", "", T, T, ""]]),
    "entity_tags.csv": csv(H.entity_tags, [[1, 140, 1813, "customer", T, T, ""], [2, 3, 1813, "customer", T, T, "2026-01-21 12:17:24"], [3, 7, 7440, "profiling", T, T, ""]]),
    "products.csv": csv(H.products, [
      [300, 2, "Microsoft 365 Business Basic", 1, "M365-BASIC-ZZ", "service", "997331", "INR 1100.0", "INR 1250.0", "[]", 0, "annual", "[]", 1, "published", T, T, "", 1],
      [728, 13, "Zz Laptop", 1, "ZZ-LAPTOP-1", "goods", "84713010", "52000", "55,000", "[]", 0, "A laptop", "[]", 1, "published", T, T, "", ""],
      [2, 2, "Deskzo's own SKU", 1, "zz-existing-sku", "service", "997331", "100", "120", "[]", 0, "", "[]", 1, "published", T, T, "", ""],
    ]),
    "customers.csv": csv(H.customers, [
      [1813, 3, "Pan India Consultants Pvt. Ltd.", "", "06AAACP0622N1ZK", "9911631987", "ashishgupta@panindiagroup.com", "https://www.panindiagroup.com/", "information-technology", "", "51-200", "inr", "no", "105, Phase -4, Udyog Vihar", "Gurgaon", "HR", "122015", "IN", "", "active", 1, T, T, "", "private-limited", "", "1985-06-11", "+91", "[\"Microsoft 365\"]", "U74899DL1985PTC021177"],
      [1901, 1, "Burda Media India Pvt. Ltd.", "", "06AABCE0544R1ZH", "8860404433", "arun.salhotra@burda.in", website1901, "media", "", "201-500", "inr", "no", "Ambience Mall", "Gurgaon", "HR", "122002", "IN", "", "active", 1, T, T, "", "private-limited", "", "2002-08-27", "+91", "", "U22110DL2002PTC116720"],
      [1945, "", "Zz Deskzo Already Has Ltd", "", "", "9717075333", "x@zz.invalid", "", "packaging", "", "1001+", "usd", "no", "A-1, Sector-60", "Noida", "UP", "201301", "IN", "", "active", 19, T, T, "", "limited", "", "", "+91", "", "L74899DL1988PLC032166"],
      [9999, "", "Gone Ltd", "", "", "", "gone@zz.invalid", "", "other", "", "", "inr", "no", "", "", "", "", "IN", "", "active", 1, T, T, "2025-09-01 10:00:00", "", "", "", "", "", "U1"],
    ]),
    "billing_addresses.csv": csv(H.billing, [
      [1135, 1813, "105, Phase -4, Udyog Vihar", "Gurgaon", "HR", "IN", "122001", "06AAACP0622N1ZK", "active", T, T, ""],
      [2856, 1813, "809A 3rd Floor, Sector 19, Udyog Vihar Phase 5", "Gurgaon", "HR", "IN", "122015", "", "active", T, T, ""],
    ]),
    "shipping_addresses.csv": csv(H.shipping, [[1, 1813, "105, Phase -4, Udyog Vihar", "Gurgaon", "HR", "IN", "122001", "active", "06AAACP0622N1ZK", T, T, ""]]),
    "employees.csv": csv(H.employees, [
      [10539, 1813, 9, "", "Ashish", "Gupta", "ashishgupta@panindiagroup.com", "9911631987", 1, "", "male", T, T, "", "", "+91", "active"],
      [157, 1813, "", "", "N/A", "", "", "", 1, "", "other", T, T, "", "", "", "active"],
      [289, 1945, "", "", "Mehul", "Jain", "mehul.jain@zz.invalid", "9717075333", 1, "", "other", T, T, "", "", "", "active"],
      [777, 4242, "", "", "Orphan", "Person", "o@zz.invalid", "1", 0, "", "other", T, T, "", "", "", "active"],
      // A live contact of Gone Ltd, which the old CRM deleted: stays behind with it.
      [778, 9999, "", "", "Left", "Behind", "left.behind@zz.invalid", "2", 0, "", "other", T, T, "", "", "", "active"],
    ]),
    "profilings.csv": csv(H.profilings, [
      [7440, "", "Rajesh", "rajesh@zz-newco.invalid", "8851525274", "8851525274", "809-A, Phase V, Udyog Vihar\nGurugram, Haryana 122016", "Gurgaon", "HR", "IN", "122016", "Technology, Information and Media", "", "51-200", "Zz NewCo Profiled Pvt Ltd", "", "Sr. Manager / IT", "Profiling", "unverified", 25, 28, "", "", 1, T, T, "", "private-limited", "", "+91"],
      [7441, "", "Anoop", "", "9812566933", "9812566933", "", "", "", "IN", "", "", "", "", "Pan India Consultants Pvt. Ltd.", "", "IT Manager", "Profiling", "pending", "", "", "", "", 1, T, T, "", "", "", ""],
    ]),
    "leads.csv": csv(H.leads, [
      [415, 300, "Mehul Jain", "mehul.jain@zz.invalid", "8866291551", "Zz Lead Co Limited", "SM-8", "Ahmedabad", "GJ", "IN", "382110", "1001+", 1, "", "won", "old-client", "IT Head", "", "", "", 25, 25, "", "", 25, "2025-06-13 13:07:15", "2025-07-16 12:41:21", "", "limited", "", "", "25,800", "", ""],
      [1883, "", "Arun Dubey", "arun@zz-lost.invalid", "919818601385", "Zz Lost Deal Ltd", "", "Gurgaon", "HR", "IN", "", "51-200", "", "", "loss", "warm-call", "", "", "", "", 25, 25, "", "", 25, T, "2025-09-22 17:00:50", "", "limited", "", "Due to price ", "", "", ""],
      // Contacted, in a pipeline with no Contacted stage (retired before the import): they wait at New, said so.
      [1901, "", "Fola Up", "fola@zz-follow.invalid", "", "Zz Follow Up Ltd", "", "Pune", "MH", "IN", "", "", "", "", "follow-up", "warm-call", "", "", "", "", 25, 25, "", "", 25, T, T, "", "limited", "", "", "", "", ""],
      [1902, "", "Mae Ledone", "mae@zz-mail.invalid", "", "Zz Mail Done Ltd", "", "Pune", "MH", "IN", "", "", "", "", "mail-done", "warm-call", "", "", "", "", 25, 25, "", "", 25, T, T, "", "limited", "", "", "", "", ""],
      [1903, "", "Enid Quiry", "enid@zz-enquiry.invalid", "", "Zz Enquiry Ltd", "", "Pune", "MH", "IN", "", "", "", "", "enquiry-received", "website", "", "", "", "", 25, 25, "", "", 25, T, T, "", "limited", "", "", "", "", ""],
    ]),
    "customer_product.csv": csv(H.customer_product, [
      [1565, "", 1813, 1135, 300, 19, "renewed", "2024-09-11 05:30:00", "2025-09-10 05:30:00", "WTPO24-25613", "fresh", T, T, "", "panindiagrp.onmicrosoft.com", "Ingram Micro India Private Limited", "WT/24-25/676\n", "", "no-action", 1, "", "annual"],
      [7008, "", 1813, "", 300, 19, "active", "2025-09-11 05:30:00", "2026-09-10 05:30:00", "WTPO25-26101", "renewal", T, T, "", "", "Ingram Micro India Private Limited", "WT/25-26/101", 1565, "payment-received", 1, "", "annual"],
      [7018, 7008, 1813, "", 728, 2, "active", "2025-09-11 05:30:00", "2026-09-10 05:30:00", "WTPO25-26102", "addon", T, T, "", "Part Code: CFQ7TTC0HL8W", "Wroffy Technologies Private Limited", "", "", "lost", 1, "due to price ", "3_years"],
      [8000, "", 1813, "", 728, 1, "active", "", "", "WTPO25-26103", "fresh", T, T, "2025-08-08 15:57:25", "", "", "", "", "no-action", "", "", ""],
    ]),
    "product_tickets.csv": csv(H.product_tickets, [
      [140, 7008, 1813, "B1C6F9244B", "spam mail issue", "i have added the dmarc records on the domain", "", "[]", "observation", "medium", 23, 23, 23, "user", "2025-08-28 12:18:30", "2025-08-28 12:18:41", "", ""],
      [141, 7008, 1813, "B1C6F9244C", "closed one", "done", "", "[]", "closed", "high", 23, 23, 99, "user", T, "2025-08-29 10:00:00", "", 10539],
    ]),
    "anonymous_tickets.csv": csv(H.anonymous_tickets, [[872, "DA7C243161", 1813, 300, "need assistance with acrobat", "Kindly help\nEmail: x@zz.invalid", "[null]", "closed", "medium", "demo", 23, 23, 23, T, T, "", ""]]),
    "replies.csv": csv(H.replies, [
      [1, "product", 140, "user", 23, "client will share username", T, T, ""],
      [2, "anonymous", 872, "user", 25, "installation link shared", T, T, ""],
      [3, "product", 999999, "user", 23, "a reply to nothing", T, T, ""],
    ]),
    "field_visits.csv": csv(H.field_visits, [[61, 1813, "", "2025-08-20 05:30:00", "Wroffy", "105, Phase 4", "business", "in-progress", "d", "Ashish Gupta", "9911631987", "ashishgupta@panindiagroup.com", "", 25, 1, "", "", T, T, "", 23, "+91", "", "", "", "", ""]]),
    "call_logs.csv": csv(H.call_logs, [
      [20, "lead", 415, "connected", "negative", "not_interested", "said no", "", "", "", 25, "2025-06-27 16:58:13", T, ""],
      [21, "profiling", 7440, "disconnected", "", "", "Mail done", "2099-01-01 10:00:00", "", "", 25, T, T, ""],
      [22, "customer", 1813, "connected", "positive", "interested", "renewal talk", "", "", "", 1, T, T, ""],
      [23, "product_ticket", 140, "not_reachable", "", "", "", "", "", "", 23, T, T, ""],
    ]),
    "feedback_links.csv": `${BOM}${H.feedback_links}\n`,
    "notes-from-someone.csv": `${BOM}a,b\n1,2\n`,
    // Other tables of the dump with a lookup's few headings: no lookup's by name, so left out.
    "plans.csv": csv("id,name,description,status,createdAt,updatedAt,deletedAt", [[1, "Basic IT Support - Plan 1", "", "active", T, T, ""]]),
    "configurations.csv": csv("id,name,status,createdAt,updatedAt,deletedAt", [[1, "Localization", "active", T, T, ""]]),
  };
}

async function zipOf(files: Record<string, string>) {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(`WroffyCRM/${name}`, text);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const f = require("../src/lib/legacy-import/formats") as typeof import("../src/lib/legacy-import/formats");
  const files = require("../src/lib/legacy-import/files") as typeof import("../src/lib/legacy-import/files");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("Reading the export");
  const parsed = files.parseCsv("employees.csv", csv("id,name,notes", [[1, "A", "line one\nline two, with a comma"], [2, "NULL", 'say "hi"']]));
  ok("a byte-order mark dropped, a quoted field across lines kept, quotes unescaped", parsed.headers[0] === "id" && parsed.rows[0]!.notes === "line one\nline two, with a comma" && parsed.rows[1]!.notes === 'say "hi"', parsed.rows);
  ok("  the dump's NULL read as empty", f.clean(parsed.rows[1]!.name!) === "");
  let refused = "";
  try {
    files.parseCsv("x.csv", "a,b,A\n1,2,3\n");
  } catch (e) {
    refused = (e as Error).message;
  }
  ok("a heading twice is refused", /twice/.test(refused), refused);
  const all = exportFiles();
  const read = await files.readUpload([{ name: "wroffycrm.zip", bytes: await zipOf(all) }]);
  ok("a ZIP's CSVs, folders flattened", read.length === Object.keys(all).length && read.some((r) => r.name === "customers.csv"), read.map((r) => r.name));
  let bad = "";
  try {
    await files.readUpload([{ name: "notes.txt", bytes: Buffer.from("x") }]);
  } catch (e) {
    bad = (e as Error).message;
  }
  ok("  anything but a .csv or .zip refused", /isn't a .csv or a .zip/.test(bad), bad);
  const detected = Object.fromEntries(read.map((r) => [r.name, f.detectKind(r.headers, r.name)]));
  ok(
    "each file taken for its table by its headings",
    detected["customers.csv"] === "customers" && detected["profilings.csv"] === "profilings" && detected["leads.csv"] === "leads" && detected["customer_product.csv"] === "customer_product" && detected["users.csv"] === "users" && detected["call_logs.csv"] === "call_logs" && detected["notes-from-someone.csv"] === null,
    detected,
  );
  ok("  billing and shipping addresses, which share headings, by name", detected["billing_addresses.csv"] === "billing_addresses" && detected["shipping_addresses.csv"] === "shipping_addresses");
  ok("  and a renamed file still by its headings", f.detectKind(read.find((r) => r.name === "customers.csv")!.headers, "export_7.csv") === "customers");
  ok(
    "a lookup table only by its own name: plans and settings with its headings left out, departments still found",
    detected["plans.csv"] === null && detected["configurations.csv"] === null && detected["departments.csv"] === "departments",
    detected,
  );

  section("Values");
  ok("an old timestamp is India time", f.oldInstant("2025-07-03 15:12:42")?.toISOString() === "2025-07-03T09:42:42.000Z");
  ok("  a licence date (05:30) is its day", f.oldDay("2025-06-23 05:30:00")?.toISOString() === "2025-06-23T00:00:00.000Z");
  // Opened and saved in Excel (owner, 30 Oct 2026): day first, the time by a dot.
  ok("  as Excel saves it — 26-05-2025 17.26 — the same India time", f.oldInstant("26-05-2025 17.26")?.toISOString() === "2025-05-26T11:56:00.000Z", f.oldInstant("26-05-2025 17.26"));
  ok("  by a colon, with seconds and PM", f.oldInstant("03/06/2025 05:51:10 PM")?.toISOString() === "2025-06-03T12:21:10.000Z" && f.oldInstant("03/06/2025 12:05 AM")?.toISOString() === "2025-06-02T18:35:00.000Z");
  ok("  its day is its day", f.oldDay("26-05-2025 17.26")?.toISOString() === "2025-05-26T00:00:00.000Z");
  ok("  a month past 12, or a day that isn't, reads as nothing", f.oldInstant("13-13-2025 17.26") === null && f.oldDay("31-02-2025") === null);
  ok("money: INR 1250.0, 25,800, empty", f.money("INR 1250.0") === 1250 && f.money("25,800") === 25800 && f.money("") === null);
  ok("states: HR is Haryana in India, 10 stays 10 in Thailand", f.stateName("HR", "IN") === "Haryana" && f.stateName("10", "TH") === "10");
  ok("statuses: won, loss, quotation-shared; observation is on hold", f.LEAD_STATUS.won === "WON" && f.LEAD_STATUS.loss === "LOST" && f.LEAD_STATUS["quotation-shared"] === "PROPOSAL_SENT" && f.TICKET_STATUS.observation === "ON_HOLD");
  ok("a subscription category's product is a subscription; goods are goods", f.itemType("service", "subscription") === "SUBSCRIPTION" && f.itemType("goods", "regular") === "GOOD" && f.itemType("service", "regular") === "SERVICE");
  ok("job titles read as designations", f.designationKind("AGM (Information Technology)") === "IT_HEAD" && f.designationKind("IT Manager") === "IT_MANAGER" && f.designationKind("Founder & CEO") === "CEO" && f.designationKind("Lead HR Specialist") === "HR");
  // Phones with their row's country_code (owner, 27 Oct 2026): "+91", "91" or blank, and numbers that carry their own.
  const phones: [string, string, string | null][] = [
    ["9876543210", "+91", "+91 9876543210"],
    ["98765 43210", "91", "+91 98765 43210"],
    ["919876543210", "91", "+91 9876543210"],
    ["09876543210", "+91", "+91 9876543210"],
    ["501234567", "+971", "+971 501234567"],
    ["+44 20 7946 0958", "+91", "+44 20 7946 0958"],
    ["9876543210", "", "+91 9876543210"],
    ["NULL", "+91", null],
  ];
  const misread = phones.filter(([p, c, want]) => f.oldPhone(p, c) !== want).map(([p, c]) => `${p} (${c || "no code"}) → ${f.oldPhone(p, c)}`);
  ok("phones take their row's country code — +91, 91, +971, none — and keep one they carry", misread.length === 0, misread.join("; "));
  ok("  a file uploaded before country_code was read has it read now", (f.kindDef("employees")?.columns ?? []).includes("country_code") && f.defaultMapping("employees", ["id", "country_code", "phone"]).country_code === "country_code");

  masterRules();
  await scratch(read);
}

function masterRules() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const m = require("../src/lib/legacy-import/master") as typeof import("../src/lib/legacy-import/master");
  /* eslint-enable @typescript-eslint/no-require-imports */
  type Party = import("../src/lib/legacy-import/master").Party;
  const p = (id: string, name: string, gstin = "", email = "", phone = ""): Party => ({ id, name, label: name, gstins: gstin ? [gstin] : [], emails: [email], phones: [phone] });

  section("Master lists: matching");
  ok("names read loosely: Pvt. Ltd. and Private Limited alike, & as and", m.looseName("Burda Media India Pvt. Ltd.") === m.looseName("BURDA MEDIA INDIA PRIVATE LIMITED") && m.looseName("Credent Solutions & Services") === m.looseName("Credent Solutions and Services"));
  ok("a GSTIN read through spaces and a line break; a wrong one is none", m.gstinOf(" 07AABCC4077F1ZU\n") === "07AABCC4077F1ZU" && m.gstinOf("07AABCC4077F1Z") === null);
  ok("a mailbox provider's domain is no evidence; a company's is", m.domainOf("x@gmail.com") === null && m.domainOf("a@intech.org") === "intech.org");
  ok("Excel's rounded ids are spotted", m.roundedId("8.80908E+17") && !m.roundedId("880908000000095122"));
  const zoho = [
    p("z1", "Intech Online pvt ltd", "27AABCK3805B1Z2", "amit@intech.org", "9821102028"),
    p("z2", "Ingram Micro India Private Limited", "07AABCT1296R1ZP"),
    p("z3", "Redington Limited", "06AABCR0347P1Z7"),
    p("z4", "Burda Media India Pvt Ltd"),
    p("z5", "Zeta Exports", "", "sales@zeta-exports.in"),
    p("z6", "Teengage"),
    p("z7", "Acme Widgets Private Limited"),
  ];
  const old = [
    p("1", "Intech Online Pvt. Ltd.", "27AABCK3805B1Z2"),
    p("2", "Intech Organics Limited", "06AAACI9363D1ZO", "", "9821102028"),
    p("3", "Ingram Micro India Pvt Ltd", "29AABCT1296R1ZX"),
    p("4", "BURDA MEDIA INDIA PRIVATE LIMITED"),
    p("5", "Zeta Exports Pvt Ltd (old)", "", "ravi@zeta-exports.in"),
    p("6", "Acme Widget Private Limited"),
    p("7", "Nobody In Zoho"),
  ];
  const pairs = m.matchCompanies(zoho, old);
  const of = (oldId: string) => pairs.find((x) => x.oldId === oldId);
  ok("the same GSTIN: matched", of("1")?.status === "MATCHED" && of("1")?.zohoId === "z1" && of("1")?.reason === "Same GSTIN");
  ok("the same PAN in another state: matched as a branch", of("3")?.status === "MATCHED" && of("3")?.zohoId === "z2" && /branch/.test(of("3")!.reason));
  ok("the same name, Pvt Ltd and Private Limited aside: matched", of("4")?.status === "MATCHED" && of("4")?.zohoId === "z4" && of("4")?.reason === "Same name");
  ok("a shared email domain: only suggested", of("5")?.status === "SUGGESTED" && of("5")?.zohoId === "z5" && /email domain \(zeta-exports\.in\)/.test(of("5")!.reason));
  ok("a similar name: only suggested", of("6")?.status === "SUGGESTED" && of("6")?.zohoId === "z7" && /Similar name/.test(of("6")!.reason));
  ok("a phone shared with a Zoho record GSTIN already claimed: no suggestion", of("2")?.status === "OLD_ONLY");
  ok("the rest alone, on each side", of("7")?.status === "OLD_ONLY" && pairs.some((x) => x.zohoId === "z3" && x.status === "ZOHO_ONLY") && pairs.some((x) => x.zohoId === "z6" && x.status === "ZOHO_ONLY"));
  const twice = m.matchCompanies([p("a", "Compuage Infocom Ltd", "07AABCC4077F1ZU"), p("b", "Compuage Infocom Limited", "07AABCC4077F1ZU")], [p("9", "Compuage Infocom Ltd", "07AABCC4077F1ZU")]);
  ok("a GSTIN Zoho has twice: suggested, toward the nearest name", twice.find((x) => x.oldId === "9")?.status === "SUGGESTED" && twice.find((x) => x.oldId === "9")?.zohoId === "a");

  const items = m.matchProducts(
    [{ ...p("i1", "Microsoft 365 Business Basic"), sku: "M365BB" }, p("i2", "Logo Change"), p("i3", "FortiGate-50E"), p("i4", "FortiGate 50E")],
    [{ ...p("100", "M365 Basic (annual)"), sku: "m365bb" }, p("101", "logo change"), p("102", "Fortigate 50E"), p("103", "Something else")],
  );
  const item = (id: string) => items.find((x) => x.oldId === id);
  ok("products: the same SKU, any case; else the same name", item("100")?.zohoId === "i1" && item("100")?.reason === "Same SKU" && item("101")?.zohoId === "i2" && item("101")?.reason === "Same name");
  ok("  a name Zoho has twice: suggested", item("102")?.status === "SUGGESTED");
  ok("  nothing alike: alone", item("103")?.status === "OLD_ONLY");

  const people = m.matchContacts(
    [p("c1", "Amit Bhatnagar", "", "amit@intech.org"), p("c2", "Ravi", "", "", "+91 98100 00001"), p("c3", "Pankaj")],
    [p("e1", "Amit B", "", "AMIT@intech.org"), p("e2", "Ravi Kumar", "", "", "9810000001"), p("e3", "pankaj"), p("e4", "Someone")],
  );
  const person = (id: string) => people.find((x) => x.oldId === id);
  ok("contacts: the same email, any case; else the same mobile", person("e1")?.zohoId === "c1" && person("e1")?.reason === "Same email" && person("e2")?.zohoId === "c2" && person("e2")?.reason === "Same mobile");
  ok("  the same name only: matched, flagged for a look", person("e3")?.zohoId === "c3" && person("e3")?.flagged === true);
  ok("  the rest alone", person("e4")?.status === "OLD_ONLY");
}

async function scratch(read: import("../src/lib/legacy-import/files").ReadFile[]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is needed.");
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("Only against a local database server.");
  const scratchName = `${new URL(url).pathname.slice(1)}_legacy_check`;
  const scratchUrl = withDatabase(url, scratchName);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });

  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from its migrations", true);
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = " ";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    await workspace(read);
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${scratchName}`;
    ok("the scratch workspace is dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }
}

async function workspace(read: import("../src/lib/legacy-import/files").ReadFile[]) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const actions = require("../src/actions/legacy-import") as typeof import("../src/actions/legacy-import");
  const store = require("../src/lib/legacy-import/store") as typeof import("../src/lib/legacy-import/store");
  const files = require("../src/lib/legacy-import/files") as typeof import("../src/lib/legacy-import/files");
  const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
  const { default: Page } = require("../src/app/(dashboard)/settings/data/old-crm/page") as typeof import("../src/app/(dashboard)/settings/data/old-crm/page");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const refusal = (r: { ok: boolean }) => (r.ok ? "" : (r as unknown as { error: string }).error);

  const sa = await db.user.create({ data: { name: "Zz Super", email: "super@zzlegacy.invalid", role: "ADMIN", isSuperAdmin: true, passwordHash: "x".repeat(60) }, select: { id: true } });
  const otherAdmin = await db.user.create({ data: { name: "Zz Admin", email: "admin@zzlegacy.invalid", role: "ADMIN", passwordHash: "x".repeat(60) }, select: { id: true } });
  const existingUser = await db.user.create({ data: { name: "Owner Here", email: "owner@zzlegacy.invalid", role: "SALES", passwordHash: "x".repeat(60) }, select: { id: true } });
  await db.organisationSettings.upsert({ where: { id: "global" }, create: { id: "global", legalName: "Wroffy Technologies Private Limited" }, update: { legalName: "Wroffy Technologies Private Limited" } });
  // What Deskzo already had, typed in by hand: a company of an old customer's name, a contact of an old contact's email, an item of an old SKU.
  const handCompany = await db.company.create({ data: { name: "Zz Deskzo Already Has Ltd", normalizedName: "zz deskzo already has ltd", createdById: sa.id, website: "https://kept.invalid" }, select: { id: true } });
  const handContact = await db.contact.create({ data: { companyId: handCompany.id, name: "Mehul (typed)", email: "MEHUL.JAIN@zz.invalid" }, select: { id: true } });
  const handItem = await db.item.create({ data: { name: "Typed item", sku: "ZZ-EXISTING-SKU", type: "SERVICE", sellingPrice: 99, createdById: sa.id }, select: { id: true } });

  section("Who may");
  actorId = otherAdmin.id;
  const draft0 = await store.addFiles(read, sa.id);
  ok("an admin who isn't the super admin is refused", /super admin/.test(refusal(await actions.analyseLegacyImport(draft0.id))));
  let notFound = false;
  try {
    await renderHtml(Page());
  } catch (e) {
    notFound = (e as Error).message === "NOT_FOUND";
  }
  ok("  and the page isn't there for them", notFound);
  actorId = sa.id;

  section("The preview");
  ok("the upload became a draft with every file", draft0.files.length === read.length && draft0.files.find((x) => x.name === "notes-from-someone.csv")?.kind === null);
  const a = await actions.analyseLegacyImport(draft0.id);
  if (!a.ok) throw new Error(a.error);
  const k = (kind: string) => a.data.kinds.find((x) => x.kind === kind)!;
  ok("customers: 2 new, 1 Deskzo already has, 1 deleted in the old CRM", k("customers").fresh === 2 && k("customers").matches === 1 && k("customers").deleted === 1, k("customers"));
  ok("products: 2 new, 1 meets Deskzo's SKU (case aside)", k("products").fresh === 2 && k("products").matches === 1, k("products"));
  ok("contacts: the one pointing at a customer that isn't there can't come in, and why", k("employees").problemRows === 1 && /customers 4242/.test(k("employees").problems[0]?.message ?? ""), k("employees").problems);
  ok("  the contact Deskzo already has at its company is a match", k("employees").matches === 1, k("employees"));
  ok(
    "  the one whose customer the old CRM deleted stays behind with it, said so, not a problem",
    k("employees").deleted === 2 && k("employees").warnings.some((w) => /1 row\(s\) point at customers the old CRM deleted/.test(w)) && !k("employees").problems.some((p) => /9999/.test(p.message)),
    k("employees"),
  );
  ok("a reply to a ticket that isn't there can't come in", k("replies").problemRows === 1);
  ok("deciding is needed for customers and products", JSON.stringify(a.data.needsDecision.sort()) === JSON.stringify(["customers", "employees", "products"]), a.data.needsDecision);
  ok("old users: matched by email, the rest to be created", a.data.users.find((u) => u.oldId === "1")?.match?.id === existingUser.id && a.data.users.find((u) => u.oldId === "23")?.match === null && a.data.users.find((u) => u.oldId === "23")?.roles.join() === "Support Executive");
  ok("  a ticket by an old user not in the users file is warned about", k("product_tickets").warnings.some((w) => /99/.test(w)), k("product_tickets").warnings);
  ok("files that aren't old CRM tables are listed as left out", a.data.unknownFiles.includes("notes-from-someone.csv"));
  ok("nothing was written by previewing", (await db.company.count()) === 1 && (await db.legacyImportRecord.count()) === 0);

  section("Starting");
  ok("without deciding about the matches: refused", /Choose what to do/.test(refusal(await actions.startLegacyImport(draft0.id, { strategy: "NEW", decisions: {}, confirmed: true }))));
  const decisions = { matches: { customers: "link" as const, products: "link" as const, employees: "link" as const } };
  ok("  without confirming: refused", /Confirm/.test(refusal(await actions.startLegacyImport(draft0.id, { strategy: "NEW", decisions, confirmed: false }))));
  backupOk = false;
  const noBackup = await actions.startLegacyImport(draft0.id, { strategy: "NEW", decisions, confirmed: true });
  ok("no backup, no import", /backup couldn't be taken/.test(refusal(noBackup)) && (await db.legacyImport.findUnique({ where: { id: draft0.id } }))?.status === "DRAFT", refusal(noBackup));
  backupOk = true;
  // The workspace's own pipeline without a Contacted stage, as a real one may be.
  await db.leadStage.updateMany({ where: { pipelineId: "lpip_sales", status: "CONTACTED" }, data: { archivedAt: new Date() } });
  const started = await actions.startLegacyImport(draft0.id, { strategy: "NEW", decisions, confirmed: true });
  ok("with a backup: started, the backup noted", started.ok && (await db.legacyImport.findUnique({ where: { id: draft0.id } }))?.backupId === "zz-backup", started);

  const runToEnd = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const r = await actions.stepLegacyImport(id);
      if (!r.ok) throw new Error(r.error);
      if (r.data.status !== "IMPORTING") return r.data;
    }
    throw new Error("didn't finish");
  };
  const done = await runToEnd(draft0.id);
  ok("it runs to the end", done.status === "DONE", done.progress.failure);
  const counts = done.progress.counts;

  section("What came in");
  const users = await db.user.findMany({ where: { email: { in: ["abhijeet@oldcrm.invalid", "abhijeet.singh@oldcrm.invalid"] } }, select: { active: true, role: true } });
  ok("old users not in Deskzo: created switched off, the one there used", users.length === 2 && users.every((u) => !u.active) && counts.users?.linked === 1, users);
  const pan = await db.company.findUnique({ where: { normalizedName: "pan india consultants pvt. ltd." }, select: { id: true, stage: true, tags: true, panNumber: true, customFields: true, employeeCount: true, createdById: true, industry: { select: { name: true } }, customerCategoryId: true, locations: { select: { label: true, state: true, gstNumber: true, isPrimary: true, isBilling: true, isShipping: true } } } });
  const cf = (pan?.customFields ?? {}) as Record<string, string>;
  ok("a customer: a customer company, its industry, PAN from the GSTIN, its live tags", pan?.stage === "CUSTOMER" && pan.industry?.name === "Information Technology" && pan.panNumber === "AAACP0622N" && JSON.stringify(pan.tags.sort()) === JSON.stringify(["Azure", "Microsoft 365", "Profiling"].sort()), pan);
  ok("  the CIN, incorporation date and old id in custom fields", cf.cin === "U74899DL1985PTC021177" && cf.incorporated_on === "1985-06-11" && cf.oldcrm_id === "1813", cf);
  ok("  made by the old user, now a Deskzo user", pan?.createdById === existingUser.id);
  const office = pan?.locations.find((l) => l.label === "Head office");
  ok("  its head office in Haryana, also its billing and shipping address (the same address)", office?.state === "Haryana" && office.isPrimary && office.isBilling && office.isShipping && pan!.locations.filter((l) => l.isBilling).length === 2, pan?.locations);
  const kept = await db.company.findUnique({ where: { id: handCompany.id }, select: { website: true, stage: true } });
  ok("Deskzo's own company of the same name: used, not changed", kept?.website === "https://kept.invalid" && kept.stage === "PROSPECT");
  ok("  its old contact matched the typed one, not doubled", (await db.contact.count({ where: { companyId: handCompany.id } })) === 1 && (await db.legacyImportRecord.findFirst({ where: { kind: "employees", oldId: "289" } }))?.recordId === handContact.id);
  ok("the placeholder N/A contact left out; the real one in, primary, with its designation", (await db.contact.findFirst({ where: { companyId: pan!.id, email: "ashishgupta@panindiagroup.com" }, select: { isPrimary: true, designation: true } }))?.designation === "IT_MANAGER" && counts.employees?.skipped === 2);
  ok("  the contact of the deleted customer skipped with it, never made", (await db.contact.count({ where: { email: "left.behind@zz.invalid" } })) === 0);
  const item = await db.item.findFirst({ where: { sku: "M365-BASIC-ZZ" }, select: { type: true, sellingPrice: true, billingCycle: true, brand: { select: { name: true } }, category: true, hsnCode: true } });
  ok("products: a subscription at its selling price, brand and category", item?.type === "SUBSCRIPTION" && Number(item.sellingPrice) === 1250 && item.billingCycle === "ANNUAL" && item.brand?.name === "Microsoft" && item.category === "Subscription Software" && item.hsnCode === "997331", item);
  ok("  Deskzo's own SKU used, not changed", (await db.item.findUnique({ where: { id: handItem.id }, select: { name: true } }))?.name === "Typed item" && (await db.legacyImportRecord.findFirst({ where: { kind: "products", oldId: "2" } }))?.recordId === handItem.id);
  const prospect = await db.company.findUnique({ where: { normalizedName: "zz newco profiled pvt ltd" }, select: { id: true, stage: true, tags: true, ownerUserId: true, contacts: { select: { name: true, customFields: true } } } });
  ok("a profiling: a contact on a new prospect company, tagged Profiling and its own tags, owned by its old assignee", prospect?.stage === "PROSPECT" && prospect.tags.includes("Profiling") && prospect.tags.includes("Microsoft 365") && (prospect.contacts[0]?.customFields as Record<string, string>)?.job_title === "Sr. Manager / IT", prospect);
  ok("  a profiling at a customer's company goes on that company", (await db.contact.count({ where: { companyId: pan!.id, name: "Anoop" } })) === 1);
  const won = await db.lead.findFirst({ where: { externalId: "oldcrm:415" }, select: { status: true, estimatedValue: true, source: true, sourceDetail: true, stage: { select: { status: true } }, requirements: { select: { item: { select: { sku: true } } } }, title: true, company: { select: { stage: true } } } });
  ok("a won lead: in a won stage, its BOM as value, an existing-customer source, its product", won?.status === "WON" && won.stage?.status === "WON" && Number(won.estimatedValue) === 25800 && won.source === "EXISTING_CUSTOMER" && won.sourceDetail === "old-client" && won.requirements[0]?.item.sku === "M365-BASIC-ZZ" && won.title.startsWith("Microsoft 365 Business Basic"), won);
  const lost = await db.lead.findFirst({ where: { externalId: "oldcrm:1883" }, select: { status: true, lostReason: true, source: true } });
  ok("  a lost one with its reason, a calling source", lost?.status === "LOST" && lost.lostReason === "Due to price" && lost.source === "CALLING", lost);
  const waiting = await db.lead.findMany({ where: { externalId: { in: ["oldcrm:1901", "oldcrm:1902", "oldcrm:1903"] } }, select: { externalId: true, status: true, stage: { select: { status: true } } } });
  ok(
    "follow-up and mail-done mean contacted; with no Contacted stage they came in at New, its stage New too; an enquiry is New",
    waiting.length === 3 && waiting.every((l) => l.status === "NEW" && l.stage?.status === "NEW"),
    waiting,
  );
  const first = await db.legacyImportRecord.findFirst({ where: { kind: "customer_product", oldId: "1565" }, select: { recordId: true } });
  const renewal = await db.companyProduct.findFirst({ where: { ourPoNumber: "WTPO25-26101" }, select: { id: true, orderStatus: true, businessType: true, renewedFromId: true, startDate: true, endDate: true, vendorId: true, location: { select: { label: true } } } });
  ok("the renewals book: fulfilled orders, the renewal linked to the order it renewed, its dates as days", renewal?.orderStatus === "FULFILLED" && renewal.businessType === "RENEWAL" && renewal.renewedFromId === first?.recordId && renewal.endDate?.toISOString().slice(0, 10) === "2026-09-10", renewal);
  const fresh = await db.companyProduct.findUnique({ where: { id: first!.recordId }, select: { location: { select: { gstNumber: true } }, vendor: { select: { name: true, relationshipType: true } }, customFields: true } });
  ok("  booked to its billing address, bought from the distributor (made a vendor), its tenant kept", fresh?.location.gstNumber === "06AAACP0622N1ZK" && fresh.vendor?.name === "Ingram Micro India Private Limited" && fresh.vendor.relationshipType === "VENDOR" && (fresh.customFields as Record<string, string>).tenant_domain === "panindiagrp.onmicrosoft.com", fresh);
  const addon = await db.companyProduct.findFirst({ where: { ourPoNumber: "WTPO25-26102" }, select: { parentId: true, vendorId: true, renewalStage: true, renewalStageNote: true, notes: true } });
  ok("  an add-on under its parent; our own company never a vendor; lost with its reason", addon?.parentId === renewal?.id && addon?.vendorId === null && addon?.renewalStage === "LOST" && addon.renewalStageNote === "due to price" && /Part Code/.test(addon.notes ?? ""), addon);
  ok("  the deleted one left behind", (await db.companyProduct.count({ where: { ourPoNumber: "WTPO25-26103" } })) === 0);
  const ticket = await db.ticket.findFirst({ where: { title: "spam mail issue" }, select: { status: true, companyProductId: true, description: true, comments: { select: { body: true } } } });
  ok("a product ticket on its order, observation as on hold with the old status and number said, its reply", ticket?.status === "ON_HOLD" && ticket.companyProductId === renewal?.id && /B1C6F9244B/.test(ticket.description ?? "") && /observation/.test(ticket.description ?? "") && ticket.comments[0]?.body === "client will share username", ticket);
  const closed = await db.ticket.findFirst({ where: { title: "closed one" }, select: { status: true, closedAt: true, contact: { select: { email: true } } } });
  ok("  a closed one, closed on its last update, its contact", closed?.status === "CLOSED" && closed.closedAt?.toISOString() === "2025-08-29T04:30:00.000Z" && closed.contact?.email === "ashishgupta@panindiagroup.com", closed);
  ok("an other ticket as a demo, its product said", (await db.ticket.findFirst({ where: { title: "need assistance with acrobat" }, select: { ticketType: true, description: true } }))?.ticketType === "DEMO");
  const visit = await db.visit.findFirst({ select: { status: true, agenda: true, contact: { select: { email: true } } } });
  ok("a field visit: done, from where, with whom, its contact matched", visit?.status === "COMPLETED" && /From Wroffy/.test(visit.agenda ?? "") && /Abhijeet Chaudhary/.test(visit.agenda ?? "") && visit.contact?.email === "ashishgupta@panindiagroup.com", visit);
  const calls = await db.callLog.findMany({ select: { leadId: true, contactId: true, ticketId: true, outcome: true, notes: true, followUpDone: true } });
  ok("call logs: on the lead, the profiled contact, the company and the ticket", calls.length === 4 && calls.some((c) => c.leadId && c.notes === "said no (negative, not interested)") && calls.some((c) => c.contactId && c.outcome === "NO_ANSWER" && c.followUpDone === false) && calls.some((c) => c.ticketId && c.outcome === "SWITCHED_OFF"), calls);
  ok("the custom fields it needed, made once", (await db.customFieldDefinition.count({ where: { key: "cin" } })) === 1);

  section("The error report");
  const report = await actions.legacyErrorReport(draft0.id);
  ok("the rows that didn't come in, with file, line and why", report.ok && report.data.count >= 2 && /employees\.csv/.test(report.data.csv) && /4242/.test(report.data.csv) && /999999/.test(report.data.csv), report.ok ? report.data.csv : report);
  ok("  a row left behind with its deleted customer isn't an error", report.ok && !/\(9999\)/.test(report.data.csv), report.ok ? report.data.csv : report);
  const lines = report.ok ? report.data.csv.split("\n") : [];
  const lineOf = (id: string) => lines.find((l) => l.includes(`"leads.csv"`) && l.includes(`"${id}"`)) ?? "";
  ok(
    "  the two contacted leads say which stage they came in at; mail-done and an enquiry aren't unknown statuses",
    /no Contacted stage; it came in at/.test(lineOf("1901")) && /no Contacted stage; it came in at/.test(lineOf("1902")) && !/isn't one the tool knows/.test(lineOf("1902")) && lineOf("1903") === "",
    [lineOf("1901"), lineOf("1902"), lineOf("1903")],
  );

  section("A lead's company by name, after merges");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { companyByName } = require("../src/lib/legacy-import/apply") as typeof import("../src/lib/legacy-import/apply");
  const legal = await db.company.create({ data: { name: "Zz Legal Form Private Limited", normalizedName: "zz legal form private limited", createdById: sa.id }, select: { id: true } });
  const stayed = await db.company.create({ data: { name: "Zz Stayed Ltd", normalizedName: "zz stayed ltd", formerNames: "Zz Went Away Pvt Ltd", createdById: sa.id }, select: { id: true } });
  const twinA = await db.company.create({ data: { name: "Zz Twin Pvt Ltd", normalizedName: "zz twin pvt ltd", createdById: sa.id }, select: { id: true } });
  const twinB = await db.company.create({ data: { name: "Zz Twin Private Ltd", normalizedName: "zz twin private ltd", createdById: sa.id }, select: { id: true } });
  const by = (n: string) => companyByName(db as never, n).then((c) => c?.id ?? null);
  ok("a lead naming \"Pvt. Ltd.\" finds the customer kept as \"Private Limited\"", (await by("Zz Legal Form Pvt. Ltd.")) === legal.id);
  ok("  one naming a duplicate merged away finds the customer it was merged into", (await by("Zz Went Away Private Limited")) === stayed.id);
  ok("  two with the same legal name: neither guessed — a new prospect, as before", (await by("Zz Twin (P) Ltd")) === null);
  await db.company.deleteMany({ where: { id: { in: [legal.id, stayed.id, twinA.id, twinB.id] } } });

  section("The same files again");
  const draft1 = await store.addFiles(read, sa.id);
  const again = await actions.analyseLegacyImport(draft1.id);
  ok("the preview: everything came in before, nothing new", again.ok && again.data.kinds.find((x) => x.kind === "customers")!.imported === 3 && again.data.kinds.filter((x) => x.role === "records").every((x) => x.fresh === 0), again.ok ? again.data.kinds.map((x) => `${x.kind}:${x.fresh}`) : again);
  const before = { companies: await db.company.count(), contacts: await db.contact.count(), orders: await db.companyProduct.count(), calls: await db.callLog.count() };
  await actions.startLegacyImport(draft1.id, { strategy: "NEW", decisions, confirmed: true });
  await runToEnd(draft1.id);
  ok("importing it: not one record twice", JSON.stringify(before) === JSON.stringify({ companies: await db.company.count(), contacts: await db.contact.count(), orders: await db.companyProduct.count(), calls: await db.callLog.count() }), before);

  section("Updating");
  const changed = await files.readUpload([{ name: "customers.csv", bytes: Buffer.from(exportFiles("https://burda.example")["customers.csv"]!) }]);
  const lookupFiles = read.filter((r) => ["users.csv", "custom_categories.csv", "tags.csv", "entity_tags.csv"].includes(r.name));
  const draft2 = await store.addFiles([...changed, ...lookupFiles], sa.id);
  await actions.analyseLegacyImport(draft2.id);
  await actions.startLegacyImport(draft2.id, { strategy: "UPDATE", decisions, confirmed: true });
  const updated = await runToEnd(draft2.id);
  const burda = await db.company.findUnique({ where: { normalizedName: "burda media india pvt. ltd." }, select: { website: true } });
  ok("Update: an imported company takes the file's new value; Deskzo's own is still untouched", burda?.website === "https://burda.example" && updated.progress.counts.customers?.updated === 2 && (await db.company.findUnique({ where: { id: handCompany.id }, select: { website: true } }))?.website === "https://kept.invalid", updated.progress.counts.customers);
  const undoUpdate = await actions.undoLegacyImport(draft2.id, "undo");
  ok("  undoing that update puts the old value back, and deletes nothing", undoUpdate.ok && undoUpdate.data.done && (await db.company.findUnique({ where: { normalizedName: "burda media india pvt. ltd." }, select: { website: true } }))?.website === "https://www.burdaluxury.com/" && (await db.company.count()) === before.companies, undoUpdate);
  ok("  and the records are the first import's again", (await db.legacyImportRecord.findFirst({ where: { kind: "customers", oldId: "1901" }, select: { importId: true, action: true } }))?.importId === draft0.id);

  section("Undo");
  ok("undo needs UNDO typed", /Type UNDO/.test(refusal(await actions.undoLegacyImport(draft0.id, "yes"))));
  // Somebody has since built on an imported company in Deskzo: a lead typed in by hand.
  await db.lead.create({ data: { companyId: pan!.id, title: "Typed after the import" } });
  let undone: Awaited<ReturnType<typeof actions.undoLegacyImport>> | null = null;
  for (let i = 0; i < 50; i++) {
    undone = await actions.undoLegacyImport(draft0.id, "UNDO");
    if (!undone.ok || undone.data.done) break;
  }
  ok("the import taken back: the company built on is kept, and said so", undone?.ok === true && undone.data.done && undone.data.kept >= 1 && !!(await db.company.findUnique({ where: { id: pan!.id } })), undone);
  ok("  everything else it made is gone", (await db.companyProduct.count()) === 0 && (await db.callLog.count()) === 0 && (await db.ticket.count()) === 0 && !(await db.company.findUnique({ where: { normalizedName: "zz newco profiled pvt ltd" } })) && (await db.lead.count({ where: { externalId: { not: null } } })) === 0);
  ok("  the switched-off users it made gone, the matched one and Deskzo's own records still there", (await db.user.count({ where: { email: { endsWith: "@oldcrm.invalid" } } })) === 0 && !!(await db.user.findUnique({ where: { id: existingUser.id } })) && !!(await db.item.findUnique({ where: { id: handItem.id } })) && !!(await db.contact.findUnique({ where: { id: handContact.id } })));
  ok("  the custom fields retired, not deleted", (await db.customFieldDefinition.findFirst({ where: { key: "cin" }, select: { archivedAt: true } }))?.archivedAt instanceof Date);

  section("Replace");
  const draft3 = await store.addFiles(read, sa.id);
  await actions.analyseLegacyImport(draft3.id);
  await actions.startLegacyImport(draft3.id, { strategy: "NEW", decisions, confirmed: true });
  await runToEnd(draft3.id);
  const draft4 = await store.addFiles(read, sa.id);
  await actions.analyseLegacyImport(draft4.id);
  await actions.startLegacyImport(draft4.id, { strategy: "REPLACE", decisions, confirmed: true });
  const replaced = await runToEnd(draft4.id);
  ok("Replace undoes the earlier import, then brings the files in afresh", replaced.status === "DONE" && (replaced.progress.replaced ?? []).some((r) => r.importId === draft3.id) && (await db.legacyImport.findUnique({ where: { id: draft3.id } }))?.status === "UNDONE" && (await db.companyProduct.count()) === 3, replaced.progress);

  section("Master lists, from the files");
  const zohoFiles = await files.readUpload([
    {
      name: "Contacts.csv",
      bytes: Buffer.from(
        csv("Contact ID,Display Name,Company Name,First Name,Last Name,EmailID,MobilePhone,Phone,Customer Sub Type,GST Identification Number (GSTIN),Status,Owner Name", [
          ["880908000000100001", "Pan India Consultants", "Pan India Consultants Private Limited", "Ashish", "Gupta", "ashishgupta@panindiagroup.com", "9911631987", "", "business", "06AAACP0622N1ZK", "Active", "Nobody Known"],
          ["880908000000100002", "Burda Media", "Burda Media India Private Limited", "", "", "", "", "", "business", "", "Active", ""],
          ["880908000000100003", "Only In Zoho Pvt Ltd", "Only In Zoho Pvt Ltd", "", "", "", "", "", "business", "", "Active", "OWNER  here."],
        ]),
      ),
    },
    {
      name: "Contact_Persons.csv",
      bytes: Buffer.from(csv("Customer ID,Customer Name,Contact Person ID,First Name,Last Name,EmailID,Phone,MobilePhone,Is Primary,Designation", [["880908000000100001", "Pan India Consultants", "880908000000200001", "Anoop", "", "", "", "", "false", "IT Manager"]])),
    },
    {
      name: "Item.csv",
      bytes: Buffer.from(csv("Item ID,Item Name,SKU,HSN/SAC,Rate,Product Type,Status", [["880908000000300001", "Microsoft 365 Business Basic", "", "997331", "INR 1250.00", "service", "Active"]])),
    },
  ]);
  const draft5 = await store.addFiles([...read, ...zohoFiles], sa.id);
  ok("Zoho's files are taken for Zoho's tables", draft5.files.filter((x) => x.kind?.startsWith("zoho_")).length === 3, draft5.files.map((x) => x.kind));
  const lists = await actions.buildLegacyMasterLists(draft5.id);
  ok("built: Pan India by GSTIN, Burda by name, one only in Zoho", lists.ok && lists.data.counts.customers?.MATCHED === 2 && lists.data.counts.customers?.ZOHO_ONLY === 1, lists.ok ? lists.data.counts : lists);
  const people = await actions.legacyMatches(draft5.id, "contacts", "matched", "", 0);
  ok("  contacts inside the matched pair: Zoho's primary contact and WroffyCRM's by email", people.ok && people.data.rows.some((r) => r.reason === "Same email" && r.company?.startsWith("Pan India")), people.ok ? people.data.rows : people);
  ok("  the product by name", lists.ok && lists.data.counts.products?.MATCHED === 1);
  const burdaPair = await actions.legacyMatches(draft5.id, "customers", "matched", "Burda", 0);
  const burdaRow = burdaPair.ok ? burdaPair.data.rows[0] : null;
  const split = await actions.decideLegacyMatch(draft5.id, burdaRow!.id, "reject");
  ok("splitting a pair: each alone again", split.ok && split.data.customers?.MATCHED === 1 && split.data.customers?.ZOHO_ONLY === 2, split.ok ? split.data : split);
  const exported = await actions.legacyMasterCsv(draft5.id, "customers");
  const back = exported.ok
    ? exported.data.csv
        .split("\n")
        .map((line) => (line.includes(`"Burda Media`) && line.includes("ZOHO_ONLY") ? line.replace(/""$/, '"pair"').replace(/,"",""/, ',"1901","Burda Media India Pvt. Ltd."') : line))
        .join("\n")
    : "";
  const pairedBack = await actions.uploadLegacyMasterCsv(draft5.id, "customers", back);
  ok("pairing by hand through the CSV", pairedBack.ok && pairedBack.data.paired === 1 && pairedBack.data.counts.customers?.CONFIRMED === 1, pairedBack.ok ? pairedBack.data : pairedBack);
  const badCsv = await actions.uploadLegacyMasterCsv(draft5.id, "customers", `List,Status,Reason,Zoho id,Zoho record,WroffyCRM id,WroffyCRM record,Decision\ncustomers,X,,999,,1901,,pair\n`);
  ok("  an id not in the list refuses the whole file", /isn't in this list/.test(refusal(badCsv)));
  section("Importing through the master lists");
  // A clean slate: the Replace's import taken back first (the company built on by hand stays, as above).
  for (let i = 0; i < 50; i++) {
    const u = await actions.undoLegacyImport(draft4.id, "UNDO");
    if (!u.ok || u.data.done) break;
  }
  await actions.analyseLegacyImport(draft5.id);
  const suggestions = await db.legacyMatch.findMany({ where: { importId: draft5.id, status: "SUGGESTED" }, select: { id: true } });
  if (suggestions.length) ok("a suggestion left unsettled refuses the import", /suggestion/.test(refusal(await actions.startLegacyImport(draft5.id, { strategy: "NEW", decisions, confirmed: true }))));
  for (const s of suggestions) await actions.decideLegacyMatch(draft5.id, s.id, "confirm");
  const throughLists = await actions.startLegacyImport(draft5.id, { strategy: "NEW", decisions, confirmed: true });
  ok("with every suggestion settled, it starts", throughLists.ok, throughLists);
  const zohoRun = await runToEnd(draft5.id);
  ok("  and finishes", zohoRun.status === "DONE", zohoRun.progress);
  const recordOf = (kind: string, oldId: string) => db.legacyImportRecord.findUnique({ where: { kind_oldId: { kind, oldId } }, select: { recordId: true, action: true } });
  const burdaZoho = await recordOf("zoho_contacts", "880908000000100002");
  const burdaOld = await recordOf("customers", "1901");
  const burdaCompany = burdaZoho ? await db.company.findUnique({ where: { id: burdaZoho.recordId }, select: { name: true, website: true, stage: true } }) : null;
  ok("Burda, paired by hand: one company, Zoho's name, WroffyCRM's website filling the blank, both ids logged", burdaZoho?.action === "CREATED" && burdaOld?.recordId === burdaZoho.recordId && burdaOld.action === "LINKED" && burdaCompany?.name === "Burda Media India Private Limited" && burdaCompany.website === "https://www.burdaluxury.com/" && burdaCompany.stage === "CUSTOMER", { burdaZoho, burdaOld, burdaCompany });
  const onlyZoho = await recordOf("zoho_contacts", "880908000000100003");
  const onlyZohoCompany = onlyZoho ? await db.company.findUnique({ where: { id: onlyZoho.recordId }, select: { stage: true, ownerUserId: true, locations: { select: { isPrimary: true, isBilling: true } } } }) : null;
  ok("  the one only in Zoho: a customer, with its head office", onlyZohoCompany?.stage === "CUSTOMER" && onlyZohoCompany.locations.some((l) => l.isPrimary && l.isBilling), onlyZohoCompany);
  ok("  its owner in Zoho is its account manager, the name read however it was typed", onlyZohoCompany?.ownerUserId === existingUser.id, onlyZohoCompany);
  const panIndia = await recordOf("zoho_contacts", "880908000000100001");
  const panIndiaOwner = panIndia ? (await db.company.findUnique({ where: { id: panIndia.recordId }, select: { ownerUserId: true } }))?.ownerUserId : undefined;
  ok("  an owner nobody in Deskzo is called: no account manager guessed", !!panIndia && panIndiaOwner !== existingUser.id, { panIndia, panIndiaOwner });
  const itemZoho = await recordOf("zoho_items", "880908000000300001");
  const itemOld = await recordOf("products", "300");
  const zohoItem = itemZoho ? await db.item.findUnique({ where: { id: itemZoho.recordId }, select: { sku: true, sellingPrice: true, hsnCode: true } }) : null;
  ok("  the item: one, Zoho's price, WroffyCRM's SKU where Zoho had none", itemOld?.recordId === itemZoho?.recordId && zohoItem?.sku === "M365-BASIC-ZZ" && Number(zohoItem.sellingPrice) === 1250 && zohoItem.hsnCode === "997331", { itemZoho, itemOld, zohoItem });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { recordForOldId, ZOHO_PARTY_KINDS, ZOHO_ITEM_KINDS } = require("../src/lib/legacy-import/links") as typeof import("../src/lib/legacy-import/links");
  ok("  the switch finds them by Zoho's ids", (await recordForOldId(ZOHO_PARTY_KINDS, "880908000000100002")) === burdaZoho?.recordId && (await recordForOldId(ZOHO_ITEM_KINDS, "880908000000300001")) === itemZoho?.recordId && (await recordForOldId(ZOHO_PARTY_KINDS, "8.80908E+17")) === null);
  const anoop = await recordOf("zoho_contact_persons", "880908000000200001");
  ok("  Zoho's contact person comes in on its company", !!anoop && (await db.contact.findUnique({ where: { id: anoop.recordId }, select: { designation: true } }))?.designation === "IT_MANAGER", anoop);
  for (let i = 0; i < 50; i++) {
    const u = await actions.undoLegacyImport(draft5.id, "UNDO");
    if (!u.ok || u.data.done) break;
  }
  ok("  undone: what came from Zoho is gone", !(await db.company.findUnique({ where: { id: onlyZoho!.recordId } })) && !(await db.item.findUnique({ where: { id: itemZoho!.recordId } })) && !(await recordOf("zoho_contacts", "880908000000100003")));

  const draft6 = await store.addFiles([...read, ...zohoFiles], sa.id);
  await actions.buildLegacyMasterLists(draft6.id);
  await actions.removeLegacyFile(draft6.files.find((x) => x.name === "Item.csv")!.id);
  ok("changing the files throws the lists away", (await db.legacyMatch.count({ where: { importId: draft6.id } })) === 0);
  await actions.discardLegacyDraft(draft6.id);

  section("Zoho's Contacts.csv on its own, for its owners");
  // As the owner uploaded it (30 Oct 2026): no WroffyCRM files, a company Deskzo has by hand with no account manager.
  const byHand = await db.company.create({ data: { name: "Zz Hand Made Traders Pvt Ltd", normalizedName: "zz hand made traders pvt ltd", createdById: sa.id }, select: { id: true } });
  // Customers WroffyCRM brought under other names than Zoho's: one by its GSTIN, one whose GSTIN two companies share.
  const sameTax = (name: string, gst: string) => db.company.create({ data: { name, normalizedName: name.toLowerCase(), createdById: sa.id, locations: { create: { label: "Head office", gstNumber: gst, isPrimary: true } } }, select: { id: true } });
  const byGstin = await sameTax("Zz Intech Infotech", "07ZZTAX1234K1Z5");
  const panTwins = [await sameTax("Zz Twin One", "29ZZPAN5678Q1Z5"), await sameTax("Zz Twin Two", "29ZZPAN5678Q1Z5")];
  const alone = await files.readUpload([
    {
      name: "Contacts.csv",
      bytes: Buffer.from(
        csv("Contact ID,Display Name,Company Name,GST Identification Number (GSTIN),Customer Sub Type,Status,Owner Name", [
          ["880908000000900001", "Zz Hand Made Traders", "Zz Hand Made Traders Pvt Ltd", "", "business", "Active", "owner here"],
          ["880908000000900002", "Zz Zoho Only Two", "Zz Zoho Only Two Pvt Ltd", "", "business", "Active", "Somebody Gone"],
          ["880908000000900003", "Zz Intech Online", "Zz Intech Online Pvt Ltd", "07ZZTAX1234K1Z5", "business", "Active", "owner here"],
          ["880908000000900004", "Zz Intech Mumbai", "Zz Intech Mumbai", "27ZZTAX1234K1Z5", "business", "Active", ""],
          ["880908000000900005", "Zz Twin Books", "Zz Twin Books", "29ZZPAN5678Q1Z5", "business", "Active", ""],
        ]),
      ),
    },
  ]);
  const draft7 = await store.addFiles(alone, sa.id);
  await actions.buildLegacyMasterLists(draft7.id);
  const aloneAnalysis = await actions.analyseLegacyImport(draft7.id);
  const zohoKind = aloneAnalysis.ok ? aloneAnalysis.data.kinds.find((k) => k.kind === "zoho_contacts") : undefined;
  ok("The preview counts them: three already in Deskzo (one by name, two on their own by GSTIN and PAN), two new", zohoKind?.matches === 3 && zohoKind.linked === 2 && zohoKind.fresh === 2, zohoKind);
  ok("  says how many are a company Deskzo has by GSTIN and by PAN", !!zohoKind?.warnings.some((w) => /1 by the same GSTIN, 1 by the same PAN/.test(w)), zohoKind?.warnings);
  ok("  says which owners nobody in Deskzo answers to", !!zohoKind?.warnings.some((w) => w.includes("Somebody Gone")), zohoKind?.warnings);
  ok("  and asks what to do with the one already here", aloneAnalysis.ok && aloneAnalysis.data.needsDecision.includes("zoho_contacts"));
  ok("Without that choice: refused", /Choose what to do/.test(refusal(await actions.startLegacyImport(draft7.id, { strategy: "NEW", decisions: {}, confirmed: true }))));
  const aloneStarted = await actions.startLegacyImport(draft7.id, { strategy: "NEW", decisions: { matches: { zoho_contacts: "link" } }, confirmed: true });
  ok("Using the company already here: it starts", aloneStarted.ok, aloneStarted);
  const aloneRun = await runToEnd(draft7.id);
  ok("  and finishes", aloneRun.status === "DONE", aloneRun.progress);
  ok("  the company made by hand gets its Zoho owner as account manager", (await db.company.findUnique({ where: { id: byHand.id }, select: { ownerUserId: true } }))?.ownerUserId === existingUser.id);
  const aloneRecord = (oldId: string) => db.legacyImportRecord.findUnique({ where: { kind_oldId: { kind: "zoho_contacts", oldId } }, select: { recordId: true, action: true } });
  const [viaGstin, viaPan, twinBooks] = [await aloneRecord("880908000000900003"), await aloneRecord("880908000000900004"), await aloneRecord("880908000000900005")];
  ok("  a different name, the same GSTIN: the company Deskzo has, no new one, its owner filled", viaGstin?.action === "LINKED" && viaGstin.recordId === byGstin.id && (await db.company.findUnique({ where: { id: byGstin.id }, select: { ownerUserId: true } }))?.ownerUserId === existingUser.id, viaGstin);
  ok("  the same PAN in another state: that company too", viaPan?.action === "LINKED" && viaPan.recordId === byGstin.id, viaPan);
  ok("  a GSTIN two Deskzo companies share: nothing guessed, the name decides", twinBooks?.action === "CREATED" && !panTwins.some((t) => t.id === twinBooks.recordId), twinBooks);
  for (let i = 0; i < 50; i++) {
    const u = await actions.undoLegacyImport(draft7.id, "UNDO");
    if (!u.ok || u.data.done) break;
  }
  for (const id of [byHand.id, byGstin.id, ...panTwins.map((t) => t.id)]) {
    await db.companyLocation.deleteMany({ where: { companyId: id } });
    await db.company.delete({ where: { id } }).catch(() => {});
  }

  section("Every row comes in: gaps get a stand-in to fix later");
  // From the owner's error file (30 Oct 2026): 1,332 orders with no address to book to, products that never came
  // across, companies with no name, and 951 leads whose status the tool didn't know.
  const rowOf = (head: string, v: Record<string, string | number>) => head.split(",").map((h) => v[h] ?? "");
  // A company Deskzo has by hand, with no address: the customer of that name links to it, and its order has nowhere to go.
  const linkedHand = await db.company.create({ data: { name: "Zz Gaps Linked Ltd", normalizedName: "zz gaps linked ltd", createdById: sa.id }, select: { id: true } });
  const gaps = await files.readUpload([
    { name: "customers.csv", bytes: Buffer.from(csv(H.customers, [rowOf(H.customers, { id: 6001, company: "", official_email: "nameless@zz-gaps.invalid", status: "active", createdAt: T, updatedAt: T }), rowOf(H.customers, { id: 6002, company: "Zz Gaps Linked Ltd", status: "active", createdAt: T, updatedAt: T })])) },
    { name: "customer_product.csv", bytes: Buffer.from(csv(H.customer_product, [rowOf(H.customer_product, { id: 6101, customer_id: 6002, product_id: 88881, quantity: 2, status: "active", createdAt: T, updatedAt: T })])) },
    {
      name: "leads.csv",
      bytes: Buffer.from(
        csv(H.leads, [
          rowOf(H.leads, { id: 6201, company: "Zz Gaps Not A Fit Ltd", status: "Not a fit", createdAt: T, updatedAt: T }),
          rowOf(H.leads, { id: 6202, company: "Zz Gaps On Hold Ltd", status: "On hold", createdAt: T, updatedAt: T }),
          rowOf(H.leads, { id: 6203, company: "Zz Gaps Just Lead Ltd", status: "Lead", createdAt: T, updatedAt: T }),
        ]),
      ),
    },
  ]);
  const draft8 = await store.addFiles(gaps, sa.id);
  const gapsAnalysis = await actions.analyseLegacyImport(draft8.id);
  const cantCome = gapsAnalysis.ok ? gapsAnalysis.data.kinds.reduce((t, k) => t + k.problemRows, 0) : -1;
  ok("The preview refuses none of them", cantCome === 0, gapsAnalysis.ok ? gapsAnalysis.data.kinds.flatMap((k) => k.problems) : gapsAnalysis);
  const gapsStarted = await actions.startLegacyImport(draft8.id, { strategy: "NEW", decisions: { matches: { customers: "link", products: "link", employees: "link" } }, confirmed: true });
  ok("  it starts", gapsStarted.ok, gapsStarted);
  const gapsRun = await runToEnd(draft8.id);
  ok("  and finishes", gapsRun.status === "DONE", gapsRun.progress);
  const nameless = await recordOf("customers", "6001");
  const namelessCompany = nameless ? await db.company.findUnique({ where: { id: nameless.recordId }, select: { name: true } }) : null;
  ok("A customer with no name: named for its email, marked (to fix)", namelessCompany?.name === "nameless@zz-gaps.invalid (to fix)", namelessCompany);
  const order = await recordOf("customer_product", "6101");
  const orderRow = order ? await db.companyProduct.findUnique({ where: { id: order.recordId }, select: { quantity: true, location: { select: { label: true } }, item: { select: { name: true, sku: true } } } }) : null;
  ok("Its order comes in, booked to a head office marked (to fix)", orderRow?.location.label === "Head office (to fix)", orderRow);
  ok("  on a stand-in for the product that never came across", orderRow?.item.sku === "OLDCRM-88881" && orderRow.item.name.endsWith("(to fix)"), orderRow?.item);
  const statusOf = async (oldId: string) => {
    const rec = await recordOf("leads", oldId);
    return rec ? await db.lead.findUnique({ where: { id: rec.recordId }, select: { status: true, description: true } }) : null;
  };
  const notAFit = await statusOf("6201");
  const onHold = await statusOf("6202");
  const justLead = await statusOf("6203");
  ok('"Not a fit" is disqualified', notAFit?.status === "DISQUALIFIED", notAFit);
  ok('"On hold" is contacted, said in its description', ["CONTACTED", "NEW"].includes(onHold?.status ?? "") && (onHold?.description ?? "").includes("On hold in the old CRM"), onHold);
  ok('"Lead" is new', justLead?.status === "NEW", justLead);
  for (let i = 0; i < 50; i++) {
    const u = await actions.undoLegacyImport(draft8.id, "UNDO");
    if (!u.ok || u.data.done) break;
  }
  await db.companyLocation.deleteMany({ where: { companyId: linkedHand.id } });
  await db.company.delete({ where: { id: linkedHand.id } }).catch(() => {});
  ok("Undone: the stand-ins go with it", !(await db.item.findUnique({ where: { sku: "OLDCRM-88881" } })) && !(nameless && (await db.company.findUnique({ where: { id: nameless.recordId } }))));

  section("A big upload, in parts");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const parts = require("../src/lib/legacy-import/parts") as typeof import("../src/lib/legacy-import/parts");
  const whole = Buffer.from("id,company\n" + Array.from({ length: 5000 }, (_, i) => `${i},Zz Part Co ${i}`).join("\n"));
  const third = Math.ceil(whole.length / 3);
  const id = parts.newUploadId();
  const send = (index: number, userId = sa.id) => parts.receivePart({ uploadId: id, index, count: 3, name: "customers.csv", size: whole.length, userId, bytes: whole.subarray(index * third, (index + 1) * third) });
  const firstPart = await send(0);
  const stranger = await send(1, "someone-else").then(() => "", (e: Error) => e.message);
  await send(2);
  const last = await send(1);
  ok("a file sent in three parts, out of order, comes back whole", !firstPart.done && last.done && last.bytes.equals(whole));
  ok("  a part from somebody else is refused", /somebody else/.test(stranger));
  ok("  an id the app didn't give is refused", await parts.receivePart({ uploadId: "../../etc", index: 0, count: 1, name: "x.csv", size: 1, userId: sa.id, bytes: Buffer.from("x") }).then(() => false, () => true));
  const seen: string[] = [];
  await files.eachUploadFile([{ name: "customers.csv", bytes: whole }, { name: "employees.csv", bytes: Buffer.from("id,first_name\n1,Zz") }], async (file) => void seen.push(`${file.name}:${file.rows.length}`));
  ok("  files read a file at a time, each handed on before the next", seen.join() === "customers.csv:5000,employees.csv:1", seen);

  section("The page");
  const html = (await renderHtml(Page())).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  ok("the super admin sees the tool and the imports so far", html.includes("Old CRM migration") && html.includes("Super Admin only") && html.includes("Imports so far") && html.includes("Upload the old CRM"), html.slice(0, 300));
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAll legacy import checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
